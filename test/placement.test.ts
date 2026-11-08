// 물건 관계 (docs/물건-관계-명세.md): 받치는 것(on)·담긴 곳(in) 포인터, 순환 거부, 거리·높이·있는 곳, 한 줄 표기, 기록과 영수증.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { EventLog } from '../src/core/log.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { chainPairs, chains, contour, distance, height, parseChain, rootOf, wouldCycle } from '../src/core/placement.ts';
import type { PlaceMap } from '../src/core/placement.ts';
import { parseEvent } from '../src/core/events.ts';
import { printReceipts, verifyReceipts } from '../src/core/receipt.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { World, WorldError } from '../src/core/world.ts';
import { sha256 } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

const parsed = parsePatch({
  format: 'small-happiness-patch', version: 1, why: '시험: 놓임',
  defs: [
    { id: 'PLC+1', names: { ko: '주방' } },
    ...['식탁', '식탁보', '컵', '접시', '물병', '물'].map((n, i) => ({ id: `OBJ+${i + 1}`, names: { ko: n }, mobility: 'portable' })),
  ],
});
assert.ok(parsed.patch);
const db: Db = mergePatch(emptyDb(), parsed.patch, vocab).db;
const [KITCHEN, TABLE, CLOTH, CUP, PLATE, BOTTLE, WATER] = ['PLC000001', 'OBJ000001', 'OBJ000002', 'OBJ000003', 'OBJ000004', 'OBJ000005', 'OBJ000006'];
const I = (d: string): string => `${d}#1`;

function world(): { w: World; log: EventLog } {
  const log = new EventLog({ isKnownType: (t) => vocab.has('event_type', t) });
  const w = new World(db, vocab, log);
  for (const d of [KITCHEN, TABLE, CLOTH, CUP, PLATE, BOTTLE, WATER]) w.spawn(d, { t: 0 });
  return { w, log };
}

function stacked(): { w: World; log: EventLog } {
  const x = world();
  // 주방 ^ 식탁 ^ 식탁보 ^ (컵, 접시), 물병 안에 물, 물병은 식탁 위
  for (const [above, below] of [[TABLE, KITCHEN], [CLOTH, TABLE], [CUP, CLOTH], [PLATE, CLOTH], [BOTTLE, TABLE]] as const) x.w.place(I(above), 'on', I(below), { t: 1 });
  x.w.place(I(WATER), 'in', I(BOTTLE), { t: 1 });
  return x;
}

test('놓임: 받치는 것·담긴 곳은 사건으로만 바뀌고, 같은 값이면 사건이 없다', () => {
  const { w, log } = world();
  assert.equal(w.place(I(CLOTH), 'on', I(TABLE), { t: 1 })?.type, 'placed');
  assert.equal(w.place(I(CLOTH), 'on', I(TABLE), { t: 2 }), null);
  assert.deepEqual(w.placeOf(I(CLOTH)), { on: I(TABLE) });
  w.place(I(CLOTH), 'on', null, { t: 3 });
  assert.equal(w.placeOf(I(CLOTH))?.on, undefined);
  assert.deepEqual(log.effective().filter((e) => e.type === 'placed').map((e) => e.data['to']), [I(TABLE), null]);
});

test('놓임: 없는 개체·자기 자신·순환은 거부한다 (받치는 것과 담긴 곳을 모두 따라가며 본다)', () => {
  const { w } = stacked();
  assert.throws(() => w.place('OBJ000099#1', 'on', I(TABLE), { t: 2 }), /없는 인스턴스/);
  assert.throws(() => w.place(I(CUP), 'on', 'OBJ000099#1', { t: 2 }), /가리키는 인스턴스가 없다/);
  assert.throws(() => w.place(I(CUP), 'on', I(CUP), { t: 2 }), /자기 자신/);
  assert.throws(() => w.place(I(TABLE), 'on', I(CUP), { t: 2 }), WorldError); // 식탁 → 컵 → 식탁보 → 식탁
  assert.throws(() => w.place(I(BOTTLE), 'in', I(WATER), { t: 2 }), /순환/); // 물병 ⊂ 물 ⊂ 물병
});

test('놓임: 높이·있는 곳·거리는 포인터에서 계산한다', () => {
  const { w } = stacked();
  const m = w.placeMap();
  assert.equal(height(m, I(CUP)), 3); // 컵 → 식탁보 → 식탁 → 주방
  assert.equal(height(m, I(KITCHEN)), 0);
  assert.equal(w.whereIs(I(WATER)), I(KITCHEN)); // 물 ⊂ 물병 ⊂(위) 식탁 ⊂(위) 주방
  assert.equal(w.distanceBetween(I(CUP), I(TABLE)), 2);
  assert.equal(w.distanceBetween(I(CUP), I(PLATE)), 2); // 같은 식탁보 위
  assert.equal(w.distanceBetween(I(WATER), I(CUP)), 4); // 물 · 물병 · 식탁 · 식탁보 · 컵
  assert.equal(distance(m, I(CUP), 'OBJ000099#1'), null);
});

test('놓임: 기록만으로 같은 놓임을 다시 만든다 (잘못된 사건은 던진다)', () => {
  const { w, log } = stacked();
  w.place(I(PLATE), 'on', I(TABLE), { t: 5 });
  const again = World.fromLog(db, vocab, log);
  assert.deepEqual(again.places(), w.places());
  const bad = new EventLog({ isKnownType: (t) => vocab.has('event_type', t) });
  for (const e of log.effective().filter((x) => !(x.type === 'placed' && x.data['id'] === I(PLATE) && x.data['from'] === null))) bad.append({ t: e.t, type: e.type, src: e.src, cause: e.cause, data: e.data });
  assert.throws(() => World.fromLog(db, vocab, bad), /놓임|지금/); // 앞 놓임이 빠지면 from이 어긋난다
});

test('한 줄 표기: 왼쪽이 아래다. 쌍으로 풀고 포인터에서 같은 줄로 돌아온다 (왕복)', () => {
  assert.deepEqual(parseChain('식탁^식탁보^컵'), ['식탁', '식탁보', '컵']);
  assert.equal(parseChain('식탁^^컵'), null);
  assert.equal(parseChain(''), null);
  assert.deepEqual(chainPairs(['A', 'B', 'C']), [{ below: 'A', above: 'B' }, { below: 'B', above: 'C' }]);
  const { w } = stacked();
  const lines = chains(w.placeMap()).map((p) => p.join('^'));
  assert.deepEqual(lines, [`${I(KITCHEN)}^${I(TABLE)}^${I(CLOTH)}^${I(CUP)}`, `${I(KITCHEN)}^${I(TABLE)}^${I(CLOTH)}^${I(PLATE)}`, `${I(KITCHEN)}^${I(TABLE)}^${I(BOTTLE)}`]);
  const rebuilt = new Map<string, { on?: string }>();
  for (const l of lines) for (const { below, above } of chainPairs(parseChain(l) ?? [])) rebuilt.set(above, { on: below });
  for (const [id, p] of rebuilt) assert.equal(w.placeOf(id)?.on, p.on);
});

test('등고선 보기: 한 줄이면 꼭대기까지 갔다 내려오고, 같은 물건 사이의 ^ 수가 거리다', () => {
  assert.equal(contour(['식탁', '식탁보', '컵']).join('^'), '식탁^식탁보^컵^식탁보^식탁');
  assert.equal(contour(['식탁']).join('^'), '식탁');
  const m: PlaceMap = new Map([['b', { on: 'a' }], ['c', { on: 'b' }]]);
  assert.equal(distance(m, 'a', 'c'), 2);
  assert.equal(wouldCycle(m, 'a', 'c'), true);
  assert.equal(rootOf(m, 'c'), 'a');
});

test('시나리오: layout과 contain으로 처음 놓임을 세우고, 영수증이 놓임을 마감에 담아 검증된다', () => {
  const sc = parseScenario({
    why: '시험', use_db: true, seed: 1, start: 0, end: 60, routine: { blocks: [{ kind: 'meal', from: 0, to: 60 }] },
    spawn: [KITCHEN, TABLE, CLOTH, CUP], set: [],
    layout: [`${I(KITCHEN)}^${I(TABLE)}^${I(CLOTH)}^${I(CUP)}`], contain: [],
  });
  const trace = runScenario(db, vocab, sc);
  const placed = trace.log.filter((e) => (e as { type: string }).type === 'placed');
  assert.equal(placed.length, 3);
  const first = trace.steps[0]?.values['world.place'] as { layout?: Record<string, { on?: string }> };
  assert.equal(first.layout?.[I(CUP)]?.on, I(CLOTH));
  const run = { scenario: 't', scenario_sha256: 'a', content_sha256: 'b', seed: 1, start: 0, end: 60 };
  const rs = printReceipts(trace.log.map(parseEvent), run, sha256);
  assert.equal(verifyReceipts(rs, sha256).ok, true);
  assert.equal(rs.at(-1)?.close.place?.[I(CUP)]?.on, I(CLOTH));
  assert.throws(() => parseScenario({ why: 'x', use_db: true, seed: 1, start: 0, end: 1, routine: {}, spawn: [], set: [], layout: ['A^^B'] }), /layout/);
});
