// 영수증 감사 (docs/영수증-명세.md 8장): 사건 기록이 정의(규칙·행동·진행·감각)와 맞는지 엔진 없이 다시 계산한다.
// 엔진이 낸 진짜 기록은 위반이 없고, 사건 하나를 망가뜨리면 그 검사가 잡는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import type { AuditCheck } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb, scenarioDb, scenarioRun } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const WEEK = 'content/scenarios/first-week.json';
const SKELETON = 'examples/scenarios/skeleton-day.json';
const scenarioOf = (file: string) => parseScenario(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
const eventsOf = (file: string): GameEvent[] => scenarioRun(ROOT, vocab, file).log.map(parseEvent);

test('감사: 엔진이 낸 진짜 기록은 위반이 없고, 검사 종류가 모두 실제로 돌았다', () => {
  for (const file of [WEEK, SKELETON]) {
    const sc = scenarioOf(file);
    const r = auditLog(eventsOf(file), scenarioDb(ROOT, vocab, sc), vocab, { externalUntil: sc.start });
    assert.deepEqual(r.findings, [], file);
    for (const check of ['timing', 'cause', 'effects', 'state', 'awareness', 'action']) assert.ok((r.checked[check] ?? 0) > 0, `${file}: ${check} 검사가 한 번도 돌지 않았다`);
  }
  const week = auditLog(eventsOf(WEEK), loadDb(ROOT), vocab);
  assert.ok((week.checked['progress'] ?? 0) > 0, '진행 검사가 돌았다 (첫 주에는 진행이 있다)');
});

type Mut = (events: GameEvent[]) => GameEvent[];
const at = (events: readonly GameEvent[], pred: (e: GameEvent, i: number) => boolean): number => {
  const i = events.findIndex(pred);
  assert.ok(i >= 0, '망가뜨릴 사건을 못 찾았다');
  return i;
};
const patch = (events: GameEvent[], i: number, change: Partial<GameEvent> | ((e: GameEvent) => Partial<GameEvent>)): GameEvent[] =>
  events.map((e, k) => (k === i ? { ...e, ...(typeof change === 'function' ? change(e) : change) } : e));
const data = (e: GameEvent, change: Record<string, string | number>): Partial<GameEvent> => ({ data: { ...e.data, ...change } });
const effectOfFire = (e: GameEvent, events: readonly GameEvent[]): boolean => e.type === 'state_changed' && events.some((c) => c.seq === e.cause && c.type === 'delay_fired');

test('감사: 사건을 하나씩 망가뜨리면 해당 검사가 잡는다 (결과·시각·조건·행동·진행·앎·원인)', () => {
  const sc = scenarioOf(WEEK);
  const db = scenarioDb(ROOT, vocab, sc);
  const base = eventsOf(WEEK);
  const smellLevels = vocab.levelOrder('smell') ?? [];
  const cases: readonly { name: string; mutate: Mut; check: AuditCheck; message: RegExp }[] = [
    { name: '발화의 결과 값을 바꾼다', check: 'effects', message: /발화의 결과가 아니다/,
      mutate: (ev) => patch(ev, at(ev, (e) => effectOfFire(e, ev) && e.data['key'] === 'PLC000002#1|space:smell'), (e) => data(e, { to: smellLevels.find((l) => l !== e.data['from'] && l !== e.data['to'] && !vocab.isLocked('smell', l)) ?? '' })) },
    { name: '발화 뒤의 결과를 지운다', check: 'effects', message: /결과가 빠졌다/,
      mutate: (ev) => ev.filter((_, i) => i !== at(ev, (e) => effectOfFire(e, ev) && e.data['key'] === 'PLC000002#1|space:smell')) },
    { name: '규칙이 요구하지 않는 결과를 덧붙인다', check: 'effects', message: /요구하지 않는 결과/,
      mutate: (ev) => { const i = at(ev, (e) => effectOfFire(e, ev)); return [...ev.slice(0, i + 1), { ...(ev[i] as GameEvent), seq: 'L999999' }, ...ev.slice(i + 1)]; } },
    { name: '처음 상태를 지운다', check: 'effects', message: /처음 상태 뒤에 결과가 빠졌다/,
      mutate: (ev) => ev.filter((_, i) => i !== at(ev, (e) => e.type === 'state_changed' && ev.some((c) => c.seq === e.cause && c.type === 'instance_created'))) },
    { name: '예약의 발화 시각을 늦춘다', check: 'timing', message: /발화 시각이 .*규칙의 지연으로는/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'delay_scheduled'), (e) => data(e, { due: Number(e.data['due']) + 60 })) },
    { name: '발화를 예약 시각이 아닌 때에 기록한다', check: 'timing', message: /예약 시각 .*아닌/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'delay_fired'), (e) => ({ t: e.t + 1 })) },
    { name: '규칙이 걸리지 않는 개체의 예약', check: 'rule', message: /걸리는 규칙이 아니다/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'delay_scheduled'), (e) => data(e, { at: 'CHR000001#1' })) },
    { name: '조건이 풀렸는데 발화한 것으로 적는다', check: 'holds', message: /조건이 풀려 있는데 발화/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'delay_cancelled'), { type: 'delay_fired' }) },
    { name: '조건이 맞는데 취소한 것으로 적는다', check: 'holds', message: /조건이 여전히 맞는데 취소/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'delay_fired'), { type: 'delay_cancelled' }) },
    { name: '행동이 끝나는 시각을 바꾼다', check: 'action', message: /끝나는 시각이 .*분 걸려/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'action_chosen'), (e) => data(e, { ends: Number(e.data['ends']) + 1 })) },
    { name: '행동의 동사를 바꾼다', check: 'action', message: /동사가 .*행동의 동사는/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'action_chosen'), (e) => data(e, { verb: e.data['verb'] === 'discard' ? 'inspect' : 'discard' })) },
    { name: '행동 끝을 다른 시각에 기록한다', check: 'action', message: /끝나는 시각 .*아닌/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'action_done'), (e) => ({ t: e.t + 1 })) },
    { name: '진행이 사다리를 내려간다', check: 'progress', message: /사다리를 올라가야 한다/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'stage_advanced'), (e) => data(e, { to: (vocab.levelOrder(String(e.data['key']).split(':').pop() ?? '') ?? [])[0] ?? '' })) },
    { name: '느낀 단계가 세계와 다르다', check: 'awareness', message: /세계의 단계/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'awareness_up' && String(e.data['via']).includes('/sense/')), (e) => data(e, { level: e.data['level'] === 'foul' ? 'faint' : 'foul' })) },
    { name: '살피지 않았는데 이해했다고 적는다', check: 'awareness', message: /행동이 끝난 기록이 없는데/,
      mutate: (ev) => ev.filter((e) => e.type !== 'action_done') },
    { name: '예약의 원인을 지운다', check: 'cause', message: /조건을 마지막으로 채운 사건/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'delay_scheduled' && e.cause !== null), { cause: null }) },
    { name: '저절로 느낀 것의 원인을 엉뚱한 사건으로 바꾼다', check: 'cause', message: /조건을 마지막으로 채운 사건/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'awareness_up' && String(e.data['via']).includes('/sense/')), { cause: (ev[0] as GameEvent).seq }) },
    { name: '살펴서 안 것의 원인을 지운다', check: 'cause', message: /살피기의 끝/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'awareness_up' && String(e.data['via']).includes('/offer/')), { cause: null }) },
    { name: '행동의 원인(앎)을 지운다', check: 'cause', message: /앎\(awareness 사건\)이 아니다/,
      mutate: (ev) => patch(ev, at(ev, (e) => e.type === 'action_chosen'), { cause: null }) },
    { name: '원인 없는 상태 변화를 처음 설정 뒤에 끼운다', check: 'state', message: /원인 없는 상태 변화/,
      mutate: (ev) => { const last = ev.at(-1) as GameEvent; return [...ev, { seq: 'L999999', t: last.t, type: 'state_changed', src: 'world', cause: null, data: { key: 'OBJ000002#1|cond:temp', from: 'fridge', to: 'frozen' } }]; } },
    { name: '앎이 일으킨 상태 변화(원인이 엉뚱한 사건)', check: 'state', message: /상태 변화의 원인이 awareness_up/,
      mutate: (ev) => { const firstAwareness = at(ev, (e) => e.type === 'awareness_up'); return patch(ev, at(ev, (e, i) => i > firstAwareness && effectOfFire(e, ev)), { cause: (ev[firstAwareness] as GameEvent).seq }); } },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(base)), db, vocab, { externalUntil: sc.start });
    const hits = r.findings.filter((f) => f.check === c.check);
    assert.ok(hits.length > 0, `${c.name}: ${c.check} 검사가 못 잡았다 (잡힌 것: ${r.findings.map((f) => f.check).join(',') || '없음'})`);
    assert.match(hits.map((f) => f.message).join('\n'), c.message, c.name);
  }
});

test('감사: 일정·처음 상태·같은 물건 여럿을 무작위로 바꾼 시나리오 40개도 위반이 없다 (엔진과 감사가 같은 판단을 한다)', () => {
  const db = loadDb(ROOT);
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
  const defs = Object.keys(db.defs).filter((d) => d !== 'OBJ000001'); // 종류(음식)는 개체로 두지 않는다
  const keys = defs.flatMap((d) => Object.entries(db.defs[d]?.slots ?? {}).flatMap(([slot, s]) => s.features.map((feature) => ({ key: `${d}#1|${slot}:${feature}`, feature }))));
  let total = 0;
  for (let n = 0; n < 40; n++) {
    const days = 1 + Math.floor(rnd() * 4);
    const blocks: object[] = [];
    for (let d = 0; d < days; d++) {
      const base = d * 1440;
      if (rnd() < 0.7) {
        const from = base + 430 + Math.floor(rnd() * 180);
        blocks.push({ kind: 'out', from, to: from + 60 + Math.floor(rnd() * 600) });
      }
      blocks.push({ kind: 'asleep', from: base + 1320 + Math.floor(rnd() * 100), to: base + 1440 + 400 });
    }
    const spawn = defs.filter(() => rnd() < 0.85).flatMap((d) => (d.startsWith('OBJ') && rnd() < 0.3 ? [d, d] : [d]));
    const set = Array.from({ length: Math.floor(rnd() * 8) }, () => {
      const c = pick(keys);
      return { t: Math.floor(rnd() * 420), key: c.key, level: pick((vocab.levelOrder(c.feature) ?? []).filter((l) => !vocab.isLocked(c.feature, l))) };
    }).filter((s) => spawn.includes(s.key.split('#')[0] ?? '')).sort((a, b) => a.t - b.t);
    const sc = parseScenario({ why: '감사 무작위', use_db: true, seed: n, spawn, set, start: 420, end: days * 1440 + 420, routine: { blocks } });
    const trace = runScenario(db, vocab, sc);
    const r = auditLog(trace.log.map(parseEvent), db, vocab, { externalUntil: sc.start });
    assert.deepEqual(r.findings, [], `무작위 시나리오 #${n}`);
    total += trace.log.length;
  }
  assert.ok(total > 2000, `사건 ${total}건을 감사했다 (너무 적으면 시나리오가 헛돈다)`);
});
