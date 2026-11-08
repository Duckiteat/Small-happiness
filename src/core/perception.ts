// 지각 (5층) — 세계(라인 A)와 사람(라인 B)이 처음 만나는 곳 (docs/품질판-명세.md · 상호작용-명세 2A)
//
// 하루씨가 집에 깨어 있을 때만 느낀다 (presence = home). 외출·잠 중에는 아무것도 지각하지 않는다.
//   - 저절로 (수동): 장소에 퍼진 것(장소의 상태: 냄새, 벌레)은 감각 임계를 넘으면 느낀다 → 알아챔.
//   - 살펴서 (능동): 살피기(reveals)가 끝난 장소에서는 물건의 상태까지 본다 → 이해함 (정체와 위치를 안다).
//     직전 단계의 행동을 읽는다 (되먹임 길 F6: 행동 → 지각).
// 감각 임계는 인물 정의(CHR)의 senses에서, 특징을 느끼는 감각은 사전 feature의 sense에서 온다. 코드에 수치가 없다.
//
// 앎 = 인지 단계(알아챔·이해함) + **본 단계**(그때 본 상태) + 본 시각. 인물은 세계가 아니라 이 앎으로 판단한다.
//   - 인지 단계는 오르기만 한다 (awareness_up). 본 단계는 다시 볼 때마다 바뀐다 (awareness_changed).
//   - 집에서 느끼던 장소의 냄새·벌레가 임계 아래로 내려가면 "없어졌다"고 안다 (사다리 0칸으로). 다시 나면 다시 알아챈다.
//   - 살핀 물건의 앎은 다시 살필 때까지 그대로다 — 앎은 낡는다 (그 사이 세계가 바뀌어도 모른다).
//
// 단순화 (기본안, 위치·번짐 11번 전까지): 물건의 위치가 없어서, 장소를 살피면 집 안의 모든 물건을 본다.

import type { BoardValue } from './board.ts';
import { formatVia } from './via.ts';
import type { Db } from './db.ts';
import { defOf } from './ids.ts';
import type { EventLog } from './log.ts';
import { isObserved } from './schedule.ts';
import { parseStateKey } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import type { World } from './world.ts';
import { parseRecent } from './agency.ts';

export const PERCEPTION_SRC = 'perception';
export const AWARENESS_UP = 'awareness_up';
export const AWARENESS_CHANGED = 'awareness_changed';
export const UNKNOWN = 'unknown';
export const NOTICED = 'noticed';
export const UNDERSTOOD = 'understood';

export interface Percept {
  readonly who: string;
  readonly key: string;
  readonly level: string;
}

/** 하나의 앎: 인지 단계 키(사전 awareness), 그때 본 단계 키, 본 시각. */
export interface Knowing {
  readonly aw: string;
  readonly level: string;
  readonly t: number;
  /** 이 앎을 만든 awareness 사건 번호. 행동을 고른 이유(cause)를 적을 때 쓴다 */
  readonly seq: string;
}

/** 인물 인스턴스 → 상태 키 → 앎. */
export type AwareMap = { readonly [who: string]: { readonly [key: string]: Knowing } };

export function awarenessRank(vocab: Vocab, key: string): number {
  const r = vocab.entry('awareness', key)?.attrs['rank'];
  return typeof r === 'number' ? r : 0;
}

/** 판의 aware 값을 읽는다 (5층이 쓴 모양). */
export function parseAware(value: BoardValue | undefined): AwareMap {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, Record<string, Knowing>> = {};
  for (const [who, m] of Object.entries(value)) {
    if (typeof m !== 'object' || Array.isArray(m)) continue;
    const inner: Record<string, Knowing> = {};
    for (const [key, k] of Object.entries(m)) {
      if (typeof k !== 'object' || Array.isArray(k)) continue;
      const o = k as { readonly [f: string]: BoardValue };
      if (typeof o['aw'] === 'string' && typeof o['level'] === 'string' && typeof o['t'] === 'number' && typeof o['seq'] === 'string') inner[key] = { aw: o['aw'], level: o['level'], t: o['t'], seq: o['seq'] };
    }
    out[who] = inner;
  }
  return out;
}

export class Perception {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #aware = new Map<string, Map<string, Knowing>>();
  readonly #reveals: { readonly place: string; readonly ends: number; readonly via: string; readonly event: string }[] = [];
  readonly #done = new Map<string, string>(); // 고른 행동 사건 → 끝난 사건 (살펴서 안 것의 원인)

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  /** 한 단계의 지각. prevRecent는 직전 단계의 행동(F6). */
  step(world: World, t: number, presence: string, prevRecent: BoardValue | undefined): { perceived: Percept[]; aware: AwareMap } {
    for (const r of parseRecent(prevRecent)) if (r.reveals !== undefined) this.#reveals.push({ place: r.reveals, ends: r.ends, via: r.via, event: r.event });
    const perceived: Percept[] = [];
    if (isObserved(this.#vocab, presence)) {
      const revealed = this.#reveals.filter((r) => r.ends <= t);
      this.#reveals.splice(0, this.#reveals.length, ...this.#reveals.filter((r) => r.ends > t));
      const instances = world.instances();
      const objects = revealed.length > 0 ? instances.filter((i) => i.startsWith('OBJ')) : [];
      const inspectVia = revealed[0]?.via ?? ''; // 살펴서 안 것의 근거는 그 살피기 행동, 원인은 그 행동이 끝난 사건
      const inspectDone = this.#done.get(revealed[0]?.event ?? '') ?? null;
      for (const who of instances.filter((i) => i.startsWith('CHR'))) {
        const senses = this.#db.defs[defOf(who) ?? '']?.senses ?? {};
        // 집에 있는 동안 머무는 곳의 냄새만 맡는다 (정의에 stays가 없으면 모든 장소)
        const stays = this.#db.defs[defOf(who) ?? '']?.stays;
        const places = instances.filter((i) => i.startsWith('PLC') && (stays === undefined || defOf(i) === stays));
        // 저절로 느낀 것의 근거는 그 감각 (인물 정의의 senses)
        const senseVia = (key: string): string => {
          const k = parseStateKey(key);
          const sense = k === null ? undefined : this.#vocab.entry('feature', k.feature)?.attrs['sense'];
          return formatVia(defOf(who) ?? '', 'sense', typeof sense === 'string' ? sense : '');
        };
        const felt = (key: string): boolean => {
          const k = parseStateKey(key);
          const sense = k === null ? undefined : this.#vocab.entry('feature', k.feature)?.attrs['sense'];
          const notice = typeof sense === 'string' ? senses[sense]?.notice : undefined;
          const idx = world.levelIndex(key);
          return notice !== undefined && idx !== null && idx >= notice;
        };
        // 저절로: 장소에 퍼진 것. 느끼면 알아챔, 알던 것이 임계 아래로 내려가면 없어졌다고 안다
        // 그 장소에 놓여 눈에 보이는 물건(받치는 것을 따라 닿는 곳. 냉장고 안에 든 것처럼 어딘가의 안에 있으면 보이지 않는다)의 눈에 보이는 상태도 저절로 안다: 켜진 불, 담긴 물.
        // 놓임이 없는 물건(냉장고 속 음식처럼 어디에 있는지 모르는 것)은 살펴야만 안다.
        const here = instances.filter((i) => i.startsWith('OBJ') && places.includes(world.visiblePlace(i)));
        for (const key of [...places, ...here].flatMap((p) => world.keysOf(p))) {
          if (felt(key)) {
            perceived.push({ who, key, level: world.level(key) });
            this.#observe(who, key, NOTICED, world.level(key), t, senseVia(key), world.lastChange(key));
            continue;
          }
          const known = this.#aware.get(who)?.get(key);
          const k = parseStateKey(key);
          const zero = k === null ? undefined : this.#vocab.levelOrder(k.feature)?.at(0);
          // 없어졌다고 아는 것은 그 감각이 있을 때뿐이다 (촉각이 없으면 살펴서 안 온도를 '없음'으로 바꾸지 않는다)
          const sense = k === null ? undefined : this.#vocab.entry('feature', k.feature)?.attrs['sense'];
          const hasSense = typeof sense === 'string' && senses[sense]?.notice !== undefined;
          if (hasSense && known !== undefined && zero !== undefined && known.level !== zero) this.#observe(who, key, known.aw, zero, t, senseVia(key), world.lastChange(key));
        }
        // 살펴서: 가까이 본 물건은 임계와 상관없이 모든 상태를 안다 (냄새가 없어도 곰팡이·보관 상태가 보인다)
        for (const key of objects.flatMap((o) => world.keysOf(o))) {
          if (felt(key)) perceived.push({ who, key, level: world.level(key) });
          this.#observe(who, key, UNDERSTOOD, world.level(key), t, inspectVia, inspectDone);
        }
      }
    }
    return { perceived, aware: this.snapshot() };
  }

  /**
   * 자기가 한 행동이 바꾼 상태를 안다 (이해함). 행동이 끝난 직후 2층이 알려 준다. 원인은 그 행동의 끝, 근거는 그 행동이다.
   * 요리로 쓴 재료가 없어졌다는 것을 하루씨가 알아야 같은 재료를 다시 요리하지 않는다.
   */
  learn(who: string, key: string, level: string, t: number, via: string, cause: string): void {
    this.#observe(who, key, UNDERSTOOD, level, t, via, cause);
  }

  /** 고른 행동이 끝났음을 알려 준다 (2층이 끝난 사건을 기록한 직후). 살펴서 안 것의 원인이 된다. */
  recordDone(chosen: string, done: string): void {
    this.#done.set(chosen, done);
  }

  snapshot(): AwareMap {
    const out: Record<string, Record<string, Knowing>> = {};
    for (const who of [...this.#aware.keys()].sort()) {
      const m = this.#aware.get(who) as Map<string, Knowing>;
      out[who] = Object.fromEntries([...m.keys()].sort().map((k) => [k, { ...(m.get(k) as Knowing) }]));
    }
    return out;
  }

  /** 본 것을 앎에 남긴다. 인지 단계는 오르기만 하고, 본 단계가 바뀌면 앎이 바뀐다. 바뀐 것이 있을 때만 사건을 남긴다. */
  #observe(who: string, key: string, aw: string, level: string, t: number, via: string, cause: string | null): void {
    const m = this.#aware.get(who) ?? new Map<string, Knowing>();
    this.#aware.set(who, m);
    const prev = m.get(key);
    const prevAw = prev?.aw ?? UNKNOWN;
    const rose = awarenessRank(this.#vocab, aw) > awarenessRank(this.#vocab, prevAw);
    const to = rose ? aw : prevAw;
    if (!rose && prev !== undefined && prev.level === level) return;
    const e = this.#log.append({ t, type: rose ? AWARENESS_UP : AWARENESS_CHANGED, src: PERCEPTION_SRC, cause, data: { who, key, to, level, via } });
    m.set(key, { aw: to, level, t, seq: e.seq });
  }
}
