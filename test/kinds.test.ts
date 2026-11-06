// 종류 (is_a): 규칙·행동을 종류에 한 번만 쓰고 물건마다 물려받는다. 같은 키로 덮어쓴다. on_all · 소멸 · when
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { runGate } from '../src/core/gate.ts';
import { effectiveRules, kindMembers } from '../src/core/kinds.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { scenarioRun } from '../src/node/clerk.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const real: Db = loadDb(ROOT);
type E = { t: number; type: string; data: Record<string, unknown> };

test('실제 저장소: 음식 종류 하나에 음식 10가지가 속하고, 실제 저장소가 관문을 통과한다', () => {
  assert.equal(kindMembers(real, 'OBJ000001').size, 11);
  assert.equal(runGate(emptyDb(), real, vocab, []).pass, true);
});

test('물려받기와 덮어쓰기: 우유는 종류의 규칙을 그대로, 두부는 시들기·상하기를 자기 것으로, 냄새는 종류의 것', () => {
  const owners = (def: string): string[] => effectiveRules(real, def).map((r) => `${r.key}:${r.owner}`);
  assert.deepEqual(owners('OBJ000002'), ['go_bad:OBJ000001', 'spoil:OBJ000001', 'wilt:OBJ000001']);
  assert.deepEqual(owners('OBJ000003'), ['go_bad:OBJ000003', 'spoil:OBJ000001', 'wilt:OBJ000003']);
});

test('첫 주: 덮어쓴 시간대로 상한다 (두부·남은 치킨 → 우유·상추 → 햄), 종류의 냄새 규칙은 모든 음식에 걸린다', () => {
  const trace = scenarioRun(ROOT, vocab, 'content/scenarios/first-week.json');
  const spoiled = (trace.log as E[])
    .filter((e) => e.type === 'state_changed' && e.data['to'] === 'spoiled')
    .map((e) => `${e.t} ${real.defs[String(e.data['key']).split('#')[0] ?? '']?.names.ko ?? ''}`);
  assert.deepEqual(spoiled.slice(0, 5), ['4320 두부', '4320 남은 치킨', '7200 우유', '7200 상추', '8640 햄']);
  const smells = (trace.log as E[]).filter((e) => e.type === 'state_changed' && String(e.data['key']).endsWith('body:smell') && e.data['to'] === 'distinct');
  assert.ok(smells.length >= 5, '상한 음식마다 냄새가 난다 (종류의 spoil 규칙)');
});

test('버리기는 상한 음식만 (when): 신선한 음식은 살핀 뒤에도 버리지 않는다', () => {
  const trace = scenarioRun(ROOT, vocab, 'content/scenarios/first-week.json');
  const discarded = (trace.log as E[]).filter((e) => e.type === 'action_chosen' && e.data['verb'] === 'discard').map((e) => String(e.data['at']));
  assert.ok(discarded.length > 0);
  assert.ok(!discarded.includes('OBJ000004#1'), '계란(21일)은 버리지 않는다');
});

function gateOf(extra: unknown): string {
  const base = mergePatch(emptyDb(), parsePatch({
    format: 'small-happiness-patch', version: 1, why: '시험 기준',
    defs: [{ id: 'OBJ+1', names: { ko: '음식' }, slots: { body: { features: ['rot'] } },
      rules: { w: { on: ['OBJ+1|body:rot@=fresh'], emits: ['OBJ+1|body:rot@=wilted'] } } }],
  }).patch ?? assert.fail(), vocab).db;
  const p = parsePatch(extra);
  assert.ok(p.patch);
  const m = mergePatch(base, p.patch, vocab);
  const g = runGate(base, m.db, vocab, m.report.errors);
  return [g.reason, ...g.newErrors.map((i) => i.msg), ...g.mergeErrors.map((i) => i.msg)].join('\n');
}

test('거부: 종류의 규칙이 쓰는 특징이 없는 물건 (물려받을 수 없다)', () => {
  assert.match(gateOf({ format: 'small-happiness-patch', version: 1, why: '시험',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000001', names: { ko: '돌' }, slots: { body: { features: ['dirt'] } } }] }), /부위 body에 특징 rot가 있어야 한다/);
});

test('거부: 종류는 한 단계만, 같은 접두만, 있는 정의만', () => {
  assert.match(gateOf({ format: 'small-happiness-patch', version: 1, why: '시험',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000099', names: { ko: '유령' }, slots: { body: { features: ['rot'] } } }] }), /없는 정의를 가리킨다: OBJ000099/);
  assert.match(gateOf({ format: 'small-happiness-patch', version: 1, why: '시험',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000001', names: { ko: '과일' }, slots: { body: { features: ['rot'] } } },
      { id: 'OBJ+2', is_a: 'OBJ+1', names: { ko: '사과' }, slots: { body: { features: ['rot'] } } }] }), /종류는 한 단계만/);
});
