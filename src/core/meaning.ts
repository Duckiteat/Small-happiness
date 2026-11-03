// 상태 의미 (docs/DB-개념-이식.md 1-2 · 원 설계: 정의항의 "상태 의미 규칙")
//
// 같은 상태 값이 그 정의에게 무엇을 뜻하는지는 정의가 소유한다. 위에서부터 보아 처음 맞는 의미가 답이다.
// 예) 음식: 상함 ≤ 1 → "먹을 수 있음", 그 밖 → "먹을 수 없음".
// 새 오브젝트 종류를 코드로 만들지 않고 데이터만으로 상태의 뜻을 바꾼다.

import type { Definition, MeaningDef } from './db.ts';
import { condRange, parseLocalCondition } from './statekey.ts';

/**
 * @param levels 키 `부위:특징` → 단계(정수). 없는 키는 0으로 본다.
 * @returns 처음 맞는 의미. 하나도 맞지 않으면 undefined (기본값이 없는 정의).
 */
export function meaningOf(def: Definition, levels: Readonly<Record<string, number>>): MeaningDef | undefined {
  for (const meaning of def.meanings ?? []) {
    const matches = meaning.when.every((w) => {
      const c = parseLocalCondition(w);
      if (c === null) return false;
      const level = levels[`${c.slot}:${c.feature}`] ?? 0;
      const r = condRange(c.cond);
      return level >= r.min && level <= r.max;
    });
    if (matches) return meaning;
  }
  return undefined;
}
