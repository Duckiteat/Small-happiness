// 밖의 하루 (outside.ts): 귀가할 때 그날의 요약 카드를 뽑아(개입) 내면에 반영한다(인과)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent, JsonValue } from '../src/core/events.ts';
import { cardChanges, cardDefs, cardRange, drawCards } from '../src/core/outside.ts';
import { Rng } from '../src/core/rng.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { loadDb, scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOCAB_DIR = join(ROOT, 'data', 'vocab');
const vocab = loadVocabDir(VOCAB_DIR);
const db = loadDb(ROOT);
const WHO = 'CHR000001#1';
const mind = db.defs['CHR000001']?.mind;
const KEYS = ['mood:pleasure', 'mood:displeasure', 'mood:stability', 'condition:reserve', 'condition:energy', 'condition:tension'].map((k) => `${WHO}|${k}`);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const state = (s: Record<string, string>): ((key: string) => string) => {
  const base: Record<string, string> = { 'mood:pleasure': 'none', 'mood:displeasure': 'none', 'mood:stability': 'steady', 'condition:reserve': 'usual', 'condition:energy': 'full', 'condition:tension': 'none' };
  return (key) => s[key.slice(key.indexOf('|') + 1)] ?? base[key.slice(key.indexOf('|') + 1)] ?? '';
};
const show = (cs: readonly { key: string; to: string }[]): string[] => cs.map((c) => `${c.key.slice(c.key.indexOf('|') + 1)}=${c.to}`);

const WEEK = 'content/scenarios/first-week.json';
const weekRaw = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, WEEK), 'utf8')) as Record<string, unknown>;
const run = (r: Record<string, unknown>): { events: GameEvent[]; start: number; db: ReturnType<typeof scenarioDb> } => {
  const sc = parseScenario(r);
  const sdb = scenarioDb(ROOT, vocab, sc);
  return { events: runScenario(sdb, vocab, sc).log.map(parseEvent), start: sc.start, db: sdb };
};
const week = run(weekRaw());
const days = (es: readonly GameEvent[]): GameEvent[] => es.filter((e) => e.type === 'outside_day_done');

test('사전: 카드 다섯 장, 출근(외출) 구간이 끝나면 1~2장, 잠·집에서는 뽑지 않는다', () => {
  assert.deepEqual(cardDefs(vocab).map((c) => c.key), ['crowded_commute', 'harsh_word', 'long_meetings', 'praise', 'quiet_day']);
  assert.deepEqual(cardRange(vocab, 'out'), { min: 1, max: 2 });
  assert.equal(cardRange(vocab, 'asleep'), null);
  assert.equal(cardRange(vocab, 'home'), null);
});

test('뽑기는 개입: 같은 시드면 같은 카드, 1~2장, 겹치지 않는다', () => {
  const draw = (seed: number): string[][] => {
    const rng = Rng.fromSeed(seed);
    return Array.from({ length: 20 }, () => drawCards(vocab, { min: 1, max: 2 }, rng));
  };
  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
  for (const cards of draw(3)) {
    assert.ok(cards.length >= 1 && cards.length <= 2);
    assert.equal(new Set(cards).size, cards.length);
  }
  const lengths = new Set(draw(3).map((c) => c.length));
  assert.deepEqual([...lengths].sort(), [1, 2], '한 장인 날도 두 장인 날도 있다');
});

test('카드의 영향은 감정과 같은 규칙: 칭찬은 쾌·여유, 싫은 말은 불쾌와 긴장(여유가 넉넉하면 여유로 버팀, 안심되지 않으면 더), 회의는 에너지와 긴장, 조용한 하루는 없음', () => {
  const ch = (cards: string[], s: Record<string, string> = {}): string[] => show(cardChanges(vocab, mind, WHO, cards, KEYS, state(s)));
  assert.deepEqual(ch(['praise']), ['mood:pleasure=faint', 'condition:reserve=ample']);
  assert.deepEqual(ch(['harsh_word']), ['mood:displeasure=faint', 'condition:tension=slight']);
  assert.deepEqual(ch(['harsh_word'], { 'condition:reserve': 'ample' }), ['mood:displeasure=faint', 'condition:reserve=usual'], '버팀');
  assert.deepEqual(ch(['harsh_word'], { 'mood:stability': 'uneasy' }), ['mood:displeasure=faint', 'condition:tension=built'], '안심되지 않으면 한 칸 더');
  assert.deepEqual(ch(['long_meetings']), ['condition:energy=usual', 'condition:tension=slight']);
  assert.deepEqual(ch(['crowded_commute']), ['condition:energy=usual'], '그저 그런 카드는 적힌 것만');
  assert.deepEqual(ch(['quiet_day']), []);
  assert.deepEqual(ch(['praise', 'harsh_word']), ['mood:pleasure=faint', 'condition:reserve=ample', 'mood:displeasure=faint', 'condition:reserve=usual'], '카드 순서대로: 칭찬으로 생긴 여유가 싫은 말을 버틴다');
});

test('첫 주: 출근한 날마다 귀가하는 순간(외출 구간의 끝) 카드가 정해지고, 바로 뒤에 그 카드가 내면을 움직인다', () => {
  const sc = parseScenario(weekRaw());
  const plan = (sc.routine as { blocks: { kind: string; from: number; to: number }[] }).blocks;
  const outs = plan.filter((b) => b.kind === 'out' && b.to > sc.start && b.to <= sc.end);
  const ds = days(week.events);
  assert.equal(ds.length, outs.length, '출근한 날마다 한 번');
  for (const d of ds) {
    const b = outs.find((x) => x.from === d.data['from']);
    assert.ok(b !== undefined && d.t === b.to, '귀가하는 순간');
    assert.equal(d.cause, null, '뽑기는 개입이라 원인이 없다');
  }
  const moved = week.events.filter((e) => e.type === 'state_changed' && ds.some((d) => d.seq === e.cause));
  assert.ok(moved.length > 0 && moved.every((e) => /\|(mood|condition):/.test(str(e.data['key']))), '영향은 내면으로만');
  assert.deepEqual(days(run(weekRaw()).events).map((e) => e.data['cards']), ds.map((e) => e.data['cards']), '같은 시드면 같은 카드');
  assert.deepEqual(auditLog(week.events, week.db, vocab, { externalUntil: week.start }).findings, []);
});

test('시나리오가 그 구간의 카드를 정해 두면 뽑지 않고 그것을 쓴다', () => {
  const r = weekRaw();
  const first = days(week.events)[0];
  assert.ok(first !== undefined);
  r['outside'] = [{ from: first.data['from'], cards: ['harsh_word', 'long_meetings'] }];
  const out = run(r);
  assert.deepEqual(days(out.events)[0]?.data['cards'], ['harsh_word', 'long_meetings']);
  assert.deepEqual(auditLog(out.events, out.db, vocab, { externalUntil: out.start }).findings, []);
  assert.throws(() => parseScenario({ ...weekRaw(), outside: [{ from: 1 }] }), /outside는/);
});

test('감사: 카드와 그 영향을 다시 맞춰, 고치거나 빠뜨리거나 원인을 지어내면 잡는다', () => {
  const es = week.events;
  const opts = { externalUntil: week.start };
  const d = days(es).find((x) => es.some((e) => e.cause === x.seq));
  assert.ok(d !== undefined);
  const cases: { name: string; mutate: (x: GameEvent[]) => GameEvent[] }[] = [
    { name: '카드를 조용한 하루로 고침', mutate: (x) => x.map((e) => (e.seq === d.seq ? { ...e, data: { ...e.data, cards: ['quiet_day'] } } : e)) },
    { name: '사전에 없는 카드', mutate: (x) => x.map((e) => (e.seq === d.seq ? { ...e, data: { ...e.data, cards: ['lottery'] } } : e)) },
    { name: '카드의 영향을 지움', mutate: (x) => x.filter((e) => e.cause !== d.seq) },
    { name: '뽑기에 원인을 지어냄', mutate: (x) => x.map((e) => (e.seq === d.seq ? { ...e, cause: 'L000001' } : e)) },
  ];
  for (const c of cases) assert.ok(auditLog(c.mutate(structuredClone(es)), week.db, vocab, opts).findings.length > 0, c.name);
});

test('사전: 카드의 결·효과와 뽑는 구간을 검사한다', () => {
  type Entry = { key: string; ko: string; attrs?: { [k: string]: JsonValue } };
  type Category = { category: string; entries: Entry[] };
  const edit = (fn: (raw: Category[]) => void): string => {
    const raw = readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(readFileSync(join(VOCAB_DIR, f), 'utf8')) as Category[]);
    fn(raw);
    const asRaw: VocabCategoryRaw[] = raw;
    return validateVocab(asRaw).map((i) => `${i.path}: ${i.message}`).join('\n');
  };
  const card = (raw: Category[], key: string): { [k: string]: JsonValue } => {
    for (const c of raw) for (const e of c.entries) if (c.category === 'outside_card' && e.key === key && e.attrs !== undefined) return e.attrs;
    throw new Error(key);
  };
  assert.equal(edit(() => undefined), '');
  assert.match(edit((r) => void (card(r, 'praise')['tone'] = 'great')), /tone은/);
  assert.match(edit((r) => void (card(r, 'praise')['shifts'] = { smell: 1 })), /내면 특징이 아니다/);
  assert.match(edit((r) => void (card(r, 'praise')['shifts'] = { pleasure: 3 })), /±1~2/);
  assert.match(
    edit((r) => {
      for (const c of r) for (const e of c.entries) if (c.category === 'presence' && e.key === 'home' && e.attrs !== undefined) e.attrs['cards'] = { min: 1, max: 2, tuned: false };
    }),
    /보지 않는 구간에서만/,
  );
  assert.match(
    edit((r) => {
      for (const c of r) for (const e of c.entries) if (c.category === 'presence' && e.key === 'out' && e.attrs !== undefined) e.attrs['cards'] = { min: 2, max: 1, tuned: false };
    }),
    /1 ≤ min ≤ max/,
  );
});
