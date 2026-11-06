// 세계 상태 (docs/구현-계획.md 9): 정의의 부위·특징에 맞지 않는 값 거부 · 사건과 상태 일치
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { EventLog } from '../src/core/log.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { INSTANCE_CREATED, STATE_CHANGED, World, WorldError } from '../src/core/world.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const isKnownType = (type: string): boolean => vocab.has('event_type', type);

// 예시 패치: OBJ000001 음식(body: rot, smell), PLC000001 주방(space: smell, bug), OBJ000002 신발(sole: dirt)
const db: Db = (() => {
  const parsed = parsePatch(JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-chain.json'), 'utf8')));
  assert.ok(parsed.patch);
  return mergePatch(emptyDb(), parsed.patch, vocab).db;
})();

function fresh(): { world: World; log: EventLog } {
  const log = new EventLog({ isKnownType });
  return { world: new World(db, vocab, log), log };
}

function rejects(fn: () => unknown, match: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof WorldError && match.test(e.message));
}

test('사전에 세계 상태의 사건 유형이 있다', () => {
  assert.equal(vocab.has('event_type', STATE_CHANGED), true);
  assert.equal(vocab.has('event_type', INSTANCE_CREATED), true);
});

test('인스턴스를 만들면 사건이 남고 번호가 차례로 나온다', () => {
  const { world, log } = fresh();
  const a = world.spawn('OBJ000001', { t: 0 });
  const b = world.spawn('OBJ000001', { t: 0 });
  assert.equal(a.id, 'OBJ000001#1');
  assert.equal(b.id, 'OBJ000001#2');
  assert.equal(log.size, 2);
  assert.deepEqual(a.event.data, { id: 'OBJ000001#1', def: 'OBJ000001' });
  assert.deepEqual(world.instances(), ['OBJ000001#1', 'OBJ000001#2']);
});

test('바뀐 적 없는 상태는 사다리 0칸이다', () => {
  const { world } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  assert.equal(world.level(`${id}|body:rot`), 'fresh');
  assert.equal(world.levelIndex(`${id}|body:rot`), 0);
  assert.deepEqual(world.keysOf(id), [`${id}|body:rot`, `${id}|body:smell`]);
});

test('상태를 바꾸면 state_changed 사건이 남고, 같은 값이면 사건이 없다', () => {
  const { world, log } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  const e = world.set(`${id}|body:rot`, 'spoiled', { t: 60 });
  assert.ok(e);
  assert.equal(e.type, STATE_CHANGED);
  assert.equal(e.src, 'world');
  assert.deepEqual(e.data, { key: `${id}|body:rot`, from: 'fresh', to: 'spoiled' });
  assert.equal(world.level(`${id}|body:rot`), 'spoiled');
  assert.equal(world.levelIndex(`${id}|body:rot`), 3);
  assert.equal(world.set(`${id}|body:rot`, 'spoiled', { t: 61 }), null);
  assert.equal(log.size, 2);
});

test('원인 사건을 이어 둔다', () => {
  const { world, log } = fresh();
  const { id, event } = world.spawn('OBJ000001', { t: 0 });
  const e = world.set(`${id}|body:rot`, 'wilted', { t: 5, cause: event.seq });
  assert.ok(e);
  assert.deepEqual(log.chain(e.seq).map((x) => x.seq), [e.seq, event.seq]);
});

test('종결 단계(소멸·고정)는 값으로 쓸 수 있고, 칸 번호는 없다', () => {
  const { world } = fresh();
  const { id } = world.spawn('OBJ000002', { t: 0 });
  world.set(`${id}|sole:dirt`, 'fixed', { t: 1 });
  assert.equal(world.level(`${id}|sole:dirt`), 'fixed');
  assert.equal(world.levelIndex(`${id}|sole:dirt`), null);
  world.set(`${id}|sole:dirt`, 'gone', { t: 2 });
  assert.equal(world.level(`${id}|sole:dirt`), 'gone');
});

// ---- 거부: 정의의 부위·특징과 사전에 맞지 않는 값 ----

test('거부: 없는 정의의 인스턴스', () => {
  const { world, log } = fresh();
  rejects(() => world.spawn('OBJ000099', { t: 0 }), /없는 정의다/);
  rejects(() => world.spawn('OBJ000001#1', { t: 0 }), /정의 번호가 아니다/);
  assert.equal(log.size, 0);
});

test('거부: 없는 인스턴스의 상태', () => {
  const { world } = fresh();
  rejects(() => world.set('OBJ000001#1|body:rot', 'spoiled', { t: 0 }), /없는 인스턴스다/);
});

test('거부: 상태 키 형식이 아니다', () => {
  const { world } = fresh();
  world.spawn('OBJ000001', { t: 0 });
  rejects(() => world.set('OBJ000001|body:rot', 'spoiled', { t: 0 }), /상태 키 형식이 아니다/);
  rejects(() => world.level('rot'), /상태 키 형식이 아니다/);
});

test('거부: 정의에 없는 부위', () => {
  const { world } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  rejects(() => world.set(`${id}|sole:dirt`, 'dust', { t: 0 }), /부위 "sole"가 없다/);
});

test('거부: 부위에 없는 특징', () => {
  const { world } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  rejects(() => world.set(`${id}|body:dirt`, 'dust', { t: 0 }), /특징 "dirt"가 없다/);
});

test('거부: 특징의 단계에 없는 키', () => {
  const { world } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  rejects(() => world.set(`${id}|body:rot`, 'dirty', { t: 0 }), /단계 키 "dirty"가 "rot"의 단계에 없다/);
});

test('거부: 잠긴 단계 칸', () => {
  const { world, log } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  rejects(() => world.set(`${id}|body:rot`, 's2', { t: 0 }), /아직 잠겨 있다/);
  assert.equal(log.size, 1, '거부된 변경은 사건을 남기지 않는다');
});

test('거부: 시각이 거꾸로 가면 기록이 받지 않고 상태도 그대로다', () => {
  const { world } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 10 });
  assert.throws(() => world.set(`${id}|body:rot`, 'spoiled', { t: 5 }), /시각이 거꾸로/);
  assert.equal(world.level(`${id}|body:rot`), 'fresh');
});

// ---- 사건과 상태 일치 ----

function scenario(): { world: World; log: EventLog } {
  const { world, log } = fresh();
  const food = world.spawn('OBJ000001', { t: 0 }).id;
  const kitchen = world.spawn('PLC000001', { t: 0 }).id;
  const shoes = world.spawn('OBJ000002', { t: 0 }).id;
  const rot = world.set(`${food}|body:rot`, 'spoiled', { t: 600 });
  const smell = world.set(`${food}|body:smell`, 'distinct', { t: 600, cause: rot?.seq ?? null });
  world.set(`${kitchen}|space:smell`, 'faint', { t: 700, cause: smell?.seq ?? null });
  world.set(`${shoes}|sole:dirt`, 'dust', { t: 800 });
  world.set(`${shoes}|sole:dirt`, 'clean', { t: 900 });
  return { world, log };
}

test('기록만으로 다시 만든 세계는 같은 상태다', () => {
  const { world, log } = scenario();
  const restored = World.fromLog(db, vocab, EventLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())), { isKnownType }));
  assert.deepEqual(restored.snapshot(), world.snapshot());
  assert.deepEqual(world.snapshot(), {
    instances: { 'OBJ000001#1': 'OBJ000001', 'OBJ000002#1': 'OBJ000002', 'PLC000001#1': 'PLC000001' },
    states: {
      'OBJ000001#1|body:rot': 'spoiled',
      'OBJ000001#1|body:smell': 'distinct',
      'PLC000001#1|space:smell': 'faint',
    },
  });
});

test('다시 만든 세계는 같은 기록에 이어 쓰고 번호를 다시 쓰지 않는다', () => {
  const { log } = scenario();
  const restored = World.fromLog(db, vocab, log);
  assert.equal(restored.spawn('OBJ000001', { t: 1000 }).id, 'OBJ000001#2');
});

test('같은 입력이면 같은 기록이 나온다', () => {
  assert.equal(JSON.stringify(scenario().log.toJSON()), JSON.stringify(scenario().log.toJSON()));
});

test('거부: 기록의 from이 그때의 상태와 다르면 복원하지 않는다 (손으로 고친 기록)', () => {
  const { log } = scenario();
  const raw = JSON.parse(JSON.stringify(log.toJSON())) as { type: string; data: Record<string, unknown> }[];
  const target = raw.find((e) => e.type === STATE_CHANGED && e.data['to'] === 'clean');
  assert.ok(target);
  target.data['from'] = 'dirty';
  const tampered = EventLog.fromJSON(raw, { isKnownType });
  rejects(() => World.fromLog(db, vocab, tampered), /지금 단계는 dust인데 사건은 dirty에서/);
});

test('거부: 기록의 인스턴스 번호가 건너뛰면 복원하지 않는다', () => {
  const log = new EventLog({ isKnownType });
  log.append({ t: 0, type: INSTANCE_CREATED, src: 'world', data: { id: 'OBJ000001#2', def: 'OBJ000001' } });
  rejects(() => World.fromLog(db, vocab, log), /인스턴스 번호 순서가 어긋난다/);
});

test('거부: 기록이 사전에 없는 단계로 바꾸면 복원하지 않는다', () => {
  const log = new EventLog({ isKnownType });
  log.append({ t: 0, type: INSTANCE_CREATED, src: 'world', data: { id: 'OBJ000001#1', def: 'OBJ000001' } });
  log.append({ t: 1, type: STATE_CHANGED, src: 'world', data: { key: 'OBJ000001#1|body:rot', from: 'fresh', to: 'mushy' } });
  rejects(() => World.fromLog(db, vocab, log), /단계 키 "mushy"/);
});

test('철회된 상태 변화는 복원에 들어가지 않는다', () => {
  const { world, log } = fresh();
  const { id } = world.spawn('OBJ000001', { t: 0 });
  const e = world.set(`${id}|body:smell`, 'faint', { t: 1 });
  assert.ok(e);
  log.retract(e.seq, '시험: 잘못 기록됨', { t: 2, src: 'test' });
  assert.equal(World.fromLog(db, vocab, log).level(`${id}|body:smell`), 'none');
});
