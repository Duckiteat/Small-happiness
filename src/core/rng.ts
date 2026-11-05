// 난수 (docs/기반층-명세.md 2장)
//
// 시드를 주입하는 작은 생성기(xoshiro128**). 쓰는 곳은 이벤트 발생, 행동 판정, 문장 조각 선택뿐이다.
// 변화 규칙(chains·meaning·gate·statekey)은 이 모듈을 가져오지 않는다 — 시험이 소스 수준에서 확인한다.
// 확률은 정수 분자·분모로 받는다. 확률 결과는 예약 시점에 뽑아 저장하고 발동 시점에 다시 뽑지 않는다.

export type RngState = readonly [number, number, number, number];

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** 32비트 정수 시드를 네 개의 상태 값으로 펼친다 (splitmix32). */
function expandSeed(seed: number): [number, number, number, number] {
  let a = seed | 0;
  const next = (): number => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
  return [next(), next(), next(), next()];
}

function assertPositiveInt(n: number, name: string): void {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`${name}은 양의 정수여야 한다: ${n}`);
}

export class Rng {
  #s: [number, number, number, number];

  private constructor(state: [number, number, number, number]) {
    this.#s = state;
  }

  static fromSeed(seed: number): Rng {
    if (!Number.isInteger(seed)) throw new RangeError(`시드는 정수여야 한다: ${seed}`);
    const s = expandSeed(seed);
    if (s.every((v) => v === 0)) s[0] = 1; // 모두 0이면 생성기가 멈춘다
    return new Rng(s);
  }

  static restore(state: RngState): Rng {
    if (state.length !== 4 || !state.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)) {
      throw new RangeError('난수 상태는 0~2^32-1 정수 네 개여야 한다');
    }
    if (state.every((v) => v === 0)) throw new RangeError('난수 상태가 모두 0이다');
    return new Rng([state[0], state[1], state[2], state[3]]);
  }

  /** 저장용 상태. 복원하면 같은 수열이 이어진다. */
  state(): RngState {
    return [this.#s[0], this.#s[1], this.#s[2], this.#s[3]];
  }

  /** 0 이상 2^32 미만의 정수. */
  next32(): number {
    const s = this.#s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** 0 이상 1 미만. 상태 값에는 쓰지 않는다 (문장 변주 같은 표현에만). */
  uniform(): number {
    return this.next32() / 0x100000000;
  }

  /** 0 이상 n 미만의 정수. 나머지 편향이 없도록 거부 추출을 쓴다. */
  int(n: number): number {
    assertPositiveInt(n, 'n');
    if (n > 0x100000000) throw new RangeError('n은 2^32 이하여야 한다');
    const limit = 0x100000000 - (0x100000000 % n);
    let x = this.next32();
    while (x >= limit) x = this.next32();
    return x % n;
  }

  /** 확률 num/den 로 참. 0 ≤ num ≤ den. */
  chance(num: number, den: number): boolean {
    assertPositiveInt(den, 'den');
    if (!Number.isInteger(num) || num < 0 || num > den) throw new RangeError(`확률은 0 ≤ 분자 ≤ 분모여야 한다: ${num}/${den}`);
    return this.int(den) < num;
  }

  /** 정수 가중치 목록에서 하나의 위치를 뽑는다. 가중치가 0인 항목은 뽑히지 않는다. */
  pick(weights: readonly number[]): number {
    if (weights.length === 0) throw new RangeError('가중치 목록이 비어 있다');
    let total = 0;
    for (const w of weights) {
      if (!Number.isInteger(w) || w < 0) throw new RangeError(`가중치는 0 이상 정수여야 한다: ${w}`);
      total += w;
    }
    if (total === 0) throw new RangeError('가중치의 합이 0이다');
    let r = this.int(total);
    for (const [i, w] of weights.entries()) {
      if (r < w) return i;
      r -= w;
    }
    throw new RangeError('도달할 수 없는 위치'); // 합계 검사 때문에 오지 않는다
  }
}
