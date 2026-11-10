// 한 단계 돌리기 (docs/품질판-명세.md 1·3·5·9장)
//
// 층은 항상 같은 순서(0 → 1 → 2 → 3 → 4a → 4b → 5 → 6 → 7 → 8)로 돈다. 아홉 층이 모두 있어야 한다.
// 층마다 자기 몫의 손잡이만 받는다: 읽기는 읽기 규칙 안에서, 쓰기는 자기 이름 공간에만,
// 난수는 받을 수 있는 층(4a·5·6·7·8)에만 준다. 1~3층과 4b층에는 난수가 닿을 길이 없다.
// 층은 자기 이름 공간을 매 단계 모두 써야 한다 (할 일이 없으면 중립값을 쓴다). 8층은 쓰지 않고 장면을 낸다.

import { Board, BoardError, LAYERS, OWNER, RNG_LAYERS } from './board.ts';
import type { BoardValue, LayerId, Namespace } from './board.ts';
import type { Rng } from './rng.ts';
import { parseRecent } from './agency.ts';
import { isObserved, nextStepTime, parsePlan } from './schedule.ts';
import type { Vocab } from './vocab.ts';

export interface LayerContext {
  readonly layer: LayerId;
  /** 단계의 절대 시각(분). */
  readonly t: number;
  read(ns: Namespace): BoardValue;
  /** 직전 단계의 값 (되먹임 길만). 첫 단계면 undefined. */
  prev(ns: Namespace): BoardValue | undefined;
  write(ns: Namespace, value: unknown): void;
  /** 4a·5·6·7·8층만 받는다. 나머지 층에서는 null. */
  readonly rng: Rng | null;
}

export interface Layer {
  readonly id: LayerId;
  /** 8층(표현)만 문장 줄을 돌려준다. 다른 층은 판에 쓰고 아무것도 돌려주지 않는다. */
  run(ctx: LayerContext): readonly string[] | void;
}

export interface StepResult {
  readonly board: Board;
  readonly lines: readonly string[];
}

const owned = (layer: LayerId): Namespace[] => (Object.keys(OWNER) as Namespace[]).filter((ns) => OWNER[ns] === layer);

/** 층 목록이 아홉 층을 정확히 한 번씩 갖는지 검사하고, 정해진 순서로 돌려준다. */
export function orderLayers(layers: readonly Layer[]): Layer[] {
  const byId = new Map<LayerId, Layer>();
  for (const l of layers) {
    if (byId.has(l.id)) throw new BoardError(`${l.id}층이 두 번 있다`);
    byId.set(l.id, l);
  }
  const missing = LAYERS.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new BoardError(`빠진 층: ${missing.join(', ')} (뼈대는 아홉 층이 모두 있어야 돈다)`);
  return LAYERS.map((id) => byId.get(id) as Layer);
}

/** 단계 하나를 돌린다. prev는 직전 단계의 판(되먹임 길에만 쓰인다). */
export function runStep(layers: readonly Layer[], t: number, prev: Board | null, rng: Rng): StepResult {
  if (prev !== null && t < prev.t) throw new BoardError(`단계 시각이 거꾸로 간다 (${prev.t} → ${t})`);
  const board = new Board(t);
  let lines: readonly string[] = [];
  for (const layer of orderLayers(layers)) {
    const id = layer.id;
    const ctx: LayerContext = {
      layer: id,
      t,
      read: (ns) => board.read(id, ns),
      prev: (ns) => Board.readPrev(prev, id, ns),
      write: (ns, value) => board.write(id, ns, value),
      rng: RNG_LAYERS.has(id) ? rng : null,
    };
    const out = layer.run(ctx);
    if (out !== undefined && id !== '8') throw new BoardError(`${id}층은 문장을 낼 수 없다 (표현은 8층)`);
    if (id === '8') lines = out ?? [];
    const unwritten = owned(id).filter((ns) => !board.has(ns));
    if (unwritten.length > 0) throw new BoardError(`${id}층이 자기 이름 공간을 쓰지 않았다: ${unwritten.join(', ')} (할 일이 없으면 중립값을 쓴다)`);
  }
  board.seal();
  return { board, lines };
}

/** 여러 단계를 차례로 돌린다. 시각은 거꾸로 가지 않는다. */
export function runSteps(layers: readonly Layer[], times: readonly number[], rng: Rng): StepResult[] {
  const results: StepResult[] = [];
  let prev: Board | null = null;
  for (const t of times) {
    const r = runStep(layers, t, prev, rng);
    results.push(r);
    prev = r.board;
  }
  return results;
}

/**
 * 멈췄다 이어 갈 수 있는 하루 (엔진 입구 · session.ts). 다음 단계 시각은 시계(0층)가 직전 단계의 일정을 읽어 정한다 (F5, schedule.ts).
 * 끝 시각에도 한 단계를 돈다. 한 번에 끝까지 돌리든 나눠 돌리든 단계 시각과 결과가 같다.
 */
export class DayRunner {
  readonly #layers: readonly Layer[];
  readonly #end: number;
  readonly #rng: Rng;
  readonly #vocab: Vocab;
  readonly #stepMin: number | undefined;
  #prev: Board | null = null;
  #next: number | null;

  constructor(layers: readonly Layer[], start: number, end: number, rng: Rng, vocab: Vocab, stepMin?: number) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new BoardError(`하루의 시작과 끝은 0 이상의 정수(분)이고 끝이 시작보다 앞서지 않아야 한다 (${start}, ${end})`);
    }
    this.#layers = layers;
    this.#end = end;
    this.#rng = rng;
    this.#vocab = vocab;
    this.#stepMin = stepMin;
    this.#next = start;
  }

  /** 다음 단계의 시각. 하루가 끝났으면 null. */
  get next(): number | null {
    return this.#next;
  }

  /** 마지막으로 돈 단계의 판. 아직 돌지 않았으면 null. */
  get last(): Board | null {
    return this.#prev;
  }

  /** 시각 until까지(포함) 차례가 된 단계를 모두 돌린다. */
  runUntil(until: number): StepResult[] {
    const results: StepResult[] = [];
    while (this.#next !== null && this.#next <= until) {
      const t: number = this.#next;
      const r = runStep(this.#layers, t, this.#prev, this.#rng);
      results.push(r);
      this.#prev = r.board;
      const ends = parseRecent(Board.readPrev(this.#prev, '0', 'recent')).map((a) => a.ends);
      // F7: 집에 있을 때는 세계가 스스로 바뀌는 시각에도 깨어난다 (외출·잠 중이면 schedule이 거른다)
      const source = Board.readPrev(this.#prev, '0', 'world.stimulus_source');
      const nextChange = typeof source === 'object' && !Array.isArray(source) ? (source as { readonly next_change?: BoardValue }).next_change : undefined;
      if (typeof nextChange === 'number') ends.push(nextChange);
      this.#next = nextStepTime(parsePlan(Board.readPrev(this.#prev, '0', 'plan'), this.#vocab), t, this.#end, ends, this.#stepMin, (p) => isObserved(this.#vocab, p));
    }
    return results;
  }
}

/** 시작부터 끝까지 하루를 한 번에 돌린다 (DayRunner를 끝까지). */
export function runDay(layers: readonly Layer[], start: number, end: number, rng: Rng, vocab: Vocab, stepMin?: number): StepResult[] {
  return new DayRunner(layers, start, end, rng, vocab, stepMin).runUntil(end);
}
