// 인물 조각과 인물 기록의 대조 (docs/데이터-형식.md 6B장)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPieces, tracePerson, traceReportText } from '../src/core/pieces.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

type Obj = Record<string, unknown>;

function piece(id: string, extra: Obj = {}): Obj {
  return { id, text: '시험 조각', source: ['A'], tracks: ['daily'], ...extra };
}
function pieces(list: Obj[], extra: Obj = {}): Obj {
  return { format_version: 1, file_kind: 'pieces', person: '시험', why: '시험', pieces: list, ...extra };
}
function sheet(sections: Obj, extra: Obj = {}): Obj {
  return { format_version: 1, file_kind: 'person_sheet', person: '시험', why: '시험', ...sections, ...extra };
}
function item(id: string, from: string[], extra: Obj = {}): Obj {
  return { id, about: '시험 항목', from, ...extra };
}
function msgs(p: unknown, s: unknown): string {
  return tracePerson(p, s, vocab).issues.map((i) => `${i.where}: ${i.msg}`).join('\n');
}
const TWO = pieces([piece('H-001'), piece('H-002', { tracks: ['past', 'role'] })]);

test('실제 인물 파일은 대조를 오류 없이 통과하고 모든 조각이 쓰인다', () => {
  const read = (f: string): unknown => JSON.parse(readFileSync(join(ROOT, 'data', 'src', 'characters', f), 'utf8'));
  const names = ['하루-조각.json', '하루.json'] as const;
  const r = tracePerson(read(names[0]), read(names[1]), vocab);
  assert.deepEqual(r.issues, []);
  assert.ok(r.report !== null);
  assert.equal(r.report.pieces, 28);
  assert.deepEqual(r.report.unused, []);
  assert.deepEqual(r.report.withoutPiece, []);
});

test('보고: 쓰인 곳, 안 쓰인 조각, 궤도별 수', () => {
  const r = tracePerson(TWO, sheet({ persona: [item('P-01', ['H-002'])], events: [item('E-01', ['H-002'])] }), vocab);
  assert.deepEqual(r.issues, []);
  assert.ok(r.report !== null);
  assert.deepEqual(r.report.usedBy, { 'H-002': ['P-01', 'E-01'] });
  assert.deepEqual(r.report.unused, ['H-001']);
  assert.deepEqual(r.report.byTrack['daily'], { pieces: 1, used: 0 });
  assert.deepEqual(r.report.byTrack['past'], { pieces: 1, used: 1 });
  assert.deepEqual(r.report.bySection, { persona: 1, events: 1, external: 0 });
  assert.match(traceReportText(r.report, vocab), /아직 쓰이지 않은 조각: H-001/);
});

test('조각: 번호 꼴·중복·빈 내용을 거부한다', () => {
  const bad = pieces([piece('H-1'), piece('H-002'), piece('H-002'), piece('H-003', { text: ' ' })]);
  const m = checkPieces(bad, vocab).issues.map((i) => i.msg).join('\n');
  assert.match(m, /H-001 꼴/);
  assert.match(m, /H-002가 두 번/);
  assert.match(m, /내용\(text\)/);
});

test('조각: 원천은 Q-번호·S·A 뿐이고 하나 이상 있어야 한다', () => {
  const m = checkPieces(pieces([piece('H-001', { source: [] }), piece('H-002', { source: ['추정'] })]), vocab).issues.map((i) => i.msg).join('\n');
  assert.match(m, /원천이 하나 이상/);
  assert.match(m, /원천 형식이 아니다.*추정/);
  assert.deepEqual(checkPieces(pieces([piece('H-001', { source: ['Q-001', 'S'] })]), vocab).issues, []);
});

test('조각: 사전에 없는 궤도와 빈 궤도를 거부한다', () => {
  const m = checkPieces(pieces([piece('H-001', { tracks: ['hobby'] }), piece('H-002', { tracks: [] })]), vocab).issues.map((i) => i.msg).join('\n');
  assert.match(m, /사전에 없는 궤도: hobby/);
  assert.match(m, /궤도가 하나 이상/);
});

test('조각: 대체는 있는 다른 조각만 가리키고 고리를 이루지 않는다', () => {
  const self = checkPieces(pieces([piece('H-001', { replaced_by: 'H-001' })]), vocab).issues;
  assert.match(self.map((i) => i.msg).join('\n'), /자기 자신/);
  const missing = checkPieces(pieces([piece('H-001', { replaced_by: 'H-009' })]), vocab).issues;
  assert.match(missing.map((i) => i.msg).join('\n'), /H-009가 없다/);
  const loop = checkPieces(pieces([piece('H-001', { replaced_by: 'H-002' }), piece('H-002', { replaced_by: 'H-001' })]), vocab).issues;
  assert.match(loop.map((i) => i.msg).join('\n'), /고리/);
});

test('기록: 없는 조각을 가리키면 거부한다', () => {
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-099'])] })), /없는 조각을 가리킨다: H-099/);
});

test('기록: 대체된 조각을 가리키면 거부한다', () => {
  const p = pieces([piece('H-001', { replaced_by: 'H-002' }), piece('H-002')]);
  assert.match(msgs(p, sheet({ persona: [item('P-01', ['H-001'])] })), /대체된 조각을 가리킨다: H-001 → H-002/);
  const ok = tracePerson(p, sheet({ persona: [item('P-01', ['H-002'])] }), vocab);
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.report?.replaced, 1);
  assert.deepEqual(ok.report?.unused, []); // 대체된 조각은 안 쓰인 조각으로 세지 않는다
});

test('기록: 조각도 근거도 없는 항목을 거부하고, 근거에는 설명이 필요하다', () => {
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', [])] })), /조각도 근거\(basis\)도 없는 항목/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', [], { basis: 'provisional' })] })), /설명\(note\)이 필요/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', [], { basis: 'guess', note: '메모' })] })), /basis는 provisional 또는 calibrated/);
  const ok = tracePerson(TWO, sheet({ persona: [item('P-01', [], { basis: 'provisional', note: '시험 전의 임시값' })] }), vocab);
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.report?.withoutPiece, ['P-01']);
});

test('기록: 수치는 정수이고 보정 표시가 따라야 한다', () => {
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { value: 3 })] })), /tuned\(true\/false\)가 필요/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { value: 3.5, tuned: false })] })), /정수여야/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { value: 3, tuned: true })] })), /calibrated일 때만/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { tuned: false })] })), /value와 함께/);
  assert.equal(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { value: 3, tuned: false })] })), '');
  assert.equal(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { value: 4, tuned: true, basis: 'calibrated', note: '시험에서 올림' })] })), '');
});

test('기록: 구역과 항목 번호의 머리글자가 맞아야 하고 번호가 겹치면 안 된다', () => {
  assert.match(msgs(TWO, sheet({ events: [item('P-01', ['H-001'])] })), /사건 항목 번호는 E-01 꼴/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001']), item('P-01', ['H-002'])] })), /P-01가 두 번/);
});

test('기록: 인물이 다르거나 종류·필드가 틀리면 거부한다', () => {
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'])] }, { person: '다른 사람' })), /조각 파일의 인물\(시험\)과 다르다/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'])] }, { file_kind: 'pieces' })), /file_kind는 person_sheet/);
  assert.match(msgs(TWO, sheet({ persona: [item('P-01', ['H-001'], { score: 1 })] })), /알 수 없는 필드: score/);
  assert.match(msgs(TWO, sheet({})), /항목이 하나도 없다/);
  assert.match(msgs(pieces([]), sheet({ persona: [item('P-01', [])] })), /pieces\.pieces: pieces는 비어 있지 않은/);
});
