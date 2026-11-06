import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileSource, compileSources } from '../src/core/compile.ts';
import { emptyDb } from '../src/core/db.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { runGate } from '../src/core/gate.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const EXAMPLE = ['examples/src/objects/fridge-items.json', 'examples/src/places/kitchen.json'];

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { format_version: 1, file_kind: 'objects', why: '시험', defs: [{ id: 'OBJ+1', names: { ko: '음식' } }], ...extra };
}

test('원본 예시는 패치가 되고, 기존 파서와 관문을 오류 없이 통과한다', () => {
  const r = compileSources(EXAMPLE.map(readJson));
  assert.deepEqual(r.issues, []);
  assert.ok(r.patch);
  const parsed = parsePatch(r.patch);
  assert.deepEqual(parsed.issues, []);
  assert.ok(parsed.patch);
  const merged = mergePatch(emptyDb(), parsed.patch, vocab);
  const gate = runGate(emptyDb(), merged.db, vocab, merged.report.errors);
  assert.equal(gate.pass, true, gate.reason);
});

test('is_a 는 기본 항목을 펼치고, 개별 항목의 이름이 이긴다', () => {
  const r = compileSources(EXAMPLE.map(readJson));
  const defs = (r.patch?.['defs'] as Record<string, unknown>[]) ?? [];
  const apple = defs.find((d) => d['id'] === 'OBJ+2');
  assert.ok(apple);
  assert.deepEqual(apple['names'], { ko: '사과', en: 'apple' });
  assert.deepEqual(apple['slots'], { body: { features: ['rot', 'smell'] } });
  assert.equal('is_a' in apple, false);
  assert.equal('override' in apple, false);
});

test('머리가 틀리면 거부한다: 버전, why, 종류, 알 수 없는 최상위 필드', () => {
  assert.match(JSON.stringify(compileSource(base({ format_version: 2 })).issues), /format_version/);
  assert.match(JSON.stringify(compileSource(base({ why: '' })).issues), /why/);
  assert.match(JSON.stringify(compileSource(base({ file_kind: 'materials' })).issues), /지금 받는 종류/);
  assert.match(JSON.stringify(compileSource(base({ extra: 1 })).issues), /알 수 없는 최상위 필드/);
});

test('명세 단계 필드는 조용히 버리지 않고 거부한다', () => {
  const material = compileSource(base({ defs: [{ id: 'OBJ+1', names: { ko: '음식' }, material: '합판' }] }));
  assert.match(JSON.stringify(material.issues), /아직 받지 않는 필드/);
  // delay_s 는 2026-11-06에 구현되어 받는다. 아직 명세 단계인 warn_before_s 로 같은 성질을 본다.
  const warn = compileSource(base({ defs: [{ id: 'OBJ+1', names: { ko: '음식' }, rules: { r: { on: [], emits: [], warn_before_s: 60 } } }] }));
  assert.match(JSON.stringify(warn.issues), /warn_before_s.*아직 받지 않는 필드/);
});

test('번호는 종류와 맞아야 하고, 같은 파일 안에서 겹치면 안 된다', () => {
  assert.match(JSON.stringify(compileSource(base({ defs: [{ id: 'PLC+1', names: { ko: '주방' } }] })).issues), /OBJ 번호만/);
  const dup = compileSource(base({ defs: [{ id: 'OBJ+1', names: { ko: 'a' } }, { id: 'OBJ+1', names: { ko: 'b' } }] }));
  assert.match(JSON.stringify(dup.issues), /두 번 나온다/);
});

test('is_a 는 같은 파일의 기본 항목 하나만 가리키고, override 는 정해진 필드만 바꾼다', () => {
  const missing = compileSource(base({ defs: [{ id: 'OBJ+2', is_a: 'OBJ+9', names: { ko: '사과' } }] }));
  assert.match(JSON.stringify(missing.issues), /같은 파일 안에서만/);
  const forbidden = compileSource(base({ defs: [
    { id: 'OBJ+1', names: { ko: '음식' } },
    { id: 'OBJ+2', is_a: 'OBJ+1', names: { ko: '사과' }, override: { names: { ko: 'x' } } },
  ] }));
  assert.match(JSON.stringify(forbidden.issues), /바꿀 수 없는 필드: names/);
});

test('배치 안에서 다른 파일과 번호가 겹치면 거부한다', () => {
  const a = base();
  const b = base({ why: '다른 파일' });
  const r = compileSources([a, b]);
  assert.match(JSON.stringify(r.issues), /다른 파일과 겹친다/);
});
