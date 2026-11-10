// 줄글 속 말 누르기 = 주의 돌리기 (구현-계획 N2-2, 작가 2026-11-10): 누르면 동그라미가 그려지고,
// 하루씨가 다음에 고를 때 그 말이 이끄는 행동 쪽으로 조언처럼 닿는다. 들을지는 하루씨가 정한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { ATTENTION_DRAWN, attentionVerbs } from '../src/core/screen.ts';
import { Session, SessionError } from '../src/core/session.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { contentHash, scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const WHO = 'CHR000001#1';
const CONTENT = contentHash(ROOT);
const load = (f: string): { sc: ReturnType<typeof parseScenario>; db: ReturnType<typeof scenarioDb> } => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', f), 'utf8')) as Record<string, unknown>);
  return { sc, db: scenarioDb(ROOT, vocab, sc) };
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const log = (s: Session): GameEvent[] => s.trace().log.map(parseEvent);

// 첫 주 4일차 07:29 (4749분): 상한 냄새의 장면이 열려 있고 "썩고 있다"를 누를 수 있다. 누르면 하루씨가 다음에 고를 때 살핀다
const FW = load('first-week.json');
const PRESS_AT = 4749;
const pressed = (): Session => {
  const s = Session.start(FW.db, vocab, FW.sc);
  s.advance(PRESS_AT);
  s.attend(WHO, 'a1');
  return s;
};

test('사전: 주의 단어는 leads_to의 행동으로, 행동 단어는 그 행동으로, 작가가 쓴 말(별칭)도 찾는다', () => {
  assert.deepEqual(attentionVerbs(vocab, '탐색'), ['inspect']);
  assert.deepEqual(attentionVerbs(vocab, '킁킁'), ['inspect']);
  assert.deepEqual(attentionVerbs(vocab, 'search'), ['inspect']);
  assert.deepEqual(attentionVerbs(vocab, '환기'), ['ventilate']);
  assert.deepEqual(attentionVerbs(vocab, '없는 말'), []);
});

test('누르면: 누름이 사건으로 남고 그 앵커에 열린 호가 그려진다, 이벤트가 닫히면 닫힌 원', () => {
  const s = pressed();
  const drawn = log(s).filter((e) => e.type === ATTENTION_DRAWN);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0]?.cause, null, '플레이어의 입력이라 원인이 없다');
  assert.equal(drawn[0]?.data['anchor'], 'a1');
  assert.deepEqual(s.screen(WHO)?.anchors, [{ id: 'a1', circle: 'open' }]);
  assert.deepEqual(s.view().pendingAdvice, [{ t: PRESS_AT, verbs: ['inspect'] }]);
  s.advance(FW.sc.end);
  const v = s.screen(WHO);
  assert.equal(v?.event.status, 'closed');
  assert.deepEqual(v?.anchors, [{ id: 'a1', circle: 'closed' }]);
});

test('들음: 다음에 고를 때 그 말이 이끄는 행동(살피기)을 한다 — 조언으로 고른 것으로 남고, 감사 위반 0', () => {
  const s = pressed();
  s.advance(FW.sc.end);
  const events = log(s);
  const given = events.find((e) => e.type === 'advice_given' && Array.isArray(e.data['verbs']));
  assert.ok(given);
  assert.equal(events.find((e) => e.seq === given.cause)?.type, ATTENTION_DRAWN, '주의 돌리기의 조언은 그 누름이 원인이다');
  const followed = events.find((e) => e.type === 'action_chosen' && e.data['advised'] === given.seq);
  assert.ok(followed, '하루씨가 들었다');
  assert.equal(followed.data['verb'], 'inspect');
  // 지금 내용에서는 누르지 않아도 그때 살핀다 (살피기는 할 일이라 먼저 한다) — 누름이 행동을 바꾸는 경우가 아직 없다 (LIM046)
  const alone = runScenario(FW.db, vocab, FW.sc).log.map(parseEvent);
  assert.equal(alone.find((e) => e.type === 'action_chosen' && e.t === followed.t)?.data['verb'], 'inspect');
  assert.deepEqual(auditLog(events, FW.db, vocab).findings, []);
});

test('듣지 않음: 그 행동이 선택지에 없으면 not_option으로 듣지 않고, 하루는 누르지 않은 하루와 같은 행동을 한다', () => {
  const { sc, db } = load('kitchen-stew.json');
  const s = Session.start(db, vocab, sc);
  s.advance(1138);
  s.attend(WHO, 'a1');
  s.advance(sc.end);
  const events = log(s);
  const ignored = events.find((e) => e.type === 'advice_ignored');
  assert.equal(ignored?.data['reason'], 'not_option');
  const verbs = (es: readonly GameEvent[]): string[] => es.filter((e) => e.type === 'action_chosen').map((e) => `${e.t} ${str(e.data['verb'])}`);
  assert.deepEqual(verbs(events), verbs(runScenario(db, vocab, sc).log.map(parseEvent)));
  assert.deepEqual(auditLog(events, db, vocab).findings, []);
});

test('저장·불러오기: 누름이 입력으로 남고, 불러와 이어 가면 끊지 않은 하루와 같다', () => {
  const s = pressed();
  const text = s.save(CONTENT);
  assert.ok(s.inputs().some((i) => i.type === 'attend'));
  const { session } = Session.load(FW.db, vocab, text, CONTENT);
  session.advance(FW.sc.end);
  s.advance(FW.sc.end);
  assert.equal(JSON.stringify(session.trace()), JSON.stringify(s.trace()));
});

test('누를 수 없는 것: 없는 번호, 닫힌 장면의 말, 하루가 끝난 뒤, 저장 파일의 다른 시각 — 이유와 함께 거부', () => {
  const s = Session.start(FW.db, vocab, FW.sc);
  assert.throws(() => s.attend(WHO, 'a1'), (e: unknown) => e instanceof SessionError && /누를 수 있는 말이 아니다/.test(e.message), '장면이 열리기 전');
  s.advance(PRESS_AT);
  assert.throws(() => s.attend(WHO, 'a9'), (e: unknown) => e instanceof SessionError && /누를 수 있는 말이 아니다/.test(e.message));
  s.advance(FW.sc.end - 1);
  assert.throws(() => s.attend(WHO, 'a1'), (e: unknown) => e instanceof SessionError && /닫힌 장면/.test(e.message));
  s.advance(FW.sc.end);
  assert.throws(() => s.attend(WHO, 'a1'), (e: unknown) => e instanceof SessionError && /하루가 끝나/.test(e.message));
  const save = JSON.parse(pressed().save(CONTENT)) as { inputs: { type: string; t?: number }[] };
  const wrong = { ...save, inputs: save.inputs.map((i) => (i.type === 'attend' ? { ...i, t: 1 } : i)) };
  assert.throws(() => Session.load(FW.db, vocab, JSON.stringify(wrong), CONTENT), (e: unknown) => e instanceof SessionError && /지금/.test(e.message));
});

test('감사가 잡는 것: 이끄는 행동이 아닌 것을 고름, 누름 없이 닿은 주의, 다른 말의 행동', () => {
  const s = pressed();
  s.advance(FW.sc.end);
  const events = log(s);
  const given = events.find((e) => e.type === 'advice_given' && Array.isArray(e.data['verbs']));
  assert.ok(given);
  const followed = events.find((e) => e.type === 'action_chosen' && e.data['advised'] === given.seq);
  assert.ok(followed);
  const tamper = (f: (e: GameEvent) => GameEvent): GameEvent[] => events.map((e) => f(e));
  const cases: { name: string; events: GameEvent[]; re: RegExp }[] = [
    { name: '다른 행동', events: tamper((e) => (e.seq === followed.seq ? { ...e, data: { ...e.data, verb: 'wipe' } } : e)), re: /이끄는 행동/ },
    { name: '누름 없이', events: tamper((e) => (e.seq === given.seq ? { ...e, cause: null } : e)), re: /주의 돌리기는 그 누름이 원인/ },
    { name: '다른 말', events: tamper((e) => (e.seq === given.seq ? { ...e, data: { ...e.data, verbs: ['ventilate'] } } : e)), re: /주의 돌리기는 그 누름이 원인/ },
  ];
  for (const c of cases) {
    const found = auditLog(c.events, FW.db, vocab).findings;
    assert.ok(found.some((f) => c.re.test(f.message)), `${c.name}: ${found.map((f) => f.message).join(' / ')}`);
  }
});
