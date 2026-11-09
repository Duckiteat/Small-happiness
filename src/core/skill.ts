// 숙련 (요리-설계 11장, 작가 2026-11-08): 요리 솜씨 · 손질 솜씨 · 감별을 따로 두고, 재료를 쓸 때마다 쌓인다. 녹슮은 없다.
//
// 숙련은 인물의 내면 특징(사전 feature의 inner)이고 인물 인스턴스의 상태 키(`CHR…#1|skill:cooking`)로 둔다.
// 행동의 trains가 그 행동을 끝낼 때 쌓이는 숙련이다. 쌓이는 양은 그 행동이 재료로 쓴 칸의 수(uses의 ingredient 항목 수),
// 재료를 쓰지 않는 행동(썰기)은 한 번이다. 해 본 횟수가 사전 practice의 경계를 넘으면 칸이 오른다 (난수 없음).
// 횟수는 기록의 행동 끝(action_done)에서 다시 셀 수 있어 감사가 같은 계산을 한다.

import type { OfferDef } from './db.ts';
import type { Vocab } from './vocab.ts';

/** 숙련이 담기는 인물의 부위 (인물 정의의 slots). */
export const SKILL_SLOT = 'skill';

/** 이 행동을 한 번 끝냈을 때 쌓이는 횟수. */
export function practiceGain(offer: OfferDef): number {
  return Math.max(1, (offer.uses ?? []).filter((u) => u.ingredient === true).length);
}

/** 해 본 횟수로 오르는 칸 (사전 practice). practice가 없으면 0칸. */
export function levelForPractice(vocab: Vocab, feature: string, count: number): string {
  const ladder = vocab.levelOrder(feature) ?? [];
  const practice = vocab.entry('feature', feature)?.attrs['practice'];
  if (!Array.isArray(practice)) return ladder[0] ?? '';
  let at = 0;
  practice.forEach((need, i) => {
    if (typeof need === 'number' && count >= need && !vocab.isLocked(feature, ladder[i] ?? '')) at = i;
  });
  return ladder[at] ?? '';
}

/** 쌓인 뒤의 칸: 지금 칸과 해 본 횟수의 칸 중 높은 것 (녹슮이 없어 내려가지 않는다. 처음부터 솜씨가 있는 인물도 그대로). */
export function practicedLevel(vocab: Vocab, feature: string, current: string, count: number): string {
  const ladder = vocab.levelOrder(feature) ?? [];
  const byCount = levelForPractice(vocab, feature, count);
  return ladder.indexOf(current) >= ladder.indexOf(byCount) ? current : byCount;
}

/** 숙련에 따라 줄어든 시간(분, 내림, 최소 1). minutes_by가 없거나 표가 없으면 그대로. */
export function skilledMinutes(vocab: Vocab, offer: OfferDef, levelOf: (feature: string) => string): number {
  if (offer.minutes_by === undefined) return offer.minutes;
  const pct = vocab.entry('feature', offer.minutes_by)?.attrs['minutes_pct'];
  const idx = vocab.levelOrder(offer.minutes_by)?.indexOf(levelOf(offer.minutes_by)) ?? -1;
  const p = Array.isArray(pct) && idx >= 0 ? pct[idx] : 100;
  return Math.max(1, Math.floor((offer.minutes * (typeof p === 'number' ? p : 100)) / 100));
}

/** 인물의 숙련 상태 키. */
export function skillKey(who: string, feature: string): string {
  return `${who}|${SKILL_SLOT}:${feature}`;
}
