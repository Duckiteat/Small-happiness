// 세계 실행기: 라인 A 의 층 3 인과 (docs/축-구현-순서.md 층 3 · docs/품질판-명세.md 11장)
//
// 순수 모듈이다: 파일·시각·난수를 쓰지 않는다. 고정 틱이 없는 사건 예약 방식이다.
//   - 규칙의 on 조건이 모두 참이 되면 그 규칙을 예약한다 (due = 그때 + delay_s).
//   - 예약된 시각까지 조건이 이어지면 emits 를 적용한다. 그 전에 조건이 깨지면 예약을 취소한다.
//   - 한 번 일어난 규칙은 조건이 거짓이 되었다가 다시 참이 될 때까지 다시 일어나지 않는다.
// 시간을 한 번에 넘기든 나눠 넘기든 결과가 같다 (부재 보정의 근거).
// 지금은 정의 하나에 인스턴스 하나(#1)만 두고, 종결 단계는 다루지 않는다.

import { collectRules } from './chains.ts';
import type { Db, Issue } from './db.ts';
import type { JsonValue, NewEvent } from './events.ts';
import { condRange, formatPattern, parsePattern } from './statekey.ts';
import type { StatePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';

/** 같은 시각에 규칙이 서로를 끝없이 뒤집는 것을 막는 한도 */
const SETTLE_LIMIT = 1000;

export interface WorldRule {
  readonly ref: string;
  readonly delayS: number;
  readonly on: readonly StatePattern[];
  readonly emits: readonly StatePattern[];
}

export interface WorldSpec {
  readonly rules: readonly WorldRule[];
  /** 상태 키(`정의#1|부위:특징`) → 그 특징의 단계 키 순서 */
  readonly orders: Readonly<Record<string, readonly string[]>>;
  /** 상태 키 → 잠긴 단계의 위치 */
  readonly locked: Readonly<Record<string, readonly number[]>>;
}

export interface Reservation {
  readonly since: number;
  readonly due: number;
  readonly fired: boolean;
}

/** 실행 상태. JSON 으로 그대로 저장할 수 있다. 시각 단위는 초. */
export interface WorldState {
  readonly t: number;
  readonly levels: Readonly<Record<string, number>>;
  readonly reservations: Readonly<Record<string, Reservation>>;
}

export interface WorldBuild {
  readonly spec: WorldSpec;
  readonly state: WorldState;
  readonly issues: Issue[];
}

const keyOf = (p: StatePattern): string => `${p.def}#1|${p.slot}:${p.feature}`;

/** 정의 저장소에서 실행 명세와 처음 상태(모든 특징이 0단계)를 만든다. */
export function buildWorld(db: Db, vocab: Vocab): WorldBuild {
  const issues: Issue[] = [];
  const orders: Record<string, readonly string[]> = {};
  const locked: Record<string, readonly number[]> = {};
  const levels: Record<string, number> = {};
  for (const id of Object.keys(db.defs).sort()) {
    const def = db.defs[id];
    for (const [slot, s] of Object.entries(def?.slots ?? {})) {
      for (const feature of s.features) {
        const order = vocab.levelOrder(feature);
        if (order === undefined) continue; // 관문이 이미 거부한다
        const key = `${id}#1|${slot}:${feature}`;
        orders[key] = order;
        locked[key] = order.map((k, i) => (vocab.isLocked(feature, k) ? i : -1)).filter((i) => i >= 0);
        levels[key] = 0;
      }
    }
  }

  const rules: WorldRule[] = [];
  for (const node of collectRules(db)) {
    let ok = true;
    for (const p of node.emits) {
      const at = `${node.ref}.emits`;
      if (p.cond === null) {
        issues.push({ level: 'error', where: at, msg: `emits에 단계 조건이 없어 무엇을 만들지 알 수 없다: ${formatPattern(p)}` });
        ok = false;
      }
    }
    for (const p of [...node.on, ...node.emits]) {
      if (p.cond !== null && vocab.has('terminal', p.cond.level)) {
        issues.push({ level: 'error', where: node.ref, msg: `종결 단계는 아직 실행기가 다루지 않는다: ${formatPattern(p)}` });
        ok = false;
      } else if (orders[keyOf(p)] === undefined) {
        issues.push({ level: 'error', where: node.ref, msg: `실행할 상태가 없다: ${formatPattern(p)}` });
        ok = false;
      }
    }
    if (ok) rules.push({ ref: node.ref, delayS: node.rule.delay_s ?? 0, on: node.on, emits: node.emits });
  }
  return { spec: { rules, orders, locked }, state: { t: 0, levels, reservations: {} }, issues };
}

function holds(p: StatePattern, spec: WorldSpec, levels: Readonly<Record<string, number>>): boolean {
  const key = keyOf(p);
  const r = condRange(p.cond, spec.orders[key]);
  const level = levels[key];
  return r !== null && level !== undefined && level >= r.min && level <= r.max;
}

/** 패턴이 요구하는 범위로 단계를 옮긴 값. 범위 안이면 그대로. 잠긴 칸에 닿으면 가던 방향으로 한 칸 더 간다. */
function moved(p: StatePattern, spec: WorldSpec, cur: number): number {
  const key = keyOf(p);
  const order = spec.orders[key];
  const r = condRange(p.cond, order);
  if (r === null || order === undefined) return cur;
  const last = order.length - 1;
  const lockedAt = spec.locked[key] ?? [];
  if (cur < r.min) {
    let to = Math.min(r.min, last);
    while (lockedAt.includes(to) && to < last) to += 1;
    return lockedAt.includes(to) ? cur : to;
  }
  if (cur > r.max) {
    let to = Math.max(r.max, 0);
    while (lockedAt.includes(to) && to > 0) to -= 1;
    return lockedAt.includes(to) ? cur : to;
  }
  return cur;
}

interface Run {
  t: number;
  levels: Record<string, number>;
  reservations: Record<string, Reservation>;
  events: NewEvent[];
}

function emit(run: Run, type: string, data: { [key: string]: JsonValue }): void {
  // 사건의 t 는 분(기반층 사건 봉투). 초 단위 시각은 data.t_s 에 함께 둔다
  run.events.push({ t: Math.floor(run.t / 60), type, src: 'world', data: { t_s: run.t, ...data } });
}

function change(run: Run, spec: WorldSpec, p: StatePattern, cause: string): boolean {
  const key = keyOf(p);
  const cur = run.levels[key];
  if (cur === undefined) return false;
  const to = moved(p, spec, cur);
  if (to === cur) return false;
  run.levels[key] = to;
  const order = spec.orders[key] ?? [];
  emit(run, 'stage_advanced', { key, from: order[cur] ?? String(cur), to: order[to] ?? String(to), cause });
  return true;
}

/** 지금 시각에서 더 일어날 것이 없을 때까지: 예약·취소를 갱신하고, 때가 된 규칙을 일으킨다. */
function settle(run: Run, spec: WorldSpec): void {
  for (let round = 0; ; round++) {
    if (round >= SETTLE_LIMIT) throw new RangeError(`같은 시각(${run.t}초)에 규칙이 끝없이 이어진다 (지연 없는 순환)`);
    for (const rule of spec.rules) {
      const on = rule.on.every((p) => holds(p, spec, run.levels));
      const res = run.reservations[rule.ref];
      if (on && res === undefined) {
        run.reservations[rule.ref] = { since: run.t, due: run.t + rule.delayS, fired: false };
        if (rule.delayS > 0) emit(run, 'delayed_effect', { rule: rule.ref, phase: 'reserved', due_s: run.t + rule.delayS });
      } else if (!on && res !== undefined) {
        delete run.reservations[rule.ref];
        if (!res.fired) emit(run, 'delayed_effect', { rule: rule.ref, phase: 'cancelled', due_s: res.due });
      }
    }
    // 때가 된 것 가운데 가장 먼저 예약된 하나만 일으키고 다시 본다 (일어난 일이 다른 예약을 취소할 수 있다)
    const ready = spec.rules
      .map((rule) => ({ rule, res: run.reservations[rule.ref] }))
      .filter((x): x is { rule: WorldRule; res: Reservation } => x.res !== undefined && !x.res.fired && x.res.due <= run.t)
      .sort((a, b) => a.res.due - b.res.due || a.res.since - b.res.since || (a.rule.ref < b.rule.ref ? -1 : 1))[0];
    if (ready === undefined) return;
    run.reservations[ready.rule.ref] = { ...ready.res, fired: true };
    for (const p of ready.rule.emits) change(run, spec, p, ready.rule.ref);
  }
}

function open(state: WorldState): Run {
  return { t: state.t, levels: { ...state.levels }, reservations: { ...state.reservations }, events: [] };
}

function close(run: Run): { state: WorldState; events: NewEvent[] } {
  return { state: { t: run.t, levels: run.levels, reservations: run.reservations }, events: run.events };
}

/** 다음에 일어날 예약의 시각. 없으면 null. */
export function nextDue(state: WorldState): number | null {
  const dues = Object.values(state.reservations).filter((r) => !r.fired).map((r) => r.due);
  return dues.length === 0 ? null : Math.min(...dues);
}

/** 시각을 toT(초)까지 넘긴다. 그 사이의 예약을 시각 순서대로 처리한다. */
export function advance(state: WorldState, spec: WorldSpec, toT: number): { state: WorldState; events: NewEvent[] } {
  if (!Number.isInteger(toT) || toT < state.t) throw new RangeError('시각은 정수 초이고 거꾸로 갈 수 없다');
  const run = open(state);
  settle(run, spec);
  for (;;) {
    const due = nextDue({ t: run.t, levels: run.levels, reservations: run.reservations });
    if (due === null || due > toT) break;
    run.t = Math.max(run.t, due);
    settle(run, spec);
  }
  run.t = toT;
  return close(run);
}

/**
 * 바깥에서 오는 효과 요청(행동, 장면 설정)을 지금 시각에 적용한다. 패턴은 `정의|부위:특징@조건` 이고,
 * 결과 단계는 실행기가 정한다 (조건의 범위로 옮김). 이어지는 규칙의 예약·취소까지 처리한다.
 */
export function applyEffect(
  state: WorldState,
  spec: WorldSpec,
  patternText: string,
  cause: string,
): { state: WorldState; events: NewEvent[] } {
  const p = parsePattern(patternText);
  if (p === null || p.cond === null) throw new TypeError(`효과 패턴 형식이 아니다: ${patternText}`);
  if (spec.orders[keyOf(p)] === undefined) throw new RangeError(`없는 상태를 가리킨다: ${patternText}`);
  if (condRange(p.cond, spec.orders[keyOf(p)]) === null) throw new RangeError(`없는 단계 키다: ${patternText}`);
  const run = open(state);
  change(run, spec, p, cause);
  settle(run, spec);
  return close(run);
}

/** 상태를 단계 키로 읽는다 (보기용). */
export function readLevels(state: WorldState, spec: WorldSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(state.levels).sort()) {
    const level = state.levels[key];
    out[key] = level === undefined ? '' : (spec.orders[key]?.[level] ?? String(level));
  }
  return out;
}
