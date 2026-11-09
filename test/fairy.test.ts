// ⓒ 해석 후 행동과 요정의 조언 (docs/내면-설계.md 12장): 하루씨가 떠올린 선택지 중 요정이 하나를 권하고, 생각이 멈추면 듣지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionClass } from '../src/core/agency.ts';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'home-evening.json'), 'utf8')) as Record<string, unknown>;
const run = (r: Record<string, unknown>): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(r);
  return { events: runScenario(db, vocab, sc).log.map(parseEvent), start: sc.start };
};
const evening = run(raw());
const chosen = (es: readonly GameEvent[]): string[] => es.filter((e) => e.type === 'action_chosen').map((e) => str(e.data['verb']));
const floor = (es: readonly GameEvent[]): string | undefined => es.filter((e) => e.type === 'state_changed' && e.data['key'] === 'PLC000002#1|floor:dirt').at(-1)?.data['to'] as string | undefined;
const WIPE = 'PLC000002/offer/wipe_floor';

test('사전: 쉼(쉬기·눕기·드라마·웹툰)과 집안일(닦기·환기·버리기), 나머지는 할 일', () => {
  assert.deepEqual(['rest', 'lie_down', 'watch', 'read_webtoon'].map((v) => actionClass(vocab, v)), ['pastime', 'pastime', 'pastime', 'pastime']);
  assert.deepEqual(['wipe', 'ventilate', 'discard'].map((v) => actionClass(vocab, v)), ['upkeep', 'upkeep', 'upkeep']);
  assert.equal(actionClass(vocab, 'wash'), 'task', '먹고 난 설거지는 하루씨가 스스로 한다');
});

test('하루씨 혼자: 할 일이 없으면 쉬고(덜 한 것부터 돌아가며), 쉴 거리가 있는 동안 바닥은 스스로 닦지 않는다', () => {
  const r = raw();
  r['advice'] = [];
  const alone = run(r);
  const verbs = chosen(alone.events);
  assert.ok(verbs.length >= 4 && verbs.every((v) => actionClass(vocab, v) === 'pastime'), verbs.join(', '));
  assert.deepEqual(new Set(verbs.slice(0, 4)), new Set(['lie_down', 'rest', 'watch', 'read_webtoon']), '네 가지를 한 번씩 한 뒤에 되풀이한다');
  assert.equal(floor(alone.events), 'dirty');
  // 쉴 거리가 없으면 집안일을 스스로 한다
  r['spawn'] = ['CHR000001', 'PLC000002'];
  r['layout'] = [];
  assert.deepEqual(chosen(run(r).events), ['wipe']);
});

test('선택지: 할 일이 없을 때 떠올린 것(쉼·집안일)을 남기고, 바닥을 닦으면 닦기가 선택지에서 빠진다', () => {
  const opts = evening.events.filter((e) => e.type === 'options_formed').map((e) => (Array.isArray(e.data['options']) ? e.data['options'] : []).map((o) => (typeof o === 'object' && o !== null && !Array.isArray(o) ? str(o['offer']) : '')));
  assert.ok((opts[0] ?? []).includes(WIPE) && (opts[0] ?? []).length === 5, (opts[0] ?? []).join(', '));
  assert.ok(opts.length >= 2 && !(opts.at(-1) ?? []).includes(WIPE));
});

test('요정의 조언: 권한 것이 선택지면 다음에 고를 때 그것을 하고, 선택지가 아니면 듣지 않는다', () => {
  const given = evening.events.filter((e) => e.type === 'advice_given');
  assert.equal(given.length, 2);
  const wipe = evening.events.find((e) => e.type === 'action_chosen' && e.data['advised'] === given[0]?.seq);
  assert.equal(wipe?.data['verb'], 'wipe');
  assert.ok((given[0]?.t ?? 0) >= 1180, '쉬는 중에 권하면 쉬고 난 뒤에 닿는다');
  assert.equal(floor(evening.events), 'clean');
  const ignored = evening.events.find((e) => e.type === 'advice_ignored');
  assert.equal(ignored?.cause, given[1]?.seq);
  assert.equal(ignored?.data['reason'], 'not_option', '이미 닦은 바닥은 선택지가 아니다');
});

test('스트레스 임계: 생각이 멈춰 있으면 해석하지 못해 조언을 듣지 않는다', () => {
  const r = raw();
  r['set'] = [...(r['set'] as unknown[]), { t: 0, key: 'CHR000001#1|mood:displeasure', level: 'strong' }, { t: 0, key: 'CHR000001#1|mood:stability', level: 'uneasy' }];
  const stuck = run(r);
  const ignored = stuck.events.filter((e) => e.type === 'advice_ignored').map((e) => e.data['reason']);
  assert.deepEqual(ignored, ['overwhelmed', 'overwhelmed']);
  assert.equal(floor(stuck.events), 'dirty');
  assert.deepEqual(auditLog(stuck.events, db, vocab, { externalUntil: stuck.start }).findings, []);
});

test('시나리오의 조언은 { t, offer, at } 목록이다', () => {
  assert.throws(() => parseScenario({ ...raw(), advice: [{ t: 10, offer: WIPE }] }), /advice는/);
  assert.throws(() => parseScenario({ ...raw(), advice: { t: 10 } }), /advice는/);
});

test('감사: 조언이 닿고 듣지 않은 것, 선택지 밖의 선택을 다시 맞춰 잡는다', () => {
  const es = evening.events;
  const opts = { externalUntil: evening.start };
  assert.deepEqual(auditLog(es, db, vocab, opts).findings, []);
  const ignored = es.find((e) => e.type === 'advice_ignored')?.seq;
  const advised = es.find((e) => e.type === 'action_chosen' && e.data['advised'] !== undefined)?.seq;
  const firstRest = es.find((e) => e.type === 'action_chosen' && e.data['advised'] === undefined)?.seq;
  const cases: { name: string; mutate: (x: GameEvent[]) => GameEvent[] }[] = [
    { name: '듣지 않은 기록을 지움', mutate: (x) => x.filter((e) => e.seq !== ignored) },
    { name: '듣지 않은 이유를 생각이 멈춤으로 고침', mutate: (x) => x.map((e) => (e.seq === ignored ? { ...e, data: { ...e.data, reason: 'overwhelmed' } } : e)) },
    { name: '권한 것과 다른 것을 고른 것으로 고침', mutate: (x) => x.map((e) => (e.seq === advised ? { ...e, data: { ...e.data, via: 'OBJ000043/offer/watch_drama', at: 'OBJ000043#1', verb: 'watch' } } : e)) },
    { name: '조언 기록을 지움 (닿지 않은 조언으로 고름)', mutate: (x) => x.filter((e) => !(e.type === 'advice_given' && x.find((y) => y.seq === advised)?.data['advised'] === e.seq)) },
    { name: '선택지에 없는 것을 고른 것으로 고침', mutate: (x) => x.map((e) => (e.seq === firstRest ? { ...e, data: { ...e.data, via: 'PLC000002/offer/inspect', at: 'PLC000002#1', verb: 'inspect' } } : e)) },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(es)), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === 'action'), `${c.name}: 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});
