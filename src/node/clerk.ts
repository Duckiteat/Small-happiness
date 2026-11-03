// 서기 — 저장소 데이터를 쓰는 유일한 모듈 (docs/기반층-명세.md 4 · 원 설계: 입법 서기)
//
//   data/db.json, data/patches/  ← 관문을 통과한 패치만. 거부되면 아무것도 쓰지 않는다.
//   docs/자동생성-부록.md          ← 계산된 파생 문서만.
//
// 순수 코어(src/core)는 병합·검사·보고를 계산하고, 파일 쓰기는 여기서만 한다. 현재 시각은 인자로 받는다.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendixMarkdown, APPENDIX_PATH } from '../core/appendix.ts';
import { emptyDb, parseDb, serializeDb } from '../core/db.ts';
import type { Db } from '../core/db.ts';
import { runGate } from '../core/gate.ts';
import type { GateResult } from '../core/gate.ts';
import { mergePatch, parsePatch } from '../core/patch.ts';
import type { MergeReport } from '../core/patch.ts';
import { patchReport } from '../core/report.ts';
import type { PatchReport } from '../core/report.ts';
import type { Vocab } from '../core/vocab.ts';

export const DB_PATH = 'data/db.json';
export const PATCH_DIR = 'data/patches';

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

export function loadDb(root: string): Db {
  const file = join(root, DB_PATH);
  if (!existsSync(file)) return emptyDb();
  const { db, issues } = parseDb(JSON.parse(readFileSync(file, 'utf8')));
  if (db === null) throw new Error(`저장소 파일이 올바르지 않다 (${file}):\n` + issues.map((i) => `  - ${i.where}: ${i.msg}`).join('\n'));
  return db;
}

export type CommitStatus = 'committed' | 'dry-ok' | 'rejected' | 'unchanged' | 'invalid-patch';

export interface CommitResult {
  readonly status: CommitStatus;
  readonly gate?: GateResult;
  readonly merge?: MergeReport;
  readonly report?: PatchReport;
  readonly db?: Db;
  readonly files: string[];
  readonly patchIssues?: readonly { where: string; msg: string }[];
}

export interface CommitOptions {
  readonly dry?: boolean;
  readonly allowWarnings?: boolean;
  /** 기록 파일 이름에 쓰는 시각. 테스트에서 고정한다. */
  readonly now?: Date;
}

function slug(text: string): string {
  const s = text.replace(/[^0-9A-Za-z가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return s === '' ? 'patch' : s;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** 패치를 병합하고 관문을 거친다. 통과하고 바뀐 것이 있을 때만 쓴다. */
export function commitPatch(root: string, rawPatch: unknown, vocab: Vocab, options: CommitOptions = {}): CommitResult {
  const parsed = parsePatch(rawPatch);
  if (parsed.patch === null) return { status: 'invalid-patch', files: [], patchIssues: parsed.issues };

  const before = loadDb(root);
  const merge = mergePatch(before, parsed.patch, vocab);
  const gate = runGate(before, merge.db, vocab, merge.report.errors, options.allowWarnings === true ? { allowWarnings: true } : {});
  const report = patchReport(before, merge.db, merge.report, gate, vocab);
  const base = { gate, merge: merge.report, report, db: merge.db };

  if (!gate.pass) return { status: 'rejected', ...base, files: [] };
  if (serializeDb(merge.db) === serializeDb(before)) return { status: 'unchanged', ...base, files: [] };
  if (options.dry === true) return { status: 'dry-ok', ...base, files: [] };

  const now = options.now ?? new Date();
  // 파일 이름의 앞 번호가 적용 순서다 (같은 초에 둘이 들어와도 재생 순서가 흔들리지 않는다)
  const dir = join(root, PATCH_DIR);
  const seq = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0) + 1;
  const recordFile = join(PATCH_DIR, `${String(seq).padStart(4, '0')}-${stamp(now)}-${slug(parsed.patch.why)}.json`);
  const record = {
    patch: parsed.patch,
    allowWarnings: options.allowWarnings === true,
    idmap: merge.report.idmap,
    mapped: merge.report.mapped,
    report,
  };
  atomicWrite(join(root, recordFile), JSON.stringify(record, null, 2) + '\n');
  atomicWrite(join(root, DB_PATH), serializeDb(merge.db));
  return { status: 'committed', ...base, files: [recordFile, DB_PATH] };
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly patches: number;
  readonly problems: string[];
}

/**
 * 기록된 패치를 빈 저장소에서 순서대로 다시 적용해 data/db.json과 바이트까지 같은지 본다.
 * data/db.json을 손으로 고쳤거나 기록이 빠졌다면 어긋난다 — 서기를 거치지 않은 변경을 잡는다.
 */
export function replay(root: string, vocab: Vocab): ReplayResult {
  const dir = join(root, PATCH_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const problems: string[] = [];
  let db = emptyDb();

  for (const file of files) {
    const rec: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const body = typeof rec === 'object' && rec !== null ? (rec as Record<string, unknown>) : {};
    const parsed = parsePatch(body['patch']);
    if (parsed.patch === null) {
      problems.push(`${file}: 기록된 패치가 올바르지 않다`);
      continue;
    }
    const merged = mergePatch(db, parsed.patch, vocab);
    const gate = runGate(db, merged.db, vocab, merged.report.errors, body['allowWarnings'] === true ? { allowWarnings: true } : {});
    if (!gate.pass) {
      problems.push(`${file}: 다시 적용하면 관문을 통과하지 못한다 (${gate.reason})`);
      continue;
    }
    db = merged.db;
  }

  const expected = serializeDb(db);
  const dbFile = join(root, DB_PATH);
  const actual = existsSync(dbFile) ? readFileSync(dbFile, 'utf8') : serializeDb(emptyDb());
  if (actual !== expected) {
    problems.push('data/db.json이 기록된 패치를 순서대로 적용한 결과와 다르다 (손으로 고쳤거나 기록이 빠졌다)');
  }
  return { ok: problems.length === 0, patches: files.length, problems };
}

/** 자동 생성 부록. --write로 쓰고 --check로 최신인지 본다. */
export function appendix(root: string, vocab: Vocab, mode: 'write' | 'check' | 'print'): { ok: boolean; content: string } {
  const content = appendixMarkdown(loadDb(root), vocab);
  const file = join(root, APPENDIX_PATH);
  if (mode === 'write') {
    atomicWrite(file, content);
    return { ok: true, content };
  }
  if (mode === 'check') {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    return { ok: current === content, content };
  }
  return { ok: true, content };
}

export const WEB_PAGE = 'web/prototype/index.html';
export const VIEW_DIR = 'examples/view/fridge-smell';
const FIXTURE_BLOCK = /(<script id="fixtures" type="application\/json">\n)[\s\S]*?(\n<\/script>)/;

/** 시제품 HTML 안의 장면 JSON을 examples/view 파일과 맞춘다. 파일명 순서가 장면 순서. */
export function syncWeb(root: string, mode: 'write' | 'check'): { ok: boolean; count: number } {
  const dir = join(root, VIEW_DIR);
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  const views: unknown[] = names.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as unknown);
  const json = JSON.stringify(views).replace(/</g, '\\u003c');
  const file = join(root, WEB_PAGE);
  const html = readFileSync(file, 'utf8');
  if (!FIXTURE_BLOCK.test(html)) return { ok: false, count: names.length };
  const next = html.replace(FIXTURE_BLOCK, (_m, a: string, b: string) => a + json + b);
  if (mode === 'write') {
    atomicWrite(file, next);
    return { ok: true, count: names.length };
  }
  return { ok: next === html, count: names.length };
}
