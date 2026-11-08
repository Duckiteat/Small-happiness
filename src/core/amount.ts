// 쓰는 양 (요리-설계 3장): 행동의 uses는 그 상태를 지금 단계에서 열린 칸으로 steps칸 내린다.
// 잠긴 칸은 건너뛴다. 남은 칸이 모자라면 쓸 수 없다 (null). 행동 층과 감사가 같은 계산을 쓴다.

import type { Vocab } from './vocab.ts';

/** 열린(잠기지 않은) 칸만의 사다리. */
export function openLadder(vocab: Vocab, feature: string): string[] {
  return (vocab.levelOrder(feature) ?? []).filter((k) => !vocab.isLocked(feature, k));
}

/** level에서 steps칸 내린 단계. 사다리에 없는 단계(소멸 등)이거나 모자라면 null. */
export function stepDown(vocab: Vocab, feature: string, level: string, steps: number): string | null {
  const ladder = openLadder(vocab, feature);
  const i = ladder.indexOf(level);
  if (i < 0 || i - steps < 0) return null;
  return ladder[i - steps] ?? null;
}
