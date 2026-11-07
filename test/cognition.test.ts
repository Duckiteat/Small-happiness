// 발견 (5층 지각 + 6층 판단): 앎은 본 단계와 함께 낡고, 다시 보면 바뀌고, 집에 있으면 변화가 있을 때 깨어난다
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agency } from '../src/core/agency.ts';
import { checkValue } from '../src/core/board.ts';
import type { BoardValue } from '../src/core/board.ts';
import { EventLog } from '../src/core/log.ts';
import { Perception } from '../src/core/perception.ts';
import { World } from '../src/core/world.ts';
import { loadDb, scenarioRun } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const isKnownType = (type: string): boolean => vocab.has('event_type', type);
type E = { t: number; type: string; data: Record<string, unknown> };

/** 하루씨, 주방, 우유 하나. */
function home(): { world: World; log: EventLog; perception: Perception; agency: Agency; kitchen: string; milk: string } {
  const log = new EventLog({ isKnownType });
  const world = new World(db, vocab, log);
  world.spawn('CHR000001', { t: 0 });
  const kitchen = world.spawn('PLC000002', { t: 0 }).id;
  const milk = world.spawn('OBJ000002', { t: 0 }).id;
  return { world, log, perception: new Perception(db, vocab, log), agency: new Agency(db, vocab, log), kitchen, milk };
}
/** 직전 단계의 행동(판의 recent 값): 장소를 살핌. 판의 값 검사를 거친다. */
const inspected = (place: string, t: number): BoardValue =>
  checkValue([{ event: 'L000001', who: 'CHR000001#1', verb: 'inspect', offer: 'PLC000002/inspect', at: place, ends: t, effects: [], reveals: place }], 'recent');

test('앎은 낡는다: 살핀 뒤 우유가 상해도 다시 보기 전에는 모르고 버리지 않는다. 다시 살피면 알고 버린다', () => {
  const h = home();
  h.perception.step(h.world, 10, 'home', inspected(h.kitchen, 10)); // 살핌: 우유는 신선
  h.world.set(`${h.milk}|body:sour`, 'lumpy', { t: 20 }); // 그 사이 세계에서는 덩어리짐 (못 먹음)
  const before = h.perception.step(h.world, 30, 'home', []);
  assert.equal(before.aware['CHR000001#1']?.[`${h.milk}|body:sour`]?.level, 'fresh', '본 단계 그대로다');
  assert.deepEqual(h.agency.step(h.world, 30, 'home', before.aware), [], '믿는 것으로는 먹을 수 있다');
  const after = h.perception.step(h.world, 40, 'home', inspected(h.kitchen, 40));
  assert.equal(after.aware['CHR000001#1']?.[`${h.milk}|body:sour`]?.level, 'lumpy');
  assert.deepEqual(h.agency.step(h.world, 40, 'home', after.aware).map((a) => `${a.verb} ${a.at}`), [`discard ${h.milk}`]);
});

test('다시 알아챈다: 주방 냄새가 짙어지면, 없어지면, 다시 나면 앎이 바뀐다', () => {
  const h = home();
  const smell = `${h.kitchen}|space:smell`;
  const steps: [number, string][] = [[10, 'faint'], [20, 'distinct'], [30, 'none'], [40, 'faint']];
  for (const [t, level] of steps) {
    h.world.set(smell, level, { t });
    h.perception.step(h.world, t, 'home', []);
  }
  assert.deepEqual(
    h.log.list({ where: (e) => /^awareness/.test(e.type) && e.data['key'] === smell }).map((e) => `${e.type} ${String(e.data['level'])}`),
    ['awareness_up faint', 'awareness_changed distinct', 'awareness_changed none', 'awareness_changed faint'],
  );
});

test('없어진 냄새는 살필 이유가 아니다: 냄새가 없다고 알게 된 것만으로는 다시 살피지 않는다', () => {
  const h = home();
  const smell = `${h.kitchen}|space:smell`;
  h.world.set(smell, 'faint', { t: 10 });
  h.world.set(`${h.kitchen}|space:odor`, 'sour', { t: 10 }); // 살피기는 시큼함 이상의 냄새 종류를 알아챘을 때만 한다 (구수한 요리 냄새는 살피지 않는다)
  const a = h.perception.step(h.world, 10, 'home', []);
  assert.deepEqual(h.agency.step(h.world, 10, 'home', a.aware).map((x) => x.verb), ['inspect']);
  h.world.set(smell, 'none', { t: 20 });
  h.world.set(`${h.kitchen}|space:odor`, 'none', { t: 20 });
  const b = h.perception.step(h.world, 20, 'home', []);
  assert.deepEqual(h.agency.step(h.world, 20, 'home', b.aware), []);
});

test('외출·잠 중에는 앎이 바뀌지 않는다', () => {
  const h = home();
  h.world.set(`${h.kitchen}|space:smell`, 'distinct', { t: 10 });
  h.perception.step(h.world, 10, 'out', []);
  h.perception.step(h.world, 20, 'asleep', []);
  assert.equal(h.log.list({ where: (e) => /^awareness/.test(e.type) }).length, 0);
});

test('집에 있으면 세계가 바뀌는 시각에 깨어난다: 주말 낮(6일)에도 할 일 없이 단계가 돈다', () => {
  const trace = scenarioRun(ROOT, vocab, 'content/scenarios/first-week.json');
  const day6 = trace.steps.filter((s) => s.t > 5 * 1440 + 420 && s.t < 5 * 1440 + 1380);
  assert.ok(day6.length > 0, '6일 07:00~23:00 사이에 단계가 있다');
  assert.ok(day6.every((s) => Array.isArray(s.values['recent']) && s.values['recent'].length === 0), '행동이 아니라 세계의 변화로 깨어났다');
  const changedAt = new Set((trace.log as E[]).filter((e) => e.type === 'state_changed').map((e) => e.t));
  assert.ok(day6.every((s) => changedAt.has(s.t)), '깨어난 시각마다 세계가 바뀌었다');
});
