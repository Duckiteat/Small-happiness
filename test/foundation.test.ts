// 기반층 완료 기준 (docs/기반층-명세.md 6장)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLOCK_CONFIG, FakeClock, absenceMinutes, advance, closeDay, makeTime, openDay } from '../src/core/clock.ts';
import { EventLog } from '../src/core/log.ts';
import { Rng } from '../src/core/rng.ts';
import { SAVE_VERSION, SaveError } from '../src/core/save.ts';
import type { SaveFile } from '../src/core/save.ts';
import type { GameTime } from '../src/core/clock.ts';
import { contentHash, readSave, writeSave } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const CFG = DEFAULT_CLOCK_CONFIG;
const START = Date.parse('2026-11-03T09:00:00+09:00');

const made: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sh-found-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface World {
  clock: FakeClock;
  rng: Rng;
  log: EventLog;
  story: GameTime;
  lastClosed: number | null;
  draws: number[];
}

function newWorld(seed: number): World {
  return {
    clock: new FakeClock(START),
    rng: Rng.fromSeed(seed),
    log: new EventLog({ isKnownType: (t) => vocab.has('event_type', t) }),
    story: makeTime(1, 1, 0),
    lastClosed: null,
    draws: [],
  };
}

/** 한 날: 열고, 난수를 한 번 뽑고, 시간을 흘리고, 닫는다. 변화 규칙은 난수를 받지 않는다. */
function playDay(w: World): void {
  const open = openDay(w.clock.now(), w.lastClosed, CFG);
  assert.equal(open.opens, true);
  const openEv = w.log.append({ t: w.story.abs, type: 'day_open', src: 'clock', data: { week: w.story.week, day: w.story.day } });
  if (open.absentDays > 0) {
    w.log.append({ t: w.story.abs, type: 'absence', src: 'clock', cause: openEv.seq, data: { dt: absenceMinutes(open.absentDays) } });
  }
  w.draws.push(w.rng.int(100)); // 개입(이벤트)만 난수를 쓴다
  const moved = advance(w.story, 600);
  w.log.append({ t: moved.time.abs, type: 'tick', src: 'clock', cause: openEv.seq, data: { dt: moved.advanced } });
  const closed = closeDay(moved.time);
  w.log.append({ t: moved.time.abs, type: 'day_close', src: 'clock', cause: openEv.seq, data: { week: moved.time.week, day: moved.time.day } });
  if (closed.weekClosed) w.log.append({ t: moved.time.abs, type: 'week_close', src: 'clock', data: { week: moved.time.week } });
  w.story = closed.next;
  w.lastClosed = open.realDay;
  w.clock.advanceDays(1);
}

function toSave(w: World, seed: number, hash: string): SaveFile {
  return {
    version: SAVE_VERSION,
    contentHash: hash,
    seed,
    rng: { main: [...w.rng.state()] },
    clock: { lastClosedDay: w.lastClosed, week: w.story.week, day: w.story.day, minute: w.story.minute },
    state: { draws: w.draws },
    awareness: {},
    habits: [],
    schedule: [],
    resources: {},
    log: JSON.parse(JSON.stringify(w.log.toJSON())),
  };
}

test('기반층 완료: 빈 세계에서 시연 모드로 7일을 돌리고, 저장·복원이 일치한다', () => {
  const root = tempRoot();
  const hash = contentHash(ROOT);
  const w = newWorld(2026);
  for (let i = 0; i < 7; i++) playDay(w);

  // 7일째가 닫혔으므로 2주차 1일차로 돌아갔고, week_close 가 정확히 한 번 있다
  assert.deepEqual([w.story.week, w.story.day], [2, 1]);
  assert.equal(w.log.list({ type: 'week_close' }).length, 1);
  assert.equal(w.log.size, 7 * 3 + 1); // 하루마다 day_open · tick · day_close, 7일째에 week_close

  writeSave(root, 'demo', toSave(w, 2026, hash));
  const { save, warnings } = readSave(root, 'demo');
  assert.deepEqual(warnings.length === 0 || warnings.length === 1, true);

  // 복원: 시계, 난수, 기록이 모두 같다
  assert.deepEqual(save.clock, { lastClosedDay: w.lastClosed, week: 2, day: 1, minute: 0 });
  const rng = Rng.restore(save.rng['main'] as [number, number, number, number]);
  assert.deepEqual(rng.state(), w.rng.state());
  const log = EventLog.fromJSON(save.log ?? [], { isKnownType: (t) => vocab.has('event_type', t) });
  assert.equal(log.size, w.log.size);
  assert.deepEqual(log.toJSON(), w.log.toJSON());
  // 복원 후 이어서 같은 난수
  const nextOriginal = [w.rng.int(1000), w.rng.int(1000), w.rng.int(1000)];
  const nextRestored = [rng.int(1000), rng.int(1000), rng.int(1000)];
  assert.deepEqual(nextRestored, nextOriginal);
});

test('같은 상태는 같은 바이트로 저장된다 (두 번 저장, 두 번 복원)', () => {
  const root = tempRoot();
  const hash = contentHash(ROOT);
  const w = newWorld(7);
  for (let i = 0; i < 3; i++) playDay(w);
  const a = writeSave(root, 'a', toSave(w, 7, hash));
  const b = writeSave(root, 'b', toSave(w, 7, hash));
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
});

test('같은 시드로 7일을 다시 돌리면 같은 기록과 같은 뽑기가 나온다', () => {
  const run = (): World => {
    const w = newWorld(99);
    for (let i = 0; i < 7; i++) playDay(w);
    return w;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.draws, b.draws);
  assert.deepEqual(a.log.toJSON(), b.log.toJSON());
});

test('저장 이름이 경로를 빠져나가면 거부한다', () => {
  const root = tempRoot();
  const w = newWorld(1);
  assert.throws(() => writeSave(root, '../evil', toSave(w, 1, 'h')), SaveError);
  assert.throws(() => readSave(root, 'nope'), /저장 파일이 없다/);
});

test('콘텐츠 해시는 데이터가 바뀌면 달라진다', () => {
  const root = tempRoot();
  const w = newWorld(1);
  writeSave(root, 'x', toSave(w, 1, 'f'.repeat(64)));
  const { warnings } = readSave(root, 'x'); // 이 임시 폴더에는 데이터가 없으므로 해시가 다르다
  assert.equal(warnings.length, 1);
  assert.equal(contentHash(root), contentHash(root)); // 같은 입력은 같은 해시
});
