// 기록 (docs/기반층-명세.md 1)
//
// 추가만 되는 사건 로그. 수정·삭제 함수는 없다. 잘못된 사건은 retract 사건으로 철회 표시한다.
// 불변식: seq는 1부터 빈틈 없이 증가 · 시각은 거꾸로 가지 않음 · cause는 이미 있는 사건 ·
//        data는 JSON으로 저장 가능 · 사건 유형은 사전에 있는 말 (옵션).

import { assertJsonValue, deepFreeze, parseEvent, RETRACT_TYPE } from './events.ts';
import type { GameEvent, NewEvent } from './events.ts';
import { formatLogId, parseId } from './ids.ts';

export interface LogOptions {
  /** 사건 유형이 사전에 있는지 확인한다. retract는 항상 허용된다. */
  readonly isKnownType?: (type: string) => boolean;
}

export interface ListOptions {
  readonly type?: string;
  /** 포함하는 시작 seq */
  readonly fromSeq?: string;
  /** 포함하는 끝 seq */
  readonly toSeq?: string;
  readonly where?: (event: GameEvent) => boolean;
}

function seqNum(seq: string): number {
  const parsed = parseId(seq);
  if (parsed === null || parsed.kind !== 'log') throw new TypeError(`기록 번호가 아니다: ${seq}`);
  return parsed.num;
}

export class EventLog {
  readonly #events: GameEvent[] = [];
  readonly #bySeq = new Map<string, GameEvent>();
  readonly #retractedBy = new Map<string, string>(); // 철회된 seq → 철회 사건 seq
  readonly #isKnownType: ((type: string) => boolean) | undefined;

  constructor(options: LogOptions = {}) {
    this.#isKnownType = options.isKnownType;
  }

  get size(): number {
    return this.#events.length;
  }

  get lastSeq(): string | null {
    return this.#events.at(-1)?.seq ?? null;
  }

  /** 사건을 추가하고 seq가 붙은 불변 사건을 돌려준다. */
  append(event: NewEvent): GameEvent {
    return this.#commit({
      seq: formatLogId(this.#events.length + 1),
      t: event.t,
      type: event.type,
      src: event.src,
      cause: event.cause ?? null,
      data: event.data ?? {},
    });
  }

  /** 사건을 지우지 않고 철회 표시를 남긴다. */
  retract(target: string, reason: string, meta: { t: number; src: string; cause?: string | null }): GameEvent {
    return this.append({
      t: meta.t,
      type: RETRACT_TYPE,
      src: meta.src,
      cause: meta.cause ?? target,
      data: { target, reason },
    });
  }

  get(seq: string): GameEvent | undefined {
    return this.#bySeq.get(seq);
  }

  isRetracted(seq: string): boolean {
    return this.#retractedBy.has(seq);
  }

  /** 원본 로그를 조건으로 조회한다 (철회된 사건과 철회 사건 포함). */
  list(options: ListOptions = {}): GameEvent[] {
    const from = options.fromSeq === undefined ? 1 : seqNum(options.fromSeq);
    const to = options.toSeq === undefined ? Infinity : seqNum(options.toSeq);
    return this.#events.filter(
      (e) =>
        (options.type === undefined || e.type === options.type) &&
        seqNum(e.seq) >= from &&
        seqNum(e.seq) <= to &&
        (options.where === undefined || options.where(e)),
    );
  }

  /** 철회된 사건과 철회 사건 자체를 뺀 유효한 사건들. */
  effective(): GameEvent[] {
    return this.#events.filter((e) => e.type !== RETRACT_TYPE && !this.#retractedBy.has(e.seq));
  }

  /** 사건에서 시작해 cause를 거슬러 올라간 사슬. 자기 자신이 첫 원소. */
  chain(seq: string): GameEvent[] {
    const result: GameEvent[] = [];
    let current = this.#bySeq.get(seq);
    while (current !== undefined) {
      result.push(current);
      current = current.cause === null ? undefined : this.#bySeq.get(current.cause);
    }
    return result;
  }

  toJSON(): GameEvent[] {
    return [...this.#events];
  }

  /** 저장된 사건 목록에서 복원한다. 불변식을 처음부터 다시 검사한다. */
  static fromJSON(raw: readonly unknown[], options: LogOptions = {}): EventLog {
    const log = new EventLog(options);
    for (const item of raw) log.#commit(parseEvent(item));
    return log;
  }

  #commit(input: GameEvent): GameEvent {
    const expected = formatLogId(this.#events.length + 1);
    if (input.seq !== expected) {
      throw new Error(`seq 순서 오류: 기대 ${expected}, 실제 ${input.seq}`);
    }
    if (!Number.isInteger(input.t) || input.t < 0) {
      throw new RangeError(`${input.seq}: t는 0 이상의 정수(분)여야 한다: ${input.t}`);
    }
    const last = this.#events.at(-1);
    if (last !== undefined && input.t < last.t) {
      throw new RangeError(`${input.seq}: 시각이 거꾸로 간다 (${last.t} → ${input.t})`);
    }
    if (input.type === '' || input.src === '') {
      throw new TypeError(`${input.seq}: type과 src는 비어 있을 수 없다`);
    }
    if (input.type !== RETRACT_TYPE && this.#isKnownType !== undefined && !this.#isKnownType(input.type)) {
      throw new Error(`${input.seq}: 사전에 없는 사건 유형: ${input.type}`);
    }
    assertJsonValue(input.data, `${input.seq}.data`);

    // 철회 검사를 원인 검사보다 먼저 한다: 철회의 기본 원인은 대상 자신이라,
    // 순서가 반대면 "대상이 없다"가 "원인이 없다"로 보고된다.
    let retractTarget: string | null = null;
    if (input.type === RETRACT_TYPE) {
      const { target, reason } = input.data;
      if (typeof target !== 'string' || typeof reason !== 'string') {
        throw new TypeError(`${input.seq}: 철회 사건은 data.target과 data.reason(문자열)이 필요하다`);
      }
      const targetEvent = this.#bySeq.get(target);
      if (targetEvent === undefined) throw new Error(`${input.seq}: 철회 대상이 없다: ${target}`);
      if (targetEvent.type === RETRACT_TYPE) throw new Error(`${input.seq}: 철회 사건은 철회할 수 없다`);
      if (this.#retractedBy.has(target)) throw new Error(`${input.seq}: 이미 철회된 사건이다: ${target}`);
      retractTarget = target;
    }

    if (input.cause !== null && !this.#bySeq.has(input.cause)) {
      throw new Error(`${input.seq}: 존재하지 않는 원인 사건: ${input.cause}`);
    }

    const event = deepFreeze(structuredClone(input));
    this.#events.push(event);
    this.#bySeq.set(event.seq, event);
    if (retractTarget !== null) this.#retractedBy.set(retractTarget, event.seq);
    return event;
  }
}
