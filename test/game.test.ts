// 회색 상자 화면 (구현-계획 N2-3): web/game/index.html 은 엔진·자료를 묶은 한 장이다
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGame, GAME_PAGE, GAME_TEMPLATE } from '../src/node/clerk.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(join(ROOT, GAME_PAGE), 'utf8');

function inlineData(): { content: string; who: string; scenarios: { file: string; title: string }[]; vocab: unknown[]; db: { defs: object } } {
  const m = /<script id="game-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m?.[1], '자료 블록이 없다');
  return JSON.parse(m[1]) as ReturnType<typeof inlineData>;
}

test('게임 한 장은 지금 엔진·화면·자료로 다시 묶은 것과 바이트까지 같다 (낡으면 npm run game)', () => {
  assert.equal(buildGame(ROOT, 'check').ok, true);
});

test('게임 한 장의 자료: 모든 시나리오, 정의 저장소, 사전, 인물', () => {
  const d = inlineData();
  const files = readdirSync(join(ROOT, 'content', 'scenarios')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(d.scenarios.map((s) => s.file), files);
  assert.ok(d.scenarios.every((s) => s.title !== '' && !s.title.includes(':')));
  assert.match(d.who, /^CHR\d{6}#1$/);
  assert.ok(Object.keys(d.db.defs).length > 10);
  assert.ok(d.vocab.length > 10);
  assert.match(d.content, /^[0-9a-f]{64}$/);
});

test('게임 한 장은 바깥에서 아무것도 불러오지 않는다 (서버 없이 파일로도 열린다)', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/i);
  const template = readFileSync(join(ROOT, GAME_TEMPLATE), 'utf8');
  assert.ok(template.includes('<!--GAME-DATA-->') && template.includes('<!--GAME-SCRIPT-->'));
  assert.ok(!html.includes('<!--GAME-DATA-->') && !html.includes('<!--GAME-SCRIPT-->'));
});
