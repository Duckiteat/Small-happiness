// 뼈대 하루 (docs/기획서.md 10장): 아홉 층이 모두 돌고, 같은 입력이면 같은 기록이 나오며, 골든 트레이스와 바이트까지 같다
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NAMESPACES } from '../src/core/board.ts';
import { parseScenario, serializeTrace } from '../src/core/skeleton.ts';
import { golden, SKELETON_GOLDEN, SKELETON_SCENARIO, skeletonDay } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

test('골든 트레이스: 뼈대 하루가 기록된 결과와 바이트까지 같다 (바뀌면 결정 기록 + golden --write)', () => {
  assert.equal(golden(ROOT, vocab, 'check').ok, true);
});

test('뼈대 하루의 단계는 시간 모델대로 잡힌다: 외출·잠은 3시간마다, 경계(나감·귀가·잠듦·기상)는 항상', () => {
  const scenario = parseScenario(JSON.parse(readFileSync(join(ROOT, SKELETON_SCENARIO), 'utf8')));
  const trace = skeletonDay(ROOT, vocab);
  // 하루마다: 07:00 기상 · 08:30 나감 · 11:30 14:30 17:30 · 19:30 귀가 · 23:00 잠듦 · 02:00 05:00 (이틀, 셋째 날 07:00 끝)
  // 둘째 날 아침에는 행동이 끝나는 시각(07:05 살피기 끝, 07:10 버리기 끝)에도 돈다
  const day = [420, 510, 690, 870, 1050, 1170, 1380, 1560, 1740];
  const day2 = day.map((t) => t + 1440);
  assert.deepEqual(trace.steps.map((s) => s.t), [...day, day2[0], 1865, 1870, ...day2.slice(1), 3300]);
  assert.equal(trace.steps.at(-1)?.t, scenario.end);
  for (const s of trace.steps) {
    assert.deepEqual(Object.keys(s.values), NAMESPACES);
    assert.equal(s.lines.length, 1);
  }
});

test('같은 입력이면 같은 기록이 나온다', () => {
  assert.equal(serializeTrace(skeletonDay(ROOT, vocab)), serializeTrace(skeletonDay(ROOT, vocab)));
});

test('신선한 음식에서 시작해 세계가 스스로 변하고, 하루씨가 버린 뒤로는 벌레가 없다 (손대지 않을 때 번지는 것은 causal.test)', () => {
  const steps = skeletonDay(ROOT, vocab).steps;
  const first = steps.at(0);
  const last = steps.at(-1);
  assert.ok(first && last);
  assert.deepEqual(first.values['world.state'], {});
  assert.match(first.lines.join(''), /집에 있음 .*\| 변화 없음/);
  const finalState = last.values['world.state'] as Record<string, string>;
  assert.equal(finalState['OBJ000001#1|body:rot'], 'gone');
  assert.equal(finalState['PLC000002#1|space:bug'], undefined);
  assert.match(last.lines.join(''), /음식 상함=소멸/);
});

test('골든 파일은 저장소에 있고 비어 있지 않다', () => {
  assert.ok(readFileSync(join(ROOT, SKELETON_GOLDEN), 'utf8').length > 100);
});

test('거부: 이유 없는 시나리오', () => {
  assert.throws(() => parseScenario({ patches: ['p'], seed: 1, spawn: [], set: [], start: 0, end: 0, routine: {} }), /why/);
});

test('거부: 시나리오의 끝이 시작보다 앞선다', () => {
  assert.throws(() => parseScenario({ why: 'w', patches: ['p'], seed: 1, spawn: [], set: [], start: 100, end: 50, routine: {} }), /start와 end/);
});

test('거부: 패치가 없는 시나리오', () => {
  assert.throws(() => parseScenario({ why: 'w', patches: [], seed: 1, spawn: [], set: [], start: 0, end: 0, routine: {} }), /patches/);
});
