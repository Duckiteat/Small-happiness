import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Rng } from '../src/core/rng.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function take(r: Rng, n: number): number[] {
  return Array.from({ length: n }, () => r.next32());
}

test('같은 시드는 같은 수열, 다른 시드는 다른 수열', () => {
  assert.deepEqual(take(Rng.fromSeed(42), 20), take(Rng.fromSeed(42), 20));
  assert.notDeepEqual(take(Rng.fromSeed(42), 20), take(Rng.fromSeed(43), 20));
});

test('시드 0도 멈추지 않는다', () => {
  const xs = take(Rng.fromSeed(0), 10);
  assert.ok(new Set(xs).size > 1);
});

test('상태를 저장하고 복원하면 이어서 같은 수열이 나온다', () => {
  const a = Rng.fromSeed(7);
  take(a, 13);
  const saved = a.state();
  const rest = take(a, 25);
  assert.deepEqual(take(Rng.restore(saved), 25), rest);
});

test('복원은 잘못된 상태를 거부한다', () => {
  assert.throws(() => Rng.restore([0, 0, 0, 0]), /모두 0/);
  assert.throws(() => Rng.restore([1, 2, 3, -1]), /정수 네 개/);
  assert.throws(() => Rng.restore([1.5, 2, 3, 4]), /정수 네 개/);
});

test('int: 범위 안이고 모든 값이 나온다', () => {
  const r = Rng.fromSeed(1);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const v = r.int(6);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 6);
    seen.add(v);
  }
  assert.equal(seen.size, 6);
  assert.throws(() => r.int(0), /양의 정수/);
  assert.throws(() => r.int(1.5), /양의 정수/);
});

test('uniform: 0 이상 1 미만', () => {
  const r = Rng.fromSeed(2);
  for (let i = 0; i < 1000; i++) {
    const u = r.uniform();
    assert.ok(u >= 0 && u < 1);
  }
});

test('chance: 0과 1은 확정이고, 1/4 는 허용 오차 안에서 맞다', () => {
  const r = Rng.fromSeed(3);
  for (let i = 0; i < 100; i++) {
    assert.equal(r.chance(0, 5), false);
    assert.equal(r.chance(5, 5), true);
  }
  let hit = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (r.chance(1, 4)) hit++;
  assert.ok(Math.abs(hit / N - 0.25) < 0.02, `1/4 확률의 실제 비율 ${hit / N}`);
  assert.throws(() => r.chance(6, 5), /분자/);
});

test('pick: 가중치 분포가 허용 오차 안이고 0 가중치는 뽑히지 않는다', () => {
  const r = Rng.fromSeed(4);
  const weights = [1, 0, 3, 6];
  const counts = [0, 0, 0, 0];
  const N = 30000;
  for (let i = 0; i < N; i++) {
    const k = r.pick(weights);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  assert.equal(counts[1], 0);
  const total = weights.reduce((a, b) => a + b, 0);
  for (const [k, w] of weights.entries()) {
    assert.ok(Math.abs((counts[k] ?? 0) / N - w / total) < 0.02, `위치 ${k}: ${(counts[k] ?? 0) / N}`);
  }
  assert.throws(() => r.pick([]), /비어/);
  assert.throws(() => r.pick([0, 0]), /합이 0/);
  assert.throws(() => r.pick([1, -1]), /0 이상 정수/);
});

test('변화 규칙 모듈은 난수 모듈을 가져오지 않는다 (인과는 난수가 없다)', () => {
  for (const file of ['statekey.ts', 'chains.ts', 'meaning.ts', 'gate.ts', 'compile.ts']) {
    const text = readFileSync(join(ROOT, 'src', 'core', file), 'utf8');
    assert.doesNotMatch(text, /from\s+['"]\.\/rng\.ts['"]/, `${file}이 rng.ts를 가져온다`);
  }
});
