import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendixMarkdown } from '../src/core/appendix.ts';
import { appendix, commitPatch, loadDb, replay } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const sample: unknown = JSON.parse(readFileSync(join(ROOT, 'examples', 'patches', 'fridge-chain.json'), 'utf8'));
const NOW = new Date('2026-11-03T09:30:00Z');

const made: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sh-clerk-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test('dry-run은 아무것도 쓰지 않는다', () => {
  const root = tempRoot();
  const r = commitPatch(root, sample, vocab, { dry: true, now: NOW });
  assert.equal(r.status, 'dry-ok');
  assert.deepEqual(r.files, []);
  assert.equal(existsSync(join(root, 'data')), false);
});

test('통과한 패치는 저장소와 기록 파일을 쓴다', () => {
  const root = tempRoot();
  const r = commitPatch(root, sample, vocab, { now: NOW });
  assert.equal(r.status, 'committed');
  assert.equal(Object.keys(loadDb(root).defs).length, 5);
  const records = readdirSync(join(root, 'data', 'patches'));
  assert.equal(records.length, 1);
  assert.match(records[0] as string, /^0001-20261103-0930\d\d-/);
  const record = JSON.parse(readFileSync(join(root, 'data', 'patches', records[0] as string), 'utf8'));
  assert.equal(record.idmap['OBJ+1'], 'OBJ000001');
  assert.equal(record.report.verification.pass, true);
  assert.match(record.patch.why, /시험 케이스/);
});

test('같은 패치를 다시 넣으면 이름 충돌로 거부되고 아무것도 바뀌지 않는다', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const dbBefore = readFileSync(join(root, 'data', 'db.json'), 'utf8');
  const again = commitPatch(root, sample, vocab, { now: new Date('2026-11-03T10:00:00Z') });
  assert.equal(again.status, 'rejected');
  assert.equal(readFileSync(join(root, 'data', 'db.json'), 'utf8'), dbBefore);
  assert.equal(readdirSync(join(root, 'data', 'patches')).length, 1);
});

test('바뀐 것이 없으면 쓰지 않는다', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const same = { format: 'small-happiness-patch', version: 1, why: '변화 없음', defs: [{ id: 'OBJ000001', aliases: ['식재료'] }] };
  const r = commitPatch(root, same, vocab, { now: new Date('2026-11-03T10:00:00Z') });
  assert.equal(r.status, 'unchanged');
  assert.equal(readdirSync(join(root, 'data', 'patches')).length, 1);
});

test('형식이 틀린 패치는 invalid-patch', () => {
  const root = tempRoot();
  const r = commitPatch(root, { format: 'nope' }, vocab, { now: NOW });
  assert.equal(r.status, 'invalid-patch');
  assert.ok((r.patchIssues ?? []).length > 0);
  assert.equal(existsSync(join(root, 'data')), false);
});

test('자동 생성 부록: 내용, 쓰기, 최신 여부 검사', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const md = appendixMarkdown(loadDb(root), vocab);
  assert.match(md, /\| OBJ000001 \| object \| 음식 \| portable \|/);
  assert.match(md, /spoil → odor_reach → bugs → spread/);

  assert.equal(appendix(root, vocab, 'check').ok, false); // 아직 안 씀
  assert.equal(appendix(root, vocab, 'write').ok, true);
  assert.equal(appendix(root, vocab, 'check').ok, true);
  writeFileSync(join(root, 'docs', '자동생성-부록.md'), '손으로 고침');
  assert.equal(appendix(root, vocab, 'check').ok, false);
});

test('재생: 기록대로 다시 적용하면 저장소와 일치한다', () => {
  const root = tempRoot();
  assert.equal(replay(root, vocab).ok, true); // 아무것도 없는 상태도 일치
  commitPatch(root, sample, vocab, { now: NOW });
  const r = replay(root, vocab);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.patches, 1);
});

test('재생: 저장소를 손으로 고치면 잡는다', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const file = join(root, 'data', 'db.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"ko": "음식"', '"ko": "음식물"'));
  const r = replay(root, vocab);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /손으로 고쳤거나/);
});

test('재생: 기록 파일이 빠지거나 바뀌어도 잡는다', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const dir = join(root, 'data', 'patches');
  const [name] = readdirSync(dir);
  const recordPath = join(dir, name as string);

  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.patch.defs[0].names.ko = '다른 이름';
  writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(replay(root, vocab).ok, false); // 기록을 고치면 결과가 어긋난다

  rmSync(recordPath);
  assert.equal(replay(root, vocab).ok, false); // 기록이 빠지면 어긋난다
});

test('재생 순서: 같은 초에 들어온 패치도 번호 순서로 적용된다', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const second = { format: 'small-happiness-patch', version: 1, why: '두 번째', defs: [{ id: 'OBJ000001', aliases: ['식재료', '먹거리'] }] };
  commitPatch(root, second, vocab, { now: NOW }); // 같은 시각
  const names = readdirSync(join(root, 'data', 'patches'));
  assert.deepEqual(names.map((n) => n.slice(0, 4)), ['0001', '0002']);
  assert.equal(replay(root, vocab).ok, true);
});

test('저장소 파일이 깨졌으면 읽기를 거부한다', () => {
  const root = tempRoot();
  commitPatch(root, sample, vocab, { now: NOW });
  const file = join(root, 'data', 'db.json');
  const broken = JSON.parse(readFileSync(file, 'utf8'));
  broken.meta.next.OBJ = 0;
  writeFileSync(file, JSON.stringify(broken));
  assert.throws(() => loadDb(root), /저장소 파일이 올바르지 않다/);
});

test('실제 저장소(data/db.json)가 올바르다', () => {
  assert.doesNotThrow(() => loadDb(ROOT));
});

test('실제 저장소의 자동 생성 부록이 최신이다 (낡으면 npm run appendix)', () => {
  assert.equal(appendix(ROOT, vocab, 'check').ok, true, 'docs/자동생성-부록.md가 낡았다 — npm run appendix');
});

test('명령줄: status와 validate (쓰지 않음)', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'src', 'node', 'cli.ts'), ...args, '--root', ROOT], { encoding: 'utf8' });

  const before = readFileSync(join(ROOT, 'data', 'db.json'), 'utf8');
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`정의 ${Object.keys(loadDb(ROOT).defs).length}개`));

  // 실제 저장소에 맞는 작은 패치 (2026-11-06부터 실제 저장소에 내용이 있다): 음식 종류에 하나를 더한다
  const dir = mkdtempSync(join(tmpdir(), 'sh-cli-'));
  const file = join(dir, 'p.json');
  writeFileSync(file, JSON.stringify({ format: 'small-happiness-patch', version: 1, why: '시험: validate는 쓰지 않는다',
    defs: [{ id: 'OBJ+1', is_a: 'OBJ000001', names: { ko: '시험용 반찬' }, mobility: '가변', slots: { body: { features: ['smell', 'decay'] }, cond: { features: ['seal', 'moisture', 'cut', 'temp'] } } }] }));
  const validate = run('validate', file);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /관문: \*\*통과\*\*/);
  assert.match(validate.stdout, /결과: dry-ok/);
  assert.equal(readFileSync(join(ROOT, 'data', 'db.json'), 'utf8'), before); // 실제 저장소는 그대로
});
