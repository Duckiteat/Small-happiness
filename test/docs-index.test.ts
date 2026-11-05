// 문서 목록 시험 (docs/보고서-형식.md 8장): docs 의 모든 문서가 docs/보고서-목록.md 에 올라 있고, 목록의 문서가 실제로 있다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const index = readFileSync(join(DOCS, '보고서-목록.md'), 'utf8');
const listed = [...index.matchAll(/^\|\s*`([^`]+\.md)`\s*\|/gm)].map((m) => m[1] ?? '');

function actual(): string[] {
  const top = readdirSync(DOCS).filter((f) => f.endsWith('.md'));
  const archiveDir = join(DOCS, '보관');
  const archived = existsSync(archiveDir) ? readdirSync(archiveDir).filter((f) => f.endsWith('.md')).map((f) => `보관/${f}`) : [];
  return [...top, ...archived];
}

test('문서 목록: docs 의 모든 문서가 보고서-목록에 올라 있다', () => {
  const missing = actual().filter((f) => !listed.includes(f));
  assert.deepEqual(missing, [], `보고서-목록.md 2장에 행을 더한다: ${missing.join(', ')}`);
});

test('문서 목록: 목록에 올라 있는 문서는 실제로 있다', () => {
  const gone = listed.filter((f) => (f.startsWith('/') ? !existsSync(join(ROOT, f.slice(1))) : !existsSync(join(DOCS, f))));
  assert.deepEqual(gone, [], `없는 문서가 목록에 있다: ${gone.join(', ')}`);
});

test('문서 목록: 같은 문서를 두 번 올리지 않는다', () => {
  const dup = listed.filter((f, i) => listed.indexOf(f) !== i);
  assert.deepEqual(dup, [], `중복: ${dup.join(', ')}`);
});
