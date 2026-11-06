// 시간 모델: 다음 단계는 언제 도는가 (docs/결정-기록.md 4장 "시간 모델")
//
// 플레이어가 보지 않는 시간(하루씨가 외출했거나 자는 동안)과 보는 시간(집에 깨어 있음)을 나눈다.
//   - 보지 않는 시간: 구간 시작부터 일정한 간격(UNOBSERVED_STEP_MIN)마다 한 단계, 그리고 구간이 끝나는 순간
//     (귀가·기상) 한 단계. 귀가 장면은 그 순간의 판으로 그린다.
//   - 보는 시간: 정해진 간격이 없다. 행동이나 장면이 끝날 때 한 단계를 돈다 (행동 층이 생기면 그 끝 시각이 들어온다).
//   - 구간의 경계(나감·잠듦·귀가·기상)는 항상 한 단계다.
// 간격은 "보는 때"일 뿐 "변하는 때"가 아니다. 그 사이에 언제 임계를 넘었는지는 3층이 정확한 시각으로 계산해야 하며,
// 그래서 간격을 바꿔도 세계의 결과는 같아야 한다 (3층 구현의 완료 조건).
//
// 일정(plan)은 4a층이 쓰고, 시계(0층)는 직전 단계의 일정을 읽어 다음 시각을 정한다 (되먹임 길 F5).

import type { BoardValue } from './board.ts';
import type { Vocab } from './vocab.ts';

/** 보지 않는 시간의 단계 간격(분). 임시값 tuned:false — 결정-기록 4장. */
export const UNOBSERVED_STEP_MIN = 180;

/** 보는 시간의 상태 키 (사전 presence). 일정 구간이 없는 시간은 모두 이것이다. */
export const OBSERVED = 'home';

export interface PlanBlock {
  /** 사전 presence의 키 (보는 시간 `home`은 구간으로 쓰지 않는다). */
  readonly kind: string;
  /** 시작 시각(분, 포함) */
  readonly from: number;
  /** 끝 시각(분, 제외) */
  readonly to: number;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

function isObj(v: unknown): v is { readonly [key: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 판의 plan 값(또는 시나리오의 일정)을 구간 목록으로 해석한다. 중립값 `{}`는 구간 없음.
 * 구간은 시간 순으로 겹치지 않아야 하고, 종류는 사전 presence에 있어야 한다.
 */
export function parsePlan(value: BoardValue | unknown, vocab: Vocab): PlanBlock[] {
  if (!isObj(value)) throw new ScheduleError('plan은 객체여야 한다');
  const raw = value['blocks'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ScheduleError('plan.blocks는 목록이어야 한다');
  const blocks = raw.map((b: unknown, i): PlanBlock => {
    const at = `plan.blocks[${i}]`;
    if (!isObj(b)) throw new ScheduleError(`${at}: { kind, from, to }이어야 한다`);
    const { kind, from, to } = b;
    if (typeof kind !== 'string' || !vocab.has('presence', kind)) throw new ScheduleError(`${at}: 사전 presence에 없는 종류다 (${String(kind)})`);
    if (kind === OBSERVED) throw new ScheduleError(`${at}: ${OBSERVED}는 구간으로 쓰지 않는다 (구간 밖이 곧 ${OBSERVED})`);
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to) || from < 0) {
      throw new ScheduleError(`${at}: from과 to는 0 이상의 정수(분)여야 한다`);
    }
    if (from >= to) throw new ScheduleError(`${at}: 끝(${to})이 시작(${from})보다 뒤여야 한다`);
    return { kind, from, to };
  });
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks.at(i - 1) as PlanBlock;
    const b = blocks.at(i) as PlanBlock;
    if (b.from < a.to) throw new ScheduleError(`plan.blocks[${i}]: 앞 구간과 겹치거나 시간 순이 아니다 (${a.from}–${a.to}, ${b.from}–${b.to})`);
  }
  return blocks;
}

/** 시각 t에 하루씨는 어떤 상태인가 (presence 키). */
export function presenceAt(blocks: readonly PlanBlock[], t: number): string {
  return blocks.find((b) => b.from <= t && t < b.to)?.kind ?? OBSERVED;
}

/**
 * now 다음의 단계 시각. end를 넘으면 null (하루를 마친다).
 * @param actionEnds 보는 시간에 끝나는 행동·장면의 시각들 (행동 층이 생기기 전에는 빈 목록)
 */
export function nextStepTime(
  blocks: readonly PlanBlock[],
  now: number,
  end: number,
  actionEnds: readonly number[] = [],
  stepMin: number = UNOBSERVED_STEP_MIN,
): number | null {
  if (!Number.isInteger(stepMin) || stepMin <= 0) throw new ScheduleError(`간격은 양의 정수(분)여야 한다: ${stepMin}`);
  const candidates: number[] = [end];
  for (const b of blocks) {
    candidates.push(b.from, b.to);
    if (b.from <= now && now < b.to) candidates.push(b.from + stepMin * (Math.floor((now - b.from) / stepMin) + 1));
  }
  for (const t of actionEnds) if (presenceAt(blocks, t) === OBSERVED) candidates.push(t);
  const next = Math.min(...candidates.filter((t) => t > now));
  return Number.isFinite(next) && next <= end ? next : null;
}
