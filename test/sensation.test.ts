// 감각 자체 (docs/내면-설계.md 2장): 상태가 감각질을 주고, 감각마다 닿는 길이 다르며, 무엇에서 왔는지 모른 채 느낀다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { compileSource } from '../src/core/compile.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { effectiveFeels } from '../src/core/kinds.ts';
import { reachOf } from '../src/core/sensation.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const byName = (ko: string): string => Object.values(db.defs).find((d) => d.names.ko === ko)?.id ?? `없음:${ko}`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const scenario = (name: string): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', `${name}.json`), 'utf8')));
  return { events: runScenario(db, vocab, sc).log.map(parseEvent), start: sc.start };
};
const stew = scenario('kitchen-stew');
const felt = (es: readonly GameEvent[]): GameEvent[] => es.filter((e) => e.type === 'stimulus_perceived');
const viaKey = (e: GameEvent): string => str(e.data['via']).split('/').at(-1) ?? '';

test('사전: 감각질마다 느끼는 감각이 있고, 감각마다 닿는 길(멀리서·닿음·입)이 있다', () => {
  for (const s of vocab.keys('sensation')) assert.ok(vocab.has('sense', String(vocab.entry('sensation', s)?.attrs['sense'])), s);
  assert.deepEqual(['sight', 'hearing', 'smell', 'touch', 'taste'].map((s) => reachOf(vocab, s)), ['distance', 'distance', 'distance', 'contact', 'mouth']);
  assert.deepEqual(Object.keys(db.defs[byName('하루씨')]?.senses ?? {}).sort(), ['hearing', 'sight', 'smell', 'taste', 'touch']);
});

test('물려받기: 음식은 종류(음식)의 감각(뜨거움·차가움 …)과 자기 감각(두부의 말랑함)을 함께 갖고, 컴파일은 종류의 감각을 복사하지 않는다', () => {
  const tofu = effectiveFeels(db, byName('두부')).map((f) => f.sensation);
  assert.ok(tofu.includes('hot_feel') && tofu.includes('cold_feel') && tofu.includes('squishy'));
  const r = compileSource({
    format_version: 1,
    file_kind: 'objects',
    why: '시험',
    defs: [
      { id: 'OBJ+1', names: { ko: '시험 종류' }, mobility: 'portable', slots: { body: { features: ['smell'] } }, feels: [{ sensation: 'sweet_scent', when: [] }] },
      { id: 'OBJ+2', is_a: 'OBJ+1', names: { ko: '시험 물건' }, feels: [{ sensation: 'soft', when: [] }] },
    ],
  });
  const member = (r.patch?.['defs'] as Record<string, unknown>[] | undefined)?.find((d) => d['id'] === 'OBJ+2');
  assert.deepEqual(member?.['feels'], [{ sensation: 'soft', when: [] }], '개별 항목은 자기 감각만 적는다 (종류의 것은 실행 중에 물려받는다)');
});

test('멀리서: 냄새·보이는 것·소리는 머무는 곳에서 느끼기 시작하고 그친다. 끓는 동안 보글보글, 국물이 되면 구수한 냄새', () => {
  const on = (s: string): number[] => felt(stew.events).filter((e) => e.data['sensation'] === s && e.data['on'] === true && e.data['moment'] !== true).map((e) => e.t);
  const off = (s: string): number[] => felt(stew.events).filter((e) => e.data['sensation'] === s && e.data['on'] === false).map((e) => e.t);
  assert.ok(on('bubbling').length >= 1 && off('bubbling').length >= 1 && (off('bubbling')[0] as number) > (on('bubbling')[0] as number), '끓기 시작하면 들리고, 찌개가 되면 그친다');
  assert.ok(on('fridge_hum').includes(1080), '냉장고 소리는 처음부터');
  assert.ok(on('steaming').length > 0);
  // 촉각·미각은 멀리서 느끼지 않는다
  assert.deepEqual(felt(stew.events).filter((e) => viaKey(e) === 'touch' || viaKey(e) === 'taste'), []);
  // 무엇에서 왔는지는 적지 않는다
  assert.ok(felt(stew.events).every((e) => !('source' in e.data) && !('at' in e.data)));
});

test('닿음·입: 썰면 그 재료와 칼·도마를 손으로 느끼고, 먹으면 맛을 느낀다 (그 순간 한 번)', () => {
  const at = (offer: string): string[] => felt(stew.events).filter((e) => str(e.data['via']).endsWith(offer)).map((e) => str(e.data['sensation']));
  const tofu = felt(stew.events).filter((e) => str(e.data['via']) === `${byName('두부')}/offer/slice_for_stew`).map((e) => str(e.data['sensation']));
  assert.ok(tofu.includes('squishy') && tofu.includes('cold_feel') && tofu.includes('hard'), `두부는 말랑하고 차갑고, 칼은 딱딱하다 (${tofu.join(', ')})`);
  assert.ok(!tofu.includes('soft'), '썬 두부(깍둑)는 덩어리일 때의 부드러움이 아니다 (조건: 가공이 토막 이하)');
  const meal = at('/offer/eat');
  assert.ok(meal.includes('salty') && meal.includes('umami'), `찌개는 짜고 감칠맛 (${meal.join(', ')})`);
  assert.ok(felt(stew.events).filter((e) => e.data['moment'] === true).every((e) => e.data['on'] === true && e.cause !== null && stew.events.find((x) => x.seq === e.cause)?.type === 'action_done'));
});

test('집을 비우거나 잘 때는 멀리서 느끼지 않고, 돌아와 다시 볼 때 달라진 것만 기록한다 (첫 주)', () => {
  const week = scenario('first-week');
  const sc = JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')) as { routine: { blocks: { kind: string; from: number; to: number }[] } };
  const unobserved = sc.routine.blocks.filter((b) => b.kind === 'out' || b.kind === 'asleep');
  const during = felt(week.events).filter((e) => e.data['moment'] !== true && unobserved.some((b) => e.t > b.from && e.t < b.to));
  assert.deepEqual(during, []);
  assert.ok(felt(week.events).some((e) => e.data['sensation'] === 'savory_scent'), '계란을 요리하면 주방에 구수한 냄새');
  assert.deepEqual(auditLog(week.events, db, vocab).findings, []);
});

test('감사: 감각을 그때의 상태에서 다시 계산해, 고친 기록을 잡는다', () => {
  const opts = { externalUntil: stew.start };
  assert.deepEqual(auditLog(stew.events, db, vocab, opts).findings, []);
  const first = (pred: (e: GameEvent) => boolean): string => stew.events.find(pred)?.seq ?? '';
  const eatTaste = first((e) => e.type === 'stimulus_perceived' && str(e.data['via']).endsWith('/offer/eat'));
  const boil = first((e) => e.type === 'stimulus_perceived' && e.data['sensation'] === 'bubbling' && e.data['on'] === true);
  const boilOff = first((e) => e.type === 'stimulus_perceived' && e.data['sensation'] === 'bubbling' && e.data['on'] === false);
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[]; check: string }[] = [
    { name: '찌개를 먹고 단맛을 느낀 것으로 고침', mutate: (es) => es.map((e) => (e.seq === eatTaste ? { ...e, data: { ...e.data, sensation: 'sweet' } } : e)), check: 'awareness' },
    { name: '보글보글의 원인을 지움', mutate: (es) => es.map((e) => (e.seq === boil ? { ...e, cause: null } : e)), check: 'cause' },
    { name: '보글보글이 그친 기록을 지움 (다음에 다시 느낀 것이 겹친다)', mutate: (es) => es.filter((e) => e.seq !== boilOff), check: 'awareness' },
    { name: '멀리서 촉각으로 느낀 것으로 고침', mutate: (es) => es.map((e) => (e.seq === boil ? { ...e, data: { ...e.data, sense: 'touch', via: `${byName('하루씨')}/sense/touch` } } : e)), check: 'awareness' },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(stew.events)), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === c.check), `${c.name}: ${c.check} 위반을 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});
