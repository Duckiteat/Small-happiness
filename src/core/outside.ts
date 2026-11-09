// 밖의 하루 (4a 외부계, 인물-명세 7장, 작가 2026-11-09: 예시 카드 5장, 하루 1~2장을 시드 난수로, 귀가 순간 한 번에)
//
// 직장은 시뮬레이션하지 않고 요약 카드(사전 outside_card)를 뽑는다. 뽑기는 개입(4a층, 시드 난수)이라 원인이 없다.
// 카드의 영향은 인과다: 귀가하는 단계에 지각 층이 내면(감정 축·컨디션)에 반영한다 — 영향은 내면으로만 들어온다.
//   - shifts: 카드에 적힌 칸만큼 (예: 회의가 이어짐 → 에너지 −1).
//   - tone: 감정과 같은 규칙 (condition.ts emotionCondition) — 좋으면 여유 +1, 싫으면 여유로 버티거나 긴장이 쌓인다
//     (여유가 빠듯하면, 안심되지 않으면 더).
// 시나리오가 그 구간의 카드를 정해 두면(outside) 뽑지 않고 그것을 쓴다 (시험·연출용).

import { emotionCondition, stepped } from './condition.ts';
import type { Change } from './condition.ts';
import type { MindDef } from './db.ts';
import type { Rng } from './rng.ts';
import type { Vocab } from './vocab.ts';

export const OUTSIDE_DAY_DONE = 'outside_day_done';

export interface CardDef {
  readonly key: string;
  readonly tone: string;
  readonly shifts: { readonly [feature: string]: number };
}

/** 사전의 밖의 하루 카드 (키 순). */
export function cardDefs(vocab: Vocab): CardDef[] {
  return vocab.keys('outside_card').sort().flatMap((key) => {
    const a = vocab.entry('outside_card', key)?.attrs ?? {};
    const sh = a['shifts'];
    if (typeof a['tone'] !== 'string' || typeof sh !== 'object' || sh === null || Array.isArray(sh)) return [];
    return [{ key, tone: a['tone'], shifts: Object.fromEntries(Object.entries(sh).flatMap(([f, n]) => (typeof n === 'number' ? [[f, n] as const] : []))) }];
  });
}

/** 이 상황이 끝나면 카드를 몇 장 뽑나 (사전 presence의 cards). 뽑지 않는 상황이면 null. */
export function cardRange(vocab: Vocab, presence: string): { readonly min: number; readonly max: number } | null {
  const c = vocab.entry('presence', presence)?.attrs['cards'];
  if (typeof c !== 'object' || c === null || Array.isArray(c) || typeof c['min'] !== 'number' || typeof c['max'] !== 'number') return null;
  return { min: c['min'], max: c['max'] };
}

/** 카드 뽑기 (개입): min~max장, 겹치지 않게, 사전의 키 순 목록에서. 같은 시드면 같은 카드. */
export function drawCards(vocab: Vocab, range: { readonly min: number; readonly max: number }, rng: Rng): string[] {
  const left = cardDefs(vocab).map((c) => c.key);
  const n = Math.min(left.length, range.min + rng.int(range.max - range.min + 1));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(...left.splice(rng.int(left.length), 1));
  return out;
}

/** 인물 안에서 그 특징의 상태 키 (부위를 찾는다). 없으면 null. */
function keyOf(who: string, feature: string, keys: readonly string[]): string | null {
  return keys.find((k) => k.startsWith(`${who}|`) && k.endsWith(`:${feature}`)) ?? null;
}

/**
 * 귀가할 때 카드들이 내면에 남기는 변화 (카드 순서대로, 같은 키를 두 번 옮기면 두 번 나온다).
 * keys: 그 인물의 상태 키들. tense: 안정이 mind.tense_at 이하인지는 그때의 상태로 다시 본다.
 */
export function cardChanges(vocab: Vocab, mind: MindDef | undefined, who: string, cards: readonly string[], keys: readonly string[], level: (key: string) => string): Change[] {
  const defs = cardDefs(vocab);
  const local = new Map<string, string>();
  const cur = (k: string): string => local.get(k) ?? level(k);
  const out: Change[] = [];
  const set = (k: string, to: string): void => {
    if (to === cur(k)) return;
    local.set(k, to);
    out.push({ key: k, to });
  };
  for (const key of cards) {
    const card = defs.find((c) => c.key === key);
    if (card === undefined) continue;
    for (const f of Object.keys(card.shifts).sort()) {
      const k = keyOf(who, f, keys);
      if (k !== null) set(k, stepped(vocab, f, cur(k), card.shifts[f] ?? 0));
    }
    if (card.tone === 'neutral') continue;
    const stab = vocab.keys('feature').sort().find((f) => vocab.entry('feature', f)?.attrs['axis'] === 'stability');
    const sk = stab === undefined ? null : keyOf(who, stab, keys);
    const rung = sk === null || stab === undefined ? -1 : Math.max(0, vocab.levelOrder(stab)?.indexOf(cur(sk)) ?? 0);
    const tense = mind !== undefined && rung >= 0 && rung <= mind.tense_at;
    for (const c of emotionCondition(vocab, who, card.tone, tense, (k) => keys.includes(k), cur)) set(c.key, c.to);
  }
  return out;
}
