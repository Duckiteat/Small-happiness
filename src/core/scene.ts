// 장면 (7층 · S7, 작가 2026-11-09: B 줄글 문법, 시계 기준 하루 구간, 첫 장면 하나)
//
// 이벤트(EVT)는 핵심 — 심상 사다리를 타는 장소의 냄새 종류 — 의 사다리가 열리면 열리고, 닫힘 조건이 모두 맞거나 사다리가 닫히면 닫힌다.
// 열려 있는 동안 지금의 감각 · 사다리 칸 · 하루 구간 · 모드에 맞는 장면 중 **가장 구체적인 것**(조건이 더 많이 맞는 것)을 고르고,
// 같으면 파일 순서. 감각 × 칸마다 조건 없는 기본 장면이 있다 (관문이 지킨다). 문장은 작가의 원문 그대로 보인다 (조회만, 생성하지 않음).
// 난수 없음. 7층과 감사가 같은 계산을 쓴다.

import type { Db, Definition, SceneDef } from './db.ts';
import { latestSeq } from './events.ts';
import { levelMatches } from './causal.ts';
import type { EventLog } from './log.ts';
import type { World } from './world.ts';
import { parsePattern } from './statekey.ts';
import type { StatePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export const EVENT_OPENED = 'event_opened';
export const SCENE_SHOWN = 'scene_shown';
export const EVENT_CLOSED = 'event_closed';

/** 그 시각의 하루 구간 (사전 day_part, 시계 기준). */
export function dayPartOf(vocab: Vocab, t: number): string | null {
  const m = ((t % 1440) + 1440) % 1440;
  for (const key of vocab.keys('day_part').sort()) {
    const a = vocab.entry('day_part', key)?.attrs ?? {};
    const f = a['from'], to = a['to'];
    if (typeof f !== 'number' || typeof to !== 'number') continue;
    if (f < to ? m >= f && m < to : m >= f || m < to) return key;
  }
  return null;
}

/** 장면 조건을 볼 맥락 (7층은 지각에서, 감사는 따라간 기록에서). 각 조건이 참이게 한 사건 번호도 준다 (장면의 원인). */
export interface SceneContext {
  /** 맨 앞에 떠올린 개념, 믿는 종류 (사다리) */
  readonly concept?: string;
  readonly kind?: string;
  /** 인물의 내면 특징 단계와 그것을 정한 사건 */
  readonly inner: (feature: string) => { readonly level: string; readonly seq: string | null } | undefined;
  /** 방금 들어온 때 (현관문을 지남 in) */
  readonly cameHome?: { readonly t: number; readonly seq: string };
  /** 오늘(마지막으로 깬 뒤)의 밖의 하루 카드 */
  readonly cards?: { readonly cards: readonly string[]; readonly seq: string };
  /** 못 참는 냄새의 시작 사건 */
  readonly urgent?: string;
}

/** 장면 조건 하나가 맞으면 그것을 참이게 한 사건(없으면 null), 안 맞으면 false. */
export function condHolds(vocab: Vocab, c: string, t: number, ctx: SceneContext): string | null | false {
  const colon = c.indexOf(':');
  const key = colon < 0 ? c : c.slice(0, colon);
  const val = colon < 0 ? '' : c.slice(colon + 1);
  if (key === 'came_home') {
    const w = vocab.entry('scene_cond', 'came_home')?.attrs['window_min'];
    return ctx.cameHome !== undefined && t - ctx.cameHome.t <= (typeof w === 'number' ? w : 0) ? ctx.cameHome.seq : false;
  }
  if (key === 'urgent') return ctx.urgent ?? false;
  if (key === 'card') return ctx.cards !== undefined && ctx.cards.cards.includes(val) ? ctx.cards.seq : false;
  if (key === 'concept') return ctx.concept === val ? null : false;
  if (key === 'kind') return ctx.kind === val ? null : false;
  if (key === 'inner') {
    const at = val.indexOf('@');
    const f = val.slice(0, at);
    const m = /^(>=|<=|=)(.+)$/.exec(val.slice(at + 1));
    const cur = ctx.inner(f);
    if (m === null || cur === undefined) return false;
    return levelMatches(vocab, f, cur.level, { op: m[1] as '=' | '>=' | '<=', level: m[2] ?? '' }) ? cur.seq : false;
  }
  return false;
}

/** 가장 구체적인 장면: 감각·칸이 맞고, 하루 구간·모드·그 밖의 조건이 없거나 모두 맞는 것 중 맞는 조건이 가장 많은 것 (같으면 파일 순서). 조건을 참이게 한 사건들도. */
export function pickScene(scenes: readonly SceneDef[], sense: string, rung: string, dayPart: string | null, mode: string | null, ctx?: { readonly vocab: Vocab; readonly t: number; readonly ctx: SceneContext }): SceneDef | null {
  return pickSceneWhy(scenes, sense, rung, dayPart, mode, ctx)?.scene ?? null;
}

export function pickSceneWhy(scenes: readonly SceneDef[], sense: string, rung: string, dayPart: string | null, mode: string | null, ctx?: { readonly vocab: Vocab; readonly t: number; readonly ctx: SceneContext }): { scene: SceneDef; seqs: (string | null)[] } | null {
  let best: SceneDef | null = null;
  let bestSeqs: (string | null)[] = [];
  let bestScore = -1;
  for (const sc of scenes) {
    if (sc.sense !== sense || sc.rung !== rung) continue;
    if (sc.day_part !== undefined && sc.day_part !== dayPart) continue;
    if (sc.mode !== undefined && sc.mode !== mode) continue;
    const conds = sc.conds ?? [];
    if (conds.length > 0 && ctx === undefined) continue;
    const held = conds.map((c) => (ctx === undefined ? false : condHolds(ctx.vocab, c, ctx.t, ctx.ctx)));
    if (held.some((h) => h === false)) continue;
    const score = (sc.day_part !== undefined ? 1 : 0) + (sc.mode !== undefined ? 1 : 0) + conds.length;
    if (score > bestScore) {
      best = sc;
      bestScore = score;
      bestSeqs = held.filter((h): h is string | null => h !== false);
    }
  }
  return best === null ? null : { scene: best, seqs: bestSeqs };
}

/** 이벤트의 핵심 패턴 (정의|부위:특징). */
export function coreOf(def: Definition): StatePattern | null {
  return def.core === undefined ? null : parsePattern(def.core);
}

/** 핵심 특징을 느끼는 감각 (사전 feature의 sense). */
export function senseOf(vocab: Vocab, feature: string): string | null {
  const s = vocab.entry('feature', feature)?.attrs['sense'];
  return typeof s === 'string' ? s : null;
}

/** 닫힘 조건의 상태 키들: 핵심 정의를 가리키면 그 장소 개체, 아니면 그 정의의 개체들. */
export function closeKeys(def: Definition, place: string, instancesOf: (d: string) => readonly string[]): { key: string; p: StatePattern }[][] {
  const core = coreOf(def);
  return (def.closes ?? []).flatMap((text) => {
    const p = parsePattern(text);
    if (p === null) return [];
    const subjects = core !== null && p.def === core.def ? [place] : [...instancesOf(p.def)].sort();
    return [subjects.map((i) => ({ key: `${i}|${p.slot}:${p.feature}`, p }))];
  });
}


export const SCENE_SRC = 'scene';

/** 7층이 지각에게서 읽는 것: 사다리의 지금 자리와 그 사건, 지금의 모드와 그 사건. */
export interface StageView {
  readonly ladder: (who: string, place: string, feature: string) => { readonly rung: string; readonly seq: string } | undefined;
  readonly mode: (who: string) => { readonly mode: string; readonly seq: string } | undefined;
  /** 장면 조건의 맥락 (사다리의 개념·종류는 7층이 채운다) */
  readonly context: (who: string) => Omit<SceneContext, 'concept' | 'kind'>;
  /** 사다리의 떠올린 개념·믿는 종류 */
  readonly ladderMind: (who: string, place: string, feature: string) => { readonly concept?: string; readonly kind?: string };
}

/** 이벤트를 열고 닫고, 열린 동안 장면을 고른다. 판의 scene 값(인물 → 열린 이벤트의 장면)을 돌려준다. */
export class Stage {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #open = new Map<string, { scene: string | null; lastSeq: string }>(); // `${인물}|${이벤트}|${장소}`

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  step(world: World, t: number, view: StageView): { [who: string]: { event: string; place: string; scene: string; lines: string[] }[] } {
    const out: Record<string, { event: string; place: string; scene: string; lines: string[] }[]> = {};
    const instancesOf = (d: string): string[] => world.instances().filter((i) => world.defOfInstance(i) === d);
    for (const id of Object.keys(this.#db.defs).filter((x) => x.startsWith('EVT')).sort()) {
      const def = this.#db.defs[id];
      const core = def === undefined ? null : coreOf(def);
      if (def === undefined || core === null) continue;
      const sense = senseOf(this.#vocab, core.feature);
      for (const place of instancesOf(core.def).sort()) {
        for (const who of world.instances().filter((i) => i.startsWith('CHR')).sort()) {
          const k = `${who}|${id}|${place}`;
          const lad = view.ladder(who, place, core.feature);
          const groups = closeKeys(def, place, instancesOf);
          const closes = groups.every((g) => g.some((x) => x.p.cond !== null && levelMatches(this.#vocab, x.p.feature, world.level(x.key), x.p.cond)));
          const cur = this.#open.get(k);
          if (cur === undefined) {
            if (lad === undefined || closes) continue;
            this.#log.append({ t, type: EVENT_OPENED, src: SCENE_SRC, cause: lad.seq, data: { who, event: id, place } });
            this.#open.set(k, { scene: null, lastSeq: lad.seq });
          } else if (lad === undefined || closes) {
            const cause = closes ? latestSeq(groups.flat().map((x) => world.lastChange(x.key))) : cur.lastSeq;
            this.#log.append({ t, type: EVENT_CLOSED, src: SCENE_SRC, cause, data: { who, event: id, place, reason: closes ? 'closes' : 'ladder' } });
            this.#open.delete(k);
            continue;
          }
          const state = this.#open.get(k);
          if (state === undefined || lad === undefined || sense === null) continue;
          state.lastSeq = lad.seq;
          const m = view.mode(who);
          const ctx: SceneContext = { ...view.context(who), ...view.ladderMind(who, place, core.feature) };
          const picked = pickSceneWhy(def.scenes ?? [], sense, lad.rung, dayPartOf(this.#vocab, t), m?.mode ?? null, { vocab: this.#vocab, t, ctx });
          const sc = picked?.scene ?? null;
          if (sc !== null && sc.name !== state.scene) {
            this.#log.append({
              t,
              type: SCENE_SHOWN,
              src: SCENE_SRC,
              cause: latestSeq([lad.seq, m?.seq, ...(picked?.seqs ?? [])]),
              data: { who, event: id, place, scene: sc.name, rung: lad.rung, ...(dayPartOf(this.#vocab, t) !== null ? { day_part: dayPartOf(this.#vocab, t) as string } : {}), ...(m !== undefined ? { mode: m.mode } : {}), lines: [...sc.lines] },
            });
            state.scene = sc.name;
          }
          if (sc !== null) (out[who] ??= []).push({ event: id, place, scene: sc.name, lines: [...sc.lines] });
        }
      }
    }
    return out;
  }
}
