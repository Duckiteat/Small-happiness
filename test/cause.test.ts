// 원인 잇기 (docs/영수증-명세.md 9장): cause는 "조건을 마지막으로 채운 사건" 하나다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { latestSeq, parseEvent } from '../src/core/events.ts';
import { EventLog } from '../src/core/log.ts';
import { World } from '../src/core/world.ts';
import { loadDb, scenarioDb, scenarioRun } from '../src/node/clerk.ts';
import { parseScenario } from '../src/core/skeleton.ts';
import { readFileSync } from 'node:fs';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const WEEK = 'content/scenarios/first-week.json';

test('가장 최근 사건 고르기: 번호의 크기로 비교하고(L000010이 L000009보다 뒤), 없는 값은 건너뛴다', () => {
  assert.equal(latestSeq(['L000009', 'L000010', null, undefined, 'L000002']), 'L000010');
  assert.equal(latestSeq([]), null);
  assert.equal(latestSeq([null, undefined]), null);
  assert.throws(() => latestSeq(['OBJ000001']), /기록 번호가 아니다/);
});

test('세계 상태: 상태가 정해진 마지막 사건을 안다 (바뀐 적이 없으면 개체가 생긴 사건), 기록에서 복원해도 같다', () => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, WEEK), 'utf8')));
  const db = scenarioDb(ROOT, vocab, sc);
  const trace = scenarioRun(ROOT, vocab, WEEK);
  const log = new EventLog({ isKnownType: (t) => vocab.has('event_type', t) });
  for (const raw of trace.log) {
    const e = parseEvent(raw);
    log.append({ t: e.t, type: e.type, src: e.src, cause: e.cause, data: e.data });
  }
  const world = World.fromLog(db, vocab, log);
  const changes = log.list({ type: 'state_changed' });
  const lastByKey = new Map(changes.map((e) => [String(e.data['key']), e.seq]));
  assert.ok(lastByKey.size > 10);
  for (const [key, seq] of lastByKey) assert.equal(world.lastChange(key), seq, key);
  // 한 번도 바뀌지 않은 키는 그 개체가 생긴 사건
  const untouched = world.instances().flatMap((i) => world.keysOf(i)).find((k) => !lastByKey.has(k));
  assert.ok(untouched);
  const born = log.list({ type: 'instance_created', where: (e) => e.data['id'] === untouched.split('|')[0] });
  assert.equal(world.lastChange(untouched), born.at(0)?.seq);
  assert.equal(world.lastChange('NONE#1|a:b'), null);
});

test('원인이 없는 사건은 두 가지뿐이다: 시나리오가 세운 개체와 법칙이 원인인 진행 (나머지는 모두 cause가 있다)', () => {
  for (const file of [WEEK, 'examples/scenarios/skeleton-day.json']) {
    const noCause = new Set(scenarioRun(ROOT, vocab, file).log.map(parseEvent).filter((e) => e.cause === null).map((e) => e.type));
    assert.deepEqual([...noCause].sort(), file === WEEK ? ['instance_created', 'stage_advanced'] : ['instance_created'], file);
  }
  assert.ok(loadDb(ROOT).defs['PLC000002'], '실제 저장소');
});
