// 하루 영수증 (docs/영수증-명세.md)
//
// 엔진이 낸 사건 기록을 하루 단위로 끊어 "영수증"으로 찍는다. 엔진을 돌리지 않고 기록만 읽는다.
//   - 사건 사슬: 사건마다 직전 사건의 고리(root)를 물고, 고리 = 해시(직전 고리 + 정준 JSON). 날을 넘어서도 이어진다.
//     중간 사건을 고치거나 빼거나 끼우면 그 뒤 고리가 모두 어긋난다.
//   - 하루 사슬: 영수증마다 앞 영수증의 봉인(seal)을 물고, 봉인 = 해시(앞 봉인 + 영수증 본문). 첫 영수증은 기원(실행 정보)을 문다.
//   - 마감: 그날까지 기록에 나온 세계 상태·앎·넘어가는 예약. 다음 날은 이 마감에서 시작한다.
//   - 사건의 근거 참조(data.via, via.ts): 사전 event_type의 via_kinds가 정한 유형은 어떤 규칙·행동·법칙·감각이 만들었는지 적는다.
//   - 집계·마감·날 넘는 원인 표시는 사건에서 파생된다. 검증은 사건만으로 이것을 다시 계산해 맞춰 본다.
// 해시 함수는 인자로 받는다 (코어는 입출력 모듈을 쓰지 않는다. 시각·난수와 같은 방식).

import type { GameEvent, JsonValue } from './events.ts';
import { MINUTES_PER_DAY } from './clock.ts';
import { viaProblem } from './via.ts';
import type { ViaKind } from './via.ts';

export const RECEIPT_FORMAT = 'small-happiness-receipt';
export const RECEIPT_VERSION = 1;

/** 문자열 → 16진 해시. 노드 쪽에서 sha256을 넘긴다. */
export type Hasher = (text: string) => string;

/** 이 영수증 묶음을 낸 실행. 기원 고리는 이것의 해시다. */
export interface ReceiptRun {
  readonly scenario: string;
  readonly scenario_sha256: string;
  readonly content_sha256: string;
  readonly seed: number;
  readonly start: number;
  readonly end: number;
}

export interface ReceiptItem {
  readonly seq: string;
  readonly t: number;
  readonly type: string;
  readonly src: string;
  readonly cause: string | null;
  /** 원인이 앞날의 사건이면 그 날 번호 (하루를 넘는 연결). 같은 날이거나 원인이 없으면 없음. */
  readonly cause_day?: number;
  readonly data: { readonly [key: string]: JsonValue };
  readonly prev: string;
  readonly root: string;
}

export interface Awareness {
  readonly aw: string;
  readonly level: string;
}

export interface ReceiptClose {
  /** 기록에 나온 개체 (생긴 순서) */
  readonly instances: readonly string[];
  /** 상태 키 → 단계. 기록에서 한 번이라도 바뀐 키만 */
  readonly state: { readonly [key: string]: string };
  /** 인물 → 상태 키 → 앎 */
  readonly aware: { readonly [who: string]: { readonly [key: string]: Awareness } };
  /** 날을 넘어가는 예약 (예약됐고 아직 발동·취소되지 않은 delay_scheduled의 seq) */
  readonly open_delays: readonly string[];
}

export interface Receipt {
  readonly format: string;
  readonly version: number;
  readonly run: ReceiptRun;
  /** 1부터. 절대 분 t의 날 = floor(t / 1440) + 1 */
  readonly day: number;
  /** 이 날의 범위 [from, to) (절대 분) */
  readonly from: number;
  readonly to: number;
  /** 앞 영수증의 봉인. 첫 영수증은 기원 고리 */
  readonly prev_seal: string;
  /** 이 날 첫 사건이 무는 고리 (앞날 마지막 사건의 고리, 첫날은 기원) */
  readonly head_in: string;
  readonly items: readonly ReceiptItem[];
  readonly tally: { readonly n: number; readonly by_type: { readonly [type: string]: number } };
  readonly close: ReceiptClose;
  readonly seal: string;
}

export class ReceiptError extends Error {
  override name = 'ReceiptError';
}

/** 정준 JSON: 키를 정렬하고 undefined는 뺀다. 같은 값이면 같은 글자. */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const dayOf = (t: number): number => Math.floor(t / MINUTES_PER_DAY) + 1;

export function genesisRoot(run: ReceiptRun, hash: Hasher): string {
  return hash(`genesis\n${canon(run)}`);
}

const eventBody = (e: GameEvent): object => ({ seq: e.seq, t: e.t, type: e.type, src: e.src, cause: e.cause, data: e.data });

function itemRoot(prev: string, body: object, hash: Hasher): string {
  return hash(`${prev}\n${canon(body)}`);
}

function sealOf(r: Omit<Receipt, 'seal'>, hash: Hasher): string {
  return hash(`${r.prev_seal}\n${canon(r)}`);
}

const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null);

/** 마감 접기: 사건 하나를 반영한다. 사건이 앞의 상태와 맞지 않으면 문제를 돌려준다. */
interface Fold {
  instances: string[];
  state: Record<string, string>;
  aware: Record<string, Record<string, Awareness>>;
  open: string[];
}

function foldEvent(f: Fold, e: { seq: string; type: string; cause: string | null; data: { readonly [key: string]: JsonValue } }): string | null {
  const d = e.data;
  switch (e.type) {
    case 'instance_created': {
      const id = str(d['id']);
      if (id === null) return `${e.seq}: 개체 번호(id)가 없다`;
      f.instances.push(id);
      return null;
    }
    case 'state_changed': {
      const key = str(d['key']), from = str(d['from']), to = str(d['to']);
      if (key === null || to === null) return `${e.seq}: 상태 키나 바뀐 단계가 없다`;
      const before = f.state[key];
      if (before !== undefined && from !== null && before !== from) return `${e.seq}: ${key}의 앞 단계가 ${before}인데 사건은 ${from}에서 바뀐다고 적었다`;
      f.state[key] = to;
      return null;
    }
    case 'awareness_up':
    case 'awareness_changed': {
      const who = str(d['who']), key = str(d['key']), aw = str(d['to']), level = str(d['level']);
      if (who === null || key === null || aw === null || level === null) return `${e.seq}: 앎 사건에 who·key·to·level이 모두 있어야 한다`;
      (f.aware[who] ??= {})[key] = { aw, level };
      return null;
    }
    case 'delay_scheduled':
      f.open.push(e.seq);
      return null;
    case 'delay_fired':
    case 'delay_cancelled':
      if (e.cause !== null) f.open = f.open.filter((s) => s !== e.cause);
      return null;
    default:
      return null;
  }
}

function snapshot(f: Fold): ReceiptClose {
  const aware: Record<string, Record<string, Awareness>> = {};
  for (const who of Object.keys(f.aware).sort()) {
    const row: Record<string, Awareness> = {};
    for (const key of Object.keys(f.aware[who] ?? {}).sort()) {
      const a = f.aware[who]?.[key];
      if (a !== undefined) row[key] = { aw: a.aw, level: a.level };
    }
    aware[who] = row;
  }
  const state: Record<string, string> = {};
  for (const key of Object.keys(f.state).sort()) state[key] = f.state[key] ?? '';
  return { instances: [...f.instances], state, aware, open_delays: [...f.open] };
}

function tallyOf(items: readonly { type: string }[]): Receipt['tally'] {
  const by: Record<string, number> = {};
  for (const it of items) by[it.type] = (by[it.type] ?? 0) + 1;
  const by_type: Record<string, number> = {};
  for (const k of Object.keys(by).sort()) by_type[k] = by[k] ?? 0;
  return { n: items.length, by_type };
}

/**
 * 사건 기록을 하루 영수증들로 찍는다. 실행의 시작 날부터 끝 날까지 사건이 없는 날도 한 장씩 낸다 (날이 끊기지 않게).
 * 기록은 seq 순서여야 하고 시각이 거꾸로 가지 않아야 한다 (기록이 이미 강제한다. 여기서도 확인한다).
 */
export function printReceipts(log: readonly GameEvent[], run: ReceiptRun, hash: Hasher): Receipt[] {
  const genesis = genesisRoot(run, hash);
  const firstDay = dayOf(Math.min(run.start, ...log.map((e) => e.t)));
  const lastDay = dayOf(Math.max(run.end, ...log.map((e) => e.t)));
  const dayOfSeq = new Map<string, number>();
  const fold: Fold = { instances: [], state: {}, aware: {}, open: [] };
  const receipts: Receipt[] = [];
  let head = genesis;
  let prevSeal = genesis;
  let lastT = -Infinity;
  let i = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const from = (day - 1) * MINUTES_PER_DAY, to = day * MINUTES_PER_DAY;
    const headIn = head;
    const items: ReceiptItem[] = [];
    while (i < log.length && (log[i]?.t ?? Infinity) < to) {
      const e = log[i] as GameEvent;
      if (e.t < lastT) throw new ReceiptError(`${e.seq}: 시각이 거꾸로 간다 (${lastT} → ${e.t})`);
      lastT = e.t;
      const problem = foldEvent(fold, e);
      if (problem !== null) throw new ReceiptError(problem);
      const causeDay = e.cause === null ? undefined : dayOfSeq.get(e.cause);
      const root = itemRoot(head, eventBody(e), hash);
      items.push({ seq: e.seq, t: e.t, type: e.type, src: e.src, cause: e.cause, ...(causeDay !== undefined && causeDay < day ? { cause_day: causeDay } : {}), data: e.data, prev: head, root });
      dayOfSeq.set(e.seq, day);
      head = root;
      i++;
    }
    const body: Omit<Receipt, 'seal'> = {
      format: RECEIPT_FORMAT,
      version: RECEIPT_VERSION,
      run,
      day,
      from,
      to,
      prev_seal: prevSeal,
      head_in: headIn,
      items,
      tally: tallyOf(items),
      close: snapshot(fold),
    };
    const seal = sealOf(body, hash);
    receipts.push({ ...body, seal });
    prevSeal = seal;
  }
  return receipts;
}

export interface ReceiptVerdict {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly days: number;
  readonly events: number;
  /** 마지막 영수증의 봉인 */
  readonly head: string | null;
}

/**
 * 영수증 묶음을 영수증만으로 검증한다 (엔진을 돌리지 않는다).
 * 형식 · 날 연속 · 하루 사슬(앞 봉인) · 사건 사슬(고리 재계산, seq 연속, 시각 순서, 날 범위) · 원인이 앞에 있음 ·
 * 날 넘는 원인 표시 · 집계 · 마감(사건을 처음부터 접어 다시 만듦) · 봉인 재계산.
 */
export function verifyReceipts(
  receipts: readonly Receipt[],
  hash: Hasher,
  /** 사건 유형이 가져야 하는 근거 참조(via) 종류. 주면 모든 사건의 via를 규칙대로 확인한다 (사전 event_type의 via_kinds). */
  viaKinds?: (type: string) => readonly ViaKind[] | undefined,
): ReceiptVerdict {
  const errors: string[] = [];
  const bad = (m: string): void => void errors.push(m);
  if (receipts.length === 0) return { ok: false, errors: ['영수증이 없다'], days: 0, events: 0, head: null };
  const run = receipts[0]?.run as ReceiptRun;
  const genesis = genesisRoot(run, hash);
  const fold: Fold = { instances: [], state: {}, aware: {}, open: [] };
  const dayOfSeq = new Map<string, number>();
  let prevSeal = genesis, head = genesis, lastT = -Infinity, n = 0;
  receipts.forEach((r, k) => {
    const at = `${r.day}일 영수증`;
    if (r.format !== RECEIPT_FORMAT || r.version !== RECEIPT_VERSION) bad(`${at}: 형식이 아니다 (${r.format} v${r.version})`);
    if (canon(r.run) !== canon(run)) bad(`${at}: 실행 정보가 첫 영수증과 다르다 (다른 실행의 영수증이 섞임)`);
    if (k > 0 && r.day !== (receipts[k - 1]?.day ?? 0) + 1) bad(`${at}: 날이 이어지지 않는다 (앞 영수증 ${receipts[k - 1]?.day}일)`);
    if (r.from !== (r.day - 1) * MINUTES_PER_DAY || r.to !== r.day * MINUTES_PER_DAY) bad(`${at}: 날의 범위가 날 번호와 맞지 않는다`);
    if (r.prev_seal !== prevSeal) bad(`${at}: 앞 영수증의 봉인을 물지 않았다 — 하루 사슬이 끊김`);
    if (r.head_in !== head) bad(`${at}: 첫 사건이 무는 고리가 앞날 마지막 사건의 고리가 아니다`);
    for (const it of r.items) {
      n++;
      const expectSeq = `L${String(n).padStart(6, '0')}`;
      if (it.seq !== expectSeq) bad(`${at} ${it.seq}: 사건 번호가 ${expectSeq}이어야 한다 — 빠지거나 끼운 사건`);
      if (it.t < r.from || it.t >= r.to) bad(`${at} ${it.seq}: 시각 ${it.t}가 이 날의 범위 밖이다`);
      if (it.t < lastT) bad(`${at} ${it.seq}: 시각이 거꾸로 간다`);
      lastT = it.t;
      if (it.prev !== head) bad(`${at} ${it.seq}: 직전 사건의 고리를 물지 않았다 — 사건 사슬이 끊김`);
      const body = { seq: it.seq, t: it.t, type: it.type, src: it.src, cause: it.cause, data: it.data };
      if (it.root !== itemRoot(it.prev, body, hash)) bad(`${at} ${it.seq}: 고리 재계산이 맞지 않는다 — 사건 내용이 바뀜`);
      if (it.cause !== null && !dayOfSeq.has(it.cause)) bad(`${at} ${it.seq}: 원인 ${it.cause}가 앞에 없다`);
      const cd = it.cause === null ? undefined : dayOfSeq.get(it.cause);
      const expectCd = cd !== undefined && cd < r.day ? cd : undefined;
      if (it.cause_day !== expectCd) bad(`${at} ${it.seq}: 날 넘는 원인 표시가 맞지 않는다 (기대 ${expectCd ?? '없음'}, 적힌 값 ${it.cause_day ?? '없음'})`);
      const problem = foldEvent(fold, it);
      if (problem !== null) bad(`${at} ${problem}`);
      const viaIssue = viaKinds === undefined ? null : viaProblem(viaKinds(it.type), it.data);
      if (viaIssue !== null) bad(`${at} ${it.seq}: ${viaIssue}`);
      dayOfSeq.set(it.seq, r.day);
      head = it.root;
    }
    if (canon(r.tally) !== canon(tallyOf(r.items))) bad(`${at}: 집계가 사건과 맞지 않는다`);
    if (canon(r.close) !== canon(snapshot(fold))) bad(`${at}: 마감이 사건을 접은 결과와 맞지 않는다`);
    const { seal, ...body } = r;
    if (seal !== sealOf(body, hash)) bad(`${at}: 봉인 재계산이 맞지 않는다 — 영수증이 찍힌 뒤 바뀜`);
    prevSeal = seal;
  });
  return { ok: errors.length === 0, errors, days: receipts.length, events: n, head: receipts.at(-1)?.seal ?? null };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJson(v: unknown): v is JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  return isObj(v) && Object.values(v).every(isJson);
}

const fail = (m: string): never => {
  throw new ReceiptError(m);
};
const num = (o: Record<string, unknown>, k: string, at: string): number => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(`${at}.${k}는 숫자여야 한다`);
};
const text = (o: Record<string, unknown>, k: string, at: string): string => {
  const v = o[k];
  return typeof v === 'string' ? v : fail(`${at}.${k}는 문자열이어야 한다`);
};
const obj = (o: Record<string, unknown>, k: string, at: string): Record<string, unknown> => {
  const v = o[k];
  return isObj(v) ? v : fail(`${at}.${k}는 객체여야 한다`);
};
function exactKeys(o: Record<string, unknown>, keys: readonly string[], optional: readonly string[], at: string): void {
  const missing = keys.filter((k) => !(k in o));
  if (missing.length > 0) fail(`${at}에 없는 칸: ${missing.join(', ')}`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k) && !optional.includes(k));
  if (extra.length > 0) fail(`${at}에 모르는 칸: ${extra.join(', ')}`);
}

function parseItem(raw: unknown, at: string): ReceiptItem {
  if (!isObj(raw)) return fail(`${at}: 사건이 객체가 아니다`);
  exactKeys(raw, ['seq', 't', 'type', 'src', 'cause', 'data', 'prev', 'root'], ['cause_day'], at);
  const cause = raw['cause'];
  if (cause !== null && typeof cause !== 'string') fail(`${at}.cause는 문자열이나 null이어야 한다`);
  const data = raw['data'];
  if (!isObj(data) || !isJson(data)) return fail(`${at}.data는 JSON 객체여야 한다`);
  const cd = raw['cause_day'];
  if (cd !== undefined && typeof cd !== 'number') fail(`${at}.cause_day는 숫자여야 한다`);
  return {
    seq: text(raw, 'seq', at),
    t: num(raw, 't', at),
    type: text(raw, 'type', at),
    src: text(raw, 'src', at),
    cause: typeof cause === 'string' ? cause : null,
    ...(typeof cd === 'number' ? { cause_day: cd } : {}),
    data,
    prev: text(raw, 'prev', at),
    root: text(raw, 'root', at),
  };
}

function stringMap(o: Record<string, unknown>, at: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' ? v : fail(`${at}.${k}는 문자열이어야 한다`);
  return out;
}

function strings(v: unknown, at: string): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : fail(`${at}는 문자열 목록이어야 한다`);
}

/** 파일에서 읽은 값을 영수증으로 해석한다. 모양만 본다 (내용은 verifyReceipts). */
export function parseReceipt(raw: unknown): Receipt {
  const at = '영수증';
  if (!isObj(raw)) return fail(`${at}이 객체가 아니다`);
  exactKeys(raw, ['format', 'version', 'run', 'day', 'from', 'to', 'prev_seal', 'head_in', 'items', 'tally', 'close', 'seal'], [], at);
  const run = obj(raw, 'run', at);
  exactKeys(run, ['scenario', 'scenario_sha256', 'content_sha256', 'seed', 'start', 'end'], [], `${at}.run`);
  const tally = obj(raw, 'tally', at);
  exactKeys(tally, ['n', 'by_type'], [], `${at}.tally`);
  const byType: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(tally, 'by_type', `${at}.tally`))) byType[k] = typeof v === 'number' ? v : fail(`${at}.tally.by_type.${k}는 숫자여야 한다`);
  const close = obj(raw, 'close', at);
  exactKeys(close, ['instances', 'state', 'aware', 'open_delays'], [], `${at}.close`);
  const aware: Record<string, Record<string, Awareness>> = {};
  for (const [who, row] of Object.entries(obj(close, 'aware', `${at}.close`))) {
    if (!isObj(row)) return fail(`${at}.close.aware.${who}는 객체여야 한다`);
    const r: Record<string, Awareness> = {};
    for (const [key, a] of Object.entries(row)) {
      if (!isObj(a)) return fail(`${at}.close.aware.${who}.${key}는 객체여야 한다`);
      r[key] = { aw: text(a, 'aw', `${at}.close.aware`), level: text(a, 'level', `${at}.close.aware`) };
    }
    aware[who] = r;
  }
  const items = raw['items'];
  if (!Array.isArray(items)) return fail(`${at}.items는 사건 목록이어야 한다`);
  return {
    format: text(raw, 'format', at),
    version: num(raw, 'version', at),
    run: {
      scenario: text(run, 'scenario', `${at}.run`),
      scenario_sha256: text(run, 'scenario_sha256', `${at}.run`),
      content_sha256: text(run, 'content_sha256', `${at}.run`),
      seed: num(run, 'seed', `${at}.run`),
      start: num(run, 'start', `${at}.run`),
      end: num(run, 'end', `${at}.run`),
    },
    day: num(raw, 'day', at),
    from: num(raw, 'from', at),
    to: num(raw, 'to', at),
    prev_seal: text(raw, 'prev_seal', at),
    head_in: text(raw, 'head_in', at),
    items: items.map((it, k) => parseItem(it, `${at}.items[${k}]`)),
    tally: { n: num(tally, 'n', `${at}.tally`), by_type: byType },
    close: {
      instances: strings(close['instances'], `${at}.close.instances`),
      state: stringMap(obj(close, 'state', `${at}.close`), `${at}.close.state`),
      aware,
      open_delays: strings(close['open_delays'], `${at}.close.open_delays`),
    },
    seal: text(raw, 'seal', at),
  };
}
