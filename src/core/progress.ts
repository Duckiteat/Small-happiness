// 진행 법칙의 실행 — 축의 양이 조건에 따라 쌓이고 경계를 넘으면 단계가 오른다 (음식-변화-모델 4·5장)
//
// 양 저장: 물건 × 축마다 쌓인 양 E를 정수로 들고 있다 (BigInt, 반올림 없음).
//   - 속도 = 입력 계수(×100)의 곱. 한 분에 E가 그만큼 는다. 경계 양 e(0~1000)는 E로 ceil(e × 기본 시간(분) × 100^입력 수 / 1000).
//   - 조건은 사건이 일어나는 순간에만 바뀐다. 그래서 바뀌기 직전까지 옛 속도로 쌓고(integrate), 그 뒤로 새 속도를 쓴다.
//   - 경계를 넘는 시각은 정확히 계산한다 (ceil, 분 단위). 단계 간격을 어떻게 나눠도 결과가 같다.
//   - 계수 0이면 멈춘다 (냉동의 부패). 입력이 종결 단계(소멸)면 계수가 없으므로 0 — 버린 물건은 진행하지 않는다.
//   - 축이 종결 단계면 진행하지 않는다. 밖에서 단계를 올렸으면 양을 그 경계까지 맞춘다 (내려가지는 않는다).
// 난수를 받지 않는다. 상태를 바꾸는 것은 세계 상태(주인)이고, 여기서는 stage_advanced 사건을 원인으로 요청한다.

import type { Db } from './db.ts';
import type { EventLog } from './log.ts';
import { effectiveProgress } from './kinds.ts';
import type { FullProgress } from './kinds.ts';
import { formatStateKey } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import type { World } from './world.ts';

export const STAGE_ADVANCED = 'stage_advanced';

interface Track {
  readonly instance: string;
  readonly key: string;
  readonly law: FullProgress;
  readonly inputs: readonly { readonly key: string; readonly table: { readonly [level: string]: number } }[];
  e: bigint;
  t: number;
}

export class Progress {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #tracks = new Map<string, Track>();

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  /** 모든 진행을 시각 t까지 쌓는다 (새로 보이는 물건은 지금 단계의 경계에서 시작한다). */
  integrate(world: World, t: number): void {
    for (const instance of world.instances()) {
      const def = world.defOfInstance(instance) ?? '';
      for (const law of effectiveProgress(this.#db, def).full) {
        const key = formatStateKey({ subject: instance, slot: law.slot, feature: law.feature });
        let tr = this.#tracks.get(key);
        if (tr === undefined) {
          const slots = this.#db.defs[def]?.slots ?? {};
          const inputs = Object.entries(law.inputs).map(([feature, table]) => {
            const slot = Object.keys(slots).sort().find((s) => (slots[s]?.features ?? []).includes(feature)) ?? '';
            return { key: formatStateKey({ subject: instance, slot, feature }), table };
          });
          const idx = world.levelIndex(key);
          tr = { instance, key, law, inputs, e: idx === null ? 0n : this.#threshold(law, idx), t };
          this.#tracks.set(key, tr);
          continue;
        }
        if (t > tr.t) tr.e += BigInt(t - tr.t) * this.#rate(world, tr);
        tr.t = t;
        const idx = world.levelIndex(key);
        if (idx !== null) {
          const floor = this.#threshold(law, idx);
          if (tr.e < floor) tr.e = floor; // 밖에서 단계를 올린 경우
        }
      }
    }
  }

  /** 시각 to 이하에서 가장 이른 경계 넘김 시각. 없으면 null. integrate 뒤에 부른다. */
  next(world: World, to: number): number | null {
    let min: number | null = null;
    for (const tr of this.#tracks.values()) {
      const target = this.#nextEdge(world, tr);
      if (target === null) continue;
      let at: number;
      if (tr.e >= target.e) at = tr.t;
      else {
        const rate = this.#rate(world, tr);
        if (rate === 0n) continue;
        at = tr.t + Number((target.e - tr.e + rate - 1n) / rate);
      }
      if (at <= to && (min === null || at < min)) min = at;
    }
    return min;
  }

  /** 시각 t에 경계를 넘은 축의 단계를 올린다 (넘은 경계 중 가장 높은 칸으로). integrate(t) 뒤에 부른다. */
  fire(world: World, t: number): void {
    for (const key of [...this.#tracks.keys()].sort()) {
      const tr = this.#tracks.get(key) as Track;
      const idx = world.levelIndex(key);
      if (idx === null) continue;
      const order = this.#vocab.levelOrder(tr.law.feature) ?? [];
      let reach = idx;
      for (let j = idx + 1; j < order.length; j++) {
        const edge = tr.law.edges.at(j);
        if (edge === null || edge === undefined) continue;
        if (tr.e >= this.#threshold(tr.law, j)) reach = j;
      }
      if (reach === idx) continue;
      const level = order.at(reach) as string;
      const e = this.#log.append({ t, type: STAGE_ADVANCED, src: 'causal', data: { key, to: level } });
      world.set(key, level, { t, cause: e.seq });
    }
  }

  /** 시험·화면용: 지금 쌓인 양 (0~1000, 내림). */
  amount(key: string): number | null {
    const tr = this.#tracks.get(key);
    if (tr === undefined) return null;
    const full = this.#threshold(tr.law, -1);
    return Number((tr.e * 1000n) / full);
  }

  // ---- 내부 ----

  #scale(law: FullProgress): bigint {
    return 100n ** BigInt(Object.keys(law.inputs).length);
  }

  /** 칸 idx의 경계에 해당하는 E. idx = -1이면 양 1000(끝). */
  #threshold(law: FullProgress, idx: number): bigint {
    const edge = idx < 0 ? 1000 : law.edges.at(idx) ?? 0;
    const total = BigInt(law.base_s / 60) * this.#scale(law);
    return (BigInt(edge ?? 0) * total + 999n) / 1000n;
  }

  #rate(world: World, tr: Track): bigint {
    if (world.levelIndex(tr.key) === null) return 0n; // 축이 종결 단계
    let r = 1n;
    for (const input of tr.inputs) {
      const c = input.table[world.level(input.key)];
      if (c === undefined) return 0n; // 입력이 종결 단계(버림·소멸) — 진행하지 않는다
      r *= BigInt(c);
    }
    return r;
  }

  #nextEdge(world: World, tr: Track): { readonly e: bigint } | null {
    const idx = world.levelIndex(tr.key);
    if (idx === null) return null;
    for (let j = idx + 1; j < tr.law.edges.length; j++) {
      const edge = tr.law.edges.at(j);
      if (edge !== null && edge !== undefined) return { e: this.#threshold(tr.law, j) };
    }
    return null;
  }
}
