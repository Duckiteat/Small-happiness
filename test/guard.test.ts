// 꼼수 방지 시험 (docs/꼼수-방지.md)
//   1. 금지 패턴: 타입·시험·오류를 우회하는 코드가 들어오지 못한다
//   2. 래칫: 시험 수와 거부 말뭉치가 바닥값 아래로 내려가지 않는다
//   3. 재생: data/db.json은 기록된 패치의 결과와 같아야 한다 (손으로 고치지 못한다)
//   4. 가드: 관문·사전·시험의 규칙을 바꾸는 변경은 결정 기록을 동반한다

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { replay } from '../src/node/clerk.ts';
import { guardCheck } from '../src/node/guard.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

interface Banned {
  readonly id: string;
  readonly scope: 'all' | 'src' | 'core';
  readonly pattern: string;
  /** 이 패턴이 반드시 잡아야 하는 표본. .ts 밖(JSON)에 두어 검사기가 자기 표본을 잡지 않게 한다 */
  readonly sample: string;
  readonly why: string;
}

const banned = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'banned-patterns.json'), 'utf8')) as Banned[];
const floor = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'FLOOR.json'), 'utf8')) as {
  tests: number;
  rejections: number;
  maxAllowances: number;
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

const srcFiles = tsFiles(join(ROOT, 'src'));
const testFiles = tsFiles(join(ROOT, 'test'));
const ALLOW = 'guard-allow:';

function inScope(scope: Banned['scope'], file: string): boolean {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (scope === 'all') return rel.startsWith('src/') || rel.startsWith('test/');
  if (scope === 'src') return rel.startsWith('src/');
  return rel.startsWith('src/core/');
}

test('금지 패턴: 타입·시험·오류를 우회하는 코드가 없다', () => {
  const violations: string[] = [];
  for (const rule of banned) {
    const re = new RegExp(rule.pattern);
    for (const file of [...srcFiles, ...testFiles]) {
      if (!inScope(rule.scope, file)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line) && !line.includes(ALLOW)) {
            violations.push(`${relative(ROOT, file)}:${i + 1} [${rule.id}] ${rule.why}\n    ${line.trim()}`);
          }
        });
    }
  }
  assert.deepEqual(violations, [], '\n' + violations.join('\n'));
});

test('금지 패턴 검사기가 실제로 잡는다 (규칙마다 표본이 있고, 표본을 잡는다)', () => {
  assert.ok(banned.length > 0);
  for (const rule of banned) {
    assert.ok(typeof rule.sample === 'string' && rule.sample !== '', `${rule.id}: 표본이 없다`);
    assert.ok(new RegExp(rule.pattern).test(rule.sample), `${rule.id}: 표본을 잡지 못한다`);
  }
});

test('예외 표시(guard-allow)는 바닥값을 넘지 않는다', () => {
  let count = 0;
  for (const file of [...srcFiles, ...testFiles]) {
    if (relative(ROOT, file) === 'test/guard.test.ts') continue; // 이 파일의 설명 문자열은 제외
    count += readFileSync(file, 'utf8').split('\n').filter((l) => l.includes(ALLOW)).length;
  }
  assert.ok(count <= floor.maxAllowances, `guard-allow ${count}건 > 허용 ${floor.maxAllowances}`);
});

test('래칫: 시험 수가 바닥값 아래로 내려가지 않는다', () => {
  let count = 0;
  for (const file of testFiles) {
    if (!file.endsWith('.test.ts')) continue;
    count += readFileSync(file, 'utf8').split('\n').filter((l) => /^test\(/.test(l)).length;
  }
  assert.ok(count >= floor.tests, `시험 ${count}개 < 바닥값 ${floor.tests} — 시험을 지우거나 줄이지 않는다`);
});

test('재생: 실제 data/db.json이 기록된 패치의 결과와 같다', () => {
  const r = replay(ROOT, vocab);
  assert.equal(r.ok, true, r.problems.join('\n'));
});

test('가드: 규칙 파일을 바꾸면 결정 기록이 필요하다', () => {
  const gate = guardCheck([{ status: 'M', path: 'src/core/gate.ts' }]);
  assert.equal(gate.ok, false);
  assert.match(gate.problems.join('\n'), /결정-기록/);

  assert.equal(guardCheck([{ status: 'M', path: 'src/core/gate.ts' }, { status: 'M', path: 'docs/결정-기록.md' }]).ok, true);
  assert.equal(guardCheck([{ status: 'M', path: 'src/core/chains.ts' }]).ok, true); // 보호 대상이 아닌 일반 변경
});

test('가드: 말뭉치·바닥값·시험 파일·워크플로를 건드리면 결정 기록이 필요하다', () => {
  for (const path of [
    'test/fixtures/FLOOR.json',
    'test/fixtures/rejections/unknown-feature.json',
    'test/rejections.test.ts',
    '.github/workflows/check.yml',
    'CLAUDE.md',
  ]) {
    assert.equal(guardCheck([{ status: 'M', path }]).ok, false, path);
  }
});

test('가드: 시험 파일 삭제는 결정 기록이 없으면 막힌다', () => {
  const r = guardCheck([{ status: 'D', path: 'test/ids.test.ts' }]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /시험 파일을 지우는/);
  assert.equal(guardCheck([{ status: 'D', path: 'test/ids.test.ts' }, { status: 'M', path: 'docs/결정-기록.md' }]).ok, true);
});
