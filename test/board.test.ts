// 품질판과 단계 (docs/품질판-명세.md): 쓰기는 주인만, 읽기는 규칙 안에서, 되먹임은 네 길만, 난수는 정해진 층만
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, BoardError, LAYERS, NAMESPACES, OWNER, READS, RNG_LAYERS, checkValue } from '../src/core/board.ts';
import type { LayerId, Namespace } from '../src/core/board.ts';
import { Rng } from '../src/core/rng.ts';
import { orderLayers, runStep, runSteps } from '../src/core/step.ts';
import type { Layer, LayerContext } from '../src/core/step.ts';

function rejects(fn: () => unknown, match: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof BoardError && match.test(e.message));
}

/** 자기 이름 공간에 중립값만 쓰는 층 아홉 개. 시험마다 한 층을 바꿔 끼운다. */
function neutral(): Layer[] {
  return LAYERS.map((id) => ({
    id,
    run: (c: LayerContext) => {
      for (const ns of NAMESPACES) if (OWNER[ns] === id) c.write(ns, {});
      return id === '8' ? [] : undefined;
    },
  }));
}

function replace(layers: Layer[], layer: Layer): Layer[] {
  return layers.map((l) => (l.id === layer.id ? layer : l));
}

const rng = (): Rng => Rng.fromSeed(7);

test('모든 이름 공간에 주인 층이 있고, 주인은 아홉 층 중 하나다', () => {
  for (const ns of NAMESPACES) assert.ok(LAYERS.includes(OWNER[ns]), ns);
});

test('읽기 규칙은 같은 단계에서 자기보다 앞선 층의 이름 공간만 가리킨다', () => {
  const order = (l: LayerId): number => LAYERS.indexOf(l);
  for (const layer of LAYERS) {
    for (const ns of READS[layer]) assert.ok(order(OWNER[ns]) < order(layer), `${layer}층이 ${ns}(${OWNER[ns]}층)를 읽는다`);
  }
});

test('4b(내면)는 world.*를 읽지 않고, 6(행동)은 자극 원천을 읽지 않는다 (품질판-명세 3장)', () => {
  assert.equal(READS['4b'].some((ns) => ns.startsWith('world.')), false);
  assert.equal(READS['6'].includes('world.stimulus_source'), false);
});

test('중립 층 아홉 개로 단계가 돌고 판이 봉인된다', () => {
  const r = runStep(neutral(), 60, null, rng());
  assert.equal(r.board.sealed, true);
  assert.deepEqual(Object.keys(r.board.snapshot().values), NAMESPACES);
});

test('층은 순서와 상관없이 0 → 8 순서로 돈다', () => {
  const seen: string[] = [];
  const layers = neutral().map((l) => ({ id: l.id, run: (c: LayerContext) => (seen.push(l.id), l.run(c)) }));
  runStep([...layers].reverse(), 0, null, rng());
  assert.deepEqual(seen, [...LAYERS]);
});

// ---- 거부 ----

test('거부: 빠진 층이 있으면 돌지 않는다', () => {
  rejects(() => orderLayers(neutral().filter((l) => l.id !== '5')), /빠진 층: 5/);
});

test('거부: 같은 층이 두 번 있다', () => {
  rejects(() => orderLayers([...neutral(), { id: '3', run: () => undefined }]), /3층이 두 번/);
});

test('거부: 주인이 아닌 층의 쓰기 (6층이 세계 상태를 직접 쓴다)', () => {
  const layers = replace(neutral(), {
    id: '6',
    run: (c) => {
      c.write('recent', []);
      c.write('world.state', {});
    },
  });
  rejects(() => runStep(layers, 0, null, rng()), /6층은 world.state에 쓸 수 없다.*효과 요청/);
});

test('거부: 한 단계에 같은 이름 공간을 두 번 쓴다', () => {
  const layers = replace(neutral(), {
    id: '7',
    run: (c) => {
      c.write('scene', {});
      c.write('scene', {});
    },
  });
  rejects(() => runStep(layers, 0, null, rng()), /scene는 이 단계에 이미 썼다/);
});

test('거부: 읽기 규칙 밖의 읽기 (4b 내면이 세계 상태를 읽는다)', () => {
  const layers = replace(neutral(), { id: '4b', run: (c) => (c.read('world.state'), c.write('self', {})) });
  rejects(() => runStep(layers, 0, null, rng()), /4b층은 world.state를 읽을 수 없다/);
});

test('거부: 아직 쓰이지 않은 이름 공간을 읽는다', () => {
  const b = new Board(0);
  rejects(() => b.read('1', 'time'), /time가 아직 쓰이지 않았다/);
});

test('거부: 되먹임 길이 아닌 직전 단계 읽기 (3층이 직전 행동을 읽는다)', () => {
  const layers = replace(neutral(), { id: '3', run: (c) => (c.prev('recent'), c.write('world.stimulus_source', {})) });
  rejects(() => runStep(layers, 0, null, rng()), /3층은 직전 단계의 recent를 읽을 수 없다/);
});

test('되먹임 길: 2층은 직전 단계의 행동을 읽는다 (첫 단계에서는 없다)', () => {
  const seen: unknown[] = [];
  const layers = replace(
    replace(neutral(), {
      id: '2',
      run: (c) => {
        seen.push(c.prev('recent'));
        c.write('world.state', {});
        c.write('kit', {});
      },
    }),
    { id: '6', run: (c) => c.write('recent', ['L000001']) },
  );
  runSteps(layers, [0, 10], rng());
  assert.deepEqual(seen, [undefined, ['L000001']]);
});

test('거부: 층이 자기 이름 공간을 쓰지 않았다 (할 일이 없으면 중립값)', () => {
  const layers = replace(neutral(), { id: '5', run: (c) => c.write('perceived', []) });
  rejects(() => runStep(layers, 0, null, rng()), /5층이 자기 이름 공간을 쓰지 않았다: visible_to_player, aware, memory/);
});

test('거부: 8층이 아닌 층이 문장을 낸다', () => {
  const layers = replace(neutral(), { id: '7', run: (c) => (c.write('scene', {}), ['문장']) });
  rejects(() => runStep(layers, 0, null, rng()), /7층은 문장을 낼 수 없다/);
});

test('거부: 단계 시각이 거꾸로 간다', () => {
  rejects(() => runSteps(neutral(), [100, 50], rng()), /단계 시각이 거꾸로/);
});

test('거부: 판에 부동소수, null, 함수를 넣는다', () => {
  rejects(() => checkValue({ a: 1.5 }, 'ns'), /ns.a: 정수만/);
  rejects(() => checkValue([null], 'ns'), /ns\[0\]: 판에 넣을 수 없는 값이다 \(null\)/);
  rejects(() => checkValue({ f: () => 1 }, 'ns'), /판에 넣을 수 없는 값이다 \(function\)/);
});

test('거부: 봉인된 판에는 쓸 수 없다', () => {
  const r = runStep(neutral(), 0, null, rng());
  rejects(() => r.board.write('7', 'scene', {}), /봉인된 판/);
});

test('난수는 4a·5·6·7·8층만 받는다 (1~3층과 4b층에는 닿지 않는다)', () => {
  const got = new Map<string, boolean>();
  const layers = neutral().map((l) => ({ id: l.id, run: (c: LayerContext) => (got.set(l.id, c.rng !== null), l.run(c)) }));
  runStep(layers, 0, null, rng());
  for (const id of LAYERS) assert.equal(got.get(id), RNG_LAYERS.has(id), `${id}층`);
  for (const id of ['1', '2', '3', '4b'] as const) assert.equal(got.get(id), false, `${id}층에 난수가 닿았다`);
});

test('판의 사본은 이름 공간 순서와 키 순서가 정해져 있다', () => {
  const layers = replace(neutral(), { id: '4b', run: (c) => c.write('self', { b: 1, a: 2 }) });
  const snap = runStep(layers, 0, null, rng()).board.snapshot();
  assert.equal(JSON.stringify(snap.values['self']), '{"a":2,"b":1}');
  assert.deepEqual(Object.keys(snap.values), NAMESPACES as Namespace[]);
});
