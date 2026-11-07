// 종류 (is_a): 규칙·행동을 종류에 한 번만 쓰고 물건마다 물려받는다. 같은 키로 덮어쓴다. on_all · 소멸 · when
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { runGate } from '../src/core/gate.ts';
import { effectiveProgress, kindMembers } from '../src/core/kinds.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { scenarioRun } from '../src/node/clerk.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const real: Db = loadDb(ROOT);
type E = { t: number; type: string; data: Record<string, unknown> };

test('실제 저장소: 음식 종류 하나에 음식 10가지가 속하고, 실제 저장소가 관문을 통과한다', () => {
  assert.equal(kindMembers(real, 'OBJ000001').size, 11);
  assert.equal(runGate(emptyDb(), real, vocab, []).pass, true);
});

test('진행 법칙: 종류의 표 + 물건의 기본 시간, 그리고 물건은 자기 과정만 받는다 (우유는 시들지 않고 김치는 상하지 않는다)', () => {
  const laws = (def: string): string[] => effectiveProgress(real, def).full.map((p) => `${p.feature}:${p.base_s / 86400}일`);
  assert.deepEqual(laws('OBJ000002'), ['mold:3일', 'sour:6.5일']); // 우유
  assert.deepEqual(laws('OBJ000003'), ['decay:17일', 'mold:19일']); // 두부
  assert.deepEqual(laws('OBJ000005'), ['mold:58일', 'ripen:60일']); // 김치
  assert.deepEqual(effectiveProgress(real, 'OBJ000003').full.at(0)?.inputs, real.defs['OBJ000001']?.progress?.['decay']?.inputs);
});

test('첫 주: 음식마다 자기 과정으로 변한다 (치킨 쉼 → 상함 → 상추 시듦 → 두부 쉼 → 우유 새큼 → 대파 시듦 → 김치 익음)', () => {
  const trace = scenarioRun(ROOT, vocab, 'content/scenarios/first-week.json');
  const name = (key: string): string => real.defs[key.split('#')[0] ?? '']?.names.ko ?? key;
  const firsts: string[] = [];
  for (const e of trace.log as E[]) {
    const key = String(e.data['key']);
    if (e.type !== 'stage_advanced') continue;
    const label = `${name(key)} ${key.split(':')[1] ?? ''}=${String(e.data['to'])}`;
    if (!firsts.includes(label)) firsts.push(label);
  }
  assert.deepEqual(firsts.slice(0, 7), [
    '남은 치킨 decay=turned',
    '남은 치킨 decay=spoiled',
    '상추 wilt=wilted',
    '두부 decay=turned',
    '우유 sour=tangy',
    '대파 wilt=wilted',
    '김치 ripen=ripe',
  ]);
});

test('간격을 바꿔도 진행의 결과가 같다 (3시간 · 1시간): 양은 정수로 쌓고 경계 시각을 정확히 계산한다', () => {
  const changes = (stepMin: number): string[] =>
    (scenarioRun(ROOT, vocab, 'content/scenarios/first-week.json', stepMin).log as E[])
      .filter((e) => e.type === 'state_changed')
      .map((e) => `${e.t} ${String(e.data['key'])} ${String(e.data['to'])}`);
  assert.deepEqual(changes(60), changes(180));
});

test('버리기는 못 먹게 된 음식만 (when_meaning): 신선한 음식은 살핀 뒤에도 버리지 않는다', () => {
  const trace = scenarioRun(ROOT, vocab, 'content/scenarios/first-week.json');
  const discarded = (trace.log as E[]).filter((e) => e.type === 'action_chosen' && e.data['verb'] === 'discard').map((e) => String(e.data['at']));
  assert.ok(discarded.length > 0);
  assert.ok(!discarded.includes('OBJ000004#1'), '계란(21일)은 버리지 않는다');
});

function gateOf(extra: unknown): string {
  const base = mergePatch(emptyDb(), parsePatch({
    format: 'small-happiness-patch', version: 1, why: '시험 기준',
    defs: [{ id: 'OBJ+1', names: { ko: '음식' }, slots: { body: { features: ['rot'] } },
      rules: { w: { on: ['OBJ+1|body:rot@=fresh'], emits: ['OBJ+1|body:rot@=wilted'] } } }],
  }).patch ?? assert.fail(), vocab).db;
  const p = parsePatch(extra);
  assert.ok(p.patch);
  const m = mergePatch(base, p.patch, vocab);
  const g = runGate(base, m.db, vocab, m.report.errors);
  return [g.reason, ...g.newErrors.map((i) => i.msg), ...g.mergeErrors.map((i) => i.msg)].join('\n');
}

test('거부: 종류의 규칙이 쓰는 특징이 없는 물건 (물려받을 수 없다)', () => {
  assert.match(gateOf({ format: 'small-happiness-patch', version: 1, why: '시험',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000001', names: { ko: '돌' }, slots: { body: { features: ['dirt'] } } }] }), /부위 body에 특징 rot가 있어야 한다/);
});

test('거부: 종류는 한 단계만, 같은 접두만, 있는 정의만', () => {
  assert.match(gateOf({ format: 'small-happiness-patch', version: 1, why: '시험',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000099', names: { ko: '유령' }, slots: { body: { features: ['rot'] } } }] }), /없는 정의를 가리킨다: OBJ000099/);
  assert.match(gateOf({ format: 'small-happiness-patch', version: 1, why: '시험',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000001', names: { ko: '과일' }, slots: { body: { features: ['rot'] } } },
      { id: 'OBJ+2', is_a: 'OBJ+1', names: { ko: '사과' }, slots: { body: { features: ['rot'] } } }] }), /종류는 한 단계만/);
});
