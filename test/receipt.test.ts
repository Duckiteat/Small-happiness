// 하루 영수증 (docs/영수증-명세.md): 사건은 사건끼리, 하루는 하루끼리 사슬로 이어지고, 영수증만으로 검증된다.
// 영수증을 고치면(사건·집계·마감·날·앞 봉인·실행 정보) 검증이 잡는다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { GameEvent } from '../src/core/events.ts';
import { canon, genesisRoot, parseReceipt, printReceipts, ReceiptError, verifyReceipts } from '../src/core/receipt.ts';
import type { Receipt, ReceiptRun } from '../src/core/receipt.ts';
import { receiptText } from '../src/core/receipt-text.ts';
import { receiptNames, receiptsFor, sha256, SKELETON_SCENARIO } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const WEEK = 'content/scenarios/first-week.json';

const week = receiptsFor(ROOT, vocab, WEEK);
const clone = (rs: readonly Receipt[]): Receipt[] => JSON.parse(JSON.stringify(rs)) as Receipt[];
/** 고친 영수증의 봉인을 다시 계산한다 (봉인만 고쳐 맞추는 위조). */
const reseal = (r: Receipt): Receipt => {
  const { seal, ...body } = r;
  void seal;
  return { ...body, seal: sha256(`${r.prev_seal}\n${canon(body)}`) };
};
const errorsOf = (rs: readonly Receipt[]): string => verifyReceipts(rs, sha256).errors.join('\n');

const RUN: ReceiptRun = { scenario: 'test', scenario_sha256: 'a', content_sha256: 'b', seed: 1, start: 0, end: 2 * 1440 };
const ev = (seq: number, t: number, type: string, data: GameEvent['data'], cause: string | null = null): GameEvent => ({
  seq: `L${String(seq).padStart(6, '0')}`,
  t,
  type,
  src: 'world',
  cause,
  data,
});

test('영수증: 같은 입력이면 같은 영수증(봉인까지)이 나온다', () => {
  assert.deepEqual(receiptsFor(ROOT, vocab, WEEK).map((r) => r.seal), week.map((r) => r.seal));
});

test('영수증: 실행의 첫날부터 끝날까지 하루 한 장, 날이 끊기지 않고 앞 영수증의 봉인을 문다', () => {
  assert.deepEqual(week.map((r) => r.day), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(week[0]?.prev_seal, genesisRoot(week[0]?.run ?? RUN, sha256));
  for (let k = 1; k < week.length; k++) assert.equal(week[k]?.prev_seal, week[k - 1]?.seal);
  assert.equal(verifyReceipts(week, sha256).ok, true, errorsOf(week));
});

test('영수증: 사건 사슬은 날을 넘어 이어진다 (다음 날 첫 사건은 앞날 마지막 사건의 고리를 문다)', () => {
  for (let k = 1; k < week.length; k++) {
    const lastRoot = week.slice(0, k).flatMap((r) => r.items).at(-1)?.root;
    assert.equal(week[k]?.head_in, lastRoot);
    const first = week[k]?.items[0];
    if (first !== undefined) assert.equal(first.prev, lastRoot);
  }
  // 모든 사건이 빠짐없이 한 번씩 (엔진 기록과 같은 수)
  const items = week.flatMap((r) => r.items);
  assert.deepEqual(items.map((it) => it.seq), items.map((_, i) => `L${String(i + 1).padStart(6, '0')}`));
});

test('영수증: 원인이 앞날에 있으면 그 날을 적는다 (하루를 넘는 연결)', () => {
  const cross = week.flatMap((r) => r.items.filter((it) => it.cause_day !== undefined).map((it) => ({ day: r.day, it })));
  assert.ok(cross.length > 0, '첫 주에는 날을 넘는 지연 효과가 있다');
  const daysBySeq = new Map(week.flatMap((r) => r.items.map((it) => [it.seq, r.day] as const)));
  for (const { day, it } of cross) {
    assert.equal(daysBySeq.get(it.cause ?? ''), it.cause_day);
    assert.ok((it.cause_day ?? day) < day);
  }
});

test('영수증: 마감은 그날까지의 사건을 접은 것이고, 다음 날로 넘어간다', () => {
  const evs: GameEvent[] = [
    ev(1, 10, 'instance_created', { id: 'OBJ000001#1', def: 'OBJ000001' }),
    ev(2, 20, 'state_changed', { key: 'OBJ000001#1|body:decay', from: 'fresh', to: 'turned' }, 'L000001'),
    ev(3, 30, 'delay_scheduled', { rule: 'OBJ000001/r', at: 'OBJ000001#1', due: 1500 }),
    ev(4, 1500, 'delay_fired', { rule: 'OBJ000001/r', at: 'OBJ000001#1' }, 'L000003'),
    ev(5, 1500, 'awareness_up', { who: 'CHR000001#1', key: 'OBJ000001#1|body:decay', to: 'noticed', level: 'turned' }),
  ];
  const [d1, d2] = printReceipts(evs, RUN, sha256);
  assert.deepEqual(d1?.close, { instances: ['OBJ000001#1'], state: { 'OBJ000001#1|body:decay': 'turned' }, aware: {}, open_delays: ['L000003'] });
  assert.deepEqual(d2?.close.open_delays, [], '앞날의 예약이 다음 날 발동하면 닫힌다');
  assert.deepEqual(d2?.close.state, d1?.close.state, '바뀌지 않은 상태는 다음 날 마감에 그대로 남는다');
  assert.equal(d2?.items[0]?.cause_day, 1);
});

test('영수증: 사건이 없는 날도 한 장 찍는다 (날이 비어도 사슬은 이어진다)', () => {
  const rs = printReceipts([ev(1, 10, 'instance_created', { id: 'OBJ000001#1', def: 'OBJ000001' })], { ...RUN, end: 3 * 1440 - 1 }, sha256);
  assert.deepEqual(rs.map((r) => [r.day, r.items.length]), [[1, 1], [2, 0], [3, 0]]);
  assert.equal(rs[2]?.head_in, rs[0]?.items[0]?.root);
  assert.equal(verifyReceipts(rs, sha256).ok, true);
});

test('영수증: 찍을 때 시각이 거꾸로 가거나 사건이 앞의 상태와 어긋나면 찍지 않는다', () => {
  assert.throws(() => printReceipts([ev(1, 50, 'tick', {}), ev(2, 40, 'tick', {})], RUN, sha256), ReceiptError);
  const mismatch = [
    ev(1, 10, 'state_changed', { key: 'K#1|body:decay', from: 'fresh', to: 'turned' }),
    ev(2, 20, 'state_changed', { key: 'K#1|body:decay', from: 'fresh', to: 'spoiled' }),
  ];
  assert.throws(() => printReceipts(mismatch, RUN, sha256), /앞 단계가 turned/);
});

// ── 고친 영수증은 잡힌다 (거부 사례) ──────────────────────────────────────────

test('거부: 사건 내용을 고치면 고리가 어긋난다 (봉인을 다시 맞춰도)', () => {
  const rs = clone(week);
  const r = rs[3] as Receipt;
  const items = [...r.items];
  const target = items.findIndex((it) => it.type === 'action_chosen');
  items[target] = { ...(items[target] as Receipt['items'][number]), data: { ...items[target]?.data, verb: 'discard' } };
  rs[3] = reseal({ ...r, items });
  assert.match(errorsOf(rs), /고리 재계산이 맞지 않는다/);
});

test('거부: 사건을 빼면 번호와 사슬이 끊긴다', () => {
  const rs = clone(week);
  const r = rs[3] as Receipt;
  rs[3] = reseal({ ...r, items: r.items.filter((_, i) => i !== 2) });
  const e = errorsOf(rs);
  assert.match(e, /빠지거나 끼운 사건/);
  assert.match(e, /사건 사슬이 끊김/);
});

test('거부: 하루를 빼거나 순서를 바꾸면 하루 사슬이 끊긴다', () => {
  const dropped = clone(week).filter((r) => r.day !== 3);
  assert.match(errorsOf(dropped), /날이 이어지지 않는다/);
  assert.match(errorsOf(dropped), /앞 영수증의 봉인을 물지 않았다/);
  const swapped = clone(week);
  [swapped[1], swapped[2]] = [swapped[2] as Receipt, swapped[1] as Receipt];
  assert.match(errorsOf(swapped), /하루 사슬이 끊김/);
});

test('거부: 집계나 마감을 손으로 고치면 사건과 맞지 않는다', () => {
  const tally = clone(week);
  const t = tally[3] as Receipt;
  tally[3] = reseal({ ...t, tally: { ...t.tally, n: t.tally.n + 1 } });
  assert.match(errorsOf(tally), /집계가 사건과 맞지 않는다/);
  const close = clone(week);
  const c = close[3] as Receipt;
  close[3] = reseal({ ...c, close: { ...c.close, state: { ...c.close.state, 'OBJ000002#1|body:decay': 'rotten' } } });
  assert.match(errorsOf(close), /마감이 사건을 접은 결과와 맞지 않는다/);
});

test('거부: 봉인 글자를 바꾸면 봉인 재계산이 잡는다', () => {
  const rs = clone(week);
  const r = rs[0] as Receipt;
  rs[0] = { ...r, seal: r.seal.replace(/^./, (ch) => (ch === '0' ? '1' : '0')) };
  assert.match(errorsOf(rs), /봉인 재계산이 맞지 않는다/);
});

test('거부: 다른 실행의 영수증이 섞이면 잡는다', () => {
  const rs = clone(week);
  rs[5] = reseal({ ...(rs[5] as Receipt), run: { ...(rs[5]?.run ?? RUN), seed: 2 } });
  assert.match(errorsOf(rs), /다른 실행의 영수증이 섞임/);
});

test('거부: 날 넘는 원인 표시를 지우거나 지어내면 잡는다', () => {
  const rs = clone(week);
  const k = rs.findIndex((r) => r.items.some((it) => it.cause_day !== undefined));
  const r = rs[k] as Receipt;
  rs[k] = reseal({ ...r, items: r.items.map((it) => ({ ...it, cause_day: undefined })) });
  assert.match(errorsOf(rs), /날 넘는 원인 표시가 맞지 않는다/);
});

test('거부: 영수증 파일의 모양이 틀리면 읽지 않는다 (없는 칸·모르는 칸)', () => {
  const raw = JSON.parse(JSON.stringify(week[0])) as Record<string, unknown>;
  assert.deepEqual(parseReceipt(JSON.parse(JSON.stringify(week[0]))), week[0]);
  assert.throws(() => parseReceipt({ ...raw, extra: 1 }), /모르는 칸: extra/);
  const { seal, ...noSeal } = raw;
  void seal;
  assert.throws(() => parseReceipt(noSeal), /없는 칸: seal/);
});

// ── 글자판 ───────────────────────────────────────────────────────────────────

test('글자판: 이름은 정의와 사전에서 오고, 사건 번호와 원인·봉인을 함께 찍는다', () => {
  const names = receiptNames(ROOT, WEEK, vocab);
  const text = week.map((r) => receiptText(r, names)).join('\n');
  assert.match(text, /하루 영수증 · 4일차/);
  assert.match(text, /살피기 고름/);
  assert.match(text, /← L\d{6} \(\d일\)/, '날을 넘는 원인은 날을 붙여 찍는다');
  assert.match(text, /봉인 [0-9a-f]{12}/);
  assert.doesNotMatch(text, /OBJ\d{6}#\d/, '알려진 개체는 번호가 아니라 이름으로');
});

test('글자판: 사전에 없는 사건 유형은 지어내지 않고 유형과 data를 그대로 보인다', () => {
  const rs = printReceipts([ev(1, 10, 'mystery_kind', { x: 1 })], { ...RUN, end: 10 }, sha256);
  const text = receiptText(rs[0] as Receipt, receiptNames(ROOT, SKELETON_SCENARIO, vocab));
  assert.match(text, /mystery_kind \{"x":1\}/);
});
