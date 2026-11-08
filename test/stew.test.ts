// 된장찌개 (docs/요리-설계.md): 메뉴는 하루 계획에 적고, 재료는 남은 양에서 칸씩 쓰며, 맹물 → 육수 → 찌개의 국물 단계를 둔다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openLadder, stepDown } from '../src/core/amount.ts';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { conceive, recipeNeeds } from '../src/core/conceive.ts';
import { mealAt, parsePlan, ScheduleError } from '../src/core/schedule.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const byName = (ko: string): string => Object.values(db.defs).find((d) => d.names.ko === ko)?.id ?? `없음:${ko}`;
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-stew.json'), 'utf8')) as Record<string, unknown>;
const sc = parseScenario(raw());
const trace = runScenario(db, vocab, sc);
const events = (): GameEvent[] => trace.log.map(parseEvent);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const inst = (ko: string): string => `${byName(ko)}#1`;
const changes = events().filter((e) => e.type === 'state_changed').map((e) => ({ t: e.t, key: str(e.data['key']), to: str(e.data['to']) }));
const chosen = events().filter((e) => e.type === 'action_chosen').map((e) => ({ t: e.t, via: str(e.data['via']), at: str(e.data['at']) }));
const state = trace.steps.at(-1)?.values['world.state'] as Record<string, string>;
/** 마지막 단계 (0칸은 판에 적지 않으므로 사다리 0칸으로 읽는다) */
const last = (key: string): string => state[key] ?? vocab.levelOrder(key.slice(key.lastIndexOf(':') + 1))?.[0] ?? '';

test('쓰는 양: 열린 칸으로 steps칸 내리고, 잠긴 칸은 건너뛰며, 모자라면 쓸 수 없다', () => {
  assert.deepEqual(openLadder(vocab, 'amount'), ['none', 'little', 'half', 'plenty', 'full']);
  assert.equal(stepDown(vocab, 'amount', 'full', 1), 'plenty');
  assert.equal(stepDown(vocab, 'amount', 'full', 2), 'half');
  assert.equal(stepDown(vocab, 'amount', 'little', 1), 'none');
  assert.equal(stepDown(vocab, 'amount', 'little', 2), null, '조금 남았는데 두 칸은 못 쓴다');
  assert.equal(stepDown(vocab, 'amount', 'none', 1), null);
  assert.equal(stepDown(vocab, 'filling', 'veg', 1), 'none');
  assert.equal(stepDown(vocab, 'amount', 'gone', 1), null, '소멸은 사다리 밖이다');
});

test('끼니: 일정에는 메뉴가 없고(적으면 거부), 메뉴를 구상하는 구간(식사 준비)만 끼니다', () => {
  const plan = parsePlan(sc.routine, vocab);
  assert.deepEqual(mealAt(plan, 1100, vocab), { from: 1100 });
  assert.deepEqual(mealAt(plan, 2170, vocab), { from: 2160 });
  assert.equal(mealAt(plan, 1300, vocab), undefined, '구간 밖');
  assert.equal(mealAt(plan, 1400, vocab), undefined, '잠은 끼니가 아니다');
  assert.throws(() => parsePlan({ blocks: [{ kind: 'meal', from: 0, to: 10, menu: 'doenjang_jjigae' }] }, vocab), ScheduleError);
});

test('요리법의 재료: 같은 메뉴의 행동들이 재료로 쓰는 칸을 모은다 (요리법을 따로 적지 않는다)', () => {
  const needs = recipeNeeds(db, 'doenjang_jjigae').map((n) => `${db.defs[n.def]?.names.ko}:${n.steps}`);
  assert.deepEqual(needs.sort(), ['국물용 멸치:1', '대파:1', '된장:1', '두부:2', '애호박:2', '양파:2'].sort());
  assert.deepEqual(recipeNeeds(db, 'leftover_stew').map((n) => `${db.defs[n.def]?.names.ko}:${n.steps}`), ['찌개:2'], '된장찌개·김치찌개 어느 것이든');
  assert.deepEqual(recipeNeeds(db, 'kimchi_jjigae').map((n) => `${db.defs[n.def]?.names.ko}:${n.steps}`).sort(), ['국물용 멸치:1', '김치:1', '대파:1', '두부:2', '양파:2'].sort());
  // 아는 것으로만 구상한다: 아무것도 모르면 만들 것이 없고, 남은 찌개를 알면 그것이 먼저다
  const none = conceive(db, vocab, { known: () => [], level: () => 'full' });
  assert.equal(none, null);
  const all = conceive(db, vocab, { known: (d) => [`${d}#1`], level: () => 'full', skill: () => 'novice' });
  assert.equal(all?.menu, 'leftover_stew', '남은 음식이 앞선다 (rank)');
  const noStew = (skill: string, last: (m: string) => number = () => -1): string | undefined =>
    conceive(db, vocab, { known: (d) => (d === byName('찌개') ? [] : [`${d}#1`]), level: () => 'full', skill: () => skill, lastPlanned: last })?.menu;
  assert.equal(noStew('novice'), 'doenjang_jjigae', '입문이면 김치찌개는 아직');
  assert.equal(noStew('basic', (m) => (m === 'doenjang_jjigae' ? 1100 : -1)), 'kimchi_jjigae', '기초가 되면 해 본 적 없는 김치찌개에 먼저 도전한다');
  assert.equal(noStew('basic', (m) => (m === 'kimchi_jjigae' ? 2540 : 1100)), 'doenjang_jjigae', '같은 순위면 번갈아 (오래된 것 먼저)');
  const littleOnion = conceive(db, vocab, { known: (d) => (d === byName('찌개') ? [] : [`${d}#1`]), skill: () => 'basic', level: (k) => (k.startsWith(byName('양파')) ? 'little' : 'full') });
  assert.equal(littleOnion, null, '양파가 조금이면 (반이 필요) 시작하지 않는다');
});

test('된장찌개: 썰기 → 물 받아 붓기 → 불 → 멸치 육수(10분) → 된장 → 채소·두부·대파 → 끓음(5분) → 불 끄기 → 먹기 → 설거지', () => {
  const pot = inst('냄비'), stove = inst('가스레인지');
  const first = (key: string, to: string): number => changes.find((c) => c.key === key && c.to === to)?.t ?? -1;
  const order = [
    first(`${inst('두부')}|cond:cut`, 'sliced'),
    first(`${pot}|pot:soup`, 'plain'),
    first(`${stove}|burner:flame`, 'lit'),
    first(`${pot}|pot:soup`, 'steeping'),
    first(`${pot}|pot:soup`, 'broth'),
    first(`${pot}|pot:soup`, 'seasoned'),
    first(`${pot}|pot:filling`, 'veg'),
    first(`${pot}|pot:filling`, 'tofu'),
    first(`${pot}|pot:filling`, 'scallion'),
    first(`${pot}|pot:soup`, 'stew'),
  ];
  assert.ok(order.every((t) => t >= 0), `빠진 단계가 있다: ${order.join(', ')}`);
  for (let i = 1; i < order.length; i++) assert.ok((order[i] as number) >= (order[i - 1] as number), `${i}번째 단계가 앞 단계보다 먼저다`);
  assert.equal(first(`${pot}|pot:soup`, 'broth') - first(`${pot}|pot:soup`, 'steeping'), 10, '육수는 10분 (임시값)');
  assert.equal(first(`${pot}|pot:soup`, 'stew') - first(`${pot}|pot:filling`, 'scallion'), 5, '찌개는 5분 (임시값)');
  // 찌개가 되면 주방에 구수한 냄새, 불은 하루씨가 끈다 (한 시간 뒤 저절로 꺼지기 전에)
  const stewAt = first(`${pot}|pot:soup`, 'stew');
  assert.ok(changes.some((c) => c.t === stewAt && c.key === `${inst('주방')}|space:odor` && c.to === 'savory'));
  assert.ok(chosen.some((c) => c.via.endsWith('/offer/extinguish_stew') && c.t >= stewAt && c.t < stewAt + 10));
  // 먹고 나면 냄비가 더러워지고, 받은 물로 냄비·칼·도마를 씻는다
  const eaten = chosen.find((c) => c.via.endsWith('/offer/eat'))?.t ?? -1;
  const washed = chosen.find((c) => c.via.endsWith('/offer/wash_dishes'))?.t ?? -1;
  assert.ok(eaten > stewAt && washed > eaten);
});

test('구상: 하루씨가 끼니마다 아는 재료로 메뉴를 정하고, 남은 찌개를 먼저 먹으며, 만들 수 없으면 시작하지 않는다', () => {
  const plans = events().filter((e) => e.type === 'menu_planned').map((e) => `${String(e.data['meal'])}:${str(e.data['menu'])}`);
  assert.deepEqual(plans, ['1100:doenjang_jjigae', '2160:leftover_stew', '2540:kimchi_jjigae'], '첫날 요리로 솜씨가 올라 둘째 날 저녁에 김치찌개에 도전한다');
  const stews = changes.filter((c) => c.key === `${inst('냄비')}|pot:soup` && c.to === 'stew').map((c) => c.t);
  assert.equal(stews.length, 2, '첫날 저녁 한 번 · 둘째 날 저녁 한 번 (첫날 끼니에 시간이 남아도 다시 끓이지 않는다)');
  assert.ok((stews[0] as number) < 1220 && (stews[1] as number) >= 2540);
  const lunch = chosen.filter((c) => c.t >= 2160 && c.t < 2220).map((c) => c.via.split('/').at(-1));
  assert.deepEqual(lunch, ['take_out', 'reheat', 'eat_leftover'], '남은 찌개 점심');
  // 셋째 날: 점심은 둘째 날 남은 찌개, 저녁은 양파·애호박·두부가 없어 구상하지 못하고 아무것도 시작하지 않는다
  const r = raw();
  r['end'] = 4400;
  (r['routine'] as { blocks: unknown[] }).blocks.push({ kind: 'asleep', from: 2820, to: 3300 }, { kind: 'meal', from: 3600, to: 3660 }, { kind: 'meal', from: 3980, to: 4100 });
  const sc3 = parseScenario(r);
  const three = runScenario(db, vocab, sc3).log.map(parseEvent);
  assert.deepEqual(three.filter((e) => e.type === 'menu_planned' && Number(e.data['meal']) >= 3600).map((e) => str(e.data['menu'])), ['leftover_stew']);
  assert.deepEqual(three.filter((e) => e.type === 'action_chosen' && e.t >= 3980), [], '못 끝낼 요리는 시작하지 않는다');
  assert.deepEqual(auditLog(three, db, vocab, { externalUntil: sc3.start }).findings, []);
  // 재료가 냉장고 안에 있어 본 적이 없으면 (있는 줄 모르면) 구상하지 못한다
  const hidden = raw();
  const food = ['OBJ000026', 'OBJ000027', 'OBJ000028', 'OBJ000003', 'OBJ000011', 'OBJ000032'];
  hidden['layout'] = (hidden['layout'] as string[]).filter((l) => !food.some((f) => l.endsWith(`^${f}#1`)));
  hidden['contain'] = food.map((f) => ({ id: `${f}#1`, in: 'OBJ000021#1' }));
  const blind = runScenario(db, vocab, parseScenario(hidden)).log.map(parseEvent);
  assert.equal(blind.filter((e) => e.type === 'menu_planned').length, 0);
});

test('된장찌개: 재료는 남은 양에서 칸씩 쓰이고, 이미 썬 재료는 다시 썰지 않는다', () => {
  // 첫날 된장찌개(된장·멸치·대파 1칸, 양파·애호박·두부 2칸), 둘째 날 김치찌개(김치·멸치·대파 1칸, 양파·두부 2칸)
  assert.equal(last(`${inst('된장')}|cond:amount`), 'plenty');
  assert.equal(last(`${inst('김치')}|cond:amount`), 'plenty');
  assert.equal(last(`${inst('국물용 멸치')}|cond:amount`), 'half');
  assert.equal(last(`${inst('대파')}|cond:amount`), 'half');
  assert.equal(last(`${inst('애호박')}|cond:amount`), 'half', '김치찌개에는 애호박을 넣지 않는다');
  for (const ko of ['양파', '두부']) assert.equal(last(`${inst(ko)}|cond:amount`), 'none', `${ko}: 반씩 두 번`);
  const slices = chosen.filter((c) => c.via.endsWith('/offer/slice_for_stew'));
  assert.equal(slices.length, 4, '두부·대파·양파·애호박을 첫날에만 썬다');
  assert.ok(slices.every((s) => s.t < 1220));
  // 끝: 냄비·칼·도마는 깨끗하고, 물은 남지 않으며, 불은 꺼져 있다
  for (const ko of ['냄비', '칼', '도마']) assert.equal(last(`${inst(ko)}|body:dirt`), 'clean', `${ko}: 설거지했다`);
  for (const [k, v] of Object.entries(state)) if (k.endsWith(':water')) assert.equal(v, 'none', `${k}: 물이 남았다`);
  assert.equal(last(`${inst('가스레인지')}|burner:flame`), 'out');
});

test('된장찌개: 감사가 기록을 정의에서 다시 계산해 위반이 없고, 쓴 양·메뉴·한 끼 한 번을 고치면 잡는다', () => {
  const opts = { externalUntil: sc.start };
  assert.deepEqual(auditLog(events(), db, vocab, opts).findings, []);
  const amountKey = `${inst('된장')}|cond:amount`;
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[]; check: string }[] = [
    {
      name: '된장을 한 칸이 아니라 두 칸 쓴 것으로 고침',
      mutate: (es) => es.map((e) => (e.type === 'state_changed' && e.data['key'] === amountKey && e.data['to'] === 'plenty' ? { ...e, data: { ...e.data, to: 'half' } } : e)),
      check: 'effects',
    },
    {
      name: '요리법 단계의 메뉴를 지움',
      mutate: (es) => es.map((e) => {
        if (e.type !== 'action_chosen' || e.data['menu'] === undefined) return e;
        const { menu: _menu, ...data } = e.data;
        return { ...e, data };
      }),
      check: 'action',
    },
    {
      name: '첫 끼니의 구상을 남은 찌개로 고침 (그때는 남은 찌개를 몰랐다)',
      mutate: (es) => es.map((e) => (e.type === 'menu_planned' && e.data['meal'] === 1100 ? { ...e, data: { ...e.data, menu: 'leftover_stew' } } : e)),
      check: 'action',
    },
    {
      name: '구상 기록을 지움 (요리법 단계가 구상 없이 골라짐)',
      mutate: (es) => es.filter((e) => e.type !== 'menu_planned'),
      check: 'action',
    },
    {
      name: '둘째 날 저녁의 단계를 첫날 끼니로 적음',
      mutate: (es) => es.map((e) => (e.type === 'action_chosen' && e.data['meal'] === 2540 ? { ...e, data: { ...e.data, meal: 1100 } } : e)),
      check: 'action',
    },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(events())), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === c.check), `${c.name}: ${c.check} 위반을 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});

test('남은 찌개: 반쯤 덜어 먹고 반찬통에 옮겨 담으면 새 음식이 되어 냉장고에서 차가워지고, 다음 끼니에 꺼내 데워 먹는다', () => {
  const box = inst('반찬통'), fridge = inst('냉장고'), microwave = inst('전자레인지');
  const made = events().filter((e) => e.type === 'instance_created' && (e.data['def'] === byName('된장찌개') || e.data['def'] === byName('김치찌개')));
  assert.deepEqual(made.map((e) => db.defs[str(e.data['def'])]?.names.ko), ['된장찌개', '김치찌개'], '끓인 두 번 모두 남은 것을 옮겨 담고, 냄비의 국물 바탕이 어떤 찌개인지 정한다');
  const first = str(made[0]?.data['id']);
  const cause = events().find((e) => e.seq === made[0]?.cause);
  assert.equal(cause?.type, 'action_done', '찌개 개체는 옮겨 담기가 끝나 생긴다');
  assert.equal(str(cause?.data['via']).split('/').at(-1), 'transfer_doenjang');
  const placed = events().filter((e) => e.type === 'placed');
  const put = (id: string, rel: string, to: string): number => placed.find((e) => e.data['id'] === id && e.data['rel'] === rel && e.data['to'] === to)?.t ?? -1;
  assert.ok(put(first, 'in', box) > 0, '찌개는 반찬통 안에');
  const stored = put(box, 'in', fridge);
  assert.ok(stored > 0 && stored < 1220, '첫날 저녁에 냉장고에 넣는다');
  // 냉장고 안에서 한 시간 뒤 차가워진다 (냉장고의 rechill 규칙이 안에 든 것에 걸린다)
  const chilled = changes.find((c) => c.key === `${first}|cond:temp` && c.to === 'fridge')?.t ?? -1;
  assert.equal(chilled - stored, 60, '넣은 뒤 한 시간 (임시값)');
  // 둘째 날 점심: 꺼내 전자레인지에 넣고(본다), 식은 것을 데워(뜨거움) 먹는다
  assert.ok(put(box, 'in', microwave) >= 2160);
  const hot = changes.filter((c) => c.key === `${first}|cond:heat` && c.to === 'hot').map((c) => c.t);
  assert.equal(hot.length, 2, '만들 때 한 번 · 데울 때 한 번');
  assert.ok((hot[1] as number) >= 2160 && (hot[1] as number) < 2220);
  assert.equal(last(`${first}|cond:seal`), 'gone', '먹었다');
  assert.equal(placed.some((e) => e.data['id'] === first && e.data['rel'] === 'in' && e.data['to'] === null), true, '먹은 찌개는 반찬통에서 빠진다');
  // 끝: 둘째 날 끓인 찌개가 반찬통에 담겨 냉장고 안에 있다
  const second = str(made[1]?.data['id']);
  assert.equal(last(`${box}|box:contents`), 'full');
  assert.ok(put(second, 'in', box) >= 2540);
  assert.deepEqual(placed.filter((e) => e.data['id'] === box && e.data['rel'] === 'in' && e.data['to'] === fridge).map((e) => e.t < 1220 || e.t >= 2540), [true, true], '두 번 다 그 끼니에 냉장고에 넣는다');
  // 하루씨에게 없는 감각(촉각)으로 아는 것을 바꾸지 않는다: 살펴서 안 온도가 '없음'으로 돌아가지 않는다
  assert.equal(events().some((e) => e.type.startsWith('awareness') && str(e.data['via']).endsWith('/sense/touch')), false);
});

test('남은 찌개: 감사가 만들기·옮기기를 행동에서 다시 계산하고, 고친 기록을 잡는다', () => {
  const opts = { externalUntil: sc.start };
  const fridge = inst('냉장고'), box = inst('반찬통');
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[] }[] = [
    { name: '반찬통을 냉장고가 아니라 식탁에 넣은 것으로 고침', mutate: (es) => es.map((e) => (e.type === 'placed' && e.data['id'] === box && e.data['to'] === fridge ? { ...e, data: { ...e.data, to: inst('식탁') } } : e)) },
    { name: '옮겨 담기가 다른 음식을 만든 것으로 고침', mutate: (es) => es.map((e) => (e.type === 'instance_created' && e.data['def'] === byName('된장찌개') ? { ...e, data: { ...e.data, def: byName('된장') } } : e)) },
    { name: '냉장고에 넣은 기록을 지움', mutate: (es) => es.filter((e) => !(e.type === 'placed' && e.data['id'] === box && e.data['to'] === fridge)) },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(events())), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === 'effects'), `${c.name}: 결과(effects) 위반을 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});

test('숙련: 재료를 쓸 때마다 갈래별로 쌓이고(녹슬지 않음), 요리 솜씨가 기초가 되면 김치찌개를 구상하며, 손질 솜씨가 오르면 빨리 썬다', () => {
  const who = inst('하루씨');
  const rises = changes.filter((c) => c.key.startsWith(`${who}|skill:`)).map((c) => `${c.key.split(':').at(-1)}=${c.to}`);
  assert.deepEqual(rises, ['handling=basic', 'judging=basic', 'cooking=basic'], '썰기 4번 → 손질·감별 기초, 재료 6칸 → 요리 기초 (임시값)');
  const cookingUp = changes.find((c) => c.key === `${who}|skill:cooking`)?.t ?? -1;
  assert.ok(cookingUp > 1100 && cookingUp < 1220, '첫날 요리 중에 오른다');
  // 원인은 그 재료를 넣은 행동의 끝
  const e = events().find((x) => x.type === 'state_changed' && x.data['key'] === `${who}|skill:cooking`);
  assert.equal(events().find((x) => x.seq === e?.cause)?.type, 'action_done');
  // 손질 솜씨가 처음부터 능숙(60%)이면 3분 썰기가 1분이 된다 (내림, 최소 1분)
  const r = raw();
  r['set'] = [{ key: `${who}|skill:handling`, level: 'skilled', t: 0 }];
  const fast = runScenario(db, vocab, parseScenario(r)).log.map(parseEvent);
  const slice = fast.find((x) => x.type === 'action_chosen' && str(x.data['via']).endsWith('/offer/slice_for_stew'));
  assert.equal(Number(slice?.data['ends']) - (slice?.t ?? 0), 1);
  assert.equal(fast.some((x) => x.type === 'state_changed' && x.t > 0 && x.data['key'] === `${who}|skill:handling`), false, '처음부터 능숙하면 썰어도 내려가지 않는다');
  assert.deepEqual(auditLog(fast, db, vocab, { externalUntil: 0 }).findings, []);
  // 감사: 숙련이 오른 기록을 지우거나, 끝나는 시각을 숙련 없는 시간으로 고치면 잡는다
  const opts = { externalUntil: sc.start };
  const noRise = events().filter((x) => !(x.type === 'state_changed' && str(x.data['key']).startsWith(`${who}|skill:`)));
  assert.ok(auditLog(noRise, db, vocab, opts).findings.some((f) => f.check === 'effects'));
  const slow = fast.map((x) => (x.seq === slice?.seq ? { ...x, data: { ...x.data, ends: (slice?.t ?? 0) + 3 } } : x));
  assert.ok(auditLog(slow, db, vocab, { externalUntil: 0 }).findings.some((f) => f.check === 'action'));
});
