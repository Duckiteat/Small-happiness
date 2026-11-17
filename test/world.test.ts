// 세계 실행기: 지연 규칙의 예약·취소·발화 (docs/축-구현-순서.md 층 3)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { assertJsonValue } from '../src/core/events.ts';
import type { NewEvent } from '../src/core/events.ts';
import { runGate } from '../src/core/gate.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { advance, applyEffect, buildWorld, nextDue, readLevels } from '../src/core/world.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const DAY = 86400;

type Obj = Record<string, unknown>;

function dbOf(defs: Obj[]): Db {
  const parsed = parsePatch({ format: 'small-happiness-patch', version: 1, why: '시험', defs });
  assert.ok(parsed.patch !== null, JSON.stringify(parsed.issues));
  const before = emptyDb();
  const merged = mergePatch(before, parsed.patch, vocab);
  const gate = runGate(before, merged.db, vocab, merged.report.errors, { allowWarnings: true });
  assert.ok(gate.pass, gate.reason + JSON.stringify(gate.errors));
  return merged.db;
}
function rule(on: string, emits: string, delay?: number): Obj {
  return { on: [on], emits: [emits], ...(delay === undefined ? {} : { delay_s: delay, tuned: false }) };
}
function cup(rules: Obj): Obj {
  return { id: 'OBJ+1', names: { ko: '컵' }, mobility: 'portable', slots: { body: { features: ['dirt', 'wet', 'stain'] } }, rules };
}
const K = (feature: string): string => `OBJ000001#1|body:${feature}`;
const changes = (events: readonly NewEvent[]): string[] =>
  events.filter((e) => e.type === 'stage_advanced').map((e) => `${String(e.data?.['t_s'])} ${String(e.data?.['key'])} ${String(e.data?.['from'])}>${String(e.data?.['to'])}`);

test('지연 규칙은 조건이 이어진 채 시간이 지나야 일어난다', () => {
  const w = buildWorld(dbOf([cup({ r: rule('OBJ+1|body:dirt@=clean', 'OBJ+1|body:dirt@>=dust', 100) })]), vocab);
  assert.deepEqual(w.issues, []);
  const before = advance(w.state, w.spec, 99);
  assert.equal(before.state.levels[K('dirt')], 0);
  assert.equal(nextDue(before.state), 100);
  const after = advance(before.state, w.spec, 100);
  assert.deepEqual(changes(after.events), [`100 ${K('dirt')} clean>dust`]);
  assert.equal(nextDue(after.state), null);
});

test('지연 없는 규칙은 같은 시각에 이어서 일어난다 (사슬)', () => {
  const w = buildWorld(dbOf([cup({
    a: rule('OBJ+1|body:wet@>=damp', 'OBJ+1|body:dirt@>=dust'),
    b: rule('OBJ+1|body:dirt@>=dust', 'OBJ+1|body:stain@>=faint'),
  })]), vocab);
  const r = applyEffect(w.state, w.spec, 'OBJ000001|body:wet@>=damp', 'test');
  assert.deepEqual(changes(r.events), [`0 ${K('wet')} dry>damp`, `0 ${K('dirt')} clean>dust`, `0 ${K('stain')} none>faint`]);
});

test('예약된 시각 전에 조건이 깨지면 취소되고 일어나지 않는다', () => {
  const w = buildWorld(dbOf([cup({ r: rule('OBJ+1|body:wet@>=damp', 'OBJ+1|body:stain@>=faint', 1000) })]), vocab);
  const wet = applyEffect(w.state, w.spec, 'OBJ000001|body:wet@>=damp', 'test');
  const mid = advance(wet.state, w.spec, 500);
  const dried = applyEffect(mid.state, w.spec, 'OBJ000001|body:wet@<=dry', 'wipe');
  assert.ok(dried.events.some((e) => e.type === 'delayed_effect' && e.data?.['phase'] === 'cancelled'));
  const end = advance(dried.state, w.spec, 5000);
  assert.equal(end.state.levels[K('stain')], 0);
  // 다시 젖으면 지연은 처음부터 다시 센다
  const again = applyEffect(end.state, w.spec, 'OBJ000001|body:wet@>=damp', 'test');
  assert.equal(nextDue(again.state), 6000);
});

test('한 번 일어난 규칙은 조건이 이어지는 동안 다시 일어나지 않는다', () => {
  const w = buildWorld(dbOf([cup({ r: rule('OBJ+1|body:wet@>=damp', 'OBJ+1|body:stain@>=faint', 10) })]), vocab);
  const wet = applyEffect(w.state, w.spec, 'OBJ000001|body:wet@>=damp', 'test');
  const a = advance(wet.state, w.spec, 20);
  const cleaned = applyEffect(a.state, w.spec, 'OBJ000001|body:stain@<=none', 'wipe');
  const b = advance(cleaned.state, w.spec, 1000);
  assert.equal(b.state.levels[K('stain')], 0);
  assert.deepEqual(changes(b.events), []);
});

test('시간을 한 번에 넘기든 나눠 넘기든 결과와 사건이 같다 (부재 보정)', () => {
  const patch: unknown = JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-week.json'), 'utf8'));
  const parsed = parsePatch(patch);
  assert.ok(parsed.patch !== null);
  const db = mergePatch(emptyDb(), parsed.patch, vocab).db;
  const w = buildWorld(db, vocab);
  assert.deepEqual(w.issues, []);
  const once = advance(w.state, w.spec, 9 * DAY);
  let state = w.state;
  const pieces: NewEvent[] = [];
  for (let t = 3571; t < 9 * DAY; t += 3571) {
    const r = advance(state, w.spec, t);
    state = r.state;
    pieces.push(...r.events);
  }
  const last = advance(state, w.spec, 9 * DAY);
  assert.deepEqual(last.state, once.state);
  assert.deepEqual([...pieces, ...last.events], once.events);
});

test('골든 트레이스: 냉장고 음식 9일', () => {
  const patch: unknown = JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-week.json'), 'utf8'));
  const parsed = parsePatch(patch);
  assert.ok(parsed.patch !== null);
  const w = buildWorld(mergePatch(emptyDb(), parsed.patch, vocab).db, vocab);
  const r = advance(w.state, w.spec, 9 * DAY);
  assert.deepEqual(changes(r.events), [
    '172800 OBJ000001#1|body:rot fresh>wilted',
    '345600 OBJ000001#1|body:rot wilted>spoiled',
    '374400 OBJ000001#1|body:smell none>distinct',
    '378000 PLC000001#1|space:smell none>faint',
    '518400 OBJ000001#1|body:rot spoiled>rotten',
    '547200 OBJ000001#1|body:smell distinct>foul',
    '568800 PLC000001#1|space:smell faint>distinct',
    '612000 PLC000001#1|space:bug none>few',
    '698400 PLC000002#1|space:bug none>few',
  ]);
  assert.equal(readLevels(r.state, w.spec)['PLC000002#1|space:bug'], 'few');
  assert.doesNotThrow(() => assertJsonValue(JSON.parse(JSON.stringify(r.state)), 'state'));
});

test('도중에 음식을 치우면(효과 요청) 뒤의 사슬이 일어나지 않는다', () => {
  const patch: unknown = JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-week.json'), 'utf8'));
  const parsed = parsePatch(patch);
  assert.ok(parsed.patch !== null);
  const w = buildWorld(mergePatch(emptyDb(), parsed.patch, vocab).db, vocab);
  const day5 = advance(w.state, w.spec, 4 * DAY + 3600); // 상했고 냄새는 아직 예약 중
  const reset = applyEffect(day5.state, w.spec, 'OBJ000001|body:rot@<=fresh', 'replace');
  const end = advance(reset.state, w.spec, 5 * DAY);
  assert.equal(readLevels(end.state, w.spec)['OBJ000001#1|body:smell'], 'none');
  assert.equal(readLevels(end.state, w.spec)['PLC000001#1|space:smell'], 'none');
});

test('잠긴 칸에는 서지 않는다: 가던 방향으로 한 칸 더 간다', () => {
  const w = buildWorld(dbOf([cup({})]), vocab);
  const up = applyEffect(w.state, w.spec, 'OBJ000001|body:dirt@>dust', 'test'); // dust 다음은 잠긴 s2
  assert.equal(readLevels(up.state, w.spec)[K('dirt')], 'dirty');
  const down = applyEffect(up.state, w.spec, 'OBJ000001|body:dirt@<dirty', 'test');
  assert.equal(readLevels(down.state, w.spec)[K('dirt')], 'dust');
});

test('지연 없는 순환은 끝없이 돌지 않고 던진다', () => {
  const w = buildWorld(dbOf([cup({
    a: rule('OBJ+1|body:wet@=dry', 'OBJ+1|body:wet@>=damp'),
    b: rule('OBJ+1|body:wet@>=damp', 'OBJ+1|body:wet@<=dry'),
  })]), vocab);
  assert.throws(() => advance(w.state, w.spec, 10), /끝없이 이어진다/);
});

test('실행할 수 없는 규칙은 만들 때 알린다 (조건 없는 emits, 종결 단계)', () => {
  const noCond = buildWorld(dbOf([cup({ r: rule('OBJ+1|body:wet@>=damp', 'OBJ+1|body:stain') })]), vocab);
  assert.match(noCond.issues.map((i) => i.msg).join('\n'), /emits에 단계 조건이 없어/);
  const terminal = buildWorld(dbOf([cup({ r: rule('OBJ+1|body:wet@>=damp', 'OBJ+1|body:stain@=fixed') })]), vocab);
  assert.match(terminal.issues.map((i) => i.msg).join('\n'), /종결 단계는 아직 실행기가 다루지 않는다/);
});

test('효과 요청과 시각의 잘못된 입력을 거부한다', () => {
  const w = buildWorld(dbOf([cup({})]), vocab);
  assert.throws(() => applyEffect(w.state, w.spec, 'OBJ000001|body:dirt', 'x'), /효과 패턴 형식이 아니다/);
  assert.throws(() => applyEffect(w.state, w.spec, 'OBJ000009|body:dirt@>=dust', 'x'), /없는 상태/);
  assert.throws(() => applyEffect(w.state, w.spec, 'OBJ000001|body:dirt@>=shiny', 'x'), /없는 단계 키/);
  const later = advance(w.state, w.spec, 10);
  assert.throws(() => advance(later.state, w.spec, 5), /거꾸로 갈 수 없다/);
});
