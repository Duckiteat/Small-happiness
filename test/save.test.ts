import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAVE_VERSION, SaveError, canonicalJson, parseSave, serializeSave } from '../src/core/save.ts';
import type { SaveFile } from '../src/core/save.ts';

const HASH = 'a'.repeat(64);

function sample(extra: Partial<SaveFile> = {}): SaveFile {
  return {
    version: SAVE_VERSION,
    contentHash: HASH,
    seed: 12345,
    rng: { main: [1, 2, 3, 4] },
    clock: { lastClosedDay: 20396, week: 2, day: 3, minute: 600 },
    state: { z: 1, a: [1, 2, { y: 2, x: 1 }] },
    awareness: {},
    habits: [],
    schedule: [],
    resources: { tissue: 3 },
    ...extra,
  };
}

test('정규 JSON: 키 순서가 달라도 같은 바이트', () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.ok(a.endsWith('\n'));
});

test('저장 → 복원: 값이 같고, 다시 직렬화해도 같은 바이트', () => {
  const text = serializeSave(sample());
  const parsed = parseSave(text, HASH);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(serializeSave(parsed.save), text);
  assert.deepEqual(parsed.save.clock, { lastClosedDay: 20396, week: 2, day: 3, minute: 600 });
});

test('같은 상태는 키 입력 순서와 상관없이 같은 바이트로 저장된다', () => {
  const a = serializeSave(sample({ state: { x: 1, y: 2 } }));
  const b = serializeSave(sample({ state: { y: 2, x: 1 } }));
  assert.equal(a, b);
});

test('버전 불일치는 오류: 더 새로운 형식, 변환이 없는 옛 형식', () => {
  const newer = JSON.stringify({ ...sample(), version: SAVE_VERSION + 1 });
  assert.throws(() => parseSave(newer, HASH), /더 새로운 저장 형식/);
  const older = JSON.stringify({ ...sample(), version: 0 });
  assert.throws(() => parseSave(older, HASH), /마이그레이션이 없다/);
  assert.throws(() => serializeSave({ ...sample(), version: SAVE_VERSION + 1 }), SaveError);
});

test('콘텐츠 해시가 다르면 불러오되 경고한다', () => {
  const parsed = parseSave(serializeSave(sample()), 'b'.repeat(64));
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0] ?? '', /콘텐츠가 저장 당시와 다르다/);
});

test('모양이 틀린 저장은 거부한다', () => {
  assert.throws(() => parseSave('{', HASH), /JSON이 아니다/);
  assert.throws(() => parseSave('[]', HASH), /객체가 아니다/);
  assert.throws(() => serializeSave(sample({ seed: 1.5 })), /seed/);
  assert.throws(() => serializeSave(sample({ rng: { main: [1, 2, 3] } })), /rng.main/);
  assert.throws(() => serializeSave(sample({ rng: {} })), /rng/);
  assert.throws(() => serializeSave(sample({ clock: { lastClosedDay: null, week: 1, day: 8, minute: 0 } })), /clock.day/);
  assert.throws(() => serializeSave(sample({ clock: { lastClosedDay: null, week: 1, day: 1, minute: 1440 } })), /clock.minute/);
  assert.throws(() => serializeSave(sample({ contentHash: '' })), /contentHash/);
  const extra = { ...sample(), color: 'red' };
  assert.throws(() => serializeSave(extra as unknown as SaveFile), /알 수 없는 필드: color/);
});

test('저장할 수 없는 값은 거부한다 (NaN, 순환)', () => {
  assert.throws(() => serializeSave(sample({ state: { n: Number.NaN } })), /유한하지 않은/);
});
