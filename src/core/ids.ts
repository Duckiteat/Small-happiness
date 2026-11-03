// 번호 체계 (docs/기반층-명세.md 0-1)
//
// 정의 번호  OBJ000001        접두 + 6자리. 의미 없는 고정 번호
// 인스턴스   OBJ000001#1      정의 번호 + 순번. 순번은 단조 증가
// 기록 번호  L000001          기록이 부여
// 임시 번호  OBJ+1            패치 안에서만 쓰고 병합 때 실제 번호로 바뀐다
//
// 이름·문장은 번호에 붙은 꼬리표다. 지운 번호는 다시 쓰지 않는다
// (카운터가 단조 증가하므로 구조적으로 보장된다).

export const DEF_PREFIXES = [
  'OBJ', // 오브젝트 정의
  'PLC', // 장소
  'RUL', // 변화 규칙
  'ACT', // 행동
  'EVT', // 이벤트 정의
  'ITM', // 물품·자원 종류
  'AWR', // 인지 노드
  'FRG', // 문장 조각
  'CHR', // 인물
  'HAB', // 습관 정의
  'CMT', // 약속 정의
] as const;

export type DefPrefix = (typeof DEF_PREFIXES)[number];

const PREFIX_SET: ReadonlySet<string> = new Set(DEF_PREFIXES);

export function isDefPrefix(s: string): s is DefPrefix {
  return PREFIX_SET.has(s);
}

export type ParsedId =
  | { readonly kind: 'def'; readonly prefix: DefPrefix; readonly num: number }
  | { readonly kind: 'instance'; readonly prefix: DefPrefix; readonly num: number; readonly serial: number }
  | { readonly kind: 'log'; readonly num: number }
  | { readonly kind: 'temp'; readonly prefix: DefPrefix; readonly offset: number };

export const MAX_DEF_NUM = 999_999;

const DEF_RE = /^([A-Z]{3})(\d{6})$/;
const INSTANCE_RE = /^([A-Z]{3})(\d{6})#([1-9]\d*)$/;
const LOG_RE = /^L(\d{6,})$/;
const TEMP_RE = /^([A-Z]{3})\+([1-9]\d*)$/;

export function formatDefId(prefix: DefPrefix, num: number): string {
  if (!Number.isInteger(num) || num < 1 || num > MAX_DEF_NUM) {
    throw new RangeError(`정의 번호는 1..${MAX_DEF_NUM} 정수여야 한다: ${num}`);
  }
  return `${prefix}${String(num).padStart(6, '0')}`;
}

export function formatInstanceId(defId: string, serial: number): string {
  const parsed = parseId(defId);
  if (parsed === null || parsed.kind !== 'def') {
    throw new TypeError(`정의 번호가 아니다: ${defId}`);
  }
  if (!Number.isInteger(serial) || serial < 1) {
    throw new RangeError(`인스턴스 순번은 1 이상의 정수여야 한다: ${serial}`);
  }
  return `${defId}#${serial}`;
}

export function formatLogId(num: number): string {
  if (!Number.isInteger(num) || num < 1) {
    throw new RangeError(`기록 번호는 1 이상의 정수여야 한다: ${num}`);
  }
  return `L${String(num).padStart(6, '0')}`;
}

/** 형식이 맞지 않으면 null. 예외를 던지지 않는다. */
export function parseId(s: string): ParsedId | null {
  const inst = INSTANCE_RE.exec(s);
  if (inst) {
    const prefix = inst[1];
    const num = Number(inst[2]);
    const serial = Number(inst[3]);
    if (prefix !== undefined && isDefPrefix(prefix) && num >= 1) {
      return { kind: 'instance', prefix, num, serial };
    }
    return null;
  }

  const def = DEF_RE.exec(s);
  if (def) {
    const prefix = def[1];
    const num = Number(def[2]);
    if (prefix !== undefined && isDefPrefix(prefix) && num >= 1) {
      return { kind: 'def', prefix, num };
    }
    return null;
  }

  const log = LOG_RE.exec(s);
  if (log) {
    const num = Number(log[1]);
    return num >= 1 ? { kind: 'log', num } : null;
  }

  const temp = TEMP_RE.exec(s);
  if (temp) {
    const prefix = temp[1];
    if (prefix !== undefined && isDefPrefix(prefix)) {
      return { kind: 'temp', prefix, offset: Number(temp[2]) };
    }
    return null;
  }

  return null;
}

/** 인스턴스 번호에서 정의 번호를 꺼낸다. 인스턴스가 아니면 null. */
export function defOf(instanceId: string): string | null {
  const parsed = parseId(instanceId);
  if (parsed === null || parsed.kind !== 'instance') return null;
  return formatDefId(parsed.prefix, parsed.num);
}

export interface AllocatorState {
  readonly defs: Readonly<Record<string, number>>;
  readonly instances: Readonly<Record<string, number>>;
}

/**
 * 번호 발급기. 카운터는 단조 증가하며 되돌아가지 않으므로 번호가 재사용되지 않는다.
 * 저장·복원용 snapshot()/생성자 인자를 제공한다.
 */
export class IdAllocator {
  readonly #defs = new Map<DefPrefix, number>();
  readonly #instances = new Map<string, number>();

  constructor(state?: AllocatorState) {
    if (state === undefined) return;
    for (const [prefix, n] of Object.entries(state.defs)) {
      if (!isDefPrefix(prefix) || !Number.isInteger(n) || n < 0 || n > MAX_DEF_NUM) {
        throw new Error(`발급기 상태가 올바르지 않다 (정의 ${prefix}: ${n})`);
      }
      this.#defs.set(prefix, n);
    }
    for (const [defId, n] of Object.entries(state.instances)) {
      const parsed = parseId(defId);
      if (parsed === null || parsed.kind !== 'def' || !Number.isInteger(n) || n < 0) {
        throw new Error(`발급기 상태가 올바르지 않다 (인스턴스 ${defId}: ${n})`);
      }
      this.#instances.set(defId, n);
    }
  }

  nextDef(prefix: DefPrefix): string {
    const next = (this.#defs.get(prefix) ?? 0) + 1;
    const id = formatDefId(prefix, next); // 범위 초과면 여기서 던진다
    this.#defs.set(prefix, next);
    return id;
  }

  nextInstance(defId: string): string {
    const next = (this.#instances.get(defId) ?? 0) + 1;
    const id = formatInstanceId(defId, next); // defId 검증 포함
    this.#instances.set(defId, next);
    return id;
  }

  snapshot(): AllocatorState {
    const defs: Record<string, number> = {};
    for (const key of [...this.#defs.keys()].sort()) defs[key] = this.#defs.get(key) ?? 0;
    const instances: Record<string, number> = {};
    for (const key of [...this.#instances.keys()].sort()) instances[key] = this.#instances.get(key) ?? 0;
    return { defs, instances };
  }
}
