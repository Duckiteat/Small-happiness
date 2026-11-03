// 상태 키와 패턴 (docs/기반층-명세.md 0-3)
//
// 상태 키   OBJ000001#1|sole:dirt          인스턴스 | 부위 : 특징   (값은 정수 단계 = 사전 levels 의 위치)
// 패턴      OBJ000001|sole:dirt@>=dirty    정의 | 부위 : 특징 @ 단계 키 조건
//
// 조건은 단계 **키**로 쓴다 (축과-층위 5). 키의 순서는 사전 `levels` 목록이 정하고,
// 번호는 그 위치에서 파생된다. 그래서 단계를 끼워 넣어도 기존 조건의 뜻은 유지된다.
// 규칙의 emits 패턴과 다른 규칙의 on 패턴이 맞으면 사슬이 자동으로 이어진다 (canLink).

import { defOf, parseId } from './ids.ts';

const TOKEN = '[a-z][a-z0-9_]*';
const KEY_RE = new RegExp(`^([^|:@]+)\\|(${TOKEN}):(${TOKEN})$`);
const PATTERN_RE = new RegExp(`^([A-Z]{3}\\d{6})\\|(${TOKEN}):(${TOKEN})(?:@(>=|<=|=|>|<)(${TOKEN}))?$`);

export interface StateKey {
  readonly subject: string; // 인스턴스 번호
  readonly slot: string;
  readonly feature: string;
}

export type CompareOp = '=' | '>=' | '<=' | '>' | '<';

/** 조건의 기준은 단계 키 하나다 (사전 `levels` 의 key). */
export type Cond = { readonly op: CompareOp; readonly level: string } | null;

export interface StatePattern {
  readonly def: string; // 정의 번호
  readonly slot: string;
  readonly feature: string;
  readonly cond: Cond;
}

/** 정의 번호 없이 소유자 안에서만 쓰는 조건 (예: `body:rot@<=wilted`). */
export interface LocalCondition {
  readonly slot: string;
  readonly feature: string;
  readonly cond: Cond;
}

export interface LevelRange {
  readonly min: number;
  readonly max: number; // 상한 없음은 Infinity. min > max 면 빈 범위
}

/** 특징의 단계 키 순서 (사전 `levels`). 없으면 undefined. */
export type LevelOrder = readonly string[] | undefined;

export function formatStateKey(key: StateKey): string {
  return `${key.subject}|${key.slot}:${key.feature}`;
}

export function parseStateKey(s: string): StateKey | null {
  const m = KEY_RE.exec(s);
  if (!m) return null;
  const [, subject, slot, feature] = m;
  if (subject === undefined || slot === undefined || feature === undefined) return null;
  if (defOf(subject) === null) return null; // 주어는 인스턴스 번호여야 한다
  return { subject, slot, feature };
}

export function parsePattern(s: string): StatePattern | null {
  const m = PATTERN_RE.exec(s);
  if (!m) return null;
  const [, def, slot, feature, op, level] = m;
  if (def === undefined || slot === undefined || feature === undefined) return null;
  const parsedDef = parseId(def);
  if (parsedDef === null || parsedDef.kind !== 'def') return null;

  if (op === undefined || level === undefined) return { def, slot, feature, cond: null };
  return { def, slot, feature, cond: { op: op as CompareOp, level } };
}

export function formatPattern(p: StatePattern): string {
  const base = `${p.def}|${p.slot}:${p.feature}`;
  return p.cond === null ? base : `${base}@${p.cond.op}${p.cond.level}`;
}

const LOCAL_RE = new RegExp(`^(${TOKEN}):(${TOKEN})(?:@(>=|<=|=|>|<)(${TOKEN}))?$`);

export function parseLocalCondition(s: string): LocalCondition | null {
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [, slot, feature, op, level] = m;
  if (slot === undefined || feature === undefined) return null;
  if (op === undefined || level === undefined) return { slot, feature, cond: null };
  return { slot, feature, cond: { op: op as CompareOp, level } };
}

export function formatLocalCondition(c: LocalCondition): string {
  const base = `${c.slot}:${c.feature}`;
  return c.cond === null ? base : `${base}@${c.cond.op}${c.cond.level}`;
}

/**
 * 조건을 단계 범위로 바꾼다. 순서에 없는 키이거나 순서 자체가 없으면 null (관문이 거부한다).
 * 조건 없음은 0 .. 무한대.
 */
export function condRange(cond: Cond, order: LevelOrder): LevelRange | null {
  if (cond === null) return { min: 0, max: Infinity };
  if (order === undefined) return null;
  const at = order.indexOf(cond.level);
  if (at < 0) return null;
  switch (cond.op) {
    case '=':
      return { min: at, max: at };
    case '>=':
      return { min: at, max: Infinity };
    case '>':
      return { min: at + 1, max: Infinity };
    case '<=':
      return { min: 0, max: at };
    case '<':
      return { min: 0, max: at - 1 };
  }
}

export function patternRange(p: StatePattern, order: LevelOrder): LevelRange | null {
  return condRange(p.cond, order);
}

function sameTarget(a: StatePattern, b: StatePattern): boolean {
  return a.def === b.def && a.slot === b.slot && a.feature === b.feature;
}

function rangesOverlap(a: LevelRange, b: LevelRange): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/** 이 상태(키, 단계 번호)가 패턴에 해당하는가. */
export function matchesPattern(p: StatePattern, key: StateKey, level: number, order: LevelOrder): boolean {
  if (!Number.isInteger(level) || level < 0) return false;
  if (defOf(key.subject) !== p.def) return false;
  if (key.slot !== p.slot || key.feature !== p.feature) return false;
  const r = patternRange(p, order);
  return r !== null && level >= r.min && level <= r.max;
}

/**
 * emits 패턴이 만드는 상태가 on 패턴의 조건을 만족시킬 수 있는가.
 * 같은 정의·부위·특징이고 단계 범위가 겹치면 사슬이 이어진다. order 는 그 특징의 단계 순서.
 */
export function canLink(emits: StatePattern, on: StatePattern, order: LevelOrder): boolean {
  if (!sameTarget(emits, on)) return false;
  const a = patternRange(emits, order);
  const b = patternRange(on, order);
  return a !== null && b !== null && rangesOverlap(a, b);
}
