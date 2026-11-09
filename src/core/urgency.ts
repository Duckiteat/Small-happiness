// 긴박함 (S6, 작가 2026-11-09: "이건 하루라는 사람 세팅에 가까운데 조율해 보자")
//
// 하루씨의 설정 (인물 정의 senses의 unbearable · endure_min · habituate_min, 임시값):
//   - 머무는 곳의 공기를 unbearable 칸 이상으로 느끼면 못 참는다 (지독함부터). urgency_felt(on)
//   - 못 참는 동안: 하던 쉼을 끊고(action_stopped), 냄새를 없애려는 행동(사전 action의 against_odor: 살피기·버리기·환기)을 먼저 한다.
//     방전이어도 그것은 한다.
//   - 맡는 동안 endure_min분마다 긴장 +1 (urgency_endured) — 쌓이면 터짐으로 이어진다.
//   - habituate_min분 계속 맡으면 둔해진다 (urgency_felt off, habituated): 그 냄새가 못 참는 칸 아래로 내려갔다 다시 오를 때까지 못 참지 않는다.
//   - 냄새가 못 참는 칸 아래로 내려가면 그친다 (urgency_felt off, gone). 집을 나서면(지각하지 않는 상황) 그친다 (away).
// 난수 없음. 지각 층·행동 층과 감사가 같은 계산을 쓴다.

import type { Db, SenseDef } from './db.ts';
import type { Vocab } from './vocab.ts';

export const URGENCY_FELT = 'urgency_felt';
export const URGENCY_ENDURED = 'urgency_endured';
export const ACTION_STOPPED = 'action_stopped';

/** 그 상태 키를 느끼는 감각의 긴박함 설정. 없으면 null. */
export function urgencySense(db: Db, vocab: Vocab, characterDef: string, feature: string): (SenseDef & { readonly unbearable: number; readonly endure_min: number; readonly habituate_min: number }) | null {
  const attrs = vocab.entry('feature', feature)?.attrs ?? {};
  const sense = attrs['sense'];
  // 세기의 특징만 (종류 특징은 심상 사다리를 타며 칸 번호가 세기가 아니다)
  if (typeof sense !== 'string' || attrs['ladder'] !== undefined || vocab.entry('sense', sense)?.attrs['reach'] !== 'distance') return null;
  const s = db.defs[characterDef]?.senses?.[sense];
  if (s === undefined || s.unbearable === undefined || s.endure_min === undefined || s.habituate_min === undefined) return null;
  return { ...s, unbearable: s.unbearable, endure_min: s.endure_min, habituate_min: s.habituate_min };
}

/** 못 참는 냄새가 시작된 뒤 t까지 쌓였어야 할 긴장 칸 수 (둔해지는 때까지만). */
export function enduredTotal(s: { readonly endure_min: number; readonly habituate_min: number }, since: number, t: number): number {
  return Math.floor((Math.min(t, since + s.habituate_min) - since) / s.endure_min);
}

/** 오래 맡아 둔해졌나. */
export function isHabituated(s: { readonly habituate_min: number }, since: number, t: number): boolean {
  return t - since >= s.habituate_min;
}

/** 냄새를 없애려는 행동인가 (사전 action의 against_odor). */
export function againstOdor(vocab: Vocab, verb: string): boolean {
  return vocab.entry('action', verb)?.attrs['against_odor'] === true;
}
