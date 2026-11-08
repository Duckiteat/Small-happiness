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

/**
 * 같은 종류가 여럿일 때 쓰는 양은 **하나**에서만 덜어 낸다: 남은 양이 넉넉한 것 중, 그 행동의 조건(같은 정의의 when)에 맞는 것을 먼저,
 * 같으면 번호 순으로 첫 번째. 모두 모자라면 null. 행동 층과 감사가 같은 계산을 쓴다.
 */
export function pickUse(
  vocab: Vocab,
  keys: readonly string[],
  feature: string,
  steps: number,
  levelOf: (key: string) => string,
  preferred: (key: string) => boolean,
): { readonly key: string; readonly to: string } | null {
  const ok = [...keys].sort().flatMap((key) => {
    const to = stepDown(vocab, feature, levelOf(key), steps);
    return to === null ? [] : [{ key, to }];
  });
  return ok.find((u) => preferred(u.key)) ?? ok[0] ?? null;
}
