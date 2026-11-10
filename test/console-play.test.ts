// 텍스트 러너 (src/core/console-play.ts, 구현-계획 N2-1): 화면 없이 콘솔에서 하루를 진행하며 읽는다
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clockText, ConsolePlay, PLAY_HELP } from '../src/core/console-play.ts';
import { Session } from '../src/core/session.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const WHO = 'CHR000001#1';
const start = (f: string): { play: ConsolePlay; session: Session; sc: ReturnType<typeof parseScenario>; db: ReturnType<typeof scenarioDb> } => {
  const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', f), 'utf8')) as Record<string, unknown>);
  const db = scenarioDb(ROOT, vocab, sc);
  const session = Session.start(db, vocab, sc);
  return { play: new ConsolePlay(session, db, vocab, WHO), session, sc, db };
};
const runAll = (play: ConsolePlay, inputs: readonly string[]): string[] => inputs.flatMap((i) => play.run(i).lines);
const untilEnd = (play: ConsolePlay, session: Session): string[] => {
  const out: string[] = [];
  for (let i = 0; i < 500 && !session.ended; i++) out.push(...play.run('').lines);
  assert.ok(session.ended, '빈 줄만 넣어도 하루 끝에 닿는다');
  return out;
};

test('시계 글: 절대 분 → N일차 HH:MM', () => {
  assert.equal(clockText(0), '1일차 00:00');
  assert.equal(clockText(420), '1일차 07:00');
  assert.equal(clockText(1440 * 3 + 65), '4일차 01:05');
});

test('첫 주를 빈 줄로만 끝까지: 장면과 사다리 칸, 행동, 선택지가 글로 나오고, 하루는 엔진이 혼자 돈 하루와 같다', () => {
  const { play, session, sc, db } = start('first-week.json');
  const out = untilEnd(play, session).join('\n');
  assert.match(out, /【냉장고 냄새 · 주방】/);
  assert.match(out, /○ 짐작: \S+\? \S+\?/);
  assert.match(out, /○ 정체: /);
  assert.match(out, /● 닫힘/);
  assert.match(out, /떠올린 선택지: 1\) /);
  assert.match(out, /찾았다\. 이거였구나\./);
  assert.match(out, /하루가 끝났다/);
  // 줄글 속 눌리는 말은 [말]로
  assert.match(out, /\[[^\]]+\]/);
  assert.equal(JSON.stringify(session.trace()), JSON.stringify(runScenario(db, vocab, sc)), '러너가 하루를 바꾸지 않는다');
});

test('빈 줄은 보여 줄 것이 생길 때까지 진행한다: 시각만 있는 출력은 없다 (끝 알림 제외)', () => {
  const { play, session } = start('first-week.json');
  for (let i = 0; i < 500 && !session.ended; i++) {
    const r = play.run('').lines;
    if (session.ended) break;
    assert.ok(r.length >= 2, `시각 한 줄만 나왔다: ${r.join(' / ')}`);
  }
});

test('같은 입력이면 같은 글 (결정론)', () => {
  const inputs = ['', '', '+90', 'v', '', 'a 1', '', '', '+600', 'v'];
  const a = runAll(start('home-evening.json').play, inputs);
  const b = runAll(start('home-evening.json').play, inputs);
  assert.deepEqual(a, b);
});

test('조언: 떠올린 선택지 번호로 권하고, 시나리오의 조언처럼 하루씨에게 닿는다', () => {
  const { play, session } = start('home-evening.json');
  const first = play.run('').lines.join('\n');
  assert.match(first, /떠올린 선택지: 1\) /);
  const said = play.run('a 2').lines;
  assert.equal(said.length, 1);
  assert.match(said[0] ?? '', /^요정: ".+, 어때\?" \(.+\)$/);
  assert.equal(session.inputs().filter((i) => i.type === 'advise').length, 1);
  const later = runAll(play, ['', '', '', '']).join('\n');
  assert.match(later, /조언이 닿았다/);
});

test('거절하는 입력: 선택지 밖 번호, 선택지 전 조언, 모르는 입력 — 던지지 않고 이유를 말한다', () => {
  const fresh = start('home-evening.json').play;
  assert.deepEqual(fresh.run('a 1').lines, ['권할 선택지가 아직 없다.']);
  assert.match(fresh.run('춤춰').lines[0] ?? '', /^모르는 입력이다/);
  fresh.run('');
  assert.match(fresh.run('a 99').lines[0] ?? '', /^선택지는 1~\d+번이다\.$/);
  assert.deepEqual(fresh.run('?').lines, [PLAY_HELP]);
});

test('+분은 하루의 끝에서 멈추고, 끝난 뒤의 진행·조언은 알림만', () => {
  const { play, session, sc } = start('home-evening.json');
  play.run('+100000');
  assert.equal(session.t, sc.end);
  assert.ok(session.ended);
  assert.match(play.run('').lines[0] ?? '', /^하루가 끝났다/);
  assert.match(play.run('+5').lines[0] ?? '', /^하루가 끝났다/);
  assert.equal(play.run('q').quit, true);
});

test('다시 보기: 장면이 없으면 없다고, 있으면 줄글 전체와 칸', () => {
  const none = start('kitchen-outage.json').play;
  assert.deepEqual(none.run('v').lines.slice(1), ['  (보여 줄 장면이 없다)']);
  const { play, session } = start('first-week.json');
  untilEnd(play, session);
  const v = play.run('v').lines.join('\n');
  assert.match(v, /하루 끝/);
  assert.match(v, /【냉장고 냄새 · 주방】 닫힘/);
  assert.match(v, /○ 정체: /);
});
