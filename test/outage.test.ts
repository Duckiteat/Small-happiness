// 정전·문 열림과 기기의 망가짐 (docs/물건-관계-명세.md 5장, docs/온도-읽기.md): 설비가 끊기면 그 설비를 쓰는 기기가 망가지고,
// 설비가 돌아오면 고칠 수 있다. 냉장고가 꺼지거나 문이 열려 있으면 음식이 실온이 되고, 다시 차게 하면 돌아온다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { readTemperature } from '../src/core/temperature.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const raw = JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-outage.json'), 'utf8')) as Record<string, unknown>;
const scenario = parseScenario(raw);
const trace = runScenario(db, vocab, scenario);
const events = trace.log.map(parseEvent);

const STOVE = 'OBJ000019#1', FRIDGE = 'OBJ000021#1', MICRO = 'OBJ000016#1', MILK = 'OBJ000002#1', CHICKEN = 'OBJ000010#1', GRID = 'PLC000002#1|grid:grid_electric';
const change = (key: string, to: string, after = -1) => events.find((e) => e.type === 'state_changed' && e.data['key'] === key && e.data['to'] === to && e.t >= after);

test('온도 읽기: 가열 온도가 없음 위면 가열 온도로, 아니면 보관 온도로 읽는다', () => {
  assert.deepEqual(readTemperature(vocab, 'fridge', undefined), { band: 'storage', level: 'fridge' });
  assert.deepEqual(readTemperature(vocab, 'fridge', 'none'), { band: 'storage', level: 'fridge' });
  assert.deepEqual(readTemperature(vocab, 'fridge', 'hot'), { band: 'heat', level: 'hot' });
  assert.deepEqual(readTemperature(vocab, 'mild_room', 'fry'), { band: 'heat', level: 'fry' });
  assert.deepEqual(readTemperature(vocab, 'mild_room', 'gone'), { band: 'storage', level: 'mild_room' }, '소멸·모르는 단계는 보관 온도');
});

test('정전: 외부 사건은 원인이 없고, 바로 뒤의 상태 변화가 그 결과다. 전기를 쓰는 기기는 그 순간 망가진다', () => {
  const ext = events.filter((e) => e.type === 'external_event');
  assert.deepEqual(ext.map((e) => [e.t, e.data['label'], e.cause]), [[420, '정전', null], [900, '냉장고 문이 열림', null]]);
  const cut = change(GRID, 'cut');
  assert.equal(cut?.cause, ext[0]?.seq);
  for (const dev of [FRIDGE, MICRO]) {
    const broken = change(`${dev}|body:order`, 'broken');
    assert.ok(broken && broken.t === 420, `${dev}는 정전 때 망가진다`);
  }
});

test('냉장고: 꺼지면 두 시간 뒤 음식이 실온이 되고, 고쳐져 다시 켜지면 한 시간 뒤 다시 차가워진다', () => {
  const off = change(`${FRIDGE}|cooling:power`, 'off');
  assert.equal(off?.t, 420);
  for (const food of [MILK, CHICKEN]) {
    const warm = change(`${food}|cond:temp`, 'mild_room');
    assert.equal(warm?.t, 540, `${food}: 꺼진 지 두 시간 뒤 (임시값)`);
  }
  const repair = events.find((e) => e.type === 'action_chosen' && e.data['verb'] === 'repair' && e.data['at'] === FRIDGE);
  assert.ok(repair && repair.t >= 540, '전기가 돌아온 뒤에 고친다');
  const grid = change(GRID, 'normal');
  assert.equal(grid?.t, 540, '정전은 두 시간 뒤 끝난다 (임시값)');
  const fixed = change(`${FRIDGE}|body:order`, 'ok');
  const on = change(`${FRIDGE}|cooling:power`, 'on', 421);
  assert.ok(fixed && on && on.t >= fixed.t);
  for (const food of [MILK, CHICKEN]) assert.equal(change(`${food}|cond:temp`, 'fridge', on.t)?.t, on.t + 60, `${food}: 켜진 지 한 시간 뒤 다시 차가워진다`);
});

test('문 열림: 열린 문은 하루씨가 알아채고 바로 닫아서, 음식이 실온이 되지 않는다', () => {
  const open = change(`${FRIDGE}|door:door`, 'open');
  const closed = change(`${FRIDGE}|door:door`, 'closed');
  assert.ok(open && closed && closed.t - open.t <= 2, '열림을 알아채 바로 닫는다');
  assert.equal(events.some((e) => e.type === 'state_changed' && String(e.data['key']).endsWith('|cond:temp') && e.data['to'] === 'mild_room' && e.t > 900), false);
});

test('감사: 정전·문 열림이 들어간 하루도 기록이 정의대로다', () => {
  assert.deepEqual(auditLog(events, db, vocab, { externalUntil: scenario.start }).findings, []);
});

test('감사: 외부 사건 뒤에 그 결과가 빠지거나, 외부 사건 없이 원인 없는 변화가 끼면 잡는다', () => {
  const ext = events.find((e) => e.type === 'external_event');
  assert.ok(ext);
  const noResult = events.filter((e) => !(e.type === 'state_changed' && e.cause === ext.seq));
  assert.match(auditLog(noResult, db, vocab, { externalUntil: scenario.start }).findings.map((f) => f.message).join('\n'), /외부 사건\(정전\) 뒤에 결과가 빠졌다/);
  const door = events.filter((e) => e.type === 'external_event')[1]; // 시작 시각 뒤의 외부 사건(문 열림)
  const fake = events.map((e) => (e.type === 'state_changed' && e.cause === door?.seq ? { ...e, cause: null } : e));
  assert.match(auditLog(fake, db, vocab, { externalUntil: scenario.start }).findings.map((f) => f.message).join('\n'), /원인 없는 상태 변화가 처음 설정 시각/);
});

test('시나리오: scripted는 시작 전이면, 모양이 틀리면 읽을 때 거부한다', () => {
  assert.throws(() => parseScenario({ ...raw, scripted: [{ t: 100, key: GRID, level: 'cut', label: '정전' }] }), /시작.*보다 앞선다/);
  assert.throws(() => parseScenario({ ...raw, scripted: [{ t: 500, key: GRID }] }), /scripted\[0\]/);
  assert.throws(() => parseScenario({ ...raw, scripted: 'x' }), /scripted는 목록/);
});

test('전자레인지가 망가지면 가스레인지로 치킨을 튀겨 데운다 (가열 온도 튀김까지 오르고 식는다)', () => {
  const lit = change(`${STOVE}|burner:flame`, 'lit');
  const fry = change(`${CHICKEN}|cond:heat`, 'fry');
  assert.ok(lit && fry && fry.t >= lit.t + 10, '불을 붙이고 10분 튀긴다');
  assert.ok(events.some((e) => e.type === 'action_chosen' && e.data['verb'] === 'fry'));
  assert.equal(events.some((e) => e.type === 'action_chosen' && e.data['verb'] === 'reheat'), false, '망가진 전자레인지는 쓰지 않는다');
  assert.ok(change(`${CHICKEN}|cond:heat`, 'warm', fry.t) && change(`${CHICKEN}|cond:heat`, 'none', fry.t), '식어서 없음으로 돌아온다');
});

test('이어진 것만: 냉장고 안에 놓이지 않은 음식은 냉장고가 꺼져도 실온이 되지 않고, 냉장고 안의 음식은 보이지 않아 저절로 알지 못한다', () => {
  const out = runScenario(db, vocab, parseScenario({ ...raw, contain: [] })).log.map(parseEvent);
  assert.equal(out.some((e) => e.type === 'state_changed' && String(e.data['key']).endsWith('|cond:temp') && e.data['to'] === 'mild_room'), false, '냉장고와 이어지지 않은 음식은 그대로다');
  const sensed = events.filter((e) => (e.type === 'awareness_up' || e.type === 'awareness_changed') && String(e.data['via']).includes('/sense/')).map((e) => String(e.data['key']).split('|')[0]);
  assert.equal(sensed.includes(MILK) || sensed.includes(CHICKEN), false, '냉장고 안(in)에 든 음식은 눈에 보이지 않는다');
  assert.ok(sensed.includes(FRIDGE), '냉장고 자체는 주방에 놓여 보인다');
});
