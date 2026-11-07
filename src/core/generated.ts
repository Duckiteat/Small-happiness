// 데이터에서 만든 규칙 (docs/번짐-명세.md · docs/냄새-모델.md)
// 손으로 쓴 규칙이 아니라 장소 그래프(번짐)와 냄새 사슬(냄새 종류)에서 계산한 규칙. 인과·감사·근거 찾기가 같은 목록을 쓴다.

import type { Db } from './db.ts';
import { odorRules } from './odor.ts';
import { spreadRules } from './spread.ts';
import type { SpreadRule } from './spread.ts';
import type { Vocab } from './vocab.ts';

export function generatedRules(db: Db, vocab: Vocab): SpreadRule[] {
  return [...spreadRules(db, vocab), ...odorRules(db, vocab)];
}
