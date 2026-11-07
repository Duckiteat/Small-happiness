// 종류를 여러 단계로 (음식 > 과일 > 사과): 조상의 규칙·행동·진행·처음 상태를 가까운 것이 이기도록 물려받고, 분류 하나가 아래 모든 단계를 가리킨다.
// (결정-기록 "확장성 점검": 종류가 한 단계뿐이던 임시 제한을 푼다. 순환은 관문이 막는다)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileSource } from '../src/core/compile.ts';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { parseEvent } from '../src/core/events.ts';
import { runGate } from '../src/core/gate.ts';
import { ancestors, effectiveInitial, effectiveOffers, effectiveProgress, effectiveRules, kindMembers } from '../src/core/kinds.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

const slots = { body: { features: ['rot', 'smell'] } };
const law = (base_s: number) => ({ slot: 'body', base_s, inputs: {}, edges: [0, 200, null, 600, null, 1000], tuned: false });
// 음식(뿌리) > 과일 > 사과, 그리고 과일 종류 전체를 바라보는 냉장고
const tree = parsePatch({
  format: 'small-happiness-patch', version: 1, why: '시험: 종류 세 단계',
  defs: [
    { id: 'OBJ+1', names: { ko: '음식' }, mobility: 'portable', slots, initial: { 'body:smell': 'none' }, offers: { toss: { verb: 'discard', needs: [], effect: ['OBJ+1|body:smell@=gone'], minutes: 2, tuned: false } },
      rules: { w: { on: ['OBJ+1|body:rot@=fresh'], emits: ['OBJ+1|body:rot@=wilted'], delay_s: 43200, tuned: false } },
      progress: { rot: law(86400) } },
    { id: 'OBJ+2', is_a: 'OBJ+1', names: { ko: '과일' }, mobility: 'portable', slots, initial: { 'body:smell': 'faint' },
      rules: { c: { on: ['OBJ+2|body:rot@=wilted'], emits: ['OBJ+2|body:rot@=spoiled'], delay_s: 43200, tuned: false } } },
    { id: 'OBJ+3', is_a: 'OBJ+2', names: { ko: '사과' }, mobility: 'portable', slots, rules: { w: { on: ['OBJ+3|body:rot@=fresh'], emits: ['OBJ+3|body:rot@=spoiled'], delay_s: 3600, tuned: false } } },
    { id: 'OBJ+4', names: { ko: '냉장고' }, mobility: 'portable', slots,
      rules: { smells: { on: ['OBJ+2|body:rot@>=wilted'], emits: ['OBJ+4|body:smell@>=faint'] } } },
  ],
});
assert.ok(tree.patch);
const merged = mergePatch(emptyDb(), tree.patch, vocab);
const db: Db = merged.db;
const [FOOD, FRUIT, APPLE, FRIDGE] = ['OBJ000001', 'OBJ000002', 'OBJ000003', 'OBJ000004'];

test('여러 단계의 종류는 관문을 통과하고, 조상 사슬과 분류의 구성원이 단계를 넘어 이어진다', () => {
  assert.equal(runGate(emptyDb(), db, vocab, merged.report.errors).pass, true);
  assert.deepEqual(ancestors(db, APPLE), [FRUIT, FOOD], '가까운 조상부터');
  assert.deepEqual([...kindMembers(db, FOOD)].sort(), [FOOD, FRUIT, APPLE]);
  assert.deepEqual([...kindMembers(db, FRUIT)].sort(), [FRUIT, APPLE]);
  assert.deepEqual([...kindMembers(db, APPLE)], [APPLE]);
});

test('물려받기: 규칙·행동·진행은 가까운 것이 먼 것을 덮고, 처음 상태는 먼 조상부터 덮는다', () => {
  // 규칙: 사과는 자기 w, 과일의 c, (음식의 w는 사과의 w가 덮음)
  assert.deepEqual(effectiveRules(db, APPLE).map((r) => `${r.key}←${r.owner}`), [`c←${FRUIT}`, `w←${APPLE}`]);
  assert.deepEqual(effectiveRules(db, FRUIT).map((r) => `${r.key}←${r.owner}`), [`c←${FRUIT}`, `w←${FOOD}`]);
  // 제공 행동: 음식의 것을 두 단계 아래에서도 쓴다
  assert.deepEqual(effectiveOffers(db, APPLE).map((o) => `${o.key}←${o.owner}`), [`toss←${FOOD}`]);
  // 진행: 음식의 표를 사과가 물려받는다 (사과는 자기 부위에 그 특징이 있다)
  assert.deepEqual(effectiveProgress(db, APPLE).full.map((p) => [p.feature, p.base_s]), [['rot', 86400]]);
  // 처음 상태: 음식 none → 과일 faint로 덮이고 사과는 과일의 것을 쓴다
  assert.deepEqual(effectiveInitial(db, FOOD), { 'body:smell': 'none' });
  assert.deepEqual(effectiveInitial(db, APPLE), { 'body:smell': 'faint' });
});

test('세계에서 돈다: 사과는 음식·과일의 규칙을 물려받고(가까운 것이 덮음), 과일 전체를 바라보는 규칙은 사과에도 걸린다', () => {
  const sc = parseScenario({ why: '시험', use_db: true, seed: 1, spawn: [APPLE, FRIDGE], set: [], start: 0, end: 3000, routine: {} });
  const events = runScenario(db, vocab, sc).log.map(parseEvent);
  const changes = events.filter((e) => e.type === 'state_changed' && e.t > 0).map((e) => `${e.t} ${String(e.data['key']).split('|')[1]} ${String(e.data['to'])}`);
  // 사과의 w(60분)가 음식의 w(12시간)를 덮어 곧바로 상한다. 과일의 c는 wilted일 때만이라 걸리지 않는다
  assert.ok(changes.includes('60 body:rot spoiled'), changes.join(' / '));
  assert.ok(!changes.some((c) => c.endsWith('body:rot wilted')), '음식의 w는 덮였다');
  // 냉장고의 규칙은 "과일 종류 전체"의 상태를 본다: 사과(과일의 한 종류)가 상하면(wilted 이상) 냉장고에 냄새
  assert.ok(events.some((e) => e.type === 'state_changed' && e.data['key'] === 'OBJ000004#1|body:smell' && e.data['to'] === 'faint'));
  const sources = events.filter((e) => e.type === 'delay_scheduled').map((e) => e.data['via']);
  assert.ok(sources.includes(`${APPLE}/rule/w`) && !sources.includes(`${FOOD}/rule/w`), String(sources));
});

test('원본 컴파일러: 기본 항목도 종류를 가질 수 있고(구조를 먼 조상부터 펼침), 돌아오는 사슬은 거부한다', () => {
  const src = (defs: object[]) => compileSource({ format_version: 1, file_kind: 'objects', why: '시험', defs });
  const ok = src([
    { id: 'OBJ000001', names: { ko: '음식' }, mobility: 'portable', slots },
    { id: 'OBJ000002', is_a: 'OBJ000001', names: { ko: '과일' }, mobility: 'portable' },
    { id: 'OBJ000003', is_a: 'OBJ000002', names: { ko: '사과' }, mobility: 'portable' },
  ]);
  assert.deepEqual(ok.issues, []);
  const defs = (ok.patch?.['defs'] ?? []) as { id: string; is_a?: string; slots?: unknown; mobility?: string }[];
  assert.deepEqual(defs.map((d) => [d.id, d.is_a]), [['OBJ000001', undefined], ['OBJ000002', 'OBJ000001'], ['OBJ000003', 'OBJ000002']]);
  assert.deepEqual(defs.map((d) => [d.slots, d.mobility]), [[slots, 'portable'], [slots, 'portable'], [slots, 'portable']], '구조는 먼 조상에게서 끝까지 펼쳐진다');
  const cyc = src([{ id: 'OBJ000001', is_a: 'OBJ000002', names: { ko: '가' } }, { id: 'OBJ000002', is_a: 'OBJ000001', names: { ko: '나' } }]);
  assert.equal(cyc.patch, null);
  assert.match(cyc.issues.map((i) => i.msg).join('\n'), /종류가 돌아온다/);
});
