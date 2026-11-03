import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IdAllocator,
  defOf,
  formatDefId,
  formatInstanceId,
  formatLogId,
  parseId,
} from '../src/core/ids.ts';

test('정의 번호: 형식화와 해석이 왕복한다', () => {
  const id = formatDefId('OBJ', 1);
  assert.equal(id, 'OBJ000001');
  assert.deepEqual(parseId(id), { kind: 'def', prefix: 'OBJ', num: 1 });
});

test('인스턴스 번호: 정의 번호와 순번', () => {
  const id = formatInstanceId('OBJ000001', 3);
  assert.equal(id, 'OBJ000001#3');
  assert.deepEqual(parseId(id), { kind: 'instance', prefix: 'OBJ', num: 1, serial: 3 });
  assert.equal(defOf(id), 'OBJ000001');
  assert.equal(defOf('OBJ000001'), null);
});

test('기록 번호와 임시 번호', () => {
  assert.equal(formatLogId(12), 'L000012');
  assert.deepEqual(parseId('L000012'), { kind: 'log', num: 12 });
  assert.deepEqual(parseId('OBJ+2'), { kind: 'temp', prefix: 'OBJ', offset: 2 });
});

test('잘못된 번호는 null이다', () => {
  for (const bad of ['', 'OBJ1', 'OBJ000000', 'XYZ000001', 'OBJ000001#0', 'L000000', 'OBJ+0', 'obj000001']) {
    assert.equal(parseId(bad), null, bad);
  }
});

test('범위를 벗어난 번호 만들기는 던진다', () => {
  assert.throws(() => formatDefId('OBJ', 0), RangeError);
  assert.throws(() => formatDefId('OBJ', 1_000_000), RangeError);
  assert.throws(() => formatInstanceId('OBJ000001#1', 1), TypeError);
  assert.throws(() => formatInstanceId('OBJ000001', 0), RangeError);
  assert.throws(() => formatLogId(0), RangeError);
});

test('발급기: 접두별로 단조 증가한다', () => {
  const alloc = new IdAllocator();
  assert.equal(alloc.nextDef('OBJ'), 'OBJ000001');
  assert.equal(alloc.nextDef('OBJ'), 'OBJ000002');
  assert.equal(alloc.nextDef('PLC'), 'PLC000001');
  assert.equal(alloc.nextInstance('OBJ000001'), 'OBJ000001#1');
  assert.equal(alloc.nextInstance('OBJ000001'), 'OBJ000001#2');
  assert.equal(alloc.nextInstance('OBJ000002'), 'OBJ000002#1');
});

test('발급기: 저장 후 복원해도 번호가 재사용되지 않는다', () => {
  const alloc = new IdAllocator();
  alloc.nextDef('ITM');
  alloc.nextDef('ITM');
  alloc.nextInstance('ITM000001');
  const restored = new IdAllocator(JSON.parse(JSON.stringify(alloc.snapshot())));
  assert.equal(restored.nextDef('ITM'), 'ITM000003');
  assert.equal(restored.nextInstance('ITM000001'), 'ITM000001#2');
});

test('발급기: 인스턴스는 정의 번호에서만 발급한다', () => {
  const alloc = new IdAllocator();
  assert.throws(() => alloc.nextInstance('OBJ000001#1'), TypeError);
});

test('발급기: 잘못된 상태는 복원을 거부한다', () => {
  assert.throws(() => new IdAllocator({ defs: { ZZZ: 1 }, instances: {} }));
  assert.throws(() => new IdAllocator({ defs: { OBJ: -1 }, instances: {} }));
  assert.throws(() => new IdAllocator({ defs: {}, instances: { 'OBJ000001#1': 1 } }));
});
