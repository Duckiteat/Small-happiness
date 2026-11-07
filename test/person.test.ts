// 인물의 위치 (docs/세계-설정.md · 결정-기록 "하루씨의 위치"): 집에 있는 동안 정의의 stays 장소에 머물고, 그 장소의 냄새만 맡는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const scenario = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')));

const noticed = (trace: ReturnType<typeof runScenario>): Set<string> =>
  new Set(trace.log.map(parseEvent).filter((e) => (e.type === 'awareness_up' || e.type === 'awareness_changed') && String(e.data['via']).includes('/sense/')).map((e) => String(e.data['key']).split('|')[0] ?? ''));

test('하루씨는 주방에 머문다: 현관까지 번진 냄새는 세계에는 있지만 알아채지 못하고, 주방 냄새만 알아챈다', () => {
  assert.equal(db.defs['CHR000001']?.stays, 'PLC000002');
  const trace = runScenario(db, vocab, scenario);
  const events = trace.log.map(parseEvent);
  assert.ok(events.some((e) => e.type === 'state_changed' && e.data['key'] === 'PLC000001#1|space:smell'), '현관에도 냄새가 번졌다');
  assert.deepEqual([...noticed(trace)], ['PLC000002#1'], '알아챈 장소는 주방뿐이다');
  assert.deepEqual(auditLog(events, db, vocab, { externalUntil: scenario.start }).findings, []);
});

test('머무는 곳은 정의 데이터다: 현관에 머무는 인물은 현관 냄새만 알아채고, 머무는 곳이 없으면 모든 장소를 느낀다', () => {
  const chr = db.defs['CHR000001'];
  assert.ok(chr);
  const at = (stays: string | undefined) => {
    const { stays: _old, ...rest } = chr;
    void _old;
    return runScenario({ ...db, defs: { ...db.defs, CHR000001: stays === undefined ? rest : { ...rest, stays } } }, vocab, scenario);
  };
  assert.deepEqual([...noticed(at('PLC000001'))], ['PLC000001#1'], '현관에 머물면 현관 냄새');
  assert.deepEqual([...noticed(at(undefined))].sort(), ['PLC000001#1', 'PLC000002#1'], '위치가 없으면 둘 다 (이전 동작)');
});
