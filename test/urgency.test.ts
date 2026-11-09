// 긴박함 (urgency.ts, 작가 2026-11-09 "하루라는 사람 세팅"): 지독함부터 못 참고, 쉼을 끊고 냄새부터, 참는 동안 긴장, 오래 맡으면 둔해짐
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionClass } from '../src/core/agency.ts';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { EventLog } from '../src/core/log.ts';
import { Perception } from '../src/core/perception.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { againstOdor, enduredTotal, isHabituated, urgencySense } from '../src/core/urgency.ts';
import { World } from '../src/core/world.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const WHO = 'CHR000001#1';
const KITCHEN = 'PLC000002#1';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const of = (es: readonly GameEvent[], type: string): GameEvent[] => es.filter((e) => e.type === type);

const evening = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'home-evening.json'), 'utf8')) as Record<string, unknown>;
const run = (r: Record<string, unknown>): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(r);
  return { events: runScenario(db, vocab, sc).log.map(parseEvent), start: sc.start };
};
/** 쉬는 저녁, 19:40에 주방 냄새가 지독해진다 (시험용 외부 사건: 썩는 냄새). */
const foulAt = (t: number, extra: Record<string, unknown> = {}, odor = 'putrid'): Record<string, unknown> => {
  const r: Record<string, unknown> = { ...evening(), ...extra, advice: [] };
  r['scripted'] = [
    { t, key: `${KITCHEN}|space:smell`, level: 'foul', label: '시험: 주방에 지독한 냄새' },
    { t, key: `${KITCHEN}|space:odor`, level: odor, label: '시험: 냄새 종류' },
  ];
  return r;
};

test('하루씨의 설정: 후각은 지독함(5칸)부터 못 참고, 60분마다 긴장, 180분이면 둔해진다. 냄새 종류(심상 사다리)는 세기가 아니다', () => {
  const s = urgencySense(db, vocab, 'CHR000001', 'smell');
  assert.ok(s !== null);
  assert.deepEqual([s.unbearable, s.endure_min, s.habituate_min], [5, 60, 180]);
  assert.equal(urgencySense(db, vocab, 'CHR000001', 'odor'), null, '종류 특징은 칸 번호가 세기가 아니다');
  assert.equal(enduredTotal(s, 0, 59), 0);
  assert.equal(enduredTotal(s, 0, 130), 2);
  assert.equal(enduredTotal(s, 0, 500), 3, '둔해진 뒤로는 쌓이지 않는다');
  assert.equal(isHabituated(s, 0, 179), false);
  assert.equal(isHabituated(s, 0, 180), true);
  assert.deepEqual(['inspect', 'discard', 'ventilate', 'rest'].map((v) => againstOdor(vocab, v)), [true, true, true, false]);
});

test('쉬는 중에 냄새가 지독해지면: 못 참기 시작하고, 하던 쉼을 끊고, 냄새를 없애려는 행동(살피기)부터 한다', () => {
  const out = run(foulAt(1180));
  const on = of(out.events, 'urgency_felt').find((e) => e.data['on'] === true);
  assert.ok(on !== undefined && on.t === 1180 && on.data['key'] === `${KITCHEN}|space:smell`);
  const stop = of(out.events, 'action_stopped')[0];
  assert.ok(stop !== undefined && stop.t === 1180 && stop.cause === on.seq, '못 참는 냄새가 쉼을 끊는다');
  const stoppedAction = out.events.find((e) => e.seq === stop.data['stopped']);
  assert.equal(actionClass(vocab, str(stoppedAction?.data['verb'])), 'pastime');
  assert.ok(Number(stoppedAction?.data['ends']) > 1180, '끝나기 전이었다');
  assert.equal(out.events.some((e) => e.type === 'action_done' && e.cause === stop.data['stopped']), false, '그만둔 쉼은 끝나지 않는다 (쉼의 효과도 없다)');
  const next = of(out.events, 'action_chosen').filter((e) => e.t >= 1180).map((e) => str(e.data['verb']));
  assert.deepEqual(next.slice(0, 2), ['inspect', 'ventilate'], '냄새부터: 살피고 창을 연다');
  const cleared = out.events.find((e) => e.type === 'state_changed' && e.data['key'] === `${KITCHEN}|space:smell` && e.data['to'] === 'faint' && e.t > 1180);
  assert.ok(cleared !== undefined && cleared.t <= 1200, '창이 열려 있으면 바깥으로 빠져 10분 만에 은은해진다');
  assert.equal(of(out.events, 'urgency_felt').find((e) => e.data['on'] === false)?.data['reason'], 'gone');
  assert.deepEqual(auditLog(out.events, db, vocab, { externalUntil: out.start }).findings, []);
});

test('참는 동안 60분마다 긴장이 쌓이고, 냄새가 빠지면 그친다 (그때까지의 참음을 먼저 센다) — 처리할 행동이 없는 지독한 냄새(구수함)는 참는다', () => {
  const out = run(foulAt(1180, {}, 'savory'));
  const on = of(out.events, 'urgency_felt').find((e) => e.data['on'] === true);
  const off = of(out.events, 'urgency_felt').find((e) => e.data['on'] === false);
  assert.ok(on !== undefined && off !== undefined);
  const endured = of(out.events, 'urgency_endured');
  const total = endured.reduce((n, e) => n + Number(e.data['bumps']), 0);
  assert.equal(total, Math.floor((Math.min(off.t, on.t + 180) - on.t) / 60));
  assert.ok(total >= 2, `${total}번`);
  for (const e of endured) assert.ok(out.events.some((x) => x.type === 'state_changed' && x.cause === e.seq && str(x.data['key']).endsWith(':tension')));
  assert.ok(['gone', 'habituated'].includes(str(off.data['reason'])));
  assert.deepEqual(auditLog(out.events, db, vocab, { externalUntil: out.start }).findings, []);
});

test('방전이어도 못 참는 냄새는 처리하려 한다 (냄새를 없애려는 행동은 방전에서도 고른다)', () => {
  const r = foulAt(1140);
  r['set'] = [...(r['set'] as unknown[]), { t: 0, key: `${WHO}|condition:energy`, level: 'empty' }];
  const out = run(r);
  assert.equal(of(out.events, 'mode_changed')[0]?.data['mode'], 'drained');
  assert.equal(of(out.events, 'action_chosen')[0]?.data['verb'], 'inspect');
  assert.deepEqual(auditLog(out.events, db, vocab, { externalUntil: out.start }).findings, []);
});

test('오래 맡으면 둔해진다: 180분 뒤로는 더 못 참지 않고 긴장도 쌓이지 않으며, 냄새가 약해졌다 다시 지독해지면 다시 못 참는다', () => {
  const log = new EventLog({ isKnownType: (type) => vocab.has('event_type', type) });
  const world = new World(db, vocab, log);
  world.spawn('CHR000001', { t: 0 });
  const kitchen = world.spawn('PLC000002', { t: 0 }).id;
  const p = new Perception(db, vocab, log);
  const smell = `${kitchen}|space:smell`;
  world.set(smell, 'foul', { t: 0 });
  for (const t of [0, 60, 120, 180, 240, 300]) p.step(world, t, 'home', []);
  const felt = log.list({ where: (e) => e.type === 'urgency_felt' }).map((e) => `${e.t} ${e.data['on'] === true ? 'on' : str(e.data['reason'])}`);
  assert.deepEqual(felt, ['0 on', '180 habituated']);
  const bumps = log.list({ where: (e) => e.type === 'urgency_endured' }).map((e) => `${e.t}:${String(e.data['bumps'])}`);
  assert.deepEqual(bumps, ['60:1', '120:1', '180:1']);
  world.set(smell, 'distinct', { t: 310 });
  p.step(world, 310, 'home', []);
  world.set(smell, 'foul', { t: 320 });
  p.step(world, 320, 'home', []);
  assert.deepEqual(log.list({ where: (e) => e.type === 'urgency_felt' }).map((e) => `${e.t} ${e.data['on'] === true ? 'on' : str(e.data['reason'])}`).slice(2), ['320 on']);
  assert.deepEqual(auditLog(log.list(), db, vocab).findings, []);
});

test('집을 나서면 못 참는 냄새는 그친다 (나감)', () => {
  const log = new EventLog({ isKnownType: (type) => vocab.has('event_type', type) });
  const world = new World(db, vocab, log);
  world.spawn('CHR000001', { t: 0 });
  const kitchen = world.spawn('PLC000002', { t: 0 }).id;
  const p = new Perception(db, vocab, log);
  world.set(`${kitchen}|space:smell`, 'foul', { t: 0 });
  p.step(world, 0, 'home', []);
  p.step(world, 90, 'out', []);
  const felt = log.list({ where: (e) => e.type === 'urgency_felt' }).map((e) => `${e.t} ${e.data['on'] === true ? 'on' : str(e.data['reason'])}`);
  assert.deepEqual(felt, ['0 on', '90 away']);
  assert.equal(log.list({ where: (e) => e.type === 'urgency_endured' })[0]?.data['bumps'], 1, '나서기 전까지 참은 만큼');
  assert.deepEqual(auditLog(log.list(), db, vocab).findings, []);
});

test('감사: 못 참음·참음·쉼 끊기를 다시 맞춰, 고치거나 지어내면 잡는다', () => {
  const out = run(foulAt(1180, {}, 'savory'));
  const es = out.events;
  const opts = { externalUntil: out.start };
  const stop = of(es, 'action_stopped')[0];
  const endured = of(es, 'urgency_endured')[0];
  const on = of(es, 'urgency_felt')[0];
  assert.ok(stop !== undefined && endured !== undefined && on !== undefined);
  const cases: { name: string; mutate: (x: GameEvent[]) => GameEvent[] }[] = [
    { name: '참음을 두 배로', mutate: (x) => x.map((e) => (e.seq === endured.seq ? { ...e, data: { ...e.data, bumps: Number(e.data['bumps']) * 2 } } : e)) },
    { name: '못 참음 없이 쉼을 끊음', mutate: (x) => x.filter((e) => e.seq !== on.seq) },
    { name: '쉼을 끊은 원인을 지움', mutate: (x) => x.map((e) => (e.seq === stop.seq ? { ...e, cause: null } : e)) },
    { name: '참음의 긴장을 지움', mutate: (x) => x.filter((e) => e.cause !== endured.seq) },
  ];
  for (const c of cases) assert.ok(auditLog(c.mutate(structuredClone(es)), db, vocab, opts).findings.length > 0, c.name);
});
