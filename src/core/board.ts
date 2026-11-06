// 품질판 (docs/품질판-명세.md) — 층 사이의 유일한 약속
//
// 한 단계(step)마다 판 하나를 새로 채운다. 층은 정해진 순서로 돌고, 판을 통해서만 주고받는다.
//   - 쓰기: 이름 공간마다 주인 층이 하나다. 주인만 쓰고, 한 단계에 한 번만 쓴다 (2장, 4장).
//   - 읽기: 층마다 읽을 수 있는 이름 공간이 정해져 있다 (3장). 같은 단계의 아래 층 결과만 읽는다.
//   - 되먹임: 위에서 아래로 가는 길은 직전 단계의 판을 읽는 네 길뿐이다 (5장, F1~F4).
//   - 값: 정수, 문자열(키), 참거짓, 그리고 그것들의 목록·객체만 담는다. 부동소수와 null은 넣지 않는다 (2장, 8장).
// 어기면 BoardError를 던진다. 판은 계산하지 않고 약속만 지킨다.

export const LAYERS = ['0', '1', '2', '3', '4a', '4b', '5', '6', '7', '8'] as const;
export type LayerId = (typeof LAYERS)[number];

/** 이름 공간 → 주인 층 (2장). */
export const OWNER = {
  time: '0',
  'world.place': '1',
  'world.state': '2',
  kit: '2',
  'world.stimulus_source': '3',
  ext: '4a',
  plan: '4a',
  self: '4b',
  perceived: '5',
  visible_to_player: '5',
  aware: '5',
  memory: '5',
  recent: '6',
  scene: '7',
} as const satisfies Record<string, LayerId>;

export type Namespace = keyof typeof OWNER;
export const NAMESPACES = Object.keys(OWNER) as Namespace[];

const LINE_A: readonly Namespace[] = ['time', 'world.place', 'world.state', 'kit', 'world.stimulus_source'];
const UP_TO_5: readonly Namespace[] = [...LINE_A, 'ext', 'plan', 'self'];
const ALL_WRITTEN_BEFORE_8: readonly Namespace[] = NAMESPACES;

/** 같은 단계 안에서 층이 읽을 수 있는 이름 공간 (3장). */
export const READS: { readonly [L in LayerId]: readonly Namespace[] } = {
  '0': [],
  '1': ['time'],
  '2': ['time', 'world.place'],
  '3': ['time', 'world.place', 'world.state', 'kit'],
  '4a': ['time'],
  '4b': ['time', 'ext', 'plan'], // 명세의 self 읽기는 직전 단계의 자기 값(이월)이다 → PREV_READS
  '5': UP_TO_5,
  '6': ['world.state', 'kit', 'plan', 'self', 'perceived', 'aware', 'memory'],
  '7': NAMESPACES.filter((n) => n !== 'scene'),
  '8': ALL_WRITTEN_BEFORE_8,
};

/** 직전 단계의 판에서 읽을 수 있는 이름 공간: 되먹임 길 F1~F4 (5장). */
export const PREV_READS: { readonly [L in LayerId]?: readonly Namespace[] } = {
  '2': ['recent'], // F1 행동 → 물체 (효과 요청)
  '4b': ['recent', 'perceived', 'memory', 'self'], // F2 행동 결과 · F3 알아챈 것 · F4 어제의 집 인상 · 자기 이월
};

/** 난수를 받을 수 있는 층 (9장). 0은 생성기를 소유하고 나눠 주기만 한다. */
export const RNG_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>(['4a', '5', '6', '7', '8']);

export type BoardValue = string | number | boolean | readonly BoardValue[] | { readonly [key: string]: BoardValue };

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 판에 넣을 수 있는 값인지 검사하고, 얼린 복사본을 돌려준다. */
export function checkValue(value: unknown, path: string): BoardValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new BoardError(`${path}: 정수만 넣는다 (${value})`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((v, i) => checkValue(v, `${path}[${i}]`)));
  if (isPlainObject(value)) {
    const out: Record<string, BoardValue> = {};
    for (const key of Object.keys(value).sort()) out[key] = checkValue(value[key], `${path}.${key}`);
    return Object.freeze(out);
  }
  throw new BoardError(`${path}: 판에 넣을 수 없는 값이다 (${value === null ? 'null' : typeof value})`);
}

/** 한 단계의 판. 층이 차례로 쓰고, 다 돌면 봉인된다. */
export class Board {
  readonly t: number;
  readonly #values = new Map<Namespace, BoardValue>();
  #sealed = false;

  constructor(t: number) {
    if (!Number.isInteger(t) || t < 0) throw new BoardError(`단계 시각은 0 이상의 정수(분)여야 한다: ${t}`);
    this.t = t;
  }

  has(ns: Namespace): boolean {
    return this.#values.has(ns);
  }

  /** 층의 쓰기. 주인이 아니거나, 이미 썼거나, 봉인된 판이면 던진다. */
  write(layer: LayerId, ns: Namespace, value: unknown): void {
    if (this.#sealed) throw new BoardError(`${layer}층: 봉인된 판에는 쓸 수 없다 (${ns})`);
    if (OWNER[ns] !== layer) throw new BoardError(`${layer}층은 ${ns}에 쓸 수 없다 (주인: ${OWNER[ns]}층). 바꾸려면 효과 요청을 낸다`);
    if (this.#values.has(ns)) throw new BoardError(`${layer}층: ${ns}는 이 단계에 이미 썼다`);
    this.#values.set(ns, checkValue(value, ns));
  }

  /** 같은 단계의 읽기. 읽기 규칙 밖이거나 아직 쓰이지 않았으면 던진다. */
  read(layer: LayerId, ns: Namespace): BoardValue {
    if (!READS[layer].includes(ns)) throw new BoardError(`${layer}층은 ${ns}를 읽을 수 없다 (품질판-명세 3장)`);
    const v = this.#values.get(ns);
    if (v === undefined) throw new BoardError(`${layer}층: ${ns}가 아직 쓰이지 않았다 (주인 ${OWNER[ns]}층이 먼저 돌아야 한다)`);
    return v;
  }

  /** 직전 단계의 판 읽기 (되먹임 길). 첫 단계면 undefined. */
  static readPrev(prev: Board | null, layer: LayerId, ns: Namespace): BoardValue | undefined {
    if (!(PREV_READS[layer] ?? []).includes(ns)) {
      throw new BoardError(`${layer}층은 직전 단계의 ${ns}를 읽을 수 없다 (되먹임 길은 품질판-명세 5장의 네 가지뿐)`);
    }
    return prev === null ? undefined : prev.#values.get(ns);
  }

  seal(): void {
    const missing = NAMESPACES.filter((ns) => !this.#values.has(ns));
    if (missing.length > 0) throw new BoardError(`단계를 마쳤는데 쓰이지 않은 이름 공간: ${missing.join(', ')}`);
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  /** 정규 순서의 사본 (골든 트레이스용). */
  snapshot(): { readonly t: number; readonly values: { readonly [ns: string]: BoardValue } } {
    const values: Record<string, BoardValue> = {};
    for (const ns of NAMESPACES) {
      const v = this.#values.get(ns);
      if (v !== undefined) values[ns] = v;
    }
    return { t: this.t, values };
  }
}
