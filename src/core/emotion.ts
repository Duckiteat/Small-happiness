// ③ 감정 (내면-설계 10장, 작가 2026-11-09): "공감각 심상들 위에서 생각과 합쳐서 만들어지는 게 감정".
//
// 감정의 축은 셋이다: 쾌 · 불쾌 · 예측할 수 있음에 대한 안정 (사전 feature의 axis). 쾌와 불쾌는 따로 쌓인다.
// 여유·긴장은 축이 아니라 안정에서 읽는다: 안심되지 않을수록(안정이 낮을수록) 불쾌가 더 크게 오른다.
//
// 생각은 세 가지를 합친다.
//   1. 무엇에서 왔는지: 심상의 감각질을 준 물건 하나 — 가장 가까이 느낀 것 (입 > 손 > 멀리서 보임, 같으면 심상의 재료 순).
//      장소의 공기에서만 오면 모른다.
//   2. 생각(며칠 가는 기억): 겪은 일(심상 + 무엇에서). 인물의 thought_days 동안 남고 그 뒤에는 잊는다.
//   3. 감정이 붙은 기억: 그 일이 감각을 넘어 감정과 이어지면(쾌·불쾌가 binds_at 이상) 잊지 않는다.
//      같은 것에서 결이 다른 감정이 오면 덧씌운다 (좋은 기억 위에 실망, 싫은 기억 위에 안도).
// 감정은 사전 emotion에서 (심상의 결 tone, 생각 thought)으로 하나가 정해진다. 기억에서 오는 감정은 기억 그대로다 (그리움).
// 쾌·불쾌는 감정이 움직이고, 안정(예측할 수 있음)은 생각이 움직인다: 처음이면 내려가고, 겪어 봤거나 기억대로면 오르고, 어긋나면 내려간다.
// 불쾌가 높고 안정이 낮으면 스트레스 임계(overwhelm): 생각하고 해석하지 못한다 — 심상과 몸의 반응은 그대로 오지만 감정이 생기지 않는다.
// 난수 없음. 지각 층과 감사가 같은 계산을 쓴다.

import type { MindDef } from './db.ts';
import type { Vocab } from './vocab.ts';

export const EMOTION_FORMED = 'emotion_formed';
export const MEMORY_FORMED = 'memory_formed';
export const OVERWHELMED = 'overwhelmed';
/** 감정의 축이 담기는 인물의 부위 (인물 정의의 slots). */
export const MOOD_SLOT = 'mood';
const DAY_MIN = 1440;

export type Axis = 'pleasure' | 'displeasure' | 'stability';
export type Thought = 'new' | 'familiar' | 'against' | 'recalled';

export interface EmotionDef {
  readonly key: string;
  readonly tone: string;
  readonly thought?: string;
  readonly shifts: { readonly [feature: string]: number };
}

/** 겪은 일 (생각): 그 심상을 무엇에서 언제. */
export interface Episode {
  readonly image: string;
  readonly of: readonly string[];
  readonly t: number;
}

export interface MemoryChange {
  readonly of: string;
  readonly emotion: string;
  readonly replaces?: string;
}

export interface Appraisal {
  readonly emotion: string;
  readonly thought: Thought;
  /** 무엇에서 왔다고 아는지 (정의 번호, 번호 순) */
  readonly of: readonly string[];
  readonly memories: readonly MemoryChange[];
  /** 감정 축의 바뀐 칸 (상태 키 → 단계 키, 특징 키 순) */
  readonly changes: readonly { readonly key: string; readonly to: string }[];
  /** 이 감정으로 스트레스 임계를 넘었나 */
  readonly overwhelms: boolean;
}

export function emotionDefs(vocab: Vocab): EmotionDef[] {
  return vocab.keys('emotion').sort().flatMap((key) => {
    const a = vocab.entry('emotion', key)?.attrs ?? {};
    const sh = a['shifts'];
    if (typeof a['tone'] !== 'string' || typeof sh !== 'object' || sh === null || Array.isArray(sh)) return [];
    const shifts = Object.fromEntries(Object.entries(sh).flatMap(([f, n]) => (typeof n === 'number' ? [[f, n] as const] : [])));
    return [{ key, tone: a['tone'], ...(typeof a['thought'] === 'string' ? { thought: a['thought'] } : {}), shifts }];
  });
}

/** 심상의 결 (좋은·싫은). 없으면 감정이 생기지 않는다. */
export function toneOf(vocab: Vocab, image: string): string | undefined {
  const t = vocab.entry('image', image)?.attrs['tone'];
  return typeof t === 'string' ? t : undefined;
}

/** 감정의 축을 담는 내면 특징 (사전 feature의 axis). */
export function axisFeature(vocab: Vocab, axis: Axis): string | undefined {
  return vocab.keys('feature').sort().find((k) => vocab.entry('feature', k)?.attrs['axis'] === axis);
}

export function moodKey(who: string, feature: string): string {
  return `${who}|${MOOD_SLOT}:${feature}`;
}

/** 그 사람이 생각을 기억하는 날 수 (지금은 min — 무엇이 그날을 정하는지는 미정). */
export function thoughtDays(mind: MindDef): number {
  return mind.thought_days.min;
}

/** 아직 잊지 않은 생각 (thought_days 안). */
export function remembered(mind: MindDef, episodes: readonly Episode[], t: number): Episode[] {
  return episodes.filter((e) => e.t >= t - thoughtDays(mind) * DAY_MIN);
}

function rungOf(vocab: Vocab, feature: string, level: string): number {
  return Math.max(0, vocab.levelOrder(feature)?.indexOf(level) ?? 0);
}

/** 스트레스 임계: 불쾌가 높고 안정이 낮다 → 생각하고 해석하지 못한다. */
export function isOverwhelmed(vocab: Vocab, mind: MindDef, who: string, level: (key: string) => string): boolean {
  const d = axisFeature(vocab, 'displeasure'), s = axisFeature(vocab, 'stability');
  if (d === undefined || s === undefined) return false;
  return rungOf(vocab, d, level(moodKey(who, d))) >= mind.overwhelm.displeasure_at_least && rungOf(vocab, s, level(moodKey(who, s))) <= mind.overwhelm.stability_at_most;
}

/**
 * 심상 + 생각 → 감정. 무엇에서 왔는지(of), 아직 잊지 않은 생각(episodes), 감정이 붙은 기억(memories: 정의 → 감정)과 지금의 축으로 정한다.
 * 결이 없는 심상이거나 맞는 감정이 사전에 없으면 null.
 */
export function appraise(vocab: Vocab, mind: MindDef, who: string, image: string, of: readonly string[], t: number, episodes: readonly Episode[], memories: ReadonlyMap<string, string>, level: (key: string) => string): Appraisal | null {
  const tone = toneOf(vocab, image);
  if (tone === undefined) return null;
  const defs = emotionDefs(vocab);
  const rule = (th: string): EmotionDef | undefined => defs.find((d) => d.tone === tone && d.thought === th);
  const known = of.find((d) => memories.has(d));
  let emotion: EmotionDef | undefined;
  let thought: Thought;
  const memoryChanges: MemoryChange[] = [];
  if (known !== undefined) {
    const before = memories.get(known) as string;
    const mem = defs.find((d) => d.key === before);
    if (mem !== undefined && mem.tone === tone) {
      emotion = mem;
      thought = 'recalled';
    } else {
      emotion = rule('against');
      thought = 'against';
      if (emotion !== undefined) memoryChanges.push({ of: known, emotion: emotion.key, replaces: before });
    }
  } else {
    const familiar = of.length > 0 && remembered(mind, episodes, t).some((e) => e.image === image && e.of.some((d) => of.includes(d)));
    thought = familiar ? 'familiar' : 'new';
    emotion = rule(thought);
  }
  if (emotion === undefined) return null;
  // 축을 움직인다: 쾌·불쾌는 감정이, 안정은 생각이 (사전 by_thought). 안정이 tense_at 이하(긴장)면 불쾌가 한 칸 더
  const stab = axisFeature(vocab, 'stability'), disp = axisFeature(vocab, 'displeasure'), pleas = axisFeature(vocab, 'pleasure');
  const tense = stab !== undefined && rungOf(vocab, stab, level(moodKey(who, stab))) <= mind.tense_at;
  const moves = new Map<string, number>();
  for (const [f, n] of Object.entries(emotion.shifts)) moves.set(f, n + (f === disp && tense && n > 0 ? 1 : 0));
  const byThought = stab === undefined ? undefined : vocab.entry('feature', stab)?.attrs['by_thought'];
  const sn = typeof byThought === 'object' && byThought !== null && !Array.isArray(byThought) ? byThought[thought] : undefined;
  if (stab !== undefined && typeof sn === 'number' && sn !== 0) moves.set(stab, sn);
  const after = new Map<string, number>();
  const changes: { key: string; to: string }[] = [];
  for (const f of [...moves.keys()].sort()) {
    const open = (vocab.levelOrder(f) ?? []).filter((l) => !vocab.isLocked(f, l));
    const ladder = vocab.levelOrder(f) ?? [];
    const cur = level(moodKey(who, f));
    const pos = Math.min(open.length - 1, Math.max(0, open.indexOf(cur) + (moves.get(f) ?? 0)));
    const to = open[pos] ?? cur;
    after.set(f, ladder.indexOf(to));
    if (to !== cur) changes.push({ key: moodKey(who, f), to });
  }
  // 감각을 넘어 감정과 이어진 일은 잊지 않는다: 쾌나 불쾌가 binds_at 이상이 되면 (무엇에서 왔는지 알 때만)
  if (thought === 'new' || thought === 'familiar') {
    const strong = [pleas, disp].some((f) => f !== undefined && (emotion?.shifts[f] ?? 0) > 0 && (after.get(f) ?? 0) >= mind.binds_at);
    if (strong) for (const d of of) memoryChanges.push({ of: d, emotion: emotion.key });
  }
  const lvl = (key: string): string => changes.find((c) => c.key === key)?.to ?? level(key);
  return { emotion: emotion.key, thought, of: [...of], memories: memoryChanges, changes, overwhelms: isOverwhelmed(vocab, mind, who, lvl) };
}

/**
 * 무엇에서 왔다고 아는지: 심상의 감각질을 준 물건 중 가장 가까이 느낀 것 하나의 정의 — 입 > 손 > 멀리서 보임,
 * 같으면 심상의 재료 순. 장소의 공기만이면 무엇인지 모른다 (빈 목록).
 */
export function cueOf(parts: readonly { readonly source: string | undefined; readonly reach: string }[], defOfInstance: (i: string) => string | undefined): string[] {
  const order = ['mouth', 'contact', 'distance'];
  const things = parts.filter((p) => p.source !== undefined && p.source.startsWith('OBJ') && order.includes(p.reach));
  const best = [...things].sort((a, b) => order.indexOf(a.reach) - order.indexOf(b.reach))[0];
  const def = best?.source === undefined ? undefined : defOfInstance(best.source);
  return def === undefined ? [] : [def];
}
