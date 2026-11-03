import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEdges, chainRoots, chainsFrom, collectRules } from '../src/core/chains.ts';
import { emptyDb, parseDb, resolveDefRef, serializeDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { runGate } from '../src/core/gate.ts';
import { meaningOf } from '../src/core/meaning.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { patchReport, patchReportMarkdown } from '../src/core/report.ts';
import { formatLocalCondition, parseLocalCondition } from '../src/core/statekey.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const sample: unknown = JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-chain.json'), 'utf8'));

function patchOf(raw: unknown) {
  const r = parsePatch(raw);
  assert.ok(r.patch, JSON.stringify(r.issues));
  return r.patch;
}

function sampleDb(): Db {
  return mergePatch(emptyDb(), patchOf(sample), vocab).db;
}

/** 정의 목록을 패치로 넣어 병합하고 관문까지 돌린다. */
function attempt(db: Db, defs: unknown[], remove: string[] = []) {
  const patch = patchOf({ format: 'small-happiness-patch', version: 1, why: '테스트', defs, remove });
  const merged = mergePatch(db, patch, vocab);
  const gate = runGate(db, merged.db, vocab, merged.report.errors);
  const messages = [...gate.mergeErrors, ...gate.newErrors, ...gate.newWarnings].map((i) => `${i.where}: ${i.msg}`).join('\n');
  return { merged, gate, messages };
}

test('예시 패치: 임시 번호가 실제 번호로 배정된다', () => {
  const r = mergePatch(emptyDb(), patchOf(sample), vocab);
  assert.deepEqual(r.report.errors, []);
  assert.deepEqual(r.report.idmap, {
    'OBJ+1': 'OBJ000001',
    'OBJ+2': 'OBJ000002',
    'OBJ+3': 'OBJ000003',
    'PLC+1': 'PLC000001',
    'PLC+2': 'PLC000002',
  });
  assert.equal(Object.keys(r.db.defs).length, 5);
  assert.equal(r.db.meta.next['OBJ'], 4);
  assert.equal(r.db.meta.next['PLC'], 3);
});

test('예시 패치: 이름·별칭이 번호·표준 키로 바뀐다', () => {
  const db = sampleDb();
  const food = db.defs['OBJ000001'];
  assert.equal(food?.mobility, 'portable'); // 가변 → portable
  assert.deepEqual(food?.slots?.['body']?.features, ['rot', 'smell']); // 상함, 냄새
  assert.deepEqual(food?.meanings?.[0]?.when, ['body:rot@<=1']); // 부패 → rot
  assert.deepEqual(food?.rules?.['spoil']?.on, ['OBJ000001|body:rot@>=2']); // 임시 번호
  assert.deepEqual(food?.rules?.['spoil']?.emits, ['OBJ000001|body:smell@>=2']); // 이름 "음식"
  assert.deepEqual(db.defs['OBJ000002']?.rules?.['track']?.emits, ['OBJ000003|surface:dirt@>=1']); // 현관 바닥, 오염
  assert.equal(db.defs['OBJ000003']?.mobility, 'fixed'); // 고정
});

test('예시 패치는 관문을 오류도 경고도 없이 통과한다', () => {
  const merged = mergePatch(emptyDb(), patchOf(sample), vocab);
  const gate = runGate(emptyDb(), merged.db, vocab, merged.report.errors);
  assert.equal(gate.pass, true, gate.reason);
  assert.deepEqual(gate.errors, []);
  assert.deepEqual(gate.warnings, []);
});

test('규칙 사슬: emits와 on이 맞으면 자동으로 이어진다', () => {
  const rules = collectRules(sampleDb());
  assert.equal(rules.length, 5);
  const edges = buildEdges(rules);
  const pairs = edges.map((e) => `${e.from.split('/rule/')[1]}>${e.to.split('/rule/')[1]}`).sort();
  assert.deepEqual(pairs, ['bugs>spread', 'odor_reach>bugs', 'spoil>odor_reach']);

  const paths = chainsFrom(edges, 'OBJ000001/rule/spoil');
  assert.deepEqual(paths[0], [
    'OBJ000001/rule/spoil',
    'PLC000001/rule/odor_reach',
    'PLC000001/rule/bugs',
    'PLC000001/rule/spread',
  ]);
  assert.deepEqual(chainRoots(rules, edges).sort(), ['OBJ000001/rule/spoil', 'OBJ000002/rule/track']);
});

test('상태 의미: 위에서부터 처음 맞는 의미가 답이다', () => {
  const food = sampleDb().defs['OBJ000001'];
  assert.ok(food);
  assert.equal(meaningOf(food, {})?.means, 'edible'); // 없는 키는 0
  assert.equal(meaningOf(food, { 'body:rot': 1 })?.means, 'edible');
  assert.equal(meaningOf(food, { 'body:rot': 2 })?.means, 'inedible');
  assert.equal(meaningOf(food, { 'body:rot': 3 })?.label, '먹을 수 없음');
});

test('수정은 적은 필드만 교체하고 나머지는 유지한다', () => {
  const db = sampleDb();
  const { merged, gate } = attempt(db, [{ id: 'OBJ000001', aliases: ['식재료', '먹거리'] }]);
  assert.equal(gate.pass, true);
  assert.deepEqual(merged.report.updated, [{ id: 'OBJ000001', fields: ['aliases'] }]);
  const food = merged.db.defs['OBJ000001'];
  assert.deepEqual(food?.aliases, ['식재료', '먹거리']);
  assert.deepEqual(food?.slots, db.defs['OBJ000001']?.slots);
  assert.deepEqual(food?.rules, db.defs['OBJ000001']?.rules);
});

test('번호 카운터는 줄어들지 않고 지운 번호는 다시 배정되지 않는다', () => {
  const db = sampleDb();
  // 거실 지우기는 관문이 막지만 병합 결과의 카운터는 그대로여야 한다
  const removed = attempt(db, [], ['PLC000002']);
  assert.equal(removed.merged.db.meta.next['PLC'], 3);
  assert.equal(removed.merged.db.defs['PLC000002'], undefined);

  // 지운 뒤 새로 만들면 3번이 배정된다 (2번 재사용 금지)
  const without = removed.merged.db;
  const added = mergePatch(without, patchOf({ format: 'small-happiness-patch', version: 1, why: '재배정 시험', defs: [{ id: 'PLC+1', names: { ko: '욕실' } }] }), vocab);
  assert.equal(added.report.idmap['PLC+1'], 'PLC000003');
});

test('관문 거부: 사전에 없는 특징', () => {
  const { gate, messages } = attempt(sampleDb(), [{ id: 'OBJ+1', names: { ko: '컵' }, mobility: 'portable', slots: { rim: { features: ['반짝임'] } } }]);
  assert.equal(gate.pass, false);
  assert.match(messages, /사전에 없는 특징: 반짝임/);
});

test('관문 거부: 없는 부위·특징·단계 범위를 가리키는 패턴', () => {
  const db = sampleDb();
  assert.match(attempt(db, [{ id: 'PLC000001', rules: { bad: { on: ['OBJ000001|nowhere:rot@>=1'], emits: ['PLC000001|space:bug@=1'] } } }]).messages, /부위 "nowhere"가 없다/);
  assert.match(attempt(db, [{ id: 'PLC000001', rules: { bad: { on: ['OBJ000001|body:dirt@>=1'], emits: ['PLC000001|space:bug@=1'] } } }]).messages, /특징 "dirt"가 없다/);
  assert.match(attempt(db, [{ id: 'PLC000001', rules: { bad: { on: ['OBJ000001|body:rot@>=9'], emits: ['PLC000001|space:bug@=1'] } } }]).messages, /단계 범위/);
  assert.match(attempt(db, [{ id: 'PLC000001', rules: { bad: { on: ['OBJ000001|body:rot@>=1'], emits: ['PLC000099|space:bug@=1'] } } }]).messages, /없는 정의/);
});

test('관문 거부: 같은 종류 안의 이름 충돌 (이름 하나 = 개념 하나)', () => {
  const { gate, messages } = attempt(sampleDb(), [{ id: 'OBJ+1', names: { ko: '식재료' }, mobility: 'portable' }]);
  assert.equal(gate.pass, false);
  assert.match(messages, /여러 정의의 이름·별칭/);
});

test('종류가 다른 이름 충돌은 경고이고, 경고는 허락 없이는 거부된다', () => {
  const db = sampleDb();
  const patch = patchOf({ format: 'small-happiness-patch', version: 1, why: '경고 시험', defs: [{ id: 'OBJ+1', names: { ko: '주방' }, mobility: 'fixed' }] });
  const merged = mergePatch(db, patch, vocab);
  const strict = runGate(db, merged.db, vocab, merged.report.errors);
  assert.equal(strict.pass, false);
  assert.match(strict.reason, /새 경고/);
  const allowed = runGate(db, merged.db, vocab, merged.report.errors, { allowWarnings: true });
  assert.equal(allowed.pass, true);
});

test('관문 거부: 오브젝트의 mobility 누락은 경고', () => {
  const { gate } = attempt(sampleDb(), [{ id: 'OBJ+1', names: { ko: '컵' } }]);
  assert.equal(gate.pass, false);
  assert.ok(gate.newWarnings.some((w) => /mobility/.test(w.msg)));
});

test('병합 오류: 선언되지 않은 임시 번호, 없는 번호 수정, 알 수 없는 필드', () => {
  const db = sampleDb();
  assert.match(attempt(db, [{ id: 'OBJ+1', names: { ko: '컵' }, mobility: 'portable', rules: { r: { on: ['OBJ+9|a:rot'], emits: ['OBJ+1|a:rot'] } } }]).messages, /선언되지 않은 임시 번호: OBJ\+9/);
  assert.match(attempt(db, [{ id: 'OBJ000099', aliases: ['x'] }]).messages, /없는 번호는 수정할 수 없다/);
  assert.match(attempt(db, [{ id: 'OBJ+1', names: { ko: '컵' }, color: 'red' }]).messages, /쓸 수 없는 필드: color/);
  assert.match(attempt(db, [{ id: 'OBJ+1', mobility: 'portable' }]).messages, /names가 필요하다/);
});

test('관문 거부: 지운 정의를 규칙이 가리키고 있다', () => {
  const { gate, messages } = attempt(sampleDb(), [], ['PLC000002']);
  assert.equal(gate.pass, false);
  assert.match(messages, /없는 정의를 가리킨다: PLC000002/);
});

test('관문 거부: 번호 카운터가 줄어든 저장소', () => {
  const before = sampleDb();
  const after: Db = { ...before, meta: { next: { ...before.meta.next, OBJ: 2 } } };
  const gate = runGate(before, after, vocab, []);
  assert.equal(gate.pass, false);
  assert.ok(gate.newErrors.some((e) => /카운터/.test(e.msg)));
});

test('자기 순환 규칙은 경고한다', () => {
  const { gate } = attempt(sampleDb(), [{ id: 'PLC000002', rules: { loop: { on: ['PLC000002|space:bug@>=1'], emits: ['PLC000002|space:bug@>=2'] } } }]);
  assert.ok(gate.newWarnings.some((w) => /자기 순환/.test(w.msg)));
});

test('이름 해석: 번호, 이름, 별칭, 모호함', () => {
  const db = sampleDb();
  assert.deepEqual(resolveDefRef(db, 'OBJ000001'), { id: 'OBJ000001' });
  assert.deepEqual(resolveDefRef(db, '식재료'), { id: 'OBJ000001' });
  assert.deepEqual(resolveDefRef(db, '더비슈즈'), { id: 'OBJ000002' });
  assert.ok('error' in resolveDefRef(db, '없는이름'));
  assert.ok('error' in resolveDefRef(db, 'OBJ000099'));
});

test('저장소 직렬화는 왕복하고 번호순으로 정렬된다', () => {
  const db = sampleDb();
  const text = serializeDb(db);
  const back = parseDb(JSON.parse(text));
  assert.equal(back.issues.length, 0);
  assert.equal(serializeDb(back.db as Db), text);
  const ids = Object.keys(JSON.parse(text).defs);
  assert.deepEqual(ids, [...ids].sort());
});

test('저장소 읽기는 모양이 틀리면 거부한다', () => {
  assert.equal(parseDb({ format: 'x' }).db, null);
  const broken = JSON.parse(serializeDb(sampleDb()));
  broken.defs['OBJ000001'].slots.body.features = 'rot';
  assert.equal(parseDb(broken).db, null);
});

test('패치 보고서: 범위, 영향, 검증', () => {
  const before = emptyDb();
  const merged = mergePatch(before, patchOf(sample), vocab);
  const gate = runGate(before, merged.db, vocab, merged.report.errors);
  const report = patchReport(before, merged.db, merged.report, gate);
  assert.deepEqual(report.scope.added['object'], ['OBJ000001', 'OBJ000002', 'OBJ000003']);
  assert.deepEqual(report.scope.added['place'], ['PLC000001', 'PLC000002']);
  assert.equal(report.impact.newChainEdges, 3);
  assert.equal(report.verification.pass, true);
  const md = patchReportMarkdown(report, merged.db);
  assert.match(md, /## 패치 보고서/);
  assert.match(md, /관문: \*\*통과\*\*/);
  assert.match(md, /OBJ000001\(음식\)/);
});

test('패치 보고서: 수정의 영향은 규칙으로 가리키는 다른 정의를 알려 준다', () => {
  const db = sampleDb();
  const patch = patchOf({ format: 'small-happiness-patch', version: 1, why: '영향 시험', defs: [{ id: 'OBJ000001', aliases: ['먹거리'] }] });
  const merged = mergePatch(db, patch, vocab);
  const gate = runGate(db, merged.db, vocab, merged.report.errors);
  const report = patchReport(db, merged.db, merged.report, gate);
  assert.deepEqual(report.impact.referencedBy['OBJ000001'], ['PLC000001']); // 주방 규칙이 음식을 가리킨다
  assert.equal(report.impact.newChainEdges, 0);
});

test('조건 문법: 소유자 안의 조건', () => {
  assert.deepEqual(parseLocalCondition('body:rot@>=2'), { slot: 'body', feature: 'rot', cond: { op: '>=', n: 2 } });
  assert.equal(formatLocalCondition({ slot: 'body', feature: 'rot', cond: null }), 'body:rot');
  assert.equal(parseLocalCondition('body:rot@<0'), null);
  assert.equal(parseLocalCondition('Body:rot'), null);
});

test('패치 형식 검사', () => {
  assert.ok(parsePatch(null).issues.length > 0);
  assert.match(JSON.stringify(parsePatch({ format: 'small-happiness-patch', version: 1 }).issues), /why/);
  assert.match(JSON.stringify(parsePatch({ format: 'small-happiness-patch', version: 1, why: 'x', extra: 1 }).issues), /알 수 없는 최상위 필드/);
  assert.equal(parsePatch({ format: 'small-happiness-patch', version: 1, why: 'x' }).patch?.defs.length, 0);
});
