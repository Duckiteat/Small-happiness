// 가구와 설비 (docs/물건-관계-명세.md 5장): 기기인가, 연결된 설비(전기·수도·가스)가 있는가, 없으면 비전자제품.
// 설비를 쓰는 가구는 놓이는 장소가 그 설비를 공급해야 한다 (출처 확인). 크기는 정하지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventLog } from '../src/core/log.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { World } from '../src/core/world.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const byName = (ko: string): string => Object.values(db.defs).find((d) => d.names.ko === ko)?.id ?? `없음:${ko}`;

test('가구: 부엌 가구 10개가 정의로 있고, 기기·설비·담을 수 있는 것이 데이터로 갈린다', () => {
  const row = (ko: string): string => {
    const d = db.defs[byName(ko)];
    return `${d?.role}|${(d?.utility ?? []).join('+') || '-'}|${(d?.holds ?? []).join('+') || '-'}`;
  };
  assert.equal(row('식탁'), 'plain|-|-');
  assert.equal(row('의자'), 'plain|-|-');
  assert.equal(row('식탁보'), 'plain|-|-');
  assert.equal(row('전자레인지 선반'), 'plain|-|-');
  assert.equal(row('전자레인지'), 'device|electric|-');
  assert.equal(row('전기밥솥'), 'device|electric|water');
  assert.equal(row('후드'), 'device|electric|-');
  assert.equal(row('가스레인지'), 'device|gas|gas');
  assert.equal(row('싱크대'), 'device|water|water');
  assert.equal(row('냉장고'), 'device|electric|-');
});

test('가구: 설비가 하나도 없는 가구는 전부 그냥 가구(비전자제품)이고, 크기는 정의에 없다', () => {
  const furniture = Object.values(db.defs).filter((d) => d.role !== undefined);
  assert.equal(furniture.length, 13, '부엌 가구 10 · 칼 · 도마 · 냄비');
  for (const d of furniture) {
    if ((d.utility ?? []).length === 0) assert.equal(d.role, 'plain', `${d.names.ko}: 설비가 없으면 그냥 가구`);
    assert.equal('size' in d, false);
  }
  assert.deepEqual(db.defs['PLC000002']?.supplies, ['electric', 'water', 'gas']);
});

function world(): World {
  const w = new World(db, vocab, new EventLog({ isKnownType: (t) => vocab.has('event_type', t) }));
  for (const d of ['PLC000002', 'PLC000003', byName('식탁'), byName('후드'), byName('전자레인지'), byName('전자레인지 선반')]) w.spawn(d, { t: 0 });
  return w;
}

test('출처 확인: 전기를 쓰는 기기는 전기가 들어오는 장소에만 놓이고, 안 들어오는 장소는 거부한다', () => {
  const w = world();
  const hood = `${byName('후드')}#1`;
  assert.throws(() => w.place(hood, 'on', 'PLC000003#1', { t: 1 }), /출처 없음/); // 거실은 공급하지 않는다
  assert.ok(w.place(hood, 'on', 'PLC000002#1', { t: 1 })); // 주방은 공급한다
  // 그냥 가구는 어디든 놓인다
  assert.ok(w.place(`${byName('식탁')}#1`, 'on', 'PLC000003#1', { t: 1 }));
});

test('출처 확인: 기기 위의 물건과 선반 위 기기도 닿는 장소로 본다 (옮기면 함께 본다)', () => {
  const w = world();
  const shelf = `${byName('전자레인지 선반')}#1`, oven = `${byName('전자레인지')}#1`;
  w.place(oven, 'on', shelf, { t: 1 }); // 아직 장소에 닿지 않은 중간 단계
  assert.throws(() => w.place(shelf, 'on', 'PLC000003#1', { t: 2 }), /출처 없음/); // 선반을 거실로 옮기면 그 위의 전자레인지도 걸린다
  assert.ok(w.place(shelf, 'on', 'PLC000002#1', { t: 2 }));
  assert.equal(w.whereIs(oven), 'PLC000002#1');
});

test('부엌 가구 시나리오: 처음 놓임이 세워지고 하루가 돈다 (냉장고·싱크대는 주방 바닥에 놓임)', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-furniture.json'), 'utf8')));
  const trace = runScenario(db, vocab, sc);
  assert.ok(trace.steps.length > 0);
  const layout = (trace.steps[0]?.values['world.place'] as { layout: Record<string, { on?: string }> }).layout;
  assert.equal(layout[`${byName('전자레인지')}#1`]?.on, `${byName('전자레인지 선반')}#1`);
  assert.equal(layout[`${byName('식탁보')}#1`]?.on, `${byName('식탁')}#1`);
});

test('사전: 자원은 사라지는 길(sinks)이 있어야 하고, 밀폐 자원은 담을 수 있어야 한다', () => {
  const raw = (resource: object): VocabCategoryRaw[] => [
    { category: 'sink', entries: [{ key: 'drain', ko: '배수' }] },
    { category: 'resource', entries: [{ key: 'x', ko: '엑스', ...resource }] },
  ];
  const msgs = (r: object): string => validateVocab(raw(r)).map((i) => `${i.path}: ${i.message}`).join('\n');
  assert.match(msgs({ attrs: { holdable: true, sealed: false, sinks: [] } }), /사라지는 길/);
  assert.match(msgs({ attrs: { holdable: true, sealed: false, sinks: ['nowhere'] } }), /sink 분류에 없는 키/);
  assert.match(msgs({ attrs: { holdable: false, sealed: true, sinks: ['drain'] } }), /밀폐된 자원은 담을 수 있어야/);
  assert.equal(msgs({ attrs: { holdable: true, sealed: true, sinks: ['drain'] } }), '');
});

test('밥 짓기: 수도 → 싱크대 → 밥솥 → 전기로 지어짐까지 이어지고, 물과 전기는 끝에 모두 사라진다', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-furniture.json'), 'utf8')));
  const trace = runScenario(db, vocab, sc);
  const sink = `${byName('싱크대')}#1`, cooker = `${byName('전기밥솥')}#1`;
  type E = { type: string; t: number; data: { key?: string; to?: string; verb?: string } };
  const log = trace.log as E[];
  const changes = log.filter((e) => e.type === 'state_changed').map((e) => `${e.data.key}=${e.data.to}`);
  // 순서: 싱크대 가득 → 밥솥 가득(싱크대 비움) → 켜짐 → 밥 → 밥솥 물 없음·꺼짐
  const at = (s: string): number => changes.indexOf(s);
  assert.ok(at(`${sink}|basin:water=full`) >= 0);
  assert.ok(at(`${cooker}|pot:water=full`) > at(`${sink}|basin:water=full`));
  assert.ok(at(`${sink}|basin:water=none`) > at(`${sink}|basin:water=full`), '붓고 나면 싱크대 물이 줄어든다 (옮겨 간다)');
  assert.ok(at(`${cooker}|pot:power=on`) > at(`${cooker}|pot:water=full`));
  assert.ok(at(`${cooker}|pot:rice=cooked`) > at(`${cooker}|pot:power=on`));
  const done = log.find((e) => e.type === 'state_changed' && e.data.key === `${cooker}|pot:rice` && e.data.to === 'cooked');
  const on = log.find((e) => e.type === 'state_changed' && e.data.key === `${cooker}|pot:power` && e.data.to === 'on');
  assert.equal((done?.t ?? 0) - (on?.t ?? 0), 30, '켠 뒤 30분 (임시값)');
  // 마지막 상태: 물은 어디에도 남지 않고(밥이 흡수·배수), 전기는 꺼졌다
  const last = trace.steps.at(-1)?.values['world.state'] as Record<string, string>;
  assert.equal(last[`${cooker}|pot:rice`], 'cooked');
  for (const [k, v] of Object.entries(last)) {
    if (k.endsWith(':water')) assert.equal(v, 'none', `${k}: 끝에 물이 남아 있다`);
    if (k.endsWith(':power') && !k.includes('cooling:')) assert.equal(v, 'off', `${k}: 끝에 켜져 있다 (냉장고만 계속 켜져 있다)`);
  }
});

test('후드: 요리로 주방 냄새가 짙어지면 켜고, 10분 뒤 냄새가 옅어지며, 한 시간 뒤 스스로 꺼진다 (전기가 환기 효과가 되고 사라진다)', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-furniture.json'), 'utf8')));
  const trace = runScenario(db, vocab, sc);
  type E = { type: string; t: number; data: { key?: string; to?: string } };
  const log = trace.log as E[];
  const change = (key: string, to: string): E | undefined => log.find((e) => e.type === 'state_changed' && e.data.key === key && e.data.to === to);
  const hood = `${byName('후드')}#1`;
  const smell = 'PLC000002#1|space:smell';
  const thick = change(smell, 'distinct');
  const on = change(`${hood}|fan:power`, 'on');
  const thin = change(smell, 'faint');
  const off = change(`${hood}|fan:power`, 'off');
  assert.ok(thick && on && thin && off, '냄새가 짙어짐 · 후드 켜짐 · 냄새 옅어짐 · 후드 꺼짐이 모두 있어야 한다');
  assert.ok(on.t >= thick.t, '냄새가 짙어진 뒤에 켠다');
  assert.equal(thin.t - on.t, 10, '켠 뒤 10분 (임시값)');
  assert.equal(off.t - on.t, 60, '켠 뒤 한 시간에 꺼진다 (임시값)');
  const last = trace.steps.at(-1)?.values['world.state'] as Record<string, string>;
  assert.equal(last[`${hood}|fan:power`], undefined, '끝에 꺼져 있다 (기본값 = 꺼짐)');
});

test('가스레인지: 불을 붙이면(점화) 요리하고, 한 시간 뒤 꺼진다 (가스는 연소로 사라진다). 불 없이는 요리하지 않는다', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-furniture.json'), 'utf8')));
  const trace = runScenario(db, vocab, sc);
  type E = { type: string; t: number; data: { key?: string; to?: string; verb?: string; via?: string } };
  const log = trace.log as E[];
  const stove = `${byName('가스레인지')}#1`;
  const lit = log.find((e) => e.type === 'state_changed' && e.data.key === `${stove}|burner:flame` && e.data.to === 'lit');
  const out = log.find((e) => e.type === 'state_changed' && e.data.key === `${stove}|burner:flame` && e.data.to === 'out');
  const cook = log.find((e) => e.type === 'action_chosen' && e.data.verb === 'cook');
  assert.ok(lit && out && cook);
  assert.ok(cook.t >= lit.t, '요리는 불이 붙은 뒤에 한다');
  assert.equal(out.t - lit.t, 60, '불은 한 시간 뒤 꺼진다 (임시값)');
});

test('보이는 상태: 하루씨가 머무는 장소에 놓인 물건의 눈에 보이는 상태는 저절로 알고, 놓임이 없는 물건은 살펴야만 안다', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-furniture.json'), 'utf8')));
  const trace = runScenario(db, vocab, sc);
  type E = { type: string; data: { key?: string; via?: string } };
  const sensed = new Set((trace.log as E[]).filter((e) => (e.type === 'awareness_up' || e.type === 'awareness_changed') && String(e.data.via).includes('/sense/')).map((e) => String(e.data.key).split('|')[0]));
  assert.ok(sensed.has(`${byName('가스레인지')}#1`), '주방에 놓인 가스레인지의 불은 저절로 안다');
  assert.equal(sensed.has(`${byName('계란')}#1`), false, '놓임이 없는 계란은 저절로 알지 못한다');
});
