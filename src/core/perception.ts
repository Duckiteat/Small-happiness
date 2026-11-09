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

import { appraise, cueOf, EMOTION_FORMED, isOverwhelmed, isUnfinished, MEMORY_FORMED, MOOD_SLOT, OVERWHELMED, THOUGHT_SURFACED } from './emotion.ts';
import type { Episode } from './emotion.ts';
import { BODY_RESPONSE, IMAGE_FORMED, imageDefs, momentary, responsesTo, sustained } from './imagery.ts';
import { latestSeq } from './events.ts';
import { REFLEX, REFLEX_LEARNED, reflexDefs, triggers } from './reflex.ts';
import { actionReaches, feltCause, feltFrom, reachOf, scaleOf, sensesOf, STIMULUS_PERCEIVED, stopCause } from './sensation.ts';
import type { FeltOne, StateView } from './sensation.ts';
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
import { believed, causesOf, climb, discern, kindStrengths, knownKinds, LADDER_MOVED, ladderCause, ladderOfKey, ladderSpecs, newlySettled, rememberedKinds, strengthKeyOf } from './ladder.ts';
import type { LadderState, LadderView } from './ladder.ts';
import { skillKey } from './skill.ts';

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
  /** 심상 사다리로 아는 종류면 그 사다리가 열린 사건 (같은 냄새를 다시 짐작한 것은 새 앎이 아니다) */
  readonly since?: string;
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
      if (typeof o['aw'] === 'string' && typeof o['level'] === 'string' && typeof o['t'] === 'number' && typeof o['seq'] === 'string') inner[key] = { aw: o['aw'], level: o['level'], t: o['t'], seq: o['seq'], ...(typeof o['since'] === 'string' ? { since: o['since'] } : {}) };
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
  readonly #done = new Map<string, string>();
  readonly #felt = new Map<string, Map<string, FeltOne>>(); // 인물 → 지금 멀리서 느끼는 감각질
  readonly #learned = new Map<string, Set<string>>(); // 인물 → 배운 조건반사
  readonly #feltSeq = new Map<string, string>(); // `${인물}|${감각질}` → 멀리서 마지막으로 느끼기 시작한(세기 바뀐) 사건
  readonly #offSeq = new Map<string, string>(); // `${인물}|${감각질}` → 마지막으로 그친 사건
  readonly #imaged = new Map<string, Set<string>>(); // 인물 → 이어지고 있는 심상
  readonly #episodes = new Map<string, Episode[]>(); // 인물 → 겪은 일 (생각)
  readonly #memories = new Map<string, Map<string, string>>(); // 인물 → 정의 → 감정이 붙은 기억
  readonly #surfaced = new Map<string, Map<string, number>>(); // 인물 → 정의 → 마지막으로 갑자기 떠오른 때
  readonly #paired = new Map<string, number>(); // `${인물}|${반사}` → 짝지어 겪은 횟수 // 고른 행동 사건 → 끝난 사건 (살펴서 안 것의 원인)
  readonly #ladders = new Map<string, { readonly state: LadderState; readonly seq: string; readonly since: string }>(); // `${인물}|${장소}|${종류 특징}` → 심상 사다리의 자리, 그 사건, 열린 사건
  readonly #familiar = new Map<string, Map<string, number>>(); // 인물 → 좁히거나 정체를 안 종류 → 횟수 (자주 겪음)

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
        // 저절로 아는 것은 멀리서 닿는 감각(후각·시각·청각)뿐이다. 촉각·미각은 손에 닿거나 먹을 때만 (아래 touch)
        const felt = (key: string): boolean => {
          const k = parseStateKey(key);
          const sense = k === null ? undefined : this.#vocab.entry('feature', k.feature)?.attrs['sense'];
          if (typeof sense !== 'string' || reachOf(this.#vocab, sense) !== 'distance') return false;
          const notice = typeof sense === 'string' ? senses[sense]?.notice : undefined;
          const idx = world.levelIndex(key);
          return notice !== undefined && idx !== null && idx >= notice;
        };
        // 저절로: 장소에 퍼진 것. 느끼면 알아챔, 알던 것이 임계 아래로 내려가면 없어졌다고 안다
        // 그 장소에 놓여 눈에 보이는 물건(받치는 것을 따라 닿는 곳. 냉장고 안에 든 것처럼 어딘가의 안에 있으면 보이지 않는다)의 눈에 보이는 상태도 저절로 안다: 켜진 불, 담긴 물.
        // 놓임이 없는 물건(냉장고 속 음식처럼 어디에 있는지 모르는 것)은 살펴야만 안다.
        const here = instances.filter((i) => i.startsWith('OBJ') && places.includes(world.visiblePlace(i)));
        const specs = ladderSpecs(this.#vocab);
        const view = ladderView(world);
        for (const key of [...places, ...here].flatMap((p) => world.keysOf(p))) {
          if (ladderOfKey(specs, view, key) !== null) continue; // 장소 공기의 종류는 심상 사다리로 안다 (아래)
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
          const hasSense = typeof sense === 'string' && senses[sense]?.notice !== undefined && reachOf(this.#vocab, sense) === 'distance';
          if (hasSense && known !== undefined && zero !== undefined && known.level !== zero) this.#observe(who, key, known.aw, zero, t, senseVia(key), world.lastChange(key));
        }
        // 감각 자체 (sensation.ts): 머무는 곳과 그곳에 보이는 물건이 주는 감각질을 느끼기 시작하고 그친다 (무엇에서 왔는지는 적지 않는다)
        this.#sense(world, t, who, [...places].sort(), [...here].sort());
        // 살펴서: 가까이 본 물건은 임계와 상관없이 모든 상태를 안다 (냄새가 없어도 곰팡이·보관 상태가 보인다)
        for (const key of objects.flatMap((o) => world.keysOf(o))) {
          if (felt(key)) perceived.push({ who, key, level: world.level(key) });
          this.#observe(who, key, UNDERSTOOD, world.level(key), t, inspectVia, inspectDone);
        }
        // 심상 사다리 (ladder.ts): 머무는 곳의 냄새가 무엇인지. 살펴서 안 것까지 본 뒤에 오른다
        this.#climb(world, t, who, [...places].sort(), senseVia);
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

  /**
   * 손으로 다루거나 먹은 것의 감각 (촉각·미각): 행동이 끝난 직후 2층이 알려 준다. 그 순간 한 번 느낀다 (그치는 사건 없음).
   * 다룬 것은 행동을 내놓은 개체와 결과가 바뀐 개체들이다. 원인은 그 행동의 끝, 근거는 그 행동이다.
   */
  touch(world: World, who: string, subjects: readonly string[], verb: string, t: number, via: string, cause: string): void {
    const reaches = actionReaches(this.#vocab, verb);
    if (reaches.length === 0) return;
    const senses = sensesOf(this.#db, defOf(who) ?? '');
    const view = worldView(world);
    const seen = new Set<string>();
    const moments = new Map<string, string>(); // 이 순간 느낀 감각질 → 그 사건
    const sources = new Map<string, { source: string; reach: string }>(); // 이 순간 느낀 감각질 → 준 개체와 그 길
    for (const reach of reaches) {
      for (const f of feltFrom(this.#db, this.#vocab, view, subjects, reach, senses, this.#scale(who)).values()) {
        if (seen.has(f.sensation)) continue;
        seen.add(f.sensation);
        const e = this.#log.append({ t, type: STIMULUS_PERCEIVED, src: PERCEPTION_SRC, cause, data: { who, sensation: f.sensation, sense: f.sense, on: true, moment: true, level: f.level, scale: f.scale, via } });
        moments.set(f.sensation, e.seq);
        sources.set(f.sensation, { source: f.source, reach });
        this.#afterFelt(who, t, e.seq, f.sensation, f.level, f.scale, undefined, true);
      }
    }
    // 그 순간의 심상: 이 순간의 감각이 하나라도 들어가고 나머지는 멀리서 느끼고 있으면
    const d = new Set(this.#felt.get(who)?.keys() ?? []);
    const m = new Set(moments.keys());
    for (const img of imageDefs(this.#vocab)) {
      if (!momentary(img, d, m)) continue;
      this.#formImage(world, who, t, img.key, latestSeq(img.parts.map((p) => moments.get(p) ?? this.#feltSeq.get(`${who}|${p}`))), true, img.parts.map((p) => this.#partSource(who, p, sources)));
    }
  }

  /**
   * 심상이 생긴다 → 거기 붙은 몸의 반응이 곧바로 따른다 (해석 전 행동). 그 뒤 생각과 합쳐 감정이 생긴다 (emotion.ts):
   * 감정 → 감정이 붙은 기억(생기거나 덧씌워짐) → 스트레스 임계를 넘었으면 생각이 멈춤 → 축의 변화. 원인은 모두 그 감정.
   * 스트레스 임계에 있으면 생각하고 해석하지 못해 감정이 생기지 않는다.
   */
  #formImage(world: World, who: string, t: number, image: string, cause: string | null, moment: boolean, parts: readonly { readonly source: string | undefined; readonly reach: string }[]): void {
    const e = this.#log.append({ t, type: IMAGE_FORMED, src: PERCEPTION_SRC, cause, data: { who, image, on: true, ...(moment ? { moment: true } : {}) } });
    for (const r of responsesTo(this.#vocab, image)) this.#log.append({ t, type: BODY_RESPONSE, src: PERCEPTION_SRC, cause: e.seq, data: { who, response: r, image } });
    const def = this.#db.defs[defOf(who) ?? ''];
    const mind = def?.mind;
    if (mind === undefined || def?.slots?.[MOOD_SLOT] === undefined) return;
    const level = (key: string): string => world.level(key);
    if (isOverwhelmed(this.#vocab, mind, who, level)) return;
    const of = cueOf(parts, (i) => world.defOfInstance(i));
    const episodes = this.#episodes.get(who) ?? [];
    this.#episodes.set(who, episodes);
    const memories = this.#memories.get(who) ?? new Map<string, string>();
    this.#memories.set(who, memories);
    const surfacedAt = this.#surfaced.get(who) ?? new Map<string, number>();
    this.#surfaced.set(who, surfacedAt);
    const knows = this.#aware.get(who);
    const unfinished = (d: string): boolean => isUnfinished(this.#db, this.#vocab, d, world.instances().filter((i) => world.defOfInstance(i) === d), (k) => knows?.get(k)?.level);
    const a = appraise(this.#vocab, mind, who, image, of, t, episodes, memories, level, { unfinished, surfacedAt });
    if (a === null) return;
    const em = this.#log.append({ t, type: EMOTION_FORMED, src: PERCEPTION_SRC, cause: e.seq, data: { who, emotion: a.emotion, image, thought: a.thought, of: [...a.of] } });
    for (const m of a.memories) {
      this.#log.append({ t, type: MEMORY_FORMED, src: PERCEPTION_SRC, cause: em.seq, data: { who, of: m.of, emotion: m.emotion, ...(m.replaces !== undefined ? { replaces: m.replaces } : {}) } });
      memories.set(m.of, m.emotion);
    }
    if (a.overwhelms) this.#log.append({ t, type: OVERWHELMED, src: PERCEPTION_SRC, cause: em.seq, data: { who, on: true } });
    if (a.surfaces !== undefined) {
      this.#log.append({ t, type: THOUGHT_SURFACED, src: PERCEPTION_SRC, cause: em.seq, data: { who, of: a.surfaces.of, image: a.surfaces.image } });
      surfacedAt.set(a.surfaces.of, t);
    }
    for (const c of a.changes) world.set(c.key, c.to, { t, cause: em.seq });
    episodes.push({ image, of: a.of, t });
  }

  /** 심상의 재료 하나를 준 개체와 그 길: 이 순간 느낀 것(닿음·입)이 먼저, 아니면 멀리서 느끼는 것. */
  #partSource(who: string, part: string, moments: ReadonlyMap<string, { readonly source: string; readonly reach: string }>): { source: string | undefined; reach: string } {
    const m = moments.get(part);
    if (m !== undefined) return { source: m.source, reach: m.reach };
    return { source: this.#felt.get(who)?.get(part)?.source, reach: 'distance' };
  }

  /** 이야기가 정한 지난 기억 (시나리오의 memories): 처음에 원인 없이 남긴다. */
  remember(who: string, of: string, emotion: string, t: number): void {
    const memories = this.#memories.get(who) ?? new Map<string, string>();
    this.#memories.set(who, memories);
    this.#log.append({ t, type: MEMORY_FORMED, src: PERCEPTION_SRC, cause: null, data: { who, of, emotion, given: true } });
    memories.set(of, emotion);
  }

  /**
   * 반사 (reflex.ts): 감각을 느낀 바로 뒤. 닿거나 먹은 순간이면 먼저 조건반사를 짝짓고(그 예고 감각을 멀리서 느끼고 있을 때),
   * 그 감각질에 붙은 반사 중 문턱을 넘은 것(조건반사는 배운 것만)이 일어난다. 원인은 그 감각.
   */
  #afterFelt(who: string, t: number, seq: string, sensation: string, level: number, scale: number, was: number | undefined, moment: boolean): void {
    const learned = this.#learned.get(who) ?? new Set<string>();
    this.#learned.set(who, learned);
    if (moment) {
      const felt = this.#felt.get(who);
      for (const r of reflexDefs(this.#vocab)) {
        if (!r.conditioned || r.pairsWith !== sensation || learned.has(r.key) || felt?.has(r.on) !== true) continue;
        const k = `${who}|${r.key}`;
        const n = (this.#paired.get(k) ?? 0) + 1;
        this.#paired.set(k, n);
        if (n >= (r.times ?? 1)) {
          learned.add(r.key);
          this.#log.append({ t, type: REFLEX_LEARNED, src: PERCEPTION_SRC, cause: seq, data: { who, reflex: r.key } });
        }
      }
    }
    for (const r of reflexDefs(this.#vocab)) {
      if (r.on !== sensation || (r.conditioned && !learned.has(r.key)) || !triggers(r, level, scale, was)) continue;
      this.#log.append({ t, type: REFLEX, src: PERCEPTION_SRC, cause: seq, data: { who, reflex: r.key, sensation } });
    }
  }

  /** 그 사람이 감각마다 세기를 구분하는 단계 수. */
  #scale(who: string): (sense: string) => number {
    return (sense) => scaleOf(this.#db, defOf(who) ?? '', sense);
  }

  #sense(world: World, t: number, who: string, places: readonly string[], here: readonly string[]): void {
    const senses = sensesOf(this.#db, defOf(who) ?? '');
    const now = feltFrom(this.#db, this.#vocab, worldView(world), [...places, ...here], 'distance', senses, this.#scale(who));
    const before = this.#felt.get(who) ?? new Map<string, FeltOne>();
    const via = (sense: string): string => formatVia(defOf(who) ?? '', 'sense', sense);
    const lastChange = (k: string): string | null => world.lastChange(k);
    const born = (id: string): string | null => world.bornEvent(id);
    for (const [s, f] of [...before].sort(([a], [b]) => a.localeCompare(b))) {
      if (now.has(s)) continue;
      const cause = stopCause(this.#db, this.#vocab, [...places, ...here], s, (i) => world.defOfInstance(i), lastChange);
      const off = this.#log.append({ t, type: STIMULUS_PERCEIVED, src: PERCEPTION_SRC, cause, data: { who, sensation: s, sense: f.sense, on: false, via: via(f.sense) } });
      this.#offSeq.set(`${who}|${s}`, off.seq);
    }
    // 새로 느낀 것, 그리고 느끼던 것의 세기가 바뀐 것 (was: 바뀌기 전 세기)
    for (const [s, f] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
      const had = before.get(s);
      if (had !== undefined && had.level === f.level) continue;
      const e = this.#log.append({ t, type: STIMULUS_PERCEIVED, src: PERCEPTION_SRC, cause: feltCause(f, lastChange, born), data: { who, sensation: s, sense: f.sense, on: true, level: f.level, scale: f.scale, ...(had !== undefined ? { was: had.level } : {}), via: via(f.sense) } });
      this.#feltSeq.set(`${who}|${s}`, e.seq);
      this.#afterFelt(who, t, e.seq, s, f.level, f.scale, had?.level, false);
    }
    this.#felt.set(who, now);
    // 이어지는 심상: 멀리서 느끼는 것끼리 다 갖춰지면 생기고, 하나가 그치면 깨진다 (깨진 것 먼저)
    const d = new Set(now.keys());
    const imaged = this.#imaged.get(who) ?? new Set<string>();
    this.#imaged.set(who, imaged);
    for (const img of imageDefs(this.#vocab)) {
      if (!imaged.has(img.key) || sustained(img, d)) continue;
      imaged.delete(img.key);
      const cause = latestSeq(img.parts.filter((p) => !d.has(p)).map((p) => this.#offSeq.get(`${who}|${p}`)));
      this.#log.append({ t, type: IMAGE_FORMED, src: PERCEPTION_SRC, cause, data: { who, image: img.key, on: false } });
    }
    for (const img of imageDefs(this.#vocab)) {
      if (imaged.has(img.key) || !sustained(img, d)) continue;
      imaged.add(img.key);
      this.#formImage(world, who, t, img.key, latestSeq(img.parts.map((p) => this.#feltSeq.get(`${who}|${p}`))), false, img.parts.map((p) => this.#partSource(who, p, new Map())));
    }
  }

  /**
   * 장소마다 사다리를 연다·옮긴다·닫는다. 하루씨가 믿는 종류(짐작 이상이면 후보의 맨 앞)가 그 장소의 종류에 대한 앎이 된다.
   * 세기를 못 느끼게 되면 사다리를 닫고, 알던 종류는 없어졌다고 안다.
   */
  #climb(world: World, t: number, who: string, places: readonly string[], senseVia: (key: string) => string): void {
    const def = defOf(who) ?? '';
    const senses = this.#db.defs[def]?.senses ?? {};
    const view = ladderView(world);
    const knows = this.#aware.get(who) ?? new Map<string, Knowing>();
    for (const spec of ladderSpecs(this.#vocab)) {
      const notice = reachOf(this.#vocab, spec.sense) === 'distance' ? senses[spec.sense]?.notice : undefined;
      for (const place of places) {
        const at = strengthKeyOf(view, spec, place);
        if (at === null) continue;
        const id = `${who}|${place}|${spec.feature}`;
        const prev = this.#ladders.get(id);
        const idx = world.levelIndex(at.strength);
        if (notice === undefined || idx === null || idx < notice) {
          if (prev !== undefined) {
            this.#log.append({ t, type: LADDER_MOVED, src: PERCEPTION_SRC, cause: world.lastChange(at.strength), data: { who, of: place, feature: spec.feature, on: false } });
            this.#ladders.delete(id);
          }
          const known = knows.get(at.kind);
          const zero = this.#vocab.levelOrder(spec.feature)?.at(0);
          if (notice !== undefined && known !== undefined && zero !== undefined && known.level !== zero) this.#observe(who, at.kind, known.aw, zero, t, senseVia(at.kind), world.lastChange(at.kind));
          continue;
        }
        const { strengths, read } = kindStrengths(this.#vocab, view, spec, place);
        const sk = skillKey(who, spec.skill);
        const hasSkill = world.keysOf(who).includes(sk);
        const skillIndex = hasSkill ? (this.#vocab.levelOrder(spec.skill) ?? []).indexOf(world.level(sk)) : 0;
        const discerned = discern(this.#vocab, spec, strengths, scaleOf(this.#db, def, spec.sense), Math.max(0, skillIndex));
        const known = knownKinds(this.#vocab, spec, knows, UNDERSTOOD);
        const familiar = this.#familiar.get(who) ?? new Map<string, number>();
        this.#familiar.set(who, familiar);
        const remembered = rememberedKinds(this.#db, this.#vocab, spec, [...(this.#memories.get(who)?.keys() ?? [])].sort());
        const r = climb(this.#vocab, spec, prev?.state, { discerned, known, familiar, remembered });
        if (r !== null) {
          const thing = r.state.thing;
          const thingSeq = thing === undefined ? undefined : [...knows].find(([k]) => k.startsWith(`${thing}|`) && k.endsWith(`:${spec.feature}`))?.[1].seq;
          const cause = ladderCause(read, (k) => world.lastChange(k), [hasSkill ? world.lastChange(sk) : null, thingSeq]);
          const e = this.#log.append({
            t,
            type: LADDER_MOVED,
            src: PERCEPTION_SRC,
            cause,
            data: { who, of: place, feature: spec.feature, on: true, rung: r.state.rung, kinds: [...r.state.kinds], causes: causesOf(this.#vocab, r.state.kinds), ...(thing !== undefined ? { thing } : {}), ...(r.fresh ? { fresh: true } : {}) },
          });
          const settled = newlySettled(prev?.state, r.fresh, r.state);
          if (settled !== null) familiar.set(settled, (familiar.get(settled) ?? 0) + 1);
          this.#ladders.set(id, { state: r.state, seq: e.seq, since: prev === undefined || r.fresh ? e.seq : prev.since });
        }
        const now = this.#ladders.get(id);
        const b = believed(now?.state);
        if (b !== null && now !== undefined) this.#observe(who, at.kind, NOTICED, b, t, senseVia(at.kind), now.seq, now.since);
      }
    }
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
  #observe(who: string, key: string, aw: string, level: string, t: number, via: string, cause: string | null, since?: string): void {
    const m = this.#aware.get(who) ?? new Map<string, Knowing>();
    this.#aware.set(who, m);
    const prev = m.get(key);
    const prevAw = prev?.aw ?? UNKNOWN;
    const rose = awarenessRank(this.#vocab, aw) > awarenessRank(this.#vocab, prevAw);
    const to = rose ? aw : prevAw;
    if (!rose && prev !== undefined && prev.level === level) return;
    const e = this.#log.append({ t, type: rose ? AWARENESS_UP : AWARENESS_CHANGED, src: PERCEPTION_SRC, cause, data: { who, key, to, level, via } });
    m.set(key, { aw: to, level, t, seq: e.seq, ...(since !== undefined ? { since } : {}) });
  }
}

/** 사다리가 세계를 읽는 창 (ladder.ts). */
function ladderView(world: World): LadderView {
  return { instances: () => world.instances(), keysOf: (i) => world.keysOf(i), level: (k) => world.level(k), whereIs: (i) => world.whereIs(i) };
}

/** 지각 층이 세계를 읽는 창 (sensation.ts). */
function worldView(world: World): StateView {
  return {
    defOf: (i) => world.defOfInstance(i),
    has: (key) => {
      const bar = key.indexOf('|');
      return world.keysOf(key.slice(0, bar)).includes(key);
    },
    level: (key) => world.level(key),
  };
}
