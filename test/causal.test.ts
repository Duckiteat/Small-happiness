// 인과 (3층): 규칙이 시간에 따라 세계를 바꾼다. 간격과 상관없이 같은 결과, 정확한 시각, 발화 시점 재판정
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Causal, CausalError } from '../src/core/causal.ts';
import { emptyDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { EventLog } from '../src/core/log.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { World } from '../src/core/world.ts';
import { SKELETON_SCENARIO, skeletonDay } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const isKnownType = (type: string): boolean => vocab.has('event_type', type);

const db: Db = ['fridge-chain.json', 'fridge-time.json'].reduce((acc, f) => {
  const p = parsePatch(JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', f), 'utf8')));
  assert.ok(p.patch);
  return mergePatch(acc, p.patch, vocab).db;
}, emptyDb());

/** 세계가 바뀐 기록만 (시각, 키, 단계). 단계(step) 간격에 따라 달라지면 안 되는 것. */
function changes(log: readonly unknown[]): string[] {
  return (log as { t: number; type: string; data: Record<string, unknown> }[])
    .filter((e) => e.type === 'state_changed')
    .map((e) => `${e.t} ${String(e.data['key'])} ${String(e.data['to'])}`);
}

test('간격을 바꿔도 세계의 결과(바뀐 시각·순서)가 같다: 3시간 · 2시간 · 1시간', () => {
  const three = changes(skeletonDay(ROOT, vocab, 180).log);
  assert.ok(three.length > 0);
  assert.deepEqual(changes(skeletonDay(ROOT, vocab, 120).log), three);
  assert.deepEqual(changes(skeletonDay(ROOT, vocab, 60).log), three);
});

test('아무도 손대지 않으면 사슬이 정확한 시각에 진행된다 (지연은 예시 패치의 임시값)', () => {
  // 하루씨 없이: 같은 시나리오에서 인물을 세우지 않는다
  const base = parseScenario(JSON.parse(readFileSync(join(ROOT, SKELETON_SCENARIO), 'utf8')));
  const untouched = runScenario(db, vocab, { ...base, spawn: base.spawn.filter((d) => !d.startsWith('CHR')) });
  assert.deepEqual(changes(untouched.log), [
    '720 OBJ000001#1|body:rot wilted', // 12시간 뒤 시듦
    '1440 OBJ000001#1|body:rot spoiled', // 또 12시간 뒤 상함
    '1800 OBJ000001#1|body:smell distinct', // 6시간 뒤 냄새
    '1800 PLC000001#1|space:smell faint', // 같은 시각 주방에 퍼짐 (지연 없음)
    '1980 PLC000001#1|space:smell distinct', // 3시간 뒤 짙어짐
    '2460 PLC000001#1|space:bug few', // 8시간 뒤 벌레
    '2820 PLC000002#1|space:bug few', // 6시간 뒤 거실로
  ]);
});

test('발화 시점에 조건이 풀려 있으면 취소하고 아무것도 바꾸지 않는다 (그 사이 치운 경우)', () => {
  const log = new EventLog({ isKnownType });
  const world = new World(db, vocab, log);
  const food = world.spawn('OBJ000001', { t: 0 }).id;
  const causal = new Causal(db, vocab, log, 0);
  causal.advance(world, 600); // 시듦 예약 (720)
  assert.deepEqual(causal.pending().map((p) => p.due), [720]);
  world.set(`${food}|body:rot`, 'gone', { t: 600 }); // 치움 (행동 층이 생기면 효과 요청으로)
  causal.advance(world, 800);
  assert.equal(world.level(`${food}|body:rot`), 'gone');
  assert.deepEqual(log.list({ type: 'delay_cancelled' }).map((e) => e.t), [720]);
  assert.equal(log.list({ type: 'delay_fired' }).length, 0);
});

test('발화는 예약을 원인으로, 상태 변화는 발화를 원인으로 이어진다', () => {
  const trace = skeletonDay(ROOT, vocab);
  const log = EventLog.fromJSON(trace.log as unknown[], { isKnownType });
  const changed = log.list({ type: 'state_changed' }).at(0);
  assert.ok(changed);
  assert.deepEqual(log.chain(changed.seq).map((e) => e.type), ['state_changed', 'delay_fired', 'delay_scheduled']);
});

test('거부: 시간이 거꾸로 간다', () => {
  const log = new EventLog({ isKnownType });
  const causal = new Causal(db, vocab, log, 100);
  assert.throws(() => causal.advance(new World(db, vocab, log), 50), CausalError);
});
