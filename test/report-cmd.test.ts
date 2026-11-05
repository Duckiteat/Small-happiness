// 저장된 패치 보고서 다시 보기 (docs/보고서-형식.md 7장)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchReportMarkdown } from '../src/core/report.ts';
import { commitPatch, findRecord, loadDb, readRecordReport } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const sample: unknown = JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-chain.json'), 'utf8'));

const made: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sh-report-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test('패치 기록에 저장된 보고서를 번호나 파일 이름으로 다시 읽는다', () => {
  const root = tempRoot();
  const r = commitPatch(root, sample, vocab, { now: new Date('2026-11-05T09:00:00Z') });
  assert.equal(r.status, 'committed');
  const file = findRecord(root, '1');
  assert.ok(file);
  assert.equal(findRecord(root, '0001'), file);
  assert.equal(findRecord(root, file), file);

  const { report } = readRecordReport(root, '1');
  const md = patchReportMarkdown(report, loadDb(root));
  assert.match(md, /## 패치 보고서/);
  assert.match(md, /상한 음식이 냄새, 벌레를 거쳐/); // why 가 그대로 남는다
  assert.match(md, /관문: \*\*통과\*\*/);
});

test('없는 기록과 망가진 기록은 오류다', () => {
  const root = tempRoot();
  assert.throws(() => readRecordReport(root, '1'), /패치 기록이 없다/);
  commitPatch(root, sample, vocab, { now: new Date('2026-11-05T09:00:00Z') });
  const file = readdirSync(join(root, 'data', 'patches'))[0] ?? '';
  writeFileSync(join(root, 'data', 'patches', file), JSON.stringify({ patch: {}, report: { why: 1 } }));
  assert.throws(() => readRecordReport(root, '1'), /올바른 보고서가 없다/);
  assert.throws(() => readRecordReport(root, '99'), /패치 기록이 없다/);
});
