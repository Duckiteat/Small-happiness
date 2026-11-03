import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canLink,
  formatPattern,
  formatStateKey,
  matchesPattern,
  parsePattern,
  parseStateKey,
  patternRange,
} from '../src/core/statekey.ts';
import type { StatePattern } from '../src/core/statekey.ts';

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

test('패턴: 왕복과 조건', () => {
  for (const s of ['OBJ000001|sole:dirt', 'OBJ000001|sole:dirt@>=2', 'OBJ000001|sole:dirt@=0', 'OBJ000001|sole:dirt@<3']) {
    assert.equal(formatPattern(pattern(s)), s);
  }
  assert.equal(parsePattern('OBJ000001|sole:dirt@<0'), null);
  assert.equal(parsePattern('OBJ000001#1|sole:dirt'), null);
  assert.equal(parsePattern('OBJ000001|sole:dirt@>=x'), null);
});

test('패턴: 단계 범위', () => {
  assert.deepEqual(patternRange(pattern('OBJ000001|a:b')), { min: 0, max: Infinity });
  assert.deepEqual(patternRange(pattern('OBJ000001|a:b@=2')), { min: 2, max: 2 });
  assert.deepEqual(patternRange(pattern('OBJ000001|a:b@>2')), { min: 3, max: Infinity });
  assert.deepEqual(patternRange(pattern('OBJ000001|a:b@<=2')), { min: 0, max: 2 });
  assert.deepEqual(patternRange(pattern('OBJ000001|a:b@<2')), { min: 0, max: 1 });
});

test('패턴 일치: 같은 정의의 다른 인스턴스에도 해당한다', () => {
  const p = pattern('OBJ000001|sole:dirt@>=2');
  const a = parseStateKey('OBJ000001#1|sole:dirt');
  const b = parseStateKey('OBJ000001#7|sole:dirt');
  const other = parseStateKey('OBJ000002#1|sole:dirt');
  assert.ok(a && b && other);
  assert.equal(matchesPattern(p, a, 2), true);
  assert.equal(matchesPattern(p, b, 3), true);
  assert.equal(matchesPattern(p, a, 1), false);
  assert.equal(matchesPattern(p, other, 3), false);
  assert.equal(matchesPattern(p, a, -1), false);
  assert.equal(matchesPattern(p, a, 1.5), false);
});

test('사슬 연결: 같은 대상이고 범위가 겹치면 이어진다', () => {
  const emits = pattern('OBJ000010|food:rot@=2');
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot@>=2')), true);
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot')), true);
  assert.equal(canLink(emits, pattern('OBJ000010|food:rot@>=3')), false);
  assert.equal(canLink(emits, pattern('OBJ000010|food:smell@>=2')), false);
  assert.equal(canLink(emits, pattern('OBJ000011|food:rot@>=2')), false);
});
