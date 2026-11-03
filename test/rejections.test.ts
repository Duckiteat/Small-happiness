// 거부 말뭉치 (래칫): 잘못된 패치는 앞으로도 계속 거부되어야 한다.
// 새 규칙을 넣을 때는 거부 사례를 말뭉치에 더하고 바닥값(FLOOR.json)을 올린다.
// 말뭉치를 줄이거나 바닥값을 내리는 변경은 가드가 결정 기록을 요구한다.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/core/db.ts';
import { runGate } from '../src/core/gate.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'test', 'fixtures', 'rejections');
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

interface Expect {
  readonly stage: 'patch' | 'gate';
  readonly match: string;
}

const expects = read(join(DIR, 'EXPECT.json')) as Record<string, Expect>;
const floor = read(join(ROOT, 'test', 'fixtures', 'FLOOR.json')) as { rejections: number };
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'EXPECT.json').sort();

// 기준 저장소: 예시 패치를 적용한 상태. 말뭉치의 패치들은 이 번호들을 가리킨다.
const base = (() => {
  const parsed = parsePatch(read(join(ROOT, 'examples', 'patches', 'fridge-chain.json')));
  assert.ok(parsed.patch);
  return mergePatch(emptyDb(), parsed.patch, vocab).db;
})();

function outcome(raw: unknown): { rejected: boolean; stage: 'patch' | 'gate'; text: string } {
  const parsed = parsePatch(raw);
  if (parsed.patch === null) {
    return { rejected: true, stage: 'patch', text: parsed.issues.map((i) => `${i.where}: ${i.msg}`).join('\n') };
  }
  const merged = mergePatch(base, parsed.patch, vocab);
  const gate = runGate(base, merged.db, vocab, merged.report.errors);
  const issues = [...gate.mergeErrors, ...gate.newErrors, ...gate.newWarnings].map((i) => `${i.where}: ${i.msg}`);
  return { rejected: !gate.pass, stage: 'gate', text: [gate.reason, ...issues].join('\n') };
}

test('말뭉치: 모든 파일에 기대가 있고, 기대한 파일이 빠지지 않았다', () => {
  assert.deepEqual(files, Object.keys(expects).sort());
});

test('말뭉치: 크기가 바닥값 아래로 내려가지 않는다', () => {
  assert.ok(files.length >= floor.rejections, `거부 사례 ${files.length}건 < 바닥값 ${floor.rejections}`);
});

for (const file of files) {
  const expected = expects[file];
  test(`거부 사례 ${file}`, () => {
    assert.ok(expected, `${file}: EXPECT.json에 기대가 없다`);
    const result = outcome(read(join(DIR, file)));
    assert.equal(result.rejected, true, `${file}: 거부되어야 하는데 통과했다`);
    assert.equal(result.stage, expected.stage, `${file}: 거부 단계가 다르다`);
    assert.match(result.text, new RegExp(expected.match), `${file}: 이유가 다르다\n${result.text}`);
  });
}

test('예시 패치는 말뭉치와 달리 통과한다 (거부 규칙이 모든 것을 막지 않는다)', () => {
  const parsed = parsePatch(read(join(ROOT, 'examples', 'patches', 'fridge-chain.json')));
  assert.ok(parsed.patch);
  const merged = mergePatch(emptyDb(), parsed.patch, vocab);
  assert.equal(runGate(emptyDb(), merged.db, vocab, merged.report.errors).pass, true);
});
