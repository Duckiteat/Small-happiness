// 저장 형식 (docs/기반층-명세.md 4장)
//
// 순수 직렬화다: 파일을 읽거나 쓰지 않는다 (쓰기는 src/node/clerk.ts 만 한다). 정규 JSON(키 정렬)으로 직렬화해
// 같은 상태가 같은 바이트가 된다. 형식이 바뀌면 버전을 올리고 이전 버전용 변환을 MIGRATIONS 에 둔다.

import { assertJsonValue } from './events.ts';
import type { JsonValue } from './events.ts';
import { MINUTES_PER_DAY, DAYS_PER_WEEK } from './clock.ts';

export const SAVE_VERSION = 1;

export interface SaveClock {
  /** 마지막으로 닫은 실제 하루 번호 (`realDayIndex`). 한 번도 닫지 않았으면 null */
  readonly lastClosedDay: number | null;
  readonly week: number;
  readonly day: number;
  readonly minute: number;
}

export interface SaveFile {
  readonly version: number;
  readonly contentHash: string;
  readonly seed: number;
  /** 흐름별 난수 상태. 지금은 main 하나다 */
  readonly rng: { readonly [stream: string]: readonly number[] };
  readonly clock: SaveClock;
  readonly state: JsonValue;
  readonly awareness: JsonValue;
  readonly habits: JsonValue;
  readonly schedule: JsonValue;
  readonly resources: JsonValue;
  /** 기록. 생략하면 기록 없이 저장한 것이다 */
  readonly log?: readonly JsonValue[];
}

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveError';
  }
}

/** 이전 버전 저장을 한 단계 위로 올리는 변환. 키는 올리기 전 버전. 지금은 첫 버전이라 비어 있다. */
export const MIGRATIONS: { readonly [fromVersion: number]: (raw: Record<string, unknown>) => Record<string, unknown> } = {};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function bad(msg: string): never {
  throw new SaveError(msg);
}

function isJsonValue(v: unknown): v is JsonValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (isObj(v)) return Object.values(v).every(isJsonValue);
  return false;
}

/** JSON 값인지 검사하고 JSON 값으로 돌려준다. 순환·NaN 은 assertJsonValue 가 먼저 잡는다. */
function jsonField(value: unknown, path: string): JsonValue {
  try {
    assertJsonValue(value, path);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
  return isJsonValue(value) ? value : bad(`${path}: JSON 값이 아니다`);
}

/** 키를 정렬해 같은 값이 같은 바이트가 되게 한다. 끝에 줄바꿈 하나. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k] ?? null);
    return out;
  }
  return value;
}

const ALLOWED = ['version', 'contentHash', 'seed', 'rng', 'clock', 'state', 'awareness', 'habits', 'schedule', 'resources', 'log'];

/** 알 수 없는 값(raw)을 검사해 SaveFile 로 만든다. 타입을 강제로 맞추지 않고 검사한 값으로 새로 짓는다. */
function checkSave(raw: Record<string, unknown>): SaveFile {
  for (const k of Object.keys(raw)) if (!ALLOWED.includes(k)) bad(`알 수 없는 필드: ${k}`);

  const version = raw['version'];
  if (!isInt(version)) return bad('version이 정수가 아니다');
  const contentHash = raw['contentHash'];
  if (typeof contentHash !== 'string' || contentHash === '') return bad('contentHash가 필요하다');
  const seed = raw['seed'];
  if (!isInt(seed)) return bad('seed가 정수가 아니다');

  const rawRng = raw['rng'];
  if (!isObj(rawRng) || Object.keys(rawRng).length === 0) return bad('rng에 흐름별 상태가 필요하다');
  const rng: { [stream: string]: number[] } = {};
  for (const [name, st] of Object.entries(rawRng)) {
    if (!Array.isArray(st) || st.length !== 4) return bad(`rng.${name}은 0~2^32-1 정수 네 개여야 한다`);
    const four: number[] = [];
    for (const x of st) {
      if (!isInt(x) || x < 0 || x > 0xffffffff) return bad(`rng.${name}은 0~2^32-1 정수 네 개여야 한다`);
      four.push(x);
    }
    rng[name] = four;
  }

  const rawClock = raw['clock'];
  if (!isObj(rawClock)) return bad('clock이 필요하다');
  const lastClosedDay = rawClock['lastClosedDay'];
  if (lastClosedDay !== null && !isInt(lastClosedDay)) return bad('clock.lastClosedDay는 정수 또는 null이어야 한다');
  const week = rawClock['week'];
  const day = rawClock['day'];
  const minute = rawClock['minute'];
  if (!isInt(week) || week < 1) return bad('clock.week는 1 이상 정수여야 한다');
  if (!isInt(day) || day < 1 || day > DAYS_PER_WEEK) return bad(`clock.day는 1~${DAYS_PER_WEEK}이어야 한다`);
  if (!isInt(minute) || minute < 0 || minute >= MINUTES_PER_DAY) return bad(`clock.minute는 0~${MINUTES_PER_DAY - 1}이어야 한다`);

  for (const key of ['state', 'awareness', 'habits', 'schedule', 'resources']) {
    if (!(key in raw)) return bad(`${key}가 필요하다`);
  }
  const base = {
    version,
    contentHash,
    seed,
    rng,
    clock: { lastClosedDay, week, day, minute },
    state: jsonField(raw['state'], 'state'),
    awareness: jsonField(raw['awareness'], 'awareness'),
    habits: jsonField(raw['habits'], 'habits'),
    schedule: jsonField(raw['schedule'], 'schedule'),
    resources: jsonField(raw['resources'], 'resources'),
  };

  const rawLog = raw['log'];
  if (rawLog === undefined) return base;
  if (!Array.isArray(rawLog)) return bad('log는 목록이어야 한다');
  const log: JsonValue[] = rawLog.map((e, i) => jsonField(e, `log[${i}]`));
  return { ...base, log };
}

/** 저장 객체를 JSON 값으로 바꾼다 (필드를 하나씩 옮기므로 타입을 강제하지 않는다). */
function toJson(save: SaveFile): JsonValue {
  const out: { [key: string]: JsonValue } = {
    version: save.version,
    contentHash: save.contentHash,
    seed: save.seed,
    rng: Object.fromEntries(Object.entries(save.rng).map(([k, v]) => [k, [...v]])),
    clock: { ...save.clock },
    state: save.state,
    awareness: save.awareness,
    habits: save.habits,
    schedule: save.schedule,
    resources: save.resources,
  };
  if (save.log !== undefined) out['log'] = [...save.log];
  return out;
}

/** 저장 객체를 정규 JSON 텍스트로 만든다. 모양이 틀리면 SaveError. */
export function serializeSave(save: SaveFile): string {
  const checked = checkSave(Object.fromEntries(Object.entries(save)));
  if (checked.version !== SAVE_VERSION) throw new SaveError(`지금 형식은 버전 ${SAVE_VERSION}이다: ${checked.version}`);
  return canonicalJson(toJson(checked));
}

export interface ParsedSave {
  readonly save: SaveFile;
  /** 불러오기는 되지만 알려야 하는 것 (콘텐츠 해시 불일치 등) */
  readonly warnings: string[];
}

/** 텍스트를 읽어 검사한다. 버전이 낮으면 변환을 거치고, 높거나 변환이 없으면 SaveError. */
export function parseSave(text: string, currentContentHash: string): ParsedSave {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SaveError('저장 파일이 JSON이 아니다');
  }
  if (!isObj(raw)) throw new SaveError('저장 파일이 객체가 아니다');
  let cur: Record<string, unknown> = raw;
  let version = cur['version'];
  if (!isInt(version)) throw new SaveError('version이 정수가 아니다');
  if (version > SAVE_VERSION) throw new SaveError(`더 새로운 저장 형식이다 (파일 ${version} > 현재 ${SAVE_VERSION})`);
  while (isInt(version) && version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) throw new SaveError(`버전 ${version}용 마이그레이션이 없다 (현재 ${SAVE_VERSION})`);
    cur = step(cur);
    version = cur['version'];
  }
  const save = checkSave(cur);
  const warnings: string[] = [];
  if (save.contentHash !== currentContentHash) {
    warnings.push(`콘텐츠가 저장 당시와 다르다 (저장 ${save.contentHash.slice(0, 8)} / 현재 ${currentContentHash.slice(0, 8)})`);
  }
  return { save, warnings };
}
