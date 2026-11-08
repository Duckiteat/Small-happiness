// 사건 봉투 (docs/기반층-명세.md 0-4)

import { parseId } from './ids.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GameEvent {
  /** 기록 번호 (L000123). 기록이 부여한다. */
  readonly seq: string;
  /** 절대 게임 시각(분). */
  readonly t: number;
  /** 사건 유형. 사전(event_type)의 키. */
  readonly type: string;
  /** 사건을 낸 시스템. */
  readonly src: string;
  /** 원인 사건의 seq. 없으면 null. */
  readonly cause: string | null;
  readonly data: { readonly [key: string]: JsonValue };
}

export interface NewEvent {
  readonly t: number;
  readonly type: string;
  readonly src: string;
  readonly cause?: string | null;
  readonly data?: { readonly [key: string]: JsonValue };
}

export const RETRACT_TYPE = 'retract';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 값이 JSON으로 안전하게 직렬화되는지 검사한다. 어긋나면 던진다. */
export function assertJsonValue(value: unknown, path = 'data', ancestors: Set<unknown> = new Set()): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: 유한하지 않은 숫자는 저장할 수 없다`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path}: JSON으로 저장할 수 없는 값(${typeof value})`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path}: 순환 참조`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonValue(item, `${path}[${i}]`, ancestors));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`, ancestors);
  } else {
    throw new TypeError(`${path}: 일반 객체가 아니다`);
  }
  ancestors.delete(value);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** 외부(저장 파일 등)에서 온 값을 사건으로 해석한다. 모양이 틀리면 던진다. */
export function parseEvent(raw: unknown): GameEvent {
  if (!isPlainObject(raw)) throw new TypeError('사건이 객체가 아니다');
  const { seq, t, type, src, cause, data } = raw;
  if (typeof seq !== 'string') throw new TypeError('seq가 문자열이 아니다');
  if (typeof t !== 'number') throw new TypeError(`${seq}: t가 숫자가 아니다`);
  if (typeof type !== 'string') throw new TypeError(`${seq}: type이 문자열이 아니다`);
  if (typeof src !== 'string') throw new TypeError(`${seq}: src가 문자열이 아니다`);
  if (cause !== null && typeof cause !== 'string') throw new TypeError(`${seq}: cause가 올바르지 않다`);
  if (!isPlainObject(data)) throw new TypeError(`${seq}: data가 객체가 아니다`);
  assertJsonValue(data, `${seq}.data`);
  return { seq, t, type, src, cause, data: data as GameEvent['data'] };
}

/**
 * 사건 번호들 중 가장 최근(번호가 가장 큰) 것. 없으면 null.
 * "조건을 마지막으로 채운 사건"을 원인으로 적는 약속의 공용 함수다 (결정-기록 "원인 잇기", 영수증-명세 9장).
 */
export function latestSeq(seqs: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestNum = -1;
  for (const s of seqs) {
    if (typeof s !== 'string') continue;
    const parsed = parseId(s);
    if (parsed === null || parsed.kind !== 'log') throw new TypeError(`기록 번호가 아니다: ${s}`);
    if (parsed.num > bestNum) {
      best = s;
      bestNum = parsed.num;
    }
  }
  return best;
}
