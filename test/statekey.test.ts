import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canLink,
  condRange,
  formatPattern,
  formatStateKey,
  matchesPattern,
  parsePattern,
  parseStateKey,
  patternRange,
} from '../src/core/statekey.ts';
import type { StatePattern } from '../src/core/statekey.ts';

// 단계 순서 (사전 levels 의 목록 순서와 같은 모양)
const DIRT = ['clean', 'dust', 'dirty', 'severe'] as const;

function pattern(s: string): StatePattern {
  const p = parsePattern(s);
  assert.notEqual(p, null, s);
  return p as StatePattern;
}

test('상태 키: 왕복', () => {
  const key = { subject: 'OBJ000001#1', slot: 'sole', feature: 'dirt' };
  const text = formatStateKey(key);
  assert.equal(text, 'OBJ000001#1|sole:dirt');
  assert.deepEqual(parseStateKey(text), key);
});

test('상태 키: 주어는 인스턴스여야 한다', () => {
  assert.equal(parseStateKey('OBJ000001|sole:dirt'), null);
  assert.equal(parseStateKey('OBJ000001#1|Sole:dirt'), null);
  assert.equal(parseStateKey('OBJ000001#1|sole'), null);
});

test('패턴: 왕복과 조건 (조건은 단계 키)', () => {
  for (const s of ['OBJ000001|sole:dirt', 'OBJ000001|sole:dirt@>=dirty', 'OBJ000001|sole:dirt@=clean', 'OBJ000001|sole:dirt@<dirty']) {
    assert.equal(formatPattern(pattern(s)), s);
  }
  assert.equal(parsePattern('OBJ000001#1|sole:dirt'), null);
  assert.equal(parsePattern('OBJ000001|sole:dirt@>=2'), null); // 번호 조건은 쓸 수 없다
  assert.equal(parsePattern('OBJ000001|sole:dirt@<0'), null);
  assert.equal(parsePattern('OBJ000001|sole:dirt@>=Dirty'), null);
});

test('단계 범위: 키는 사전 순서의 위치로 바뀐다', () => {
  assert.deepEqual(patternRange(pattern('OBJ000001|a:b'), DIRT), { min: 0, max: Infinity });
  assert.deepEqual(patternRange(pattern('OBJ000001|sole:dirt@=dirty'), DIRT), { min: 2, max: 2 });
  assert.deepEqual(patternRange(pattern('OBJ000001|sole:dirt@>dust'), DIRT), { min: 2, max: Infinity });
  assert.deepEqual(patternRange(pattern('OBJ000001|sole:dirt@<=dirty'), DIRT), { min: 0, max: 2 });
  assert.deepEqual(patternRange(pattern('OBJ000001|sole:dirt@<dirty'), DIRT), { min: 0, max: 1 });
});

test('단계 범위: 순서에 없는 키·순서 없는 특징·빈 범위', () => {
  assert.equal(patternRange(pattern('OBJ000001|sole:dirt@>=nope'), DIRT), null);
  assert.equal(patternRange(pattern('OBJ000001|sole:dirt@>=dirty'), undefined), null);
  assert.deepEqual(condRange({ op: '<', level: 'clean' }, DIRT), { min: 0, max: -1 }); // 빈 범위는 관문이 거부한다
});

test('패턴 일치: 같은 정의의 다른 인스턴스에도 해당한다', () => {
  const p = pattern('OBJ000001|sole:dirt@>=dirty');
  const a = parseStateKey('OBJ000001#1|sole:dirt');
  const b = parseStateKey('OBJ000001#7|sole:dirt');
  const other = parseStateKey('OBJ000002#1|sole:dirt');
  assert.ok(a && b && other);
  assert.equal(matchesPattern(p, a, 2, DIRT), true);
  assert.equal(matchesPattern(p, b, 3, DIRT), true);
  assert.equal(matchesPattern(p, a, 1, DIRT), false);
  assert.equal(matchesPattern(p, other, 3, DIRT), false);
  assert.equal(matchesPattern(p, a, -1, DIRT), false);
  assert.equal(matchesPattern(p, a, 1.5, DIRT), false);
  assert.equal(matchesPattern(p, a, 2, undefined), false);
});

test('사슬 연결: 같은 대상이고 범위가 겹치면 이어진다', () => {
  const order = ['fresh', 'wilted', 'spoiled', 'rotten'] as const;
  const emits = pattern('OBJ000010|food:rot@=spoiled');
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot@>=spoiled'), order), true);
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot'), order), true);
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot@>=rotten'), order), false);
  assert.equal(canLink(emits, pattern('OBJ000010|food:smell@>=spoiled'), order), false);
  assert.equal(canLink(emits, pattern('OBJ000011|food:rot@>=spoiled'), order), false);
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot@>=nope'), order), false);
});
