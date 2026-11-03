// 상태 키와 패턴 (docs/기반층-명세.md 0-3)
//
// 상태 키   OBJ000001#1|sole:dirt          인스턴스 | 부위 : 특징   (값은 정수 단계)
// 패턴      OBJ000001|sole:dirt@>=2         정의 | 부위 : 특징 @ 단계 조건
//
// 규칙의 emits 패턴과 다른 규칙의 on 패턴이 맞으면 사슬이 자동으로 이어진다 (canLink).

import { defOf, parseId } from './ids.ts';

const TOKEN = '[a-z][a-z0-9_]*';
const KEY_RE = new RegExp(`^([^|:@]+)\\|(${TOKEN}):(${TOKEN})$`);
const PATTERN_RE = new RegExp(`^([A-Z]{3}\\d{6})\\|(${TOKEN}):(${TOKEN})(?:@(>=|<=|=|>|<)(\\d+))?$`);

export interface StateKey {
  readonly subject: string; // 인스턴스 번호
  readonly slot: string;
  readonly feature: string;
}

export type CompareOp = '=' | '>=' | '<=' | '>' | '<';

export type Cond = { readonly op: CompareOp; readonly n: number } | null;

export interface StatePattern {
  readonly def: string; // 정의 번호
  readonly slot: string;
  readonly feature: string;
  readonly cond: Cond;
}

/** 정의 번호 없이 소유자 안에서만 쓰는 조건 (예: `body:rot@<=1`). */
export interface LocalCondition {
  readonly slot: string;
  readonly feature: string;
  readonly cond: Cond;
}

export interface LevelRange {
  readonly min: number;
  readonly max: number; // 상한 없음은 Infinity
}

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
  const [, def, slot, feature, op, n] = m;
  if (def === undefined || slot === undefined || feature === undefined) return null;
  const parsedDef = parseId(def);
  if (parsedDef === null || parsedDef.kind !== 'def') return null;

  if (op === undefined || n === undefined) return { def, slot, feature, cond: null };

  const level = Number(n);
  if (op === '<' && level === 0) return null; // 빈 범위
  return { def, slot, feature, cond: { op: op as CompareOp, n: level } };
}

export function formatPattern(p: StatePattern): string {
  const base = `${p.def}|${p.slot}:${p.feature}`;
  return p.cond === null ? base : `${base}@${p.cond.op}${p.cond.n}`;
}

const LOCAL_RE = new RegExp(`^(${TOKEN}):(${TOKEN})(?:@(>=|<=|=|>|<)(\\d+))?$`);

export function parseLocalCondition(s: string): LocalCondition | null {
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [, slot, feature, op, n] = m;
  if (slot === undefined || feature === undefined) return null;
  if (op === undefined || n === undefined) return { slot, feature, cond: null };
  const level = Number(n);
  if (op === '<' && level === 0) return null;
  return { slot, feature, cond: { op: op as CompareOp, n: level } };
}

export function formatLocalCondition(c: LocalCondition): string {
  const base = `${c.slot}:${c.feature}`;
  return c.cond === null ? base : `${base}@${c.cond.op}${c.cond.n}`;
}

export function patternRange(p: StatePattern): LevelRange {
  return condRange(p.cond);
}

export function condRange(cond: Cond): LevelRange {
  if (cond === null) return { min: 0, max: Infinity };
  const { op, n } = cond;
  switch (op) {
    case '=':
      return { min: n, max: n };
    case '>=':
      return { min: n, max: Infinity };
    case '>':
      return { min: n + 1, max: Infinity };
    case '<=':
      return { min: 0, max: n };
    case '<':
      return { min: 0, max: n - 1 };
  }
}

function sameTarget(a: StatePattern, b: StatePattern): boolean {
  return a.def === b.def && a.slot === b.slot && a.feature === b.feature;
}

function rangesOverlap(a: LevelRange, b: LevelRange): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/** 이 상태(키, 단계)가 패턴에 해당하는가. */
export function matchesPattern(p: StatePattern, key: StateKey, level: number): boolean {
  if (!Number.isInteger(level) || level < 0) return false;
  if (defOf(key.subject) !== p.def) return false;
  if (key.slot !== p.slot || key.feature !== p.feature) return false;
  const r = patternRange(p);
  return level >= r.min && level <= r.max;
}

/**
 * emits 패턴이 만드는 상태가 on 패턴의 조건을 만족시킬 수 있는가.
 * 같은 정의·부위·특징이고 단계 범위가 겹치면 사슬이 이어진다.
 */
export function canLink(emits: StatePattern, on: StatePattern): boolean {
  return sameTarget(emits, on) && rangesOverlap(patternRange(emits), patternRange(on));
}
