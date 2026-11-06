// 지각 (5층) — 세계(라인 A)와 사람(라인 B)이 처음 만나는 곳 (docs/품질판-명세.md · 상호작용-명세 2A)
//
// 하루씨가 집에 깨어 있을 때만 느낀다 (presence = home). 외출·잠 중에는 아무것도 지각하지 않는다.
//   - 저절로 (수동): 장소에 퍼진 것(장소의 상태: 냄새, 벌레)은 감각 임계를 넘으면 느낀다 → 알아챔.
//   - 살펴서 (능동): 살피기(reveals)가 끝난 장소에서는 물건의 상태까지 본다 → 이해함 (정체와 위치를 안다).
//     직전 단계의 행동을 읽는다 (되먹임 길 F6: 행동 → 지각).
// 감각 임계는 인물 정의(CHR)의 senses에서, 특징을 느끼는 감각은 사전 feature의 sense에서 온다. 코드에 수치가 없다.
// 앎은 오르기만 하고 내려가지 않는다. 오를 때마다 awareness_up 사건을 남긴다.
//
// 단순화 (기본안, 위치·번짐 11번 전까지): 물건의 위치가 없어서, 장소를 살피면 집 안의 모든 물건을 본다.

import type { BoardValue } from './board.ts';
import type { Db } from './db.ts';
import { defOf } from './ids.ts';
import type { EventLog } from './log.ts';
import { OBSERVED } from './schedule.ts';
import { parseStateKey } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import type { World } from './world.ts';
import { parseRecent } from './agency.ts';

export const PERCEPTION_SRC = 'perception';
export const AWARENESS_UP = 'awareness_up';
export const UNKNOWN = 'unknown';
export const NOTICED = 'noticed';
export const UNDERSTOOD = 'understood';

export interface Percept {
  readonly who: string;
  readonly key: string;
  readonly level: string;
}

/** 인물 인스턴스 → 상태 키 → 인지 단계 키. */
export type AwareMap = { readonly [who: string]: { readonly [key: string]: string } };

export function awarenessRank(vocab: Vocab, key: string): number {
  const r = vocab.entry('awareness', key)?.attrs['rank'];
  return typeof r === 'number' ? r : 0;
}

/** 판의 aware 값을 읽는다 (5층이 쓴 모양). */
export function parseAware(value: BoardValue | undefined): AwareMap {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [who, m] of Object.entries(value)) {
    if (typeof m !== 'object' || Array.isArray(m)) continue;
    out[who] = Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return out;
}

export class Perception {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #aware = new Map<string, Map<string, string>>();
  readonly #reveals: { readonly place: string; readonly ends: number }[] = [];

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  /** 한 단계의 지각. prevRecent는 직전 단계의 행동(F6). */
  step(world: World, t: number, presence: string, prevRecent: BoardValue | undefined): { perceived: Percept[]; aware: AwareMap } {
    for (const r of parseRecent(prevRecent)) if (r.reveals !== undefined) this.#reveals.push({ place: r.reveals, ends: r.ends });
    const perceived: Percept[] = [];
    if (presence === OBSERVED) {
      const revealed = this.#reveals.filter((r) => r.ends <= t);
      this.#reveals.splice(0, this.#reveals.length, ...this.#reveals.filter((r) => r.ends > t));
      const instances = world.instances();
      const places = instances.filter((i) => i.startsWith('PLC'));
      const objects = revealed.length > 0 ? instances.filter((i) => i.startsWith('OBJ')) : [];
      for (const who of instances.filter((i) => i.startsWith('CHR'))) {
        const senses = this.#db.defs[defOf(who) ?? '']?.senses ?? {};
        const look = (keys: string[], to: string): void => {
          for (const key of keys) {
            const k = parseStateKey(key);
            const sense = k === null ? undefined : this.#vocab.entry('feature', k.feature)?.attrs['sense'];
            const notice = typeof sense === 'string' ? senses[sense]?.notice : undefined;
            const idx = world.levelIndex(key);
            if (notice === undefined || idx === null || idx < notice) continue;
            perceived.push({ who, key, level: world.level(key) });
            this.#raise(who, key, to, t);
          }
        };
        look(places.flatMap((p) => world.keysOf(p)), NOTICED);
        look(objects.flatMap((o) => world.keysOf(o)), UNDERSTOOD);
        // 가까이 살핀 물건은 임계와 상관없이 모든 상태를 안다 (냄새가 없어도 곰팡이·보관 상태가 보인다)
        for (const key of objects.flatMap((o) => world.keysOf(o))) this.#raise(who, key, UNDERSTOOD, t);
      }
    }
    return { perceived, aware: this.snapshot() };
  }

  snapshot(): AwareMap {
    const out: Record<string, Record<string, string>> = {};
    for (const who of [...this.#aware.keys()].sort()) {
      const m = this.#aware.get(who) as Map<string, string>;
      out[who] = Object.fromEntries([...m.keys()].sort().map((k) => [k, m.get(k) as string]));
    }
    return out;
  }

  #raise(who: string, key: string, to: string, t: number): void {
    const m = this.#aware.get(who) ?? new Map<string, string>();
    this.#aware.set(who, m);
    const now = m.get(key) ?? UNKNOWN;
    if (awarenessRank(this.#vocab, to) <= awarenessRank(this.#vocab, now)) return;
    m.set(key, to);
    this.#log.append({ t, type: AWARENESS_UP, src: PERCEPTION_SRC, data: { who, key, to } });
  }
}
