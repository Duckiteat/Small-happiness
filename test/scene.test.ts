// 장면과 줄글 스크립트 (S7 · script.ts · scene.ts, 작가 2026-11-09: B 줄글 문법, 시계 기준 하루 구간, 첫 장면 하나)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { compileSources } from '../src/core/compile.ts';
import type { Db } from '../src/core/db.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { dayPartOf, pickScene } from '../src/core/scene.ts';
import { parseScript, renderLine } from '../src/core/script.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb, scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const EV_FILE = join(ROOT, 'content', 'events', 'fridge-smell.ev');
const EV = readFileSync(EV_FILE, 'utf8');
const KITCHEN = 'PLC000002#1';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const of = (es: readonly GameEvent[], type: string): GameEvent[] => es.filter((e) => e.type === type);
const scenes = db.defs['EVT000001']?.scenes ?? [];

const evening = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'home-evening.json'), 'utf8')) as Record<string, unknown>;
const run = (r: Record<string, unknown>, d: Db = db): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(r);
  return { events: runScenario(d, vocab, sc).log.map(parseEvent), start: sc.start };
};
/** 저녁에 주방 냄새가 난다 (시험용 외부 사건). */
const smellAt = (t: number, smell: string, odor: string, sets: { key: string; level: string }[] = []): Record<string, unknown> => {
  const r: Record<string, unknown> = { ...evening(), advice: [] };
  r['set'] = [...(r['set'] as unknown[]), ...sets.map((x) => ({ t: 0, key: `CHR000001#1|${x.key}`, level: x.level }))];
  r['scripted'] = [
    { t, key: `${KITCHEN}|space:smell`, level: smell, label: '시험: 주방 냄새' },
    { t, key: `${KITCHEN}|space:odor`, level: odor, label: '시험: 냄새 종류' },
  ];
  return r;
};

test('줄글 문법: 머리·장면·앵커를 읽어 이벤트 원본을 만들고, 저장소의 냉장고 냄새와 같다', () => {
  const r = parseScript(EV, vocab);
  assert.deepEqual(r.issues, []);
  const compiled = compileSources([r.source]);
  assert.ok(compiled.patch !== null, JSON.stringify(compiled.issues));
  const def = (compiled.patch['defs'] as Record<string, unknown>[])[0];
  assert.deepEqual(def?.['scenes'], scenes, '다시 컴파일해도 저장소와 같다');
  const guess = scenes.find((s) => s.rung === 'guess' && s.mode === undefined);
  assert.deepEqual(guess?.anchors, [{ line: 0, text: '어디지.', verb: 'search' }], '동사는 사전의 이름(탐색)에서 키로');
  assert.equal(renderLine('킁킁. {어디지.|탐색}'), '킁킁. 어디지.');
});

test('줄글 문법: 틀리면 줄 번호가 있는 오류 (닫힘 없음 · 사전에 없는 감각 · 태그 · 괄호 · 머리 순서)', () => {
  const issues = (text: string): string[] => parseScript(text, vocab).issues.map((i) => `${i.line}: ${i.msg}`);
  const head = '# 이벤트: 시험\n이유: 시험\n핵심: PLC000002|space:odor\n';
  assert.ok(issues(`${head}\n## 남 / 후각 / 느낌\n냄새.`).some((x) => /닫힘 조건이 없는/.test(x)));
  assert.ok(issues(`${head}닫힘: PLC000002|space:smell@<=none\n## 남 / 촉수 / 느낌\n냄새.`).some((x) => x.startsWith('5: ') && /사전에 없는 감각/.test(x)));
  assert.ok(issues(`${head}닫힘: PLC000002|space:smell@<=none\n## 남 / 후각 / 느낌\n냄새 #구수`).some((x) => x.startsWith('6: ') && /태그/.test(x)));
  assert.ok(issues(`${head}닫힘: PLC000002|space:smell@<=none\n## 남 / 후각 / 느낌\n냄새 {난다`).some((x) => x.startsWith('6: ') && /앵커/.test(x)));
  assert.ok(issues(`이유: 시험\n# 이벤트: 시험`).some((x) => x.startsWith('1: ')));
  assert.ok(issues(`${head}닫힘: PLC000002|space:smell@<=none\n## 남 / 후각 / 느낌 / 우주\n냄새.`).some((x) => /장면 조건 "우주"/.test(x)));
});

test('하루 구간 (시계 기준): 아침 05~11 · 낮 11~17 · 저녁 17~22 · 밤 22~05, 날이 바뀌어도 같다', () => {
  assert.deepEqual([300, 659, 660, 1020, 1319, 1320, 0, 299, 1440 + 700].map((t) => dayPartOf(vocab, t)), ['morning', 'morning', 'afternoon', 'evening', 'evening', 'night', 'night', 'night', 'afternoon']);
});

test('구체성 우선: 칸·하루 구간·모드가 더 많이 맞는 장면, 없으면 기본 장면', () => {
  const pick = (rung: string, part: string | null, mode: string | null): string | undefined => pickScene(scenes, 'smell', rung, part, mode)?.name;
  assert.equal(pick('feel', 'evening', 'steady'), '현관을 열자');
  assert.equal(pick('feel', 'morning', 'steady'), '냄새가 남');
  assert.equal(pick('guess', 'evening', 'drained'), '무슨 냄새지 (지침)');
  assert.equal(pick('guess', 'evening', 'steady'), '무슨 냄새지');
  assert.equal(pick('thing', 'night', null), '찾았다');
  assert.equal(pickScene(scenes, 'sight', 'feel', null, null), null, '그 감각의 장면이 없다');
});

test('첫 주: 주방 냄새의 사다리가 열리면 이벤트가 열리고, 칸이 오르면 장면이 바뀌며, 냄새가 가시면 닫힌다. 문장은 원문 그대로', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')));
  const sdb = scenarioDb(ROOT, vocab, sc);
  const es = runScenario(sdb, vocab, sc).log.map(parseEvent);
  const opened = of(es, 'event_opened');
  assert.equal(opened.length, of(es, 'event_closed').length, '열린 만큼 닫힌다');
  for (const o of opened) assert.equal(es.find((x) => x.seq === o.cause)?.type, 'ladder_moved');
  const shown = of(es, 'scene_shown');
  assert.deepEqual([...new Set(shown.map((e) => str(e.data['scene'])))], ['무슨 냄새지', '찾았다'], '짐작 → (살펴서) 정체');
  const srcLines = EV.split('\n');
  for (const e of shown) for (const l of e.data['lines'] as string[]) assert.ok(srcLines.includes(l), `원문에 없는 줄: ${l}`);
  assert.deepEqual(auditLog(es, sdb, vocab, { externalUntil: sc.start }).findings, []);
});

test('저녁에 은은한 냄새는 "현관을 열자"(느낌·저녁), 방전이면 짐작도 "지침" 장면', () => {
  const faint = run(smellAt(1180, 'faint', 'sour'));
  assert.deepEqual(of(faint.events, 'scene_shown').map((e) => str(e.data['scene'])), ['현관을 열자']);
  assert.deepEqual(auditLog(faint.events, db, vocab, { externalUntil: faint.start }).findings, []);
  const tired = run(smellAt(1140, 'distinct', 'sour', [{ key: 'condition:energy', level: 'empty' }]));
  assert.equal(of(tired.events, 'scene_shown')[0]?.data['scene'], '무슨 냄새지 (지침)');
  assert.deepEqual(auditLog(tired.events, db, vocab, { externalUntil: tired.start }).findings, []);
});

test('새 이벤트를 더해도 기존 이벤트의 장면은 바뀌지 않는다', () => {
  const extra: Db = { ...db, defs: { ...db.defs, EVT000002: { id: 'EVT000002', names: { ko: '시험 이벤트' }, aliases: [], desc: [], core: 'PLC000002|space:odor', closes: ['PLC000002|space:smell@<=none'], scenes: [{ name: '다른 것', sense: 'smell', rung: 'guess', lines: ['다른 문장.'], anchors: [] }] } } };
  const r = smellAt(1180, 'distinct', 'sour');
  const pick = (es: GameEvent[]): string[] => es.filter((e) => e.type === 'scene_shown' && e.data['event'] === 'EVT000001').map((e) => `${e.t} ${str(e.data['scene'])}`);
  const a = run(r).events, b = run(r, extra).events;
  assert.deepEqual(pick(b), pick(a));
  assert.ok(b.some((e) => e.type === 'scene_shown' && e.data['event'] === 'EVT000002'));
});

test('감사: 장면을 그때의 칸·하루 구간·모드로 다시 고르고 원문을 맞춰, 고치면 잡는다', () => {
  const out = run(smellAt(1180, 'faint', 'sour'));
  const es = out.events;
  const opts = { externalUntil: out.start };
  const shown = of(es, 'scene_shown')[0];
  const opened = of(es, 'event_opened')[0];
  assert.ok(shown !== undefined && opened !== undefined);
  const cases: { name: string; mutate: (x: GameEvent[]) => GameEvent[] }[] = [
    { name: '다른 장면', mutate: (x) => x.map((e) => (e.seq === shown.seq ? { ...e, data: { ...e.data, scene: '냄새가 남' } } : e)) },
    { name: '원문 한 글자', mutate: (x) => x.map((e) => (e.seq === shown.seq ? { ...e, data: { ...e.data, lines: (e.data['lines'] as string[]).map((l) => l.replace('훅', '확')) } } : e)) },
    { name: '열림 없이 장면', mutate: (x) => x.filter((e) => e.seq !== opened.seq) },
  ];
  for (const c of cases) assert.ok(auditLog(c.mutate(structuredClone(es)), db, vocab, opts).findings.length > 0, c.name);
});
