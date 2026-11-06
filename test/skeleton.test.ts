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

test('뼈대 하루는 시나리오의 단계마다 판 하나와 한 줄을 낸다', () => {
  const scenario = parseScenario(JSON.parse(readFileSync(join(ROOT, SKELETON_SCENARIO), 'utf8')));
  const trace = skeletonDay(ROOT, vocab);
  assert.deepEqual(trace.steps.map((s) => s.t), scenario.steps);
  for (const s of trace.steps) {
    assert.deepEqual(Object.keys(s.values), NAMESPACES);
    assert.equal(s.lines.length, 1);
  }
});

test('같은 입력이면 같은 기록이 나온다', () => {
  assert.equal(serializeTrace(skeletonDay(ROOT, vocab)), serializeTrace(skeletonDay(ROOT, vocab)));
});

test('시나리오의 시작 상태가 세계 상태에 들어 있다', () => {
  const first = skeletonDay(ROOT, vocab).steps[0];
  assert.ok(first);
  assert.deepEqual(first.values['world.state'], { 'OBJ000001#1|body:rot': 'spoiled' });
});

test('골든 파일은 저장소에 있고 비어 있지 않다', () => {
  assert.ok(readFileSync(join(ROOT, SKELETON_GOLDEN), 'utf8').length > 100);
});

test('거부: 이유 없는 시나리오', () => {
  assert.throws(() => parseScenario({ patch: 'p', seed: 1, spawn: [], set: [], steps: [] }), /why/);
});

test('거부: 시나리오의 단계 시각이 정수(분)가 아니다', () => {
  assert.throws(() => parseScenario({ why: 'w', patch: 'p', seed: 1, spawn: [], set: [], steps: [1.5] }), /steps는 0 이상의 정수/);
});
