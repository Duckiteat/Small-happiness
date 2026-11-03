// 가드 — 관문·사전·시험의 규칙을 바꾸는 변경이 이유 없이 지나가지 못하게 한다 (docs/꼼수-방지.md)
//
// 한계를 숨기지 않는다: 이 가드는 벽이 아니라 **눈에 띄게 만드는 장치**다. 규칙을 바꾸려면 같은 커밋에서
// 결정 기록을 고쳐야 하므로 변경이 diff에 드러나고, 사람이 검토할 자리가 생긴다.

import { execFileSync } from 'node:child_process';

export interface Change {
  readonly status: string; // A, M, D, R
  readonly path: string;
}

export const DECISION_LOG = 'docs/결정-기록.md';

/** 이 경로(또는 폴더)가 바뀌면 결정 기록도 바뀌어야 한다. */
export const PROTECTED: readonly string[] = [
  'src/core/gate.ts',
  'src/core/vocab.ts',
  'src/core/db.ts',
  'src/core/patch.ts',
  'src/core/statekey.ts',
  'src/node/clerk.ts',
  'src/node/guard.ts',
  'test/fixtures/',
  'test/rejections.test.ts',
  'test/guard.test.ts',
  '.github/workflows/',
  'CLAUDE.md',
];

function isProtected(path: string): boolean {
  return PROTECTED.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

export interface GuardResult {
  readonly ok: boolean;
  readonly problems: string[];
}

export function guardCheck(changes: readonly Change[]): GuardResult {
  const problems: string[] = [];
  const logChanged = changes.some((c) => c.path === DECISION_LOG);

  const touched = [...new Set(changes.filter((c) => isProtected(c.path)).map((c) => c.path))];
  if (touched.length > 0 && !logChanged) {
    problems.push(`관문·사전·시험 규칙을 바꾸는 변경은 같은 커밋에서 ${DECISION_LOG}에 이유를 남겨야 한다: ${touched.join(', ')}`);
  }

  const deletedTests = changes.filter((c) => c.status.startsWith('D') && c.path.startsWith('test/')).map((c) => c.path);
  if (deletedTests.length > 0 && !logChanged) {
    problems.push(`시험 파일을 지우는 변경은 ${DECISION_LOG}에 이유를 남겨야 한다: ${deletedTests.join(', ')}`);
  }

  return { ok: problems.length === 0, problems };
}

/** git diff --name-status를 해석한다. 비교할 커밋이 없으면 null. */
export function changesSince(base: string, cwd: string): Change[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-status', base, 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const changes: Change[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [status, ...paths] = line.split('\t');
    for (const path of paths) changes.push({ status: (status ?? '?').slice(0, 1), path });
  }
  return changes;
}
