// 시계 (docs/기반층-명세.md 3장)
//
// 코어는 현재 시각을 직접 읽지 않는다. 실제 시각은 `Clock` 으로 주입하고, 시연 모드는 `FakeClock` 을 넘기는 것이다.
// 실제 시계(RealClock)는 src/node 에 있다. 시간대는 고정 오프셋(분)으로 받는다 (서머타임은 다루지 않는다).
// 시간 단위는 분, 고정 틱은 없다: 시간은 행동·대기·약속으로 `advance` 를 부를 때만 흐른다.

export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_WEEK = 7;

/** 설정값. 기본은 한국 시간대(+09:00), 하루 경계 04:00. */
export interface ClockConfig {
  /** UTC 와의 차이, 분 (한국 +540) */
  readonly tzOffsetMin: number;
  /** 현지 하루 경계, 자정으로부터의 분 (04:00 = 240) */
  readonly boundaryMin: number;
}

export const DEFAULT_CLOCK_CONFIG: ClockConfig = { tzOffsetMin: 540, boundaryMin: 240 };

/** 현재 시각을 돌려주는 주입 지점. 단위는 epoch 밀리초. */
export interface Clock {
  now(): number;
}

/** 시험·시연용 시계. 코어와 같은 인터페이스라 그대로 갈아 끼운다. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(startMs: number) {
    if (!Number.isInteger(startMs)) throw new RangeError('시작 시각은 정수 밀리초여야 한다');
    this.#ms = startMs;
  }

  now(): number {
    return this.#ms;
  }

  set(ms: number): void {
    if (!Number.isInteger(ms)) throw new RangeError('시각은 정수 밀리초여야 한다');
    this.#ms = ms;
  }

  advanceMinutes(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError('분은 0 이상 정수여야 한다');
    this.#ms += minutes * 60_000;
  }

  advanceDays(days: number): void {
    this.advanceMinutes(days * MINUTES_PER_DAY);
  }
}

function assertConfig(cfg: ClockConfig): void {
  if (!Number.isInteger(cfg.tzOffsetMin) || Math.abs(cfg.tzOffsetMin) > 14 * 60) {
    throw new RangeError(`시간대 오프셋은 -840~840 분 정수여야 한다: ${cfg.tzOffsetMin}`);
  }
  if (!Number.isInteger(cfg.boundaryMin) || cfg.boundaryMin < 0 || cfg.boundaryMin >= MINUTES_PER_DAY) {
    throw new RangeError(`하루 경계는 0~1439 분 정수여야 한다: ${cfg.boundaryMin}`);
  }
}

/**
 * 실제 시각이 속한 "게임 하루"의 번호. 하루 경계(현지 04:00)에서 번호가 바뀐다.
 * 경계 직전(03:59)은 전날, 경계 정각(04:00)부터 다음 날이다.
 */
export function realDayIndex(epochMs: number, cfg: ClockConfig): number {
  assertConfig(cfg);
  if (!Number.isInteger(epochMs)) throw new RangeError('시각은 정수 밀리초여야 한다');
  const minutes = Math.floor(epochMs / 60_000);
  return Math.floor((minutes + cfg.tzOffsetMin - cfg.boundaryMin) / MINUTES_PER_DAY);
}

export interface OpenDayResult {
  readonly opens: boolean;
  /** 건너뛴 날 수 (마지막으로 닫은 날과 오늘 사이에 낀 날). 열리지 않으면 0 */
  readonly absentDays: number;
  /** 지금 시각이 속한 하루 번호. 하루를 닫을 때 `lastClosedDay` 로 넘긴다 */
  readonly realDay: number;
}

/**
 * 하루를 열 수 있는가. 마지막으로 닫은 날의 다음 경계(04:00) 이후여야 열린다.
 * 한 번도 닫은 적이 없으면(`null`) 열린다.
 */
export function openDay(nowMs: number, lastClosedDay: number | null, cfg: ClockConfig): OpenDayResult {
  const today = realDayIndex(nowMs, cfg);
  if (lastClosedDay === null) return { opens: true, absentDays: 0, realDay: today };
  if (!Number.isInteger(lastClosedDay)) throw new RangeError('마지막으로 닫은 날은 정수 번호여야 한다');
  if (today <= lastClosedDay) return { opens: false, absentDays: 0, realDay: today };
  return { opens: true, absentDays: today - lastClosedDay - 1, realDay: today };
}

/** 부재 보정으로 변화 규칙에 넘길 분. `absence{ dt }` 의 dt. */
export function absenceMinutes(absentDays: number): number {
  if (!Number.isInteger(absentDays) || absentDays < 0) throw new RangeError('부재 일수는 0 이상 정수여야 한다');
  return absentDays * MINUTES_PER_DAY;
}

/** 게임 시각: 주차, 하루(1..7), 하루 안의 분(0..1439), 절대 분. */
export interface GameTime {
  readonly week: number;
  readonly day: number;
  readonly minute: number;
  readonly abs: number;
}

export function makeTime(week: number, day: number, minute: number): GameTime {
  if (!Number.isInteger(week) || week < 1) throw new RangeError(`주차는 1 이상 정수여야 한다: ${week}`);
  if (!Number.isInteger(day) || day < 1 || day > DAYS_PER_WEEK) throw new RangeError(`하루는 1~${DAYS_PER_WEEK}: ${day}`);
  if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) throw new RangeError(`분은 0~${MINUTES_PER_DAY - 1}: ${minute}`);
  return { week, day, minute, abs: ((week - 1) * DAYS_PER_WEEK + (day - 1)) * MINUTES_PER_DAY + minute };
}

export interface AdvanceResult {
  readonly time: GameTime;
  /** 실제로 흐른 분 */
  readonly advanced: number;
  /** 하루 끝(1439분)을 넘어서 못 흐른 분. 0보다 크면 호출한 쪽이 하루를 닫아야 한다 */
  readonly overflow: number;
}

/** 게임 시각을 `dt` 분 흘린다. 하루 끝을 넘으면 거기서 멈추고 넘친 분을 알려준다. */
export function advance(time: GameTime, dt: number): AdvanceResult {
  if (!Number.isInteger(dt) || dt < 0) throw new RangeError(`흐를 분은 0 이상 정수여야 한다: ${dt}`);
  const room = MINUTES_PER_DAY - 1 - time.minute;
  const advanced = Math.min(dt, room);
  return { time: makeTime(time.week, time.day, time.minute + advanced), advanced, overflow: dt - advanced };
}

export interface CloseDayResult {
  /** 다음 하루의 시작 (분 0) */
  readonly next: GameTime;
  /** 7일째를 닫아 1일차로 돌아갔는가 (이때 `week_close` 사건을 낸다) */
  readonly weekClosed: boolean;
}

/** 스토리 일차는 하루를 닫을 때만 오른다. 7일째를 닫으면 주를 마감하고 다음 주 1일차로 돌아간다. */
export function closeDay(time: GameTime): CloseDayResult {
  if (time.day >= DAYS_PER_WEEK) return { next: makeTime(time.week + 1, 1, 0), weekClosed: true };
  return { next: makeTime(time.week, time.day + 1, 0), weekClosed: false };
}
