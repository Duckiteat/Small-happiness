// 바깥·현관문·환기 (작가 2026-11-09: 현관문만 드나들 때 잠깐 열림, 바깥과 환기부터)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent, JsonValue } from '../src/core/events.ts';
import { doorKey } from '../src/core/outside.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOCAB_DIR = join(ROOT, 'data', 'vocab');
const vocab = loadVocabDir(VOCAB_DIR);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const DOOR = 'PLC000001#1|door:door_state';
const WINDOW = 'PLC000002#1|window:window';
const SMELL = 'PLC000002#1|space:smell';

const WEEK = 'content/scenarios/first-week.json';
const week = (() => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, WEEK), 'utf8')));
  const db = scenarioDb(ROOT, vocab, sc);
  return { events: runScenario(db, vocab, sc).log.map(parseEvent), db, start: sc.start, routine: sc.routine as { blocks: { kind: string; from: number; to: number }[] }, end: sc.end };
})();
const changes = (key: string): GameEvent[] => week.events.filter((e) => e.type === 'state_changed' && e.data['key'] === key);

test('현관문: 출근하며 나설 때와 귀가할 때 지나고(원인 없음), 문이 열렸다가 10분 뒤 저절로 닫힌다', () => {
  const passes = week.events.filter((e) => e.type === 'passed_door');
  const outs = week.routine.blocks.filter((b) => b.kind === 'out' && b.from >= week.start && b.to <= week.end);
  assert.deepEqual(passes.map((e) => `${e.t} ${str(e.data['dir'])}`), outs.flatMap((b) => [`${b.from} out`, `${b.to} in`]));
  assert.ok(passes.every((e) => e.cause === null && e.data['door'] === DOOR));
  const door = changes(DOOR);
  for (const p of passes) {
    const opened = door.find((e) => e.cause === p.seq);
    assert.equal(opened?.data['to'], 'open');
    const closed = door.find((e) => e.t > p.t && e.data['to'] === 'closed');
    assert.equal(closed?.t, p.t + 10, '10분 뒤 닫힌다');
  }
});

test('열린 현관문으로 냄새가 빠진다: 첫날 아침 요리 냄새(뚜렷함)가 나설 때 5분 만에 은은해진다', () => {
  const firstOut = week.events.find((e) => e.type === 'passed_door');
  assert.ok(firstOut !== undefined);
  const drop = changes(SMELL).find((e) => e.t > firstOut.t && e.data['to'] === 'faint');
  assert.equal(drop?.t, firstOut.t + 5);
});

test('환기: 넷째 날 상한 치킨을 버린 뒤 창을 열고, 창이 열린 동안 주방 냄새가 25분 만에 가시며, 30분 뒤 창을 닫는다', () => {
  const vent = week.events.find((e) => e.type === 'action_chosen' && e.data['verb'] === 'ventilate');
  const discard = week.events.find((e) => e.type === 'action_done' && e.data['verb'] === 'discard');
  assert.ok(vent !== undefined && discard !== undefined && vent.t >= discard.t, '버린 뒤');
  const opened = changes(WINDOW).find((e) => e.data['to'] === 'open');
  assert.ok(opened !== undefined);
  const gone = changes(SMELL).find((e) => e.t > opened.t && e.data['to'] === 'none');
  assert.equal(gone?.t, opened.t + 25, '10분 만에 은은함, 15분 더 지나 없음');
  assert.equal(changes(WINDOW).find((e) => e.data['to'] === 'closed')?.t, opened.t + 30);
  assert.equal(week.events.filter((e) => e.type === 'action_chosen' && e.data['verb'] === 'ventilate').length, 1, '요리 냄새로는 환기하지 않는다');
});

test('감사: 문·창의 기록이 엔진과 같고, 현관문을 지남을 고치면 잡는다', () => {
  const opts = { externalUntil: week.start };
  assert.deepEqual(auditLog(week.events, week.db, vocab, opts).findings, []);
  const pass = week.events.find((e) => e.type === 'passed_door');
  assert.ok(pass !== undefined);
  const cases: { name: string; mutate: (x: GameEvent[]) => GameEvent[] }[] = [
    { name: '원인을 지어냄', mutate: (x) => x.map((e) => (e.seq === pass.seq ? { ...e, cause: 'L000001' } : e)) },
    { name: '다른 문', mutate: (x) => x.map((e) => (e.seq === pass.seq ? { ...e, data: { ...e.data, door: WINDOW } } : e)) },
    { name: '문이 열리지 않음', mutate: (x) => x.filter((e) => e.cause !== pass.seq) },
    { name: '나가지도 들어오지도 않음', mutate: (x) => x.map((e) => (e.seq === pass.seq ? { ...e, data: { ...e.data, dir: 'up' } } : e)) },
  ];
  for (const c of cases) assert.ok(auditLog(c.mutate(structuredClone(week.events)), week.db, vocab, opts).findings.length > 0, c.name);
});

test('지나는 문은 사전의 door 특징으로 찾는다 (코드에 장소 이름이 없다)', () => {
  const keys = (i: string): string[] => (i === 'PLC000001#1' ? ['PLC000001#1|space:smell', DOOR] : i === 'PLC000002#1' ? [WINDOW, SMELL] : []);
  assert.deepEqual(doorKey(vocab, ['PLC000002#1', 'PLC000001#1'], keys), { key: DOOR, open: 'open' });
  assert.equal(doorKey(vocab, ['PLC000002#1'], keys), null, '창은 지나는 문이 아니다');
});

test('사전: 지나는 문과 집을 나서는 상황을 검사한다', () => {
  type Entry = { key: string; ko: string; attrs?: { [k: string]: JsonValue } };
  type Category = { category: string; entries: Entry[] };
  const edit = (fn: (raw: Category[]) => void): string => {
    const raw = readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(readFileSync(join(VOCAB_DIR, f), 'utf8')) as Category[]);
    fn(raw);
    const asRaw: VocabCategoryRaw[] = raw;
    return validateVocab(asRaw).map((i) => `${i.path}: ${i.message}`).join('\n');
  };
  const entry = (raw: Category[], cat: string, key: string): { [k: string]: JsonValue } => {
    for (const c of raw) for (const e of c.entries) if (c.category === cat && e.key === key && e.attrs !== undefined) return e.attrs;
    throw new Error(key);
  };
  assert.equal(edit(() => undefined), '');
  assert.match(edit((r) => void (entry(r, 'feature', 'door_state')['open'] = 'ajar')), /door 특징은/);
  assert.match(edit((r) => void (entry(r, 'presence', 'home')['leaves_home'] = true)), /leaves_home은/);
});
