import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CLOCK_CONFIG,
  FakeClock,
  absenceMinutes,
  advance,
  closeDay,
  makeTime,
  openDay,
  realDayIndex,
} from '../src/core/clock.ts';

const CFG = DEFAULT_CLOCK_CONFIG; // +09:00, 04:00 경계

/** 현지(+09:00) 날짜·시각을 epoch 밀리초로. */
function local(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00+09:00`);
}

test('하루 경계는 현지 04:00: 03:59는 전날, 04:00부터 다음 날', () => {
  const before = realDayIndex(local('2026-11-03', '03:59'), CFG);
  const at = realDayIndex(local('2026-11-03', '04:00'), CFG);
  const after = realDayIndex(local('2026-11-03', '23:59'), CFG);
  assert.equal(at, before + 1);
  assert.equal(after, at);
  assert.equal(realDayIndex(local('2026-11-04', '03:59'), CFG), at);
  assert.equal(realDayIndex(local('2026-11-04', '04:00'), CFG), at + 1);
});

test('한 번도 닫지 않았으면 열리고, 같은 날 두 번 열 수 없다', () => {
  const now = local('2026-11-03', '09:00');
  const first = openDay(now, null, CFG);
  assert.equal(first.opens, true);
  assert.equal(first.absentDays, 0);
  const again = openDay(local('2026-11-03', '23:00'), first.realDay, CFG);
  assert.equal(again.opens, false);
  const sameAfterMidnight = openDay(local('2026-11-04', '03:30'), first.realDay, CFG);
  assert.equal(sameAfterMidnight.opens, false); // 자정을 넘겨도 04:00 전이면 같은 하루
});

test('다음 날 04:00 이후에는 부재 0일로 열린다', () => {
  const closed = openDay(local('2026-11-03', '09:00'), null, CFG).realDay;
  const next = openDay(local('2026-11-04', '04:00'), closed, CFG);
  assert.deepEqual([next.opens, next.absentDays], [true, 0]);
});

test('이틀·열흘 부재: 건너뛴 날 수와 변화 규칙에 넘길 분', () => {
  const closed = openDay(local('2026-11-03', '09:00'), null, CFG).realDay;
  const two = openDay(local('2026-11-06', '10:00'), closed, CFG); // 4일(11-04,05) 건너뜀
  assert.equal(two.absentDays, 2);
  assert.equal(absenceMinutes(two.absentDays), 2 * 1440);
  const ten = openDay(local('2026-11-14', '10:00'), closed, CFG);
  assert.equal(ten.absentDays, 10);
  assert.equal(absenceMinutes(ten.absentDays), 14400);
});

test('시간대를 바꾸면 경계도 현지 시각을 따른다', () => {
  const utc: typeof CFG = { tzOffsetMin: 0, boundaryMin: 240 };
  const t = Date.parse('2026-11-03T03:59:00Z');
  assert.equal(realDayIndex(t + 60_000, utc), realDayIndex(t, utc) + 1);
  // 같은 순간이 한국 시간으로는 12:59 → 04:00 경계와 무관하게 같은 날
  assert.equal(realDayIndex(t + 60_000, CFG), realDayIndex(t, CFG));
});

test('설정이 잘못되면 거부한다', () => {
  assert.throws(() => realDayIndex(0, { tzOffsetMin: 99999, boundaryMin: 240 }), /오프셋/);
  assert.throws(() => realDayIndex(0, { tzOffsetMin: 0, boundaryMin: 1440 }), /경계/);
  assert.throws(() => openDay(0, 1.5, CFG), /정수/);
});

test('게임 시각: 절대 분과 범위 검사', () => {
  assert.equal(makeTime(1, 1, 0).abs, 0);
  assert.equal(makeTime(1, 2, 30).abs, 1470);
  assert.equal(makeTime(2, 1, 0).abs, 7 * 1440);
  assert.throws(() => makeTime(0, 1, 0), /주차/);
  assert.throws(() => makeTime(1, 8, 0), /하루/);
  assert.throws(() => makeTime(1, 1, 1440), /분/);
});

test('advance: 하루 안에서는 그대로 흐르고, 하루 끝을 넘으면 거기서 멈춰 넘친 분을 알려 준다', () => {
  const t0 = makeTime(1, 3, 600);
  const a = advance(t0, 90);
  assert.deepEqual([a.time.minute, a.advanced, a.overflow], [690, 90, 0]);
  const b = advance(makeTime(1, 3, 1400), 100);
  assert.deepEqual([b.time.minute, b.advanced, b.overflow], [1439, 39, 61]);
  assert.throws(() => advance(t0, -1), /0 이상/);
});

test('closeDay: 일차가 오르고, 7일째를 닫으면 주를 마감하고 1일차로 돌아간다', () => {
  const mid = closeDay(makeTime(1, 3, 800));
  assert.deepEqual([mid.next.week, mid.next.day, mid.next.minute, mid.weekClosed], [1, 4, 0, false]);
  const last = closeDay(makeTime(1, 7, 1000));
  assert.deepEqual([last.next.week, last.next.day, last.weekClosed], [2, 1, true]);
});

test('FakeClock: 7일을 즉시 진행하며 하루 열기·닫기를 반복한다 (시연 모드)', () => {
  const clock = new FakeClock(local('2026-11-03', '09:00'));
  let story = makeTime(1, 1, 0);
  let lastClosed: number | null = null;
  const weekCloses: number[] = [];
  for (let n = 0; n < 7; n++) {
    const open = openDay(clock.now(), lastClosed, CFG);
    assert.equal(open.opens, true, `${n + 1}번째 하루`);
    assert.equal(open.absentDays, 0);
    const closed = closeDay(advance(story, 600).time);
    lastClosed = open.realDay;
    if (closed.weekClosed) weekCloses.push(n + 1);
    story = closed.next;
    clock.advanceDays(1);
  }
  assert.deepEqual(weekCloses, [7]);
  assert.deepEqual([story.week, story.day], [2, 1]);
});

test('FakeClock: 잘못된 입력을 거부한다', () => {
  assert.throws(() => new FakeClock(1.5), /정수/);
  const c = new FakeClock(0);
  assert.throws(() => c.advanceMinutes(-1), /0 이상/);
});
