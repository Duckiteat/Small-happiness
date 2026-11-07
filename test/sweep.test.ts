// 전체 점검(2026-11-07)에서 찾은 버그의 회귀 시험과, 실제 데이터로 확인한 엔진의 성질.
// 버그마다 고치기 전의 잘못된 동작을 점검 스크립트·명령 출력으로 확인했다 (CHANGES.md 2026-11-07 "전체 점검").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEdges, collectRules, ruleNodes } from '../src/core/chains.ts';
import { generatedRules } from '../src/core/generated.ts';
import { compileSources } from '../src/core/compile.ts';
import { parseEvent } from '../src/core/events.ts';
import { EventLog } from '../src/core/log.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { instanceName, parseScenario, runScenario } from '../src/core/skeleton.ts';
import { World } from '../src/core/world.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const WEEK = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')));

test('원본 = 저장소: content/src를 다시 컴파일해 병합해도 저장소가 바뀌지 않는다 (임시 번호가 남으면 정의가 두 벌 생긴다)', () => {
  for (const f of readdirSync(join(ROOT, 'content', 'src'))) {
    const compiled = compileSources([JSON.parse(readFileSync(join(ROOT, 'content', 'src', f), 'utf8'))]);
    const parsed = parsePatch(compiled.patch);
    assert.ok(parsed.patch, `${f}: 컴파일 실패`);
    const merged = mergePatch(db, parsed.patch, vocab);
    assert.deepEqual(merged.report.added, [], `${f}: 새 정의가 생긴다 — 병합 뒤 원본의 임시 번호를 실제 번호로 바꾼다`);
    assert.equal(JSON.stringify(merged.db.defs), JSON.stringify(db.defs), `${f}: 원본과 저장소가 다르다`);
  }
});

test('시나리오: 처음 상태(set)의 시각이 하루의 시작보다 뒤면 읽을 때 거부한다 (엔진 안에서 시각 역행으로 터지지 않게)', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')) as Record<string, unknown>;
  assert.throws(() => parseScenario({ ...raw, set: [{ t: 500, key: 'PLC000002#1|space:smell', level: 'faint' }] }), /하루의 시작\(420\)보다 뒤다/);
  assert.doesNotThrow(() => parseScenario({ ...raw, set: [{ t: 420, key: 'PLC000002#1|space:smell', level: 'faint' }] }));
});

test('표시: 같은 정의의 둘째 개체부터는 번호를 붙여 구별한다', () => {
  assert.equal(instanceName(db, 'OBJ000010#1'), '남은 치킨');
  assert.equal(instanceName(db, 'OBJ000010#2'), '남은 치킨 #2');
  assert.equal(instanceName(db, 'OBJ000010'), '남은 치킨');
});

test('명령줄: 없는 파일·없는 규칙·없는 기록은 내부 덤프 없이 "오류" 한 줄로, 실패 코드로 끝난다', () => {
  const run = (...args: string[]): { status: number | null; err: string } => {
    const r = spawnSync(process.execPath, [join(ROOT, 'src', 'node', 'cli.ts'), ...args, '--root', ROOT], { encoding: 'utf8' });
    return { status: r.status, err: r.stderr };
  };
  for (const args of [['day', 'nope.json'], ['validate', 'nope.json'], ['report', '99']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.err, /^오류: /, args.join(' '));
    assert.doesNotMatch(r.err, /at .*\.ts:\d+/, `${args.join(' ')}: 스택 덤프가 나온다`);
  }
  const chains = run('chains', 'NOPE');
  assert.equal(chains.status, 1);
  assert.match(chains.err, /없는 규칙: NOPE/);
});

test('규칙 사슬: 종류(is_a)를 거쳐 잇는다 — 음식 하나의 냄새 규칙이 "음식"을 가리키는 주방 냄새 규칙으로 이어진다', () => {
  const rules = [...collectRules(db), ...ruleNodes(generatedRules(db, vocab))];
  const edges = buildEdges(rules, vocab, db);
  assert.ok(edges.some((e) => e.from.startsWith('OBJ000010/rule/') && e.to === 'PLC000002/rule/odor_reach'), '남은 치킨 냄새 → 주방 냄새');
  assert.equal(buildEdges(rules, vocab).some((e) => e.to === 'PLC000002/rule/odor_reach'), false, '저장소를 주지 않으면 같은 정의끼리만 본다');
});

test('실제 첫 주: 단계 간격을 바꿔도 사건 기록이 같다 (정확한 시각 계산 · 번짐 포함)', () => {
  const base = JSON.stringify(runScenario(db, vocab, WEEK).log);
  for (const step of [47, 120]) assert.equal(JSON.stringify(runScenario(db, vocab, WEEK, step).log), base, `간격 ${step}분`);
});

test('실제 첫 주: 사건 기록만으로 끝의 세계 상태를 다시 만들 수 있다', () => {
  const trace = runScenario(db, vocab, WEEK);
  const log = new EventLog({ isKnownType: (t) => vocab.has('event_type', t) });
  for (const raw of trace.log) {
    const e = parseEvent(raw);
    log.append({ t: e.t, type: e.type, src: e.src, cause: e.cause, data: e.data });
  }
  assert.deepEqual(World.fromLog(db, vocab, log).snapshot().states, trace.steps.at(-1)?.values['world.state']);
});
