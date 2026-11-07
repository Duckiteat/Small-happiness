// 진행 법칙 (음식-변화-모델 2·4장): 조건이 속도를 바꾼다. 냉동에서는 상하지 않고, 뜯으면 빨리 시어진다
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import type { DayTrace } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const base = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')));
type E = { t: number; type: string; data: Record<string, unknown> };

/** 하루씨 없이(손대지 않고) 일주일, 시작 조건만 바꿔서. */
function week(set: { t: number; key: string; level: string }[]): DayTrace {
  return runScenario(db, vocab, { ...base, spawn: base.spawn.filter((d) => !d.startsWith('CHR')), set });
}
const levels = (trace: DayTrace, key: string): string[] =>
  (trace.log as E[]).filter((e) => e.type === 'state_changed' && e.data['key'] === key).map((e) => String(e.data['to']));

test('살 때의 상태로 들어온다 (처음 조건은 구매와 붙어 있다)', () => {
  const first = week([]).steps.at(0);
  assert.ok(first);
  const s = first.values['world.state'] as Record<string, string>;
  assert.equal(s['OBJ000002#1|cond:seal'], 'pasteurized'); // 우유: 살균
  assert.equal(s['OBJ000009#1|cond:cut'], 'sliced'); // 햄 슬라이스: 채·큐브
  assert.equal(s['OBJ000010#1|cond:seal'], 'half'); // 남은 치킨: 반밀봉
});

test('냉동에서는 상하지 않는다: 냉동실에 넣은 치킨은 일주일 동안 부패·곰팡이가 오르지 않는다', () => {
  const room = week([]);
  const frozen = week([{ t: 0, key: 'OBJ000010#1|cond:temp', level: 'frozen' }]);
  assert.ok(levels(room, 'OBJ000010#1|body:decay').includes('spoiled'), '냉장이면 상한다');
  assert.deepEqual(levels(frozen, 'OBJ000010#1|body:decay'), []);
  assert.deepEqual(levels(frozen, 'OBJ000010#1|body:mold'), []);
});

test('뜯으면(오픈) 살균 상태보다 빨리 시어진다: 뜯은 우유는 일주일 안에 시큼해진다', () => {
  const sealed = week([]);
  const opened = week([{ t: 0, key: 'OBJ000002#1|cond:seal', level: 'open' }]);
  assert.ok(!levels(sealed, 'OBJ000002#1|body:sour').includes('sour'));
  assert.ok(levels(opened, 'OBJ000002#1|body:sour').includes('sour'));
});

test('여름 실온은 냉장보다 훨씬 빠르다: 실온에 둔 두부는 하루 안에 쉰다', () => {
  const summer = week([{ t: 0, key: 'OBJ000003#1|cond:temp', level: 'summer_room' }]);
  const turned = (summer.log as E[]).find((e) => e.type === 'state_changed' && e.data['key'] === 'OBJ000003#1|body:decay');
  assert.ok(turned && turned.t < 1440, `${turned?.t}`);
});
