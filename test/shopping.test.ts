// 장보기 (docs/요리-설계.md 12장): 만들 수 있는 요리가 없으면 모자란 재료를, 다 파는 곳 중 열려 있고 가장 빨리 손에 들어오는 곳에서 산다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { canBuy, readyAt, shoppingList } from '../src/core/shopping.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const byName = (ko: string): string => Object.values(db.defs).find((d) => d.names.ko === ko)?.id ?? `없음:${ko}`;
const inst = (ko: string, n = 1): string => `${byName(ko)}#${n}`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-shopping.json'), 'utf8')) as Record<string, unknown>;
const run = (r: Record<string, unknown>): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(r);
  return { events: runScenario(db, vocab, sc).log.map(parseEvent), start: sc.start };
};
const day = run(raw());
const offerOf = (d: string, key: string) => db.defs[byName(d)]?.offers?.[key];

test('장보기 목록: 만들 수 있는 요리가 있으면 사지 않고, 없으면 처음 나오는 요리의 모자란 재료를 산다 (오는 중인 것은 빼고)', () => {
  const all = (d: string): string[] => (d === byName('찌개') ? [] : [`${d}#1`]); // 남은 찌개는 없다
  assert.equal(shoppingList(db, vocab, { known: all, level: () => 'full', skill: () => 'basic' }), null, '다 있으면 사지 않는다');
  const noOnion = { known: all, level: (k: string) => (k.startsWith(byName('양파')) ? 'none' : 'full'), skill: () => 'basic' };
  const list = shoppingList(db, vocab, noOnion);
  assert.deepEqual(list?.items, [byName('양파')], '양파만 모자라다 (찌개 종류는 파는 곳이 없어 남은 찌개는 장보기 대상이 아니다)');
  assert.equal(shoppingList(db, vocab, { ...noOnion, ordered: (d) => d === byName('양파') }), null, '주문해 오는 중이면 다시 사지 않는다');
});

test('가게: 다 파는 곳만, 여는 시간에만. 온라인은 다음 배송 시각(07:00)에 온다', () => {
  const conv = offerOf('편의점', 'buy'), market = offerOf('시장', 'buy'), online = offerOf('온라인 장보기', 'buy');
  assert.ok(conv !== undefined && market !== undefined && online !== undefined);
  assert.equal(canBuy(conv, [byName('양파')], 600), false, '편의점에는 양파가 없다');
  assert.equal(canBuy(market, [byName('양파')], 600), true);
  assert.equal(canBuy(market, [byName('양파')], 1200), false, '시장은 19:00에 닫는다');
  assert.equal(canBuy(market, [byName('양파')], 1440 + 600), true, '다음 날도 같은 시간에 연다');
  assert.equal(readyAt(online, 1325), 1440 + 420, '밤에 주문하면 다음 날 07:00');
  assert.equal(readyAt(online, 300), 420, '새벽에 주문하면 그날 07:00');
  assert.equal(readyAt(market, 830), 830, '오프라인은 다녀온 때');
});

test('오프라인 장보기: 셋째 날 점심 뒤 만들 것이 없어 시장에 다녀오고, 다녀오는 동안 집을 비우며, 저녁에 새 재료로 끓인다', () => {
  const shops = day.events.filter((e) => e.type === 'action_chosen' && str(e.data['via']).endsWith('/offer/buy'));
  assert.equal(shops.length, 1);
  const s = shops[0] as GameEvent;
  assert.equal(str(s.data['at']), inst('시장'), '13:00: 편의점은 양파가 없고, 시장(50분)이 마트(60분)보다 빠르다');
  assert.equal(s.t % 1440, 780);
  assert.deepEqual(s.data['buys'], [byName('두부'), byName('양파')].sort());
  const made = day.events.filter((e) => e.type === 'instance_created' && e.cause !== null && day.events.find((x) => x.seq === e.cause)?.cause === s.seq);
  assert.deepEqual(made.map((e) => [e.t, str(e.data['id'])]), [[s.t + 50, inst('두부', 2)], [s.t + 50, inst('양파', 2)]]);
  assert.ok(day.events.some((e) => e.type === 'placed' && e.data['id'] === inst('양파', 2) && e.data['to'] === inst('식탁')), '산 것은 식탁에');
  // 집을 비운 동안 집의 것을 저절로 느끼지 않는다
  const felt = day.events.filter((e) => e.type.startsWith('awareness') && e.t > s.t && e.t < s.t + 50 && str(e.data['via']).includes('/sense/'));
  assert.deepEqual(felt, []);
  // 저녁: 새 양파를 썰고, 넣을 때는 썬 새 양파에서 덜어 낸다 (다 쓴 옛 양파가 아니라)
  const supper = day.events.filter((e) => e.type === 'menu_planned' && e.t > s.t).map((e) => str(e.data['menu']));
  assert.equal(supper[0], 'doenjang_jjigae');
  const onion2 = day.events.filter((e) => e.type === 'state_changed' && e.data['key'] === `${inst('양파', 2)}|cond:amount`).map((e) => str(e.data['to']));
  assert.deepEqual(onion2, ['full', 'half'], '처음 상태 가득 → 반');
  assert.deepEqual(auditLog(day.events, db, vocab, { externalUntil: day.start }).findings, []);
});

test('온라인 장보기: 가게가 다 닫은 밤에는 주문하고, 다음 날 07:00에 와서 식탁에 놓이며, 그 사이 다시 사지 않는다', () => {
  const r = raw();
  r['start'] = 1320; // 22:00 집
  r['end'] = 1440 + 600;
  r['set'] = [{ key: `${inst('양파')}|cond:amount`, level: 'none', t: 0 }];
  (r['routine'] as { blocks: unknown[] }).blocks = [{ kind: 'asleep', from: 1380, to: 1860 }];
  const night = run(r);
  const orders = night.events.filter((e) => e.type === 'action_chosen' && str(e.data['via']).endsWith('/offer/buy'));
  assert.deepEqual(orders.map((e) => [e.t, str(e.data['at'])]), [[1320, inst('온라인 장보기')]], '22:00: 시장·마트는 닫았고 편의점에는 양파가 없다 → 한 번만 주문');
  assert.equal(orders[0]?.data['ready'], 1440 + 420);
  const arrived = night.events.find((e) => e.type === 'instance_created' && e.data['id'] === inst('양파', 2));
  assert.equal(arrived?.t, 1440 + 420);
  assert.deepEqual(auditLog(night.events, db, vocab, { externalUntil: night.start }).findings, []);
});

test('장보기: 감사가 목록·가게·오는 시각을 그때의 앎으로 다시 계산해, 고친 기록을 잡는다', () => {
  const opts = { externalUntil: day.start };
  const buy = (e: GameEvent): boolean => e.type === 'action_chosen' && str(e.data['via']).endsWith('/offer/buy');
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[]; check: string }[] = [
    { name: '산 것을 양파만으로 고침', mutate: (es) => es.map((e) => (buy(e) ? { ...e, data: { ...e.data, buys: [byName('양파')] } } : e)), check: 'action' },
    { name: '오는 시각을 고침', mutate: (es) => es.map((e) => (buy(e) ? { ...e, data: { ...e.data, ready: Number(e.data['ready']) + 10 } } : e)), check: 'action' },
    { name: '산 두부가 생긴 기록을 지움', mutate: (es) => es.filter((e) => !(e.type === 'instance_created' && e.data['id'] === inst('두부', 2))), check: 'effects' },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(day.events)), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === c.check), `${c.name}: ${c.check} 위반을 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});
