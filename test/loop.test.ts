// 고리 (5층 지각 + 6층 행동): 알아채면 살피고, 이해하면 버린다. 사람이 다르면 하루가 달라진다
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { EventLog } from '../src/core/log.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import type { DayTrace } from '../src/core/skeleton.ts';
import { SKELETON_SCENARIO, skeletonDay } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const isKnownType = (type: string): boolean => vocab.has('event_type', type);
const scenario = parseScenario(JSON.parse(readFileSync(join(ROOT, SKELETON_SCENARIO), 'utf8')));

function merged(extra?: unknown): Db {
  let db = emptyDb();
  for (const raw of [...scenario.patches.map((f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as unknown), ...(extra === undefined ? [] : [extra])]) {
    const p = parsePatch(raw);
    assert.ok(p.patch, JSON.stringify(p.issues));
    const m = mergePatch(db, p.patch, vocab);
    assert.deepEqual(m.report.errors, []);
    db = m.db;
  }
  return db;
}

type E = { t: number; type: string; data: Record<string, unknown> };
const events = (trace: DayTrace, type: string): E[] => (trace.log as E[]).filter((e) => e.type === type);
const bugs = (trace: DayTrace): string[] => events(trace, 'state_changed').filter((e) => String(e.data['key']).endsWith(':bug')).map((e) => `${e.t} ${String(e.data['key'])}`);

test('고리가 닫힌다: 알아챔 → 살피기 → 이해함 → 버리기 → 냄새가 빠지고 벌레는 오지 않는다', () => {
  const trace = skeletonDay(ROOT, vocab);
  assert.deepEqual(
    events(trace, 'action_chosen').map((e) => `${e.t} ${String(e.data['verb'])} ${String(e.data['at'])}`),
    ['1860 inspect PLC000001#1', '1865 discard OBJ000001#1'],
  );
  assert.deepEqual(
    events(trace, 'awareness_up').map((e) => `${e.t} ${String(e.data['key'])} ${String(e.data['to'])}`),
    // 살핀 물건은 임계와 상관없이 모든 상태를 안다. 위치가 없어 집 안 물건 전부(신발·현관 바닥 포함)가 보인다
    [
      '1860 PLC000001#1|space:smell noticed',
      '1865 OBJ000001#1|body:rot understood',
      '1865 OBJ000001#1|body:smell understood',
      '1865 OBJ000002#1|sole:dirt understood',
      '1865 OBJ000003#1|surface:dirt understood',
    ],
  );
  assert.deepEqual(bugs(trace), []);
  assert.ok(events(trace, 'delay_cancelled').some((e) => e.data['via'] === 'PLC000001/rule/odor_thicken'), '짙어지기 예약이 취소된다');
  const last = trace.steps.at(-1);
  assert.equal((last?.values['world.state'] as Record<string, string>)['PLC000001#1|space:smell'], undefined, '주방 냄새가 빠졌다 (없음)');
});

test('버린 결과는 행동에서 이어진다: 상태 변화 ← 행동 끝 ← 행동 선택', () => {
  const trace = skeletonDay(ROOT, vocab);
  const log = EventLog.fromJSON(trace.log as unknown[], { isKnownType });
  const gone = log.list({ type: 'state_changed', where: (e) => e.data['to'] === 'gone' }).at(0);
  assert.ok(gone);
  assert.deepEqual(log.chain(gone.seq).map((e) => e.type), ['state_changed', 'action_done', 'action_chosen']);
});

test('사람이 다르면 하루가 다르다: 냄새에 둔한 사람은 저녁에야 알아채고, 그 사이 꼬인 벌레는 버린 뒤에도 거실로 번진다', () => {
  const dull = merged({
    format: 'small-happiness-patch', version: 1, why: '시험: 냄새에 둔한 사람 (임시값)',
    defs: [{ id: 'CHR000001', senses: { smell: { notice: 3, tuned: false }, sight: { notice: 1, tuned: false } } }],
  });
  const trace = runScenario(dull, vocab, scenario);
  // 아침의 은은한 냄새(1칸)는 못 느끼고, 귀가(2일 19:30 = 2610)에 뚜렷한 냄새(3칸)와 벌레를 느낀다
  assert.equal(events(trace, 'awareness_up').at(0)?.t, 2610);
  // 원천을 버려도 이미 꼬인 벌레는 남는다 (벌레를 없애는 규칙·행동이 아직 없다)
  assert.deepEqual(bugs(trace), ['2460 PLC000001#1|space:bug', '2820 PLC000002#1|space:bug']);
  assert.deepEqual(events(trace, 'action_chosen').map((e) => String(e.data['verb'])), ['inspect', 'discard']);
});

test('외출·잠 중에는 아무것도 느끼지 않고 아무것도 하지 않는다', () => {
  const trace = skeletonDay(ROOT, vocab);
  for (const s of trace.steps) {
    if (/\] (외출|잠) /.test(s.lines.join(''))) {
      assert.deepEqual(s.values['perceived'], [], `${s.t}`);
      assert.deepEqual(s.values['recent'], [], `${s.t}`);
    }
  }
});

test('행동이 끝나는 시각에 다음 단계가 돈다 (집에 있을 때)', () => {
  const ts = skeletonDay(ROOT, vocab).steps.map((s) => s.t);
  assert.ok([1860, 1865, 1870].every((t) => ts.includes(t)));
});
