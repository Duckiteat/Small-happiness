import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventLog } from '../src/core/log.ts';

function sample(): EventLog {
  const log = new EventLog();
  log.append({ t: 0, type: 'day_open', src: 'clock' });
  log.append({ t: 10, type: 'state_changed', src: 'world', cause: 'L000001', data: { key: 'OBJ000001#1|sole:dirt', level: 1 } });
  log.append({ t: 10, type: 'symptom_shown', src: 'rule', cause: 'L000002' });
  return log;
}

test('seq는 1부터 빈틈 없이 붙는다', () => {
  const log = sample();
  assert.deepEqual(
    log.list().map((e) => e.seq),
    ['L000001', 'L000002', 'L000003'],
  );
  assert.equal(log.size, 3);
  assert.equal(log.lastSeq, 'L000003');
});

test('사건은 불변이다', () => {
  const log = sample();
  const e = log.get('L000002');
  assert.ok(e);
  assert.throws(() => {
    (e as { t: number }).t = 99;
  }, TypeError);
  assert.throws(() => {
    (e.data as Record<string, unknown>)['level'] = 5;
  }, TypeError);
});

test('넘겨 준 data를 나중에 바꿔도 기록은 변하지 않는다', () => {
  const log = new EventLog();
  const data = { n: 1 };
  log.append({ t: 0, type: 'tick', src: 'clock', data });
  data.n = 2;
  assert.equal(log.get('L000001')?.data['n'], 1);
});

test('시각은 거꾸로 가지 않고 같은 시각은 허용된다', () => {
  const log = new EventLog();
  log.append({ t: 5, type: 'tick', src: 'clock' });
  log.append({ t: 5, type: 'tick', src: 'clock' });
  assert.throws(() => log.append({ t: 4, type: 'tick', src: 'clock' }), RangeError);
  assert.equal(log.size, 2); // 실패한 추가는 남지 않는다
});

test('t는 0 이상의 정수여야 한다', () => {
  const log = new EventLog();
  assert.throws(() => log.append({ t: -1, type: 'tick', src: 'clock' }), RangeError);
  assert.throws(() => log.append({ t: 1.5, type: 'tick', src: 'clock' }), RangeError);
});

test('cause는 이미 있는 사건이어야 한다', () => {
  const log = new EventLog();
  assert.throws(() => log.append({ t: 0, type: 'tick', src: 'clock', cause: 'L000009' }), /원인/);
  assert.equal(log.size, 0);
});

test('data는 JSON으로 저장 가능해야 한다', () => {
  const log = new EventLog();
  assert.throws(() => log.append({ t: 0, type: 'tick', src: 'x', data: { n: NaN } }), TypeError);
  assert.throws(() => log.append({ t: 0, type: 'tick', src: 'x', data: { f: (() => 1) as never } }), TypeError);
  assert.throws(() => log.append({ t: 0, type: 'tick', src: 'x', data: { d: new Date() as never } }), TypeError);
  assert.throws(() => log.append({ t: 0, type: 'tick', src: 'x', data: { u: undefined as never } }), TypeError);
  const cyc: Record<string, unknown> = {};
  cyc['self'] = cyc;
  assert.throws(() => log.append({ t: 0, type: 'tick', src: 'x', data: cyc as never }), /순환/);
  assert.equal(log.size, 0);
});

test('원인 사슬을 거슬러 올라갈 수 있다', () => {
  const log = sample();
  assert.deepEqual(
    log.chain('L000003').map((e) => e.seq),
    ['L000003', 'L000002', 'L000001'],
  );
  assert.deepEqual(log.chain('L000099'), []);
});

test('철회: 지우지 않고 표시만 남기며 effective에서 빠진다', () => {
  const log = sample();
  const r = log.retract('L000002', '잘못 기록됨', { t: 11, src: 'tool' });
  assert.equal(r.type, 'retract');
  assert.equal(r.cause, 'L000002');
  assert.equal(log.isRetracted('L000002'), true);
  assert.equal(log.size, 4); // 원본은 그대로 남는다
  assert.deepEqual(
    log.effective().map((e) => e.seq),
    ['L000001', 'L000003'],
  );
});

test('철회 오류: 없는 대상, 이중 철회, 철회의 철회', () => {
  const log = sample();
  assert.throws(() => log.retract('L000099', 'x', { t: 11, src: 'tool' }), /대상이 없다/);
  const r = log.retract('L000002', 'x', { t: 11, src: 'tool' });
  assert.throws(() => log.retract('L000002', 'y', { t: 12, src: 'tool' }), /이미 철회/);
  assert.throws(() => log.retract(r.seq, 'z', { t: 12, src: 'tool' }), /철회 사건은 철회할 수 없다/);
});

test('조회: 유형과 구간', () => {
  const log = sample();
  assert.deepEqual(
    log.list({ type: 'state_changed' }).map((e) => e.seq),
    ['L000002'],
  );
  assert.deepEqual(
    log.list({ fromSeq: 'L000002', toSeq: 'L000003' }).map((e) => e.seq),
    ['L000002', 'L000003'],
  );
  assert.deepEqual(
    log.list({ where: (e) => e.t === 10 }).map((e) => e.seq),
    ['L000002', 'L000003'],
  );
});

test('사전에 없는 사건 유형은 거부한다 (retract는 항상 허용)', () => {
  const known = new Set(['tick']);
  const log = new EventLog({ isKnownType: (t) => known.has(t) });
  log.append({ t: 0, type: 'tick', src: 'clock' });
  assert.throws(() => log.append({ t: 0, type: 'nonsense', src: 'x' }), /사전에 없는/);
  assert.doesNotThrow(() => log.retract('L000001', '테스트', { t: 0, src: 'x' }));
});

test('JSON 왕복: 복원한 기록은 같다', () => {
  const log = sample();
  log.retract('L000002', '테스트', { t: 11, src: 'tool' });
  const restored = EventLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
  assert.deepEqual(restored.toJSON(), log.toJSON());
  assert.equal(restored.isRetracted('L000002'), true);
  // 복원 뒤에도 이어서 추가할 수 있다
  assert.equal(restored.append({ t: 12, type: 'tick', src: 'clock' }).seq, 'L000005');
});

test('복원은 불변식을 다시 검사한다', () => {
  const good = sample().toJSON();
  const gap = [good[0], good[2]];
  assert.throws(() => EventLog.fromJSON(gap), /seq 순서/);

  const badCause = JSON.parse(JSON.stringify(good));
  badCause[1].cause = 'L000009';
  assert.throws(() => EventLog.fromJSON(badCause), /원인/);

  const timeBack = JSON.parse(JSON.stringify(good));
  timeBack[0].t = 50;
  assert.throws(() => EventLog.fromJSON(timeBack), /거꾸로/);

  assert.throws(() => EventLog.fromJSON([{ seq: 'L000001' }]), TypeError);
});
