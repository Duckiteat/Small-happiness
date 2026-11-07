// 원인 빈칸과 한계 등록부 (docs/영수증-명세.md 6장): 영수증의 원인 빈칸은 모두 등록부 항목에 걸리고, 두 문서는 최신이다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITATIONS_DATA, parseRegistry } from '../src/core/gaps.ts';
import { gaps } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));

test('원인 빈칸: 모든 빈칸이 한계 등록부에 걸리고, 원인-빈칸·한계-등록부 문서가 최신이다 (바뀌면 gaps --write)', () => {
  const r = gaps(ROOT, vocab, 'check');
  assert.equal(r.unregistered, 0, '등록 안 된 원인 빈칸 — data/limitations.json에 항목을 더한다');
  assert.deepEqual(r.stale, [], '낡은 문서 — node src/node/cli.ts gaps --write');
});

test('한계 등록부: 번호가 겹치거나, 종류가 셋 밖이거나, 대상이 있는데 상태를 손으로 적으면 읽지 않는다', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, LIMITATIONS_DATA), 'utf8')) as { entries: Record<string, unknown>[] };
  const withEntries = (entries: unknown[]): unknown => ({ ...raw, entries });
  const first = raw.entries[0] as Record<string, unknown>;
  assert.equal(parseRegistry(raw).entries.length, raw.entries.length);
  assert.throws(() => parseRegistry(withEntries([first, first])), /번호가 겹친다/);
  assert.throws(() => parseRegistry(withEntries([{ ...first, kind: '모름' }])), /종류는/);
  assert.throws(() => parseRegistry(withEntries([{ ...first, status: '해결' }])), /status는 계산된다/);
  assert.throws(() => parseRegistry(withEntries([{ ...first, target: null }])), /status를 적는다/);
});
