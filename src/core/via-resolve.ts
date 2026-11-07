// via가 가리키는 것이 저장소에 실제로 있는가 (docs/영수증-명세.md 7장)
// 엔진이 적은 참조가 지어낸 말이 아닌지 확인한다. 영수증 감사(규칙과 맞는가)도 이 함수로 규칙을 찾는다.

import type { Db } from './db.ts';
import { effectiveProgress } from './kinds.ts';
import { spreadRules } from './spread.ts';
import { parseVia } from './via.ts';
import type { Via } from './via.ts';
import type { Vocab } from './vocab.ts';

export interface ViaResolver {
  /** 근거가 실제로 있으면 읽은 값, 아니면 null. */
  resolve(text: string): Via | null;
}

/** 저장소와 사전에서 via를 찾아 주는 도구. 번짐 규칙(통로에서 만든 규칙)은 한 번만 만들어 둔다. */
export function viaResolver(db: Db, vocab: Vocab): ViaResolver {
  const generated = new Set(spreadRules(db, vocab).map((r) => `${r.owner}/${r.key}`));
  return {
    resolve(text) {
      const v = parseVia(text);
      if (v === null) return null;
      const def = db.defs[v.owner];
      if (def === undefined) return null;
      switch (v.kind) {
        case 'rule':
          return def.rules?.[v.key] !== undefined || generated.has(`${v.owner}/${v.key}`) ? v : null;
        case 'offer':
          return def.offers?.[v.key] !== undefined ? v : null;
        case 'progress':
          return effectiveProgress(db, v.owner).full.some((p) => p.feature === v.key) ? v : null;
        case 'sense':
          return def.senses?.[v.key] !== undefined ? v : null;
      }
    },
  };
}
