// 온도 읽기 (docs/온도-읽기.md): 온도는 두 축으로 저장한다.
//   - temp: 놓인 곳의 보관 온도 구간 (냉동 · 냉장 · 실온 …)
//   - heat: 가열해서 오른 온도 (따뜻함 · 뜨거움 · 끓음 · 튀김). 없음이면 가열되지 않은 것
// "지금 몇 도인가"는 항상 이 함수로 읽는다: heat가 없음 위면 heat, 아니면 temp. 한 곳에서 정해 두어 읽는 쪽마다 다르게 읽지 않는다.
// 입출력이 없는 순수 함수이고 음식의 이름 같은 사실은 모른다 (단계 키와 사전의 순서만 쓴다).

import type { Vocab } from './vocab.ts';

export type TemperatureBand = 'storage' | 'heat';

export interface Temperature {
  /** 어느 축으로 읽었나 */
  readonly band: TemperatureBand;
  /** 그 축의 단계 키 */
  readonly level: string;
}

export const STORAGE_FEATURE = 'temp';
export const HEAT_FEATURE = 'heat';

/** 보관 온도와 가열 온도에서 지금 온도를 읽는다. heat가 사다리 0칸(없음)이거나 소멸·알 수 없는 단계면 보관 온도다. */
export function readTemperature(vocab: Vocab, temp: string, heat: string | undefined): Temperature {
  const idx = heat === undefined ? -1 : (vocab.levelOrder(HEAT_FEATURE) ?? []).indexOf(heat);
  return idx > 0 && heat !== undefined ? { band: 'heat', level: heat } : { band: 'storage', level: temp };
}
