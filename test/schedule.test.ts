// 시간 모델 (docs/결정-기록.md 4장): 보지 않는 시간은 일정한 간격 + 경계, 보는 시간은 행동이 끝날 때만
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAYERS, NAMESPACES, OWNER } from '../src/core/board.ts';
import { Rng } from '../src/core/rng.ts';
import { nextStepTime, OBSERVED, parsePlan, presenceAt, ScheduleError, UNOBSERVED_STEP_MIN } from '../src/core/schedule.ts';
import { runDay } from '../src/core/step.ts';
import type { Layer, LayerContext } from '../src/core/step.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

const OUT = { kind: 'out', from: 510, to: 1170 };
const SLEEP = { kind: 'asleep', from: 1380, to: 1860 };
const plan = parsePlan({ blocks: [OUT, SLEEP] }, vocab);

/** 시각 now부터 end까지 단계 시각을 모은다. */
function steps(now: number, end: number, actionEnds: number[] = [], stepMin?: number): number[] {
  const out = [now];
  let t: number | null = now;
  while ((t = nextStepTime(plan, t, end, actionEnds, stepMin)) !== null) out.push(t);
  return out;
}

function rejects(fn: () => unknown, match: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof ScheduleError && match.test(e.message));
}

test('간격은 3시간(임시값)이다', () => {
  assert.equal(UNOBSERVED_STEP_MIN, 180);
});

test('사전에 presence 세 종류가 있다 (집에 있음 · 외출 · 잠)', () => {
  for (const k of ['home', 'out', 'asleep']) assert.equal(vocab.has('presence', k), true, k);
  assert.equal(OBSERVED, 'home');
});

test('구간 밖은 집에 있음, 구간 안은 그 종류, 끝 시각은 구간 밖이다', () => {
  assert.equal(presenceAt(plan, 509), 'home');
  assert.equal(presenceAt(plan, 510), 'out');
  assert.equal(presenceAt(plan, 1169), 'out');
  assert.equal(presenceAt(plan, 1170), 'home');
  assert.equal(presenceAt(plan, 1500), 'asleep');
});

test('외출 중에는 나간 시각부터 3시간마다, 그리고 귀가 순간에 한 단계', () => {
  assert.deepEqual(steps(510, 1170), [510, 690, 870, 1050, 1170]);
});

test('집에 있는 동안은 행동이 끝날 때만 돈다 (행동이 없으면 다음 경계까지 건너뛴다)', () => {
  assert.deepEqual(steps(1170, 1380), [1170, 1380]);
  assert.deepEqual(steps(1170, 1380, [1200, 1290]), [1170, 1200, 1290, 1380]);
});

test('외출·잠 중에 끝나는 행동은 단계를 만들지 않는다 (보지 않는 시간)', () => {
  assert.deepEqual(steps(510, 1170, [600]), [510, 690, 870, 1050, 1170]);
});

test('간격은 구간 시작에 맞춰진다: 중간에서 시작해도 같은 격자를 탄다', () => {
  assert.equal(nextStepTime(plan, 700, 1860), 870);
});

test('끝 시각에도 한 단계를 돌고, 그 뒤는 없다', () => {
  assert.equal(nextStepTime(plan, 1740, 1860), 1860);
  assert.equal(nextStepTime(plan, 1860, 1860), null);
});

test('간격을 바꾸면 단계 수만 달라지고 경계는 그대로다', () => {
  const two = steps(510, 1170, [], 120);
  assert.deepEqual(two, [510, 630, 750, 870, 990, 1110, 1170]);
  assert.ok([510, 1170].every((t) => two.includes(t)));
});

test('일정이 비어 있으면(중립값) 시작과 끝만 돈다', () => {
  assert.deepEqual(parsePlan({}, vocab), []);
  assert.equal(nextStepTime([], 0, 600), 600);
});

test('runDay: 시계는 직전 단계의 일정(F5)을 읽어 다음 시각을 정한다', () => {
  const layers: Layer[] = LAYERS.map((id) => ({
    id,
    run: (c: LayerContext) => {
      for (const ns of NAMESPACES) if (OWNER[ns] === id) c.write(ns, ns === 'plan' ? { blocks: [OUT] } : {});
      return id === '8' ? [] : undefined;
    },
  }));
  assert.deepEqual(runDay(layers, 420, 1200, Rng.fromSeed(1), vocab).map((r) => r.board.t), [420, 510, 690, 870, 1050, 1170, 1200]);
});

// ---- 거부 ----

test('거부: 사전에 없는 일정 종류', () => {
  rejects(() => parsePlan({ blocks: [{ kind: 'nap', from: 0, to: 10 }] }, vocab), /사전 presence에 없는 종류다 \(nap\)/);
});

test('거부: home은 구간으로 쓰지 않는다', () => {
  rejects(() => parsePlan({ blocks: [{ kind: 'home', from: 0, to: 10 }] }, vocab), /home는 구간으로 쓰지 않는다/);
});

test('거부: 끝이 시작보다 앞서거나 같은 구간', () => {
  rejects(() => parsePlan({ blocks: [{ kind: 'out', from: 10, to: 10 }] }, vocab), /끝\(10\)이 시작\(10\)보다 뒤여야/);
});

test('거부: 겹치는 구간', () => {
  rejects(() => parsePlan({ blocks: [OUT, { kind: 'asleep', from: 1000, to: 1400 }] }, vocab), /앞 구간과 겹치거나/);
});

test('거부: 정수(분)가 아닌 시각', () => {
  rejects(() => parsePlan({ blocks: [{ kind: 'out', from: 1.5, to: 10 }] }, vocab), /정수\(분\)/);
});

test('거부: 0 이하의 간격', () => {
  rejects(() => nextStepTime(plan, 0, 100, [], 0), /간격은 양의 정수/);
});
