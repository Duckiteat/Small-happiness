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
import { effectiveInitial, effectiveProgress } from './kinds.ts';
import { placeGraph, spreadIssues } from './spread.ts';
import { normalizeWord } from './vocab.ts';
import type { Vocab } from './vocab.ts';

const key = (i: Issue): string => `${i.level}|${i.where}|${i.msg}`;

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
  if (cond === null) return;
  // 종결 단계(소멸·고정)는 사다리 밖이다: = 로만 쓴다
  if (vocab.has('terminal', cond.level)) {
    if (cond.op !== '=') push(where, `종결 단계 "${cond.level}"는 = 조건으로만 쓸 수 있다`);
    return;
  }
  if (vocab.isLocked(feature, cond.level)) {
    return void push(where, `단계 "${cond.level}"는 아직 잠겨 있다 (사전에서 잠금을 풀면 쓸 수 있다)`);
  }
  const order = vocab.levelOrder(feature);
  if (order === undefined) return void push(where, `특징 "${feature}"에 단계 목록이 없어 조건을 쓸 수 없다`);
  if (!order.includes(cond.level)) {
    return void push(where, `조건의 단계 키 "${cond.level}"가 "${feature}"의 단계에 없다 (${order.join(', ')})`);
  }
  const r = condRange(cond, order);
  if (r === null || r.min > r.max) push(where, `조건 "${cond.op}${cond.level}"는 빈 범위다`);
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
      for (const side of ['on', 'on_all', 'emits'] as const) {
        (rule[side] ?? []).forEach((text, i) => {
          const at = `${id}.rules.${ruleKey}.${side}[${i}]`;
          const p = parsePattern(text);
          if (p === null) return void error(at, `패턴 형식이 아니다: ${text}`);
          const target = db.defs[p.def];
          if (target === undefined) return void error(at, `없는 정의를 가리킨다: ${p.def}`);
          // 결과는 "어떤 단계로 만드는가"가 분명해야 한다: = (그 단계로), >= (적어도 그 단계까지 올림), <= (그 단계까지 내림)
          if (side === 'emits' && (p.cond === null || !['=', '>=', '<='].includes(p.cond.op))) {
            error(at, `결과(emits)에는 =, >=, <= 조건이 필요하다 (어떤 단계로 만드는지 정한다): ${text}`);
          }
          slotCheck(target, p.slot, p.feature, p.cond, vocab, at, error);
        });
      }
    }
  }

  // 종류(is_a): 같은 종류의 정의를 한 단계만 가리키고, 물려받는 규칙·행동이 쓰는 부위·특징을 모두 갖는다
  for (const [id, def] of Object.entries(db.defs)) {
    if (def.is_a === undefined) continue;
    const at = `${id}.is_a`;
    const base = db.defs[def.is_a];
    if (base === undefined) {
      error(at, `없는 정의를 가리킨다: ${def.is_a}`);
      continue;
    }
    if (def.is_a === id) error(at, '자기 자신의 종류일 수 없다');
    else if (def.is_a.slice(0, 3) !== id.slice(0, 3)) error(at, `같은 종류의 정의만 가리킨다 (${id.slice(0, 3)} ≠ ${def.is_a.slice(0, 3)})`);
    else if (base.is_a !== undefined) error(at, `종류는 한 단계만 가능하다 (${def.is_a}도 is_a가 있다)`);
    const inherited = [
      ...Object.values(base.rules ?? {}).flatMap((r) => [...r.on, ...(r.on_all ?? []), ...r.emits]),
      ...Object.values(base.offers ?? {}).flatMap((o) => [...o.needs.map((n) => n.aware), ...(o.when ?? []), ...o.effect]),
    ];
    const need = new Set<string>();
    for (const text of inherited) {
      const p = parsePattern(text);
      if (p !== null && p.def === def.is_a) need.add(`${p.slot}:${p.feature}`);
    }
    for (const sf of [...need].sort()) {
      const [slot, feature] = sf.split(':') as [string, string];
      if (!(def.slots?.[slot]?.features ?? []).includes(feature)) {
        error(at, `${def.is_a}의 규칙·행동을 물려받으려면 부위 ${slot}에 특징 ${feature}가 있어야 한다`);
      }
    }
  }

  // 진행 법칙: 물건마다 완성되어야 하고(종류 + 덮어쓰기), 입력은 그 물건의 특징이며 잠기지 않은 모든 단계에 계수가 있다
  for (const id of Object.keys(db.defs)) {
    const { full, incomplete } = effectiveProgress(db, id);
    for (const f of incomplete) error(`${id}.progress.${f}`, `진행 법칙이 완성되지 않았다 (slot·base_s·inputs·edges·tuned, 그리고 부위에 특징 ${f})`);
    const features = new Set(Object.values(db.defs[id]?.slots ?? {}).flatMap((s) => s.features));
    for (const p of full) {
      const at = `${id}.progress.${p.feature}`;
      const order = vocab.levelOrder(p.feature);
      if (order === undefined) {
        error(at, `특징 "${p.feature}"에 단계 목록이 없다`);
        continue;
      }
      if (p.edges.length !== order.length) error(at, `edges는 사다리 칸 수(${order.length})만큼이어야 한다`);
      let last = -1;
      p.edges.forEach((e, i) => {
        const key = order.at(i) ?? '';
        const locked = vocab.isLocked(p.feature, key);
        if (locked && e !== null) error(at, `잠긴 칸(${key})의 경계는 null이어야 한다`);
        if (!locked && e === null) error(at, `칸 ${key}의 경계가 없다`);
        if (i === 0 && e !== 0) error(at, '0칸의 경계는 0이어야 한다');
        if (e !== null) {
          if (e <= last) error(at, `경계는 칸마다 커져야 한다 (${key}: ${e})`);
          last = e;
        }
      });
      for (const [input, table] of Object.entries(p.inputs)) {
        if (!features.has(input)) error(`${at}.inputs.${input}`, `${id}에 입력 특징 "${input}"이 없다 (부위에 둔다)`);
        const levels = vocab.levelOrder(input) ?? [];
        for (const lv of levels) {
          if (!vocab.isLocked(input, lv) && table[lv] === undefined) error(`${at}.inputs.${input}`, `단계 ${lv}의 계수가 없다`);
        }
        for (const lv of Object.keys(table)) if (!levels.includes(lv)) error(`${at}.inputs.${input}`, `"${input}"에 없는 단계: ${lv}`);
      }
    }
    for (const [sf, level] of Object.entries(effectiveInitial(db, id))) {
      const [slot, feature] = sf.split(':') as [string, string];
      if (!(db.defs[id]?.slots?.[slot]?.features ?? []).includes(feature)) {
        if (db.defs[id]?.initial?.[sf] !== undefined) error(`${id}.initial.${sf}`, `${id}에 부위 ${slot}의 특징 ${feature}가 없다`);
        continue;
      }
      if (!(vocab.levelOrder(feature) ?? []).includes(level) || vocab.isLocked(feature, level)) error(`${id}.initial.${sf}`, `"${feature}"의 쓸 수 있는 단계가 아니다: ${level}`);
    }
  }

  // 공간 (1층): 환경 등급은 사전에, 통로는 있는 장소를 가리키고 종류·매질이 사전에 있으며, 한 쌍은 한 번만 적는다
  const pairs = new Set<string>();
  for (const [id, def] of Object.entries(db.defs)) {
    for (const [trait, level] of Object.entries(def.environment ?? {})) {
      if (!vocab.has('env_trait', trait)) error(`${id}.environment.${trait}`, `사전에 없는 환경 특성: ${trait}`);
      if (!vocab.has('env_level', level)) error(`${id}.environment.${trait}`, `사전에 없는 환경 등급: ${level}`);
    }
    (def.passages ?? []).forEach((p, i) => {
      const at = `${id}.passages[${i}]`;
      if (!id.startsWith('PLC')) error(at, '통로는 장소에만 있다');
      if (db.defs[p.to] === undefined) error(at, `없는 정의를 가리킨다: ${p.to}`);
      else if (!p.to.startsWith('PLC')) error(at, `통로는 장소끼리 잇는다 (${p.to}는 장소가 아니다)`);
      if (p.to === id) error(at, '통로가 자기 자신으로 간다');
      if (!vocab.has('edge_kind', p.kind)) error(at, `사전에 없는 통로 종류: ${p.kind}`);
      for (const m of Object.keys(p.medium_pass)) if (!vocab.has('medium', m)) error(`${at}.medium_pass.${m}`, `사전에 없는 매질: ${m}`);
      const pair = [id, p.to].sort().join('~');
      if (pairs.has(pair)) error(at, `${id}와 ${p.to} 사이의 통로가 두 번 적혀 있다 (한 쌍은 한쪽에만 한 번)`);
      pairs.add(pair);
    });
  }
  // 통로가 있으면 모든 장소가 이어져 있어야 한다 (고립된 장소 없음)
  if (pairs.size > 0) {
    const g = placeGraph(db);
    const start = [...g.keys()][0];
    const seen = new Set<string>(start === undefined ? [] : [start]);
    const queue = start === undefined ? [] : [start];
    while (queue.length > 0) {
      for (const e of g.get(queue.shift() ?? '') ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    const lonely = [...g.keys()].filter((p) => !seen.has(p));
    if (lonely.length > 0) error('places', `통로로 이어지지 않은 장소: ${lonely.join(', ')} (장소 그래프가 끊겨 있다)`);
  }
  for (const msg of spreadIssues(db, vocab)) error('spread', msg);

  // 제공 행동: 동사는 사전에, 필요한 앎은 패턴(조건 없음)과 인지 단계, 결과는 =·>=·<= 패턴
  for (const [id, def] of Object.entries(db.defs)) {
    for (const [key, offer] of Object.entries(def.offers ?? {})) {
      const at = `${id}.offers.${key}`;
      if (!vocab.has('action', offer.verb)) error(`${at}.verb`, `사전에 없는 행동: ${offer.verb}`);
      offer.needs.forEach((n, i) => {
        const w = `${at}.needs[${i}]`;
        const p = parsePattern(n.aware);
        if (p === null) return void error(w, `패턴 형식이 아니다 (번호로 쓴다): ${n.aware}`);
        if (p.cond !== null) error(w, `필요한 앎에는 단계 조건을 쓰지 않는다 (at_least로 인지 단계를 정한다): ${n.aware}`);
        if (!vocab.has('awareness', n.at_least)) error(w, `사전에 없는 인지 단계: ${n.at_least}`);
        const target = db.defs[p.def];
        if (target === undefined) return void error(w, `없는 정의를 가리킨다: ${p.def}`);
        slotCheck(target, p.slot, p.feature, null, vocab, w, error);
      });
      (offer.when ?? []).forEach((text, i) => {
        const w = `${at}.when[${i}]`;
        const p = parsePattern(text);
        if (p === null) return void error(w, `패턴 형식이 아니다 (번호로 쓴다): ${text}`);
        const target = db.defs[p.def];
        if (target === undefined) return void error(w, `없는 정의를 가리킨다: ${p.def}`);
        slotCheck(target, p.slot, p.feature, p.cond, vocab, w, error);
      });
      offer.effect.forEach((text, i) => {
        const w = `${at}.effect[${i}]`;
        const p = parsePattern(text);
        if (p === null) return void error(w, `패턴 형식이 아니다 (번호로 쓴다): ${text}`);
        if (p.cond === null || !['=', '>=', '<='].includes(p.cond.op)) error(w, `결과에는 =, >=, <= 조건이 필요하다: ${text}`);
        const target = db.defs[p.def];
        if (target === undefined) return void error(w, `없는 정의를 가리킨다: ${p.def}`);
        slotCheck(target, p.slot, p.feature, p.cond, vocab, w, error);
      });
    }
    for (const sense of Object.keys(def.senses ?? {})) {
      if (!vocab.has('sense', sense)) error(`${id}.senses.${sense}`, `사전에 없는 감각: ${sense}`);
    }
  }

  for (const ref of selfLoops(collectRules(db), vocab, db)) { // 종류(is_a)를 거쳐 돌아오는 것도 (인과와 같은 판단)
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
