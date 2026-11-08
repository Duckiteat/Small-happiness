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
import { menuAt, parsePlan, ScheduleError } from '../src/core/schedule.ts';
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

test('일정의 메뉴: 구간에 적은 메뉴만 그 구간의 메뉴이고, 사전에 없는 메뉴는 거부한다', () => {
  const plan = parsePlan(sc.routine, vocab);
  assert.deepEqual(menuAt(plan, 1100), { menu: 'doenjang_jjigae', from: 1100 });
  assert.equal(menuAt(plan, 2170), undefined, '둘째 날 점심은 메뉴가 없다');
  assert.equal(menuAt(plan, 1300), undefined, '구간 밖');
  assert.throws(() => parsePlan({ blocks: [{ kind: 'meal', from: 0, to: 10, menu: 'pizza' }] }, vocab), ScheduleError);
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

test('된장찌개: 한 끼에 한 번만 끓이고, 메뉴가 없는 끼니에는 썰지도 끓이지도 않는다', () => {
  const stews = changes.filter((c) => c.key === `${inst('냄비')}|pot:soup` && c.to === 'stew').map((c) => c.t);
  assert.equal(stews.length, 2, '첫날 저녁 한 번 · 둘째 날 저녁 한 번 (첫날 끼니에 시간이 남아도 다시 끓이지 않는다)');
  assert.ok((stews[0] as number) < 1220 && (stews[1] as number) >= 2540);
  const lunch = chosen.filter((c) => c.t >= 2160 && c.t < 2220);
  assert.deepEqual(lunch, [], '메뉴 없는 점심');
  // 메뉴를 지우면 하루 종일 요리법의 어떤 단계도 고르지 않는다
  const r = raw();
  const routine = r['routine'] as { blocks: Record<string, unknown>[] };
  for (const b of routine.blocks) delete b['menu'];
  const plain = runScenario(db, vocab, parseScenario(r)).log.map(parseEvent);
  const recipe = plain.filter((e) => e.type === 'action_chosen' && db.defs[str(e.data['at']).split('#')[0] ?? '']?.offers?.[str(e.data['via']).split('/').at(-1) ?? '']?.menu !== undefined);
  assert.deepEqual(recipe, []);
  assert.equal(plain.filter((e) => e.type === 'action_chosen').length, 0, '이 시나리오의 행동은 모두 된장찌개의 단계다');
});

test('된장찌개: 재료는 남은 양에서 칸씩 쓰이고, 이미 썬 재료는 다시 썰지 않는다', () => {
  // 하루에 된장·멸치·대파 1칸, 양파·애호박·두부 2칸(반) → 이틀이면 된장 반, 양파는 다 씀
  assert.equal(last(`${inst('된장')}|cond:amount`), 'half');
  assert.equal(last(`${inst('국물용 멸치')}|cond:amount`), 'half');
  assert.equal(last(`${inst('대파')}|cond:amount`), 'half');
  for (const ko of ['양파', '애호박', '두부']) assert.equal(last(`${inst(ko)}|cond:amount`), 'none', `${ko}: 반씩 두 번`);
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
