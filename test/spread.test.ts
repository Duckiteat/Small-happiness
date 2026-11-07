// 공간과 번짐 (docs/번짐-명세.md · 결정-기록 "공간과 번짐 1차"): 장소의 상태가 통로를 따라 이웃 장소로 번진다.
// 투과율의 곱과 칸마다의 감쇠로 약해지고, 닫힌 문이 막고, 칸마다 걸리는 시간 뒤에 닿으며, 원천이 약해지면 따라 약해진다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Causal } from '../src/core/causal.ts';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { runGate } from '../src/core/gate.ts';
import { EventLog } from '../src/core/log.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { placeGraph, spreadRules } from '../src/core/spread.ts';
import { World } from '../src/core/world.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

// 시험용 집: A가 원천 (규칙이 A의 냄새·벌레를 바꾼다), B는 A와 열린 통로, D는 B와 열린 통로 (A에서 두 칸), C는 A와 닫힌 문.
const space = { space: { features: ['smell', 'bug'] } };
const open = (to: string): object => ({ to, kind: 'open', medium_pass: { air: 1000, self_move: 1000 }, tuned: false });
const door = (to: string): object => ({ to, kind: 'door', medium_pass: { air: 100, self_move: 0 }, tuned: false });
const db: Db = (() => {
  const parsed = parsePatch({
    format: 'small-happiness-patch',
    version: 1,
    why: '번짐 시험용 집',
    defs: [
      { id: 'OBJ+1', names: { ko: '시험 통' }, mobility: 'portable', slots: { body: { features: ['smell'] } } },
      {
        id: 'PLC+1', names: { ko: '가' }, slots: space, passages: [open('PLC+2'), door('PLC+3')],
        rules: {
          smell_src: { on: ['OBJ+1|body:smell@>=foul'], emits: ['PLC+1|space:smell@>=foul'] },
          bug_src: { on: ['OBJ+1|body:smell@>=foul'], emits: ['PLC+1|space:bug@>=few'] },
        },
      },
      { id: 'PLC+2', names: { ko: '나' }, slots: space, passages: [open('PLC+4')] },
      { id: 'PLC+3', names: { ko: '다' }, slots: space },
      { id: 'PLC+4', names: { ko: '라' }, slots: space },
    ],
  });
  assert.ok(parsed.patch);
  const merged = mergePatch(emptyDb(), parsed.patch, vocab);
  const gate = runGate(emptyDb(), merged.db, vocab, merged.report.errors);
  assert.equal(gate.pass, true, gate.reason);
  return merged.db;
})();
const [A, B, C, D] = ['PLC000001', 'PLC000002', 'PLC000003', 'PLC000004'];

function house(): { world: World; causal: Causal; at: (t: number) => void; set: (t: number, place: string, feature: string, level: string) => void; level: (place: string, feature: string) => string } {
  const log = new EventLog({ isKnownType: (type) => vocab.has('event_type', type) });
  const world = new World(db, vocab, log);
  for (const def of ['OBJ000001', A, B, C, D]) world.spawn(def, { t: 0 });
  const causal = new Causal(db, vocab, log, 0);
  return {
    world,
    causal,
    at: (t) => causal.advance(world, t),
    set: (t, place, feature, level) => {
      causal.advance(world, t);
      world.set(`${place}#1|space:${feature}`, level, { t });
      causal.advance(world, t);
    },
    level: (place, feature) => world.level(`${place}#1|space:${feature}`),
  };
}

test('번짐(냄새): 열린 통로는 칸마다 약해져 닿고, 닫힌 문은 막고, 원천이 약해지면 곧바로 따라 약해진다', () => {
  const h = house();
  h.set(10, A, 'smell', 'foul');
  assert.deepEqual([B, D, C].map((p) => h.level(p, 'smell')), ['distinct', 'distinct', 'none'], '지독함 → 한 칸 뚜렷함(5−1, 잠긴 칸 아래로), 두 칸 뚜렷함(5−2), 문 너머 없음(5×100/1000)');
  h.set(20, A, 'smell', 'distinct');
  assert.deepEqual([B, D, C].map((p) => h.level(p, 'smell')), ['faint', 'faint', 'none']);
  h.set(30, A, 'smell', 'faint');
  assert.deepEqual([B, D, C].map((p) => h.level(p, 'smell')), ['none', 'none', 'none'], '은은함은 한 칸만 가도 사라진다');
});

test('번짐(벌레): 칸마다 hop_s 뒤에 닿고, 자력 이동이 0인 닫힌 문은 막으며, 원천에서 사라지면 같은 시간 뒤 사라진다', () => {
  const hop = 360; // 사전 insect.hop_s 21600초 (tuned:false)
  const h = house();
  h.set(100, A, 'bug', 'few');
  h.at(100 + hop - 1);
  assert.equal(h.level(B, 'bug'), 'none', '아직 닿지 않았다');
  h.at(100 + hop);
  assert.equal(h.level(B, 'bug'), 'few');
  assert.equal(h.level(D, 'bug'), 'none');
  h.at(100 + 2 * hop);
  assert.equal(h.level(D, 'bug'), 'few', '두 칸이면 두 배의 시간');
  h.at(100 + 10 * hop);
  assert.equal(h.level(C, 'bug'), 'none', '닫힌 문은 벌레를 막는다');
  h.set(5000, A, 'bug', 'none');
  h.at(5000 + hop);
  assert.equal(h.level(B, 'bug'), 'none');
  assert.equal(h.level(D, 'bug'), 'few', '먼 곳은 한 칸 더 늦게');
  h.at(5000 + 2 * hop);
  assert.equal(h.level(D, 'bug'), 'none');
});

test('실제 집: 여섯 장소가 통로로 모두 이어지고, 주방 냄새는 현관(열린 통로)에만 은은하게 번진다', () => {
  const real = loadDb(ROOT);
  const g = placeGraph(real);
  assert.equal(g.size, 6);
  for (const [, edges] of g) assert.ok(edges.length > 0, '고립된 장소가 없다');
  const owners = new Set(spreadRules(real, vocab).map((r) => real.defs[r.owner]?.names.ko));
  assert.deepEqual([...owners], ['현관'], '문이 모두 닫혀 있어(문 자동 규칙 보류) 주방 냄새는 현관에만 닿는다. 현관에는 벌레 특징이 없다');
});
