// 감각의 세기와 반사 (docs/내면-설계.md 8장): 세기는 그 사람이 감각을 몇 단계로 구분하는지에 맞추고, 반사는 감각 자체에 곧바로 붙는다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { reaches, reflexDefs, triggers } from '../src/core/reflex.ts';
import { feltLevel } from '../src/core/sensation.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { Vocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOCAB_DIR = join(ROOT, 'data', 'vocab');
const vocab = loadVocabDir(VOCAB_DIR);
const db = loadDb(ROOT);
const byName = (ko: string): string => Object.values(db.defs).find((d) => d.names.ko === ko)?.id ?? `없음:${ko}`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const scenarioRaw = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', `${name}.json`), 'utf8')) as Record<string, unknown>;
const run = (raw: Record<string, unknown>, v: Vocab = vocab): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(raw);
  return { events: runScenario(db, v, sc).log.map(parseEvent), start: sc.start };
};
const shop = run(scenarioRaw('kitchen-shopping'));
const reflexEvents = (es: readonly GameEvent[]): GameEvent[] => es.filter((e) => e.type === 'reflex');

test('세기: 같은 상태도 그 사람이 감각을 몇 단계로 구분하느냐에 따라 다른 칸이 된다 (그 감각질을 주는 칸들 중에서)', () => {
  const view = (level: string) => ({ defOf: () => 'X', has: () => true, level: () => level });
  // 냄새 세기: 은은함 · 뚜렷함 · 지독함 (없음은 뺀다)
  assert.deepEqual([2, 3, 5].map((sc) => feltLevel(vocab, view('distinct'), 'X#1', 'space:smell', false, sc)), [2, 2, 4]);
  assert.deepEqual([2, 3, 5].map((sc) => feltLevel(vocab, view('faint'), 'X#1', 'space:smell', false, sc)), [1, 1, 2]);
  assert.deepEqual([2, 3, 5].map((sc) => feltLevel(vocab, view('foul'), 'X#1', 'space:smell', false, sc)), [2, 3, 5]);
  // 차가움(온도 냉장 이하, 낮을수록 세다): 냉장 < 냉동
  const cold = ['cond:temp@<=fridge'];
  assert.equal(feltLevel(vocab, view('fridge'), 'X#1', 'cond:temp', true, 3, cold), 2);
  assert.equal(feltLevel(vocab, view('frozen'), 'X#1', 'cond:temp', true, 3, cold), 3);
  // 뜨거움(가열 뜨거움 이상): 뜨거움 < 끓음 < 튀김
  const hot = ['cond:heat@>=hot'];
  assert.deepEqual(['hot', 'boil', 'fry'].map((l) => feltLevel(vocab, view(l), 'X#1', 'cond:heat', false, 3, hot)), [1, 2, 3]);
  assert.equal(feltLevel(vocab, view('anything'), 'X#1', undefined, false, 4), 4, '세기를 정하는 상태가 없으면 가장 센 칸');
});

test('반사의 문턱: 그 사람의 단계 중 몇 %로 정하고, 세기가 올라 처음 넘을 때만 다시 일어난다', () => {
  const r = { key: 'x', on: 's', atLeast: 60, conditioned: false };
  assert.equal(reaches(r, 2, 3), true);
  assert.equal(reaches(r, 1, 3), false);
  assert.equal(reaches(r, 2, 4), false, '네 단계로 느끼는 사람에게 2는 문턱 아래다');
  assert.equal(triggers(r, 3, 3, 2), false, '이미 넘어 있었으면 다시 일어나지 않는다');
  assert.equal(triggers(r, 2, 3, 1), true);
  for (const d of reflexDefs(vocab)) {
    assert.ok(vocab.has('sensation', d.on), d.key);
    if (d.conditioned) assert.ok(vocab.has('sensation', d.pairsWith ?? '') && (d.times ?? 0) >= 1, d.key);
  }
});

test('무조건반사: 데운 찌개에 손을 움찔 떼고, 썬 대파에 코를 찡그리며, 냉장고에서 꺼낸 것의 차가움(2/3)에는 반사가 없다', () => {
  const got = reflexEvents(shop.events).map((e) => str(e.data['reflex']));
  assert.ok(got.includes('flinch_hot') && got.includes('wrinkle_nose') && got.includes('pucker'));
  assert.ok(!got.includes('withdraw_cold'), '냉장의 차가움은 가장 센 칸이 아니다 (냉동이어야)');
  // 반사의 원인은 바로 그 감각이고, 같은 시각이다
  for (const e of reflexEvents(shop.events)) {
    const c = shop.events.find((x) => x.seq === e.cause);
    assert.equal(c?.type, 'stimulus_perceived');
    assert.equal(c?.data['sensation'], e.data['sensation']);
    assert.equal(c?.t, e.t);
  }
});

test('조건반사: 구수한 냄새를 맡으며 감칠맛을 세 번 겪으면 배운다. 늘 나는 냄새(식탁 위 된장)는 다시 시작하지 않아 일어나지 않는다', () => {
  const learned = shop.events.filter((e) => e.type === 'reflex_learned').map((e) => [str(e.data['reflex']), e.t]);
  assert.deepEqual(learned.map(([k]) => k), ['salivate_savory']);
  assert.equal(shop.events.filter((e) => e.type === 'stimulus_perceived' && e.data['sensation'] === 'umami' && e.t <= Number(learned[0]?.[1])).length, 3);
  assert.equal(reflexEvents(shop.events).some((e) => e.data['reflex'] === 'salivate_savory'), false);
});

test('조건반사는 배운 뒤 그 예고 감각이 새로 시작될 때 일어난다 (시험용 사전: 김이 나는 것을 보며 감칠맛을 한 번 겪으면 배움)', () => {
  const raw: VocabCategoryRaw[] = readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(readFileSync(join(VOCAB_DIR, f), 'utf8')) as VocabCategoryRaw[]);
  for (const c of raw) {
    if (c.category !== 'reflex') continue;
    for (const e of c.entries) if (e.key === 'salivate_savory' && e.attrs !== undefined) Object.assign(e.attrs, { on: 'steaming', times: 1 });
  }
  const v = new Vocab(raw);
  const stew = run(scenarioRaw('kitchen-stew'), v);
  const learnedAt = stew.events.find((e) => e.type === 'reflex_learned')?.t ?? -1;
  assert.ok(learnedAt > 0, '첫날 저녁에 김을 보며 찌개를 먹고 배운다');
  const fired = reflexEvents(stew.events).filter((e) => e.data['reflex'] === 'salivate_savory');
  assert.ok(fired.length > 0 && fired.every((e) => e.t > learnedAt), '다음에 김이 나기 시작하면 군침이 돈다');
  assert.deepEqual(auditLog(stew.events, db, v, { externalUntil: stew.start }).findings, []);
});

test('감사: 반사를 감각에서 다시 계산해, 빠지거나 지어낸 반사·배움을 잡는다', () => {
  const opts = { externalUntil: shop.start };
  assert.deepEqual(auditLog(shop.events, db, vocab, opts).findings, []);
  const flinch = shop.events.find((e) => e.type === 'reflex' && e.data['reflex'] === 'flinch_hot')?.seq;
  const learned = shop.events.find((e) => e.type === 'reflex_learned')?.seq;
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[] }[] = [
    { name: '손을 뗀 반사를 지움', mutate: (es) => es.filter((e) => e.seq !== flinch) },
    { name: '손을 뗀 반사를 다른 반사로 고침', mutate: (es) => es.map((e) => (e.seq === flinch ? { ...e, data: { ...e.data, reflex: 'hold_breath' } } : e)) },
    { name: '조건반사 배움을 지움', mutate: (es) => es.filter((e) => e.seq !== learned) },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(shop.events)), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === 'awareness'), `${c.name}: 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
  assert.ok(byName('하루씨').startsWith('CHR'));
});
