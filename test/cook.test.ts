// 요리 (docs/냄새-모델.md 6장 · 결정-기록 "요리"): 사람과 음식(물체)의 상호작용이 냄새의 원인이 된다.
// 식사 준비 시간에만 하고, 재료는 쓰여서 소멸하며, 요리 냄새(구수함)는 벌레도 살피기도 부르지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEvent } from '../src/core/events.ts';
import { odorChain } from '../src/core/odor.ts';
import { isObserved, nextStepTime, parsePlan, presenceAt, ScheduleError } from '../src/core/schedule.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const scenario = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')));
const events = runScenario(db, vocab, scenario).log.map(parseEvent);
const blocks = parsePlan(scenario.routine, vocab);

test('식사 준비는 플레이어가 함께 보는 시간이다: 사전이 정하고, 일정 구간으로 쓸 수 있으며, 그 안에서 행동이 끝나는 시각도 단계가 된다', () => {
  assert.deepEqual(['home', 'meal', 'out', 'asleep'].map((p) => isObserved(vocab, p)), [true, true, false, false]);
  const plan = parsePlan({ blocks: [{ kind: 'meal', from: 100, to: 140 }, { kind: 'out', from: 200, to: 300 }] }, vocab);
  assert.equal(presenceAt(plan, 120), 'meal');
  assert.throws(() => parsePlan({ blocks: [{ kind: 'home', from: 0, to: 10 }] }, vocab), ScheduleError);
  const observed = (p: string): boolean => isObserved(vocab, p);
  assert.equal(nextStepTime(plan, 100, 400, [130], 180, observed), 130, '식사 준비 안에서 끝나는 행동은 단계를 만든다');
  assert.equal(nextStepTime(plan, 100, 400, [250], 180, observed), 140, '외출 중에 끝나는 시각은 단계를 만들지 않는다');
});

test('첫 주의 요리: 식사 시간에만 하고, 계란과 햄을 한 번씩 쓰고, 재료는 소멸하며, 다시 요리하지 않는다', () => {
  const chosen = events.filter((e) => e.type === 'action_chosen' && e.data['verb'] === 'cook');
  assert.deepEqual(chosen.map((e) => [e.t, e.data['at'], e.data['via'], e.data['ends']]), [
    [441, 'OBJ000004#1', 'OBJ000004/offer/cook', 481], // 440에 가스레인지 불을 붙이고(1분) 요리한다
    [1181, 'OBJ000009#1', 'OBJ000009/offer/cook', 1221], // 불은 한 시간 뒤 꺼졌고 하루씨도 안다(보이는 상태): 다시 불을 붙인다
  ]);
  // 요리는 불이 켜져 있어야 한다: 요리 직전에 가스레인지에 불을 붙였다 (가스가 연소해 열이 된다)
  const ignites = events.filter((e) => e.type === 'action_chosen' && e.data['verb'] === 'switch').map((e) => [e.t, e.data['via']]);
  assert.deepEqual(ignites, [[440, 'OBJ000019/offer/ignite_egg'], [1180, 'OBJ000019/offer/ignite_ham']]);
  for (const c of chosen) assert.equal(presenceAt(blocks, c.t), 'meal', `${c.t}분은 식사 준비 시간이다`);
  const outside = events.filter((e) => e.type === 'action_chosen' && e.data['verb'] !== 'cook' && e.data['verb'] !== 'switch' && presenceAt(blocks, e.t) === 'meal');
  assert.deepEqual(outside, [], '식사 시간에도 다른 행동은 그대로 한다(여기서는 없다)');
  // 재료는 쓰여서 소멸로 바뀐다 (버리기와 같은 표시)
  const gone = (key: string) => events.filter((e) => e.type === 'state_changed' && e.data['key'] === key && e.data['to'] === 'gone').length;
  for (const food of ['OBJ000004#1', 'OBJ000009#1']) for (const slot of ['body:smell', 'body:odor', 'cond:seal']) assert.equal(gone(`${food}|${slot}`), 1, `${food} ${slot}`);
  // 쓰인 재료를 하루씨가 안다: 자기 행동의 결과는 이해함이고, 원인은 그 행동의 끝이다
  const done = events.find((e) => e.type === 'action_done' && e.data['via'] === 'OBJ000004/offer/cook');
  const learned = events.filter((e) => e.type === 'awareness_up' && e.cause === done?.seq);
  assert.ok(learned.length >= 3, '재료의 냄새·종류·보관과 주방의 냄새를 이해함으로 안다');
  assert.ok(learned.every((e) => e.data['via'] === 'OBJ000004/offer/cook' && e.data['to'] === 'understood'));
});

test('요리 냄새는 구수함이다: 주방에 냄새가 나도 벌레를 부르지 않고 살피지 않으며, 그 냄새는 지식(요리의 사슬)과 같다', () => {
  const cooked = events.filter((e) => e.type === 'state_changed' && e.data['key'] === 'PLC000002#1|space:odor' && e.data['to'] === 'savory');
  assert.equal(cooked.length, 2, '요리마다 주방에 구수한 냄새');
  const smell = events.filter((e) => e.type === 'state_changed' && e.data['key'] === 'PLC000002#1|space:smell' && e.t === cooked[0]?.t);
  assert.deepEqual(smell.map((e) => e.data['to']), ['distinct'], '냄새의 세기도 뚜렷함');
  // 첫 벌레 예약과 첫 살피기는 치킨이 상한 뒤(썩는 냄새)에야 있다
  const spoiled = events.find((e) => e.type === 'state_changed' && e.data['key'] === 'PLC000002#1|space:odor' && e.data['to'] === 'putrid');
  const bugs = events.find((e) => e.type === 'delay_scheduled' && e.data['via'] === 'PLC000002/rule/bugs');
  const inspect = events.find((e) => e.type === 'action_chosen' && e.data['verb'] === 'inspect');
  assert.ok(spoiled && bugs && inspect);
  assert.ok(bugs.t >= spoiled.t && inspect.t >= spoiled.t, `구수한 냄새에는 벌레도 살피기도 없다 (썩는 냄새 ${spoiled.t}분, 벌레 ${bugs.t}분, 살피기 ${inspect.t}분)`);
  // 지식과 데이터가 어긋나지 않는다: 요리의 사슬이 말하는 대표 냄새 = 요리 효과가 주방에 적는 냄새 종류
  const chain = odorChain(vocab).find((s) => s.cause === 'cooking');
  for (const food of ['OBJ000004', 'OBJ000009']) {
    const effect = db.defs[food]?.offers?.['cook']?.effect.find((t) => t.includes('|space:odor@>='));
    assert.equal(effect?.split('>=')[1], chain?.dominant, `${food}의 요리 효과`);
  }
});
