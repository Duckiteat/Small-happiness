// 관문 (docs/DB-개념-이식.md 1-7 · 사법: 검사와 판정만 한다. 데이터를 고치거나 파일을 쓰지 않는다)
//
// 병합 결과가 규칙을 어기면 패치 전체를 거부한다. 새 오류가 없어도 새 경고가 생기면 거부하고,
// 경고는 allowWarnings로만 통과시킬 수 있다 (사용자 허락이 있을 때).

import { DEF_PREFIXES, parseId } from './ids.ts';
import { PREFIX_KIND } from './db.ts';
import type { Db, Definition, Issue } from './db.ts';
import { collectRules, selfLoops } from './chains.ts';
import { condRange, parseLocalCondition, parsePattern } from './statekey.ts';
import type { Cond } from './statekey.ts';
import { normalizeWord } from './vocab.ts';
import type { Vocab } from './vocab.ts';

const key = (i: Issue): string => `${i.level}|${i.where}|${i.msg}`;

function levelCount(vocab: Vocab, feature: string): number | null {
  const levels = vocab.entry('feature', feature)?.attrs['levels'];
  return Array.isArray(levels) ? levels.length : null;
}

/** 조건이 이 특징의 단계 범위(0..L-1)와 겹치는가. */
function fitsLevels(cond: Cond, levels: number): boolean {
  const r = condRange(cond);
  return r.min <= levels - 1 && r.max >= 0 && r.min <= r.max;
}

function slotCheck(
  def: Definition | undefined,
  slot: string,
  feature: string,
  cond: Cond,
  vocab: Vocab,
  where: string,
  push: (where: string, msg: string) => void,
): void {
  if (def === undefined) return;
  const s = def.slots?.[slot];
  if (s === undefined) return void push(where, `${def.id}에 부위 "${slot}"가 없다`);
  if (!s.features.includes(feature)) return void push(where, `부위 ${def.id}.${slot}에 특징 "${feature}"가 없다`);
  const L = levelCount(vocab, feature);
  if (L !== null && !fitsLevels(cond, L)) {
    push(where, `조건이 "${feature}"의 단계 범위(0~${L - 1})를 벗어난다`);
  }
}

/** 저장소 하나가 규칙을 지키는지 검사한다 (이전 상태와의 비교는 runGate). */
export function checkDb(db: Db, vocab: Vocab): Issue[] {
  const issues: Issue[] = [];
  const error = (where: string, msg: string): void => void issues.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string): void => void issues.push({ level: 'warning', where, msg });

  // 번호 카운터는 쓰인 번호보다 커야 한다
  for (const [id, def] of Object.entries(db.defs)) {
    const parsed = parseId(id);
    if (parsed === null || parsed.kind !== 'def') continue;
    const next = db.meta.next[parsed.prefix] ?? 1;
    if (parsed.num >= next) error(id, `번호 카운터(${parsed.prefix}=${next})가 쓰인 번호보다 크지 않다`);
    if (def.id !== id) error(id, 'id 필드가 키와 다르다');
  }

  // 이름 하나 = 개념 하나: 같은 종류 안의 충돌은 오류, 종류 사이 충돌은 경고
  const owners = new Map<string, string[]>();
  for (const [id, def] of Object.entries(db.defs)) {
    for (const w of [def.names.ko, def.names.en, ...def.aliases]) {
      if (w === undefined) continue;
      const nk = normalizeWord(w);
      const list = owners.get(nk) ?? [];
      if (!list.includes(id)) list.push(id);
      owners.set(nk, list);
    }
  }
  for (const [word, ids] of owners) {
    if (ids.length < 2) continue;
    const kinds = new Set(ids.map((i) => PREFIX_KIND[(parseId(i) as { prefix: keyof typeof PREFIX_KIND }).prefix]));
    const msg = `"${word}"가 여러 정의의 이름·별칭이다: ${ids.sort().join(', ')}`;
    if (kinds.size < ids.length) error('names', msg);
    else warn('names', `${msg} (종류가 달라 번호로만 가리킬 수 있다)`);
  }

  for (const [id, def] of Object.entries(db.defs)) {
    const parsed = parseId(id);
    if (parsed === null || parsed.kind !== 'def') continue;

    if (parsed.prefix === 'OBJ') {
      if (def.mobility === undefined) warn(id, 'mobility(고정/이동형)가 없다');
      else if (!vocab.has('mobility', def.mobility)) error(`${id}.mobility`, `사전에 없는 값: ${def.mobility}`);
    }

    for (const [slotKey, slot] of Object.entries(def.slots ?? {})) {
      for (const f of slot.features) {
        if (!vocab.has('feature', f)) error(`${id}.slots.${slotKey}`, `사전에 없는 특징: ${f}`);
      }
    }

    // 상태 의미: 위에서부터 첫 일치. 기본값(빈 when)이 없으면 경고, 기본값 뒤의 의미는 닿지 않는다
    const meanings = def.meanings ?? [];
    meanings.forEach((m, i) => {
      const at = `${id}.meanings[${i}]`;
      for (const w of m.when) {
        const c = parseLocalCondition(w);
        if (c === null) error(at, `조건 형식이 아니다: ${w}`);
        else slotCheck(def, c.slot, c.feature, c.cond, vocab, at, error);
      }
    });
    if (meanings.length > 0) {
      const firstDefault = meanings.findIndex((m) => m.when.length === 0);
      if (firstDefault < 0) warn(`${id}.meanings`, '기본값(when이 빈 의미)이 없다');
      else if (firstDefault < meanings.length - 1) warn(`${id}.meanings`, '기본값 뒤의 의미는 닿지 않는다');
    }
  }

  // 규칙 패턴: 형식, 대상 정의 존재, 부위·특징·단계 범위
  for (const [id, def] of Object.entries(db.defs)) {
    for (const [ruleKey, rule] of Object.entries(def.rules ?? {})) {
      for (const side of ['on', 'emits'] as const) {
        rule[side].forEach((text, i) => {
          const at = `${id}.rules.${ruleKey}.${side}[${i}]`;
          const p = parsePattern(text);
          if (p === null) return void error(at, `패턴 형식이 아니다: ${text}`);
          const target = db.defs[p.def];
          if (target === undefined) return void error(at, `없는 정의를 가리킨다: ${p.def}`);
          slotCheck(target, p.slot, p.feature, p.cond, vocab, at, error);
        });
      }
    }
  }

  for (const ref of selfLoops(collectRules(db))) {
    warn(ref, '자기가 만든 상태가 자기 조건을 다시 만족시킨다 (자기 순환)');
  }

  return issues;
}

export interface GateResult {
  readonly pass: boolean;
  readonly errors: Issue[];
  readonly warnings: Issue[];
  readonly newErrors: Issue[];
  readonly newWarnings: Issue[];
  readonly mergeErrors: Issue[];
  readonly reason: string;
}

/**
 * 병합 전후를 비교해 판정한다. 병합 오류나 새 오류가 있으면 거부, 새 경고도 allowWarnings가 아니면 거부.
 * 이미 있던 문제는 막지 않는다 (새로 생긴 것만 본다).
 */
export function runGate(
  before: Db,
  after: Db,
  vocab: Vocab,
  mergeErrors: readonly Issue[],
  opts: { readonly allowWarnings?: boolean } = {},
): GateResult {
  const beforeKeys = new Set(checkDb(before, vocab).map(key));
  const all = checkDb(after, vocab);

  // 번호 카운터는 줄어들지 않는다
  for (const p of DEF_PREFIXES) {
    const b = before.meta.next[p] ?? 1;
    const a = after.meta.next[p] ?? 1;
    if (a < b) all.push({ level: 'error', where: `meta.next.${p}`, msg: `번호 카운터가 줄었다 (${b} → ${a})` });
  }

  const errors = all.filter((i) => i.level === 'error');
  const warnings = all.filter((i) => i.level === 'warning');
  const newErrors = errors.filter((i) => !beforeKeys.has(key(i)));
  const newWarnings = warnings.filter((i) => !beforeKeys.has(key(i)));

  let reason = '통과';
  let pass = true;
  if (mergeErrors.length > 0) {
    pass = false;
    reason = `병합 오류 ${mergeErrors.length}건`;
  } else if (newErrors.length > 0) {
    pass = false;
    reason = `새 검사 오류 ${newErrors.length}건`;
  } else if (newWarnings.length > 0 && opts.allowWarnings !== true) {
    pass = false;
    reason = `새 경고 ${newWarnings.length}건 (허락이 있을 때만 --allow-warnings로 통과)`;
  }

  return { pass, errors, warnings, newErrors, newWarnings, mergeErrors: [...mergeErrors], reason };
}
