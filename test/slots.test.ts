// 문장 자리 파일 검사 (docs/데이터-형식.md 6장)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSlotFile, parseSlotCond, satisfiable, slotReportText } from '../src/core/slots.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

type Obj = Record<string, unknown>;

function slot(extra: Obj = {}): Obj {
  return { id: 'S-1', about: '시험 자리', when: ['mold@>=spot'], default: { text: '' }, ...extra };
}
function file(slots: Obj[], extra: Obj = {}): Obj {
  return { format_version: 1, context: '시험', why: '시험', slots, ...extra };
}
function msgs(raw: unknown, strict = false): string {
  return checkSlotFile(raw, vocab, { strict }).issues.map((i) => `${i.where}: ${i.msg}`).join('\n');
}

test('실제 냉장고 자리 파일은 구조 검사를 오류 없이 통과한다', () => {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'data', 'src', 'text', '냉장고.json'), 'utf8'));
  const r = checkSlotFile(raw, vocab);
  assert.deepEqual(r.issues, []);
  assert.equal(r.report.slots, 8);
  assert.equal(r.report.required, 5);
});

test('조건 문법: 상태 조건과 감각 조건', () => {
  assert.deepEqual(parseSlotCond('mold@>=spot'), { kind: 'state', feature: 'mold', op: '>=', level: 'spot' });
  assert.deepEqual(parseSlotCond('sense:smell=high'), { kind: 'sense', sense: 'smell', value: 'high' });
  assert.equal(parseSlotCond('mold@>=2'), null); // 번호 조건은 쓸 수 없다
  assert.equal(parseSlotCond('sense:smell=mid'), null);
  assert.equal(parseSlotCond('Mold@>=spot'), null);
});

test('채움 현황: 기본 문장과 변형을 센다, 선택 자리는 필수에 들지 않는다', () => {
  const raw = file([
    slot({ id: 'S-1', default: { text: '냄새가 먼저 왔다.' }, variants: [{ id: 'S-1-a', label: 'a', when: ['sense:smell=high'], text: '코가 먼저 알았다.' }] }),
    slot({ id: 'S-2', default: { text: '' } }),
    slot({ id: 'S-3', need: 'optional', default: { text: '' } }),
  ]);
  const r = checkSlotFile(raw, vocab);
  assert.deepEqual(r.issues, []);
  assert.deepEqual([r.report.slots, r.report.required, r.report.defaultsFilled, r.report.variants, r.report.variantsFilled], [3, 2, 1, 1, 1]);
  assert.deepEqual(r.report.requiredEmpty, ['S-2']);
  assert.match(slotReportText(r.report), /비어 있는 필수 기본 문장: S-2/);
});

test('strict 에서는 비어 있는 필수 기본 문장이 오류이고, 선택 자리는 아니다', () => {
  const raw = file([slot({ id: 'S-1' }), slot({ id: 'S-2', need: 'optional' })]);
  assert.equal(msgs(raw, false), '');
  const m = msgs(raw, true);
  assert.match(m, /slots\[0\]\.default\.text: 필수 자리의 기본 문장이 비어 있다/);
  assert.doesNotMatch(m, /slots\[1\]/);
});

test('사전과 맞지 않는 조건을 거부한다: 특징, 단계 키, 잠긴 칸, 종결 연산자, 감각, 행동', () => {
  assert.match(msgs(file([slot({ when: ['nope@>=spot'] })])), /사전에 없는 특징/);
  assert.match(msgs(file([slot({ when: ['mold@>=nope'] })])), /없는 단계 키/);
  assert.match(msgs(file([slot({ when: ['mold@>=s2'] })])), /잠겨 있다/);
  assert.match(msgs(file([slot({ when: ['stain@>fixed'] })])), /= 조건으로만/);
  assert.equal(msgs(file([slot({ when: ['stain@=fixed'] })])), ''); // 종결 단계는 = 로
  assert.match(msgs(file([slot({ when: ['sense:nope=high'] })])), /사전에 없는 감각/);
  assert.match(msgs(file([slot({ action: 'fly' })])), /사전에 없는 행동/);
  assert.equal(msgs(file([slot({ action: 'wipe' })])), '');
});

test('구조 검사: 최상위 필드, 번호 중복, 필수 필드', () => {
  assert.match(msgs(file([slot()], { extra: 1 })), /알 수 없는 최상위 필드: extra/);
  assert.match(msgs(file([slot()], { format_version: 2 })), /format_version/);
  assert.match(msgs(file([])), /slots는 비어 있지 않은/);
  assert.match(msgs(file([slot({ id: 'S-1' }), slot({ id: 'S-1' })])), /두 번 나온다/);
  assert.match(msgs(file([slot({ id: 'x' })])), /"S-"로 시작/);
  assert.match(msgs(file([slot({ when: [] })])), /조건이 하나 이상 필요/);
  assert.match(msgs(file([slot({ default: undefined })])), /기본 문장\(default\.text\)이 필요/);
  assert.match(msgs(file([slot({ need: 'maybe' })])), /need는 required 또는 optional/);
});

test('중첩 충돌: 구체성이 같고 함께 켜질 수 있는 변형 쌍을 잡는다', () => {
  const v = (id: string, when: string[]): Obj => ({ id, label: id, when, text: '' });
  // 서로 다른 감각이 함께 참일 수 있다 → 모호
  assert.match(msgs(file([slot({ variants: [v('a', ['sense:smell=high']), v('b', ['sense:sight=high'])] })])), /어느 쪽이 이길지 모호/);
  // 같은 감각의 높음/낮음은 함께 참일 수 없다 → 충돌 아님
  assert.equal(msgs(file([slot({ variants: [v('a', ['sense:smell=high']), v('b', ['sense:smell=low'])] })])), '');
  // 구체성이 다르면 더 구체적인 쪽이 이긴다 → 충돌 아님
  assert.equal(msgs(file([slot({ variants: [v('a', ['sense:smell=high']), v('b', ['sense:smell=high', 'sense:sight=high'])] })])), '');
  // 같은 특징의 범위가 겹치면 함께 참일 수 있다 → 모호
  assert.match(msgs(file([slot({ when: ['residue@>=moist'], variants: [v('a', ['residue@>=moist']), v('b', ['residue@>=dried'])] })])), /모호/);
  // 같은 특징의 범위가 안 겹치면 충돌 아님
  assert.equal(msgs(file([slot({ when: ['residue@>=moist'], variants: [v('a', ['residue@=moist']), v('b', ['residue@=set'])] })])), '');
});

test('켜질 수 없는 변형: 자기 모순, 트리거와의 모순', () => {
  const v = (id: string, when: string[]): Obj => ({ id, label: id, when, text: '' });
  assert.match(msgs(file([slot({ variants: [v('a', ['sense:smell=high', 'sense:smell=low'])] })])), /서로 모순되어 켜질 수 없다/);
  assert.match(msgs(file([slot({ when: ['residue@=set'], variants: [v('a', ['residue@=moist'])] })])), /트리거와 모순/);
  assert.match(msgs(file([slot({ when: ['residue@=set', 'residue@=moist'] })])), /트리거 조건이 서로 모순/);
});

test('satisfiable: 종결 단계와 사다리 범위는 함께 참일 수 없다', () => {
  const a = parseSlotCond('stain@=fixed');
  const b = parseSlotCond('stain@>=faint');
  assert.ok(a && b);
  assert.equal(satisfiable([a, b], vocab), false);
  assert.equal(satisfiable([a], vocab), true);
});
