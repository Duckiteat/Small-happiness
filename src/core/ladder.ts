// 심상 사다리 (S5 · 상호작용-명세 2D, 작가 2026-11-09): 냄새가 무엇인지를 하루씨가 어디까지 아는가.
//
// 칸 (사전 rung, 키로 참조): feel 느낌 → guess 짐작 → narrow 좁힘 → thing 정체.
//   - feel: 냄새가 나는 것은 알지만 너무 옅어 종류를 모른다 (존재와 정도).
//   - guess: 헷갈리는 종류가 둘 이상 남았다 ("구수한가? 시큼한가?").
//   - narrow: 종류는 하나로 좁혔지만 무엇인지는 모른다 ("시큼한데, 상했나 익었나").
//   - thing: 그 종류의 물건을 알고 있다 (살펴서 안 물건, "상한 두부").
//
// 종류마다의 세기는 저장하지 않고 상태에서 계산한다 (결정-기록 8장 3: 장소별 강도 저장 → 거리 기반 파생값).
//   장소의 공기 = 장소 자신의 냄새 종류 + 그 장소에 있는(또는 놓임이 없는) 물건마다의 냄새 종류(냄새 사슬의 이른 단계).
//   종류의 세기 = 그 종류를 내는 물건 중 가장 센 것, 장소의 세기를 넘지 않는다.
// 가려 냄 (감별, 숙련): 그 사람의 단계로 느낀 세기가 kind_pct 아래면 종류를 모르고(feel),
//   clear_pct[감별 칸] 아래면 비슷한 종류(odor_kind의 like)와 헷갈린다. 감별이 오르면 더 옅은 냄새도 가려 낸다.
// 좁히기 (교집합 + 순서 규칙, 난수 없음): 남은 후보 ∩ 이번에 가려 낸 것. 비면 다른 냄새로 보고 새 사다리를 연다(fresh).
// 짐작은 개념에서 냄새로 (작가 2026-11-09: "실제 냄새를 떠올리기보단 그 냄새로 매핑된 개념을 먼저 생각해내고 그다음 냄새를 맞춰보는 작업"):
//   개념 = 냄새가 이어진 것 — 물건 정의(그 물건의 이 감각 감각질을 주는 종류들)와 냄새 원인(사슬의 종류들).
//   후보 개념 = 남은 종류 중 하나라도 맞는 개념. 순서: 기억(감정이 붙은 기억의 정의) > 자주 겪음(그 개념으로 좁히거나 정체를 안 횟수)
//     > 맞는 종류가 순한 것 > 물건이 원인보다 먼저 > 번호. 맨 앞의 개념을 먼저 떠올리고, 그 개념의 냄새를 지금 냄새에 대 본다:
//     맞는 종류가 맨 앞에 오고 그 첫째가 하루씨가 믿는 종류다. 감정의 결(좋음·싫음)은 따지지 않는다.
// 오인: 맨 앞이 실제와 다르면 하루씨는 그것을 믿고 움직인다 (살피기가 늦어진다). 해는 없고 시간만 든다.
//
// 지각 층(perception.ts)과 감사(audit.ts)가 같은 계산을 쓴다. 코드에 물건·냄새 이름은 없다.

import { openLadder } from './amount.ts';
import type { Db } from './db.ts';
import { effectiveFeels } from './kinds.ts';
import { latestSeq } from './events.ts';
import { odorChain } from './odor.ts';
import { parseLocalCondition, parseStateKey } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export const LADDER_MOVED = 'ladder_moved';
export const FEEL = 'feel';
export const GUESS = 'guess';
export const NARROW = 'narrow';
export const THING = 'thing';

/** 사다리를 타는 종류 특징 (사전 feature의 ladder). */
export interface LadderSpec {
  /** 종류 특징 (예: 냄새 종류) */
  readonly feature: string;
  /** 세기 특징 (예: 냄새) */
  readonly by: string;
  /** 가려 내는 숙련 (내면 특징) */
  readonly skill: string;
  /** 이 퍼센트 이상으로 느껴야 종류를 안다 */
  readonly kindPct: number;
  /** 숙련 칸마다: 이 퍼센트 이상이면 비슷한 종류와 헷갈리지 않는다 */
  readonly clearPct: readonly number[];
  /** 이 특징을 느끼는 감각 */
  readonly sense: string;
}

function nums(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

/** 사전에서 사다리를 타는 특징들 (키 순). 사전 검증을 지난 것만 받는다. */
export function ladderSpecs(vocab: Vocab): LadderSpec[] {
  return vocab.keys('feature').sort().flatMap((feature) => {
    const attrs = vocab.entry('feature', feature)?.attrs ?? {};
    const l = attrs['ladder'];
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return [];
    const by = l['by'], skill = l['skill'], kindPct = l['kind_pct'], sense = attrs['sense'];
    if (typeof by !== 'string' || typeof skill !== 'string' || typeof kindPct !== 'number' || typeof sense !== 'string') return [];
    return [{ feature, by, skill, kindPct, clearPct: nums(l['clear_pct']), sense }];
  });
}

/** 칸 키의 순서 (사전 rung의 rank). */
export function rungRank(vocab: Vocab, rung: string): number {
  const r = vocab.entry('rung', rung)?.attrs['rank'];
  return typeof r === 'number' ? r : -1;
}

/** 사다리가 읽는 세계 (지각 층은 World, 감사는 따라간 상태로 만든다). */
export interface LadderView {
  readonly instances: () => readonly string[];
  /** 그 개체가 가진 상태 키들 (정의의 부위·특징) */
  readonly keysOf: (id: string) => readonly string[];
  readonly level: (key: string) => string;
  /** 있는 곳 (받치는 것·담긴 곳을 따라 올라간 맨 위) */
  readonly whereIs: (id: string) => string;
}

/** 열린 칸 중 몇 번째인가 (0 = 없음). 종결 단계·잠긴 칸은 -1. */
function openIndex(vocab: Vocab, feature: string, level: string): number {
  return openLadder(vocab, feature).indexOf(level);
}

/** 같은 부위의 다른 특징 키. */
function sibling(key: string, feature: string): string | null {
  const k = parseStateKey(key);
  return k === null ? null : `${k.subject}|${k.slot}:${feature}`;
}

/** 장소의 세기 키 (종류 특징과 같은 부위에 세기 특징이 있는 곳). 없으면 null. */
export function strengthKeyOf(view: LadderView, spec: LadderSpec, place: string): { kind: string; strength: string } | null {
  const keys = view.keysOf(place);
  for (const kind of keys) {
    const k = parseStateKey(kind);
    if (k === null || k.feature !== spec.feature) continue;
    const strength = sibling(kind, spec.by);
    if (strength !== null && keys.includes(strength)) return { kind, strength };
  }
  return null;
}

/**
 * 장소의 공기에 섞인 종류마다의 세기 (열린 칸 번호)와 계산에 읽은 상태 키들.
 * 물건의 종류 = 자기 종류 특징 + 냄새 사슬에서 지금 닿은 단계들이 내는 종류. 물건의 세기 = 같은 부위의 세기 특징.
 */
export function kindStrengths(vocab: Vocab, view: LadderView, spec: LadderSpec, place: string): { strengths: Map<string, number>; read: string[] } {
  const strengths = new Map<string, number>();
  const read: string[] = [];
  const at = strengthKeyOf(view, spec, place);
  if (at === null) return { strengths, read };
  read.push(at.strength, at.kind);
  const cap = openIndex(vocab, spec.by, view.level(at.strength));
  if (cap <= 0) return { strengths, read };
  const zero = openLadder(vocab, spec.feature)[0];
  const add = (kind: string, n: number): void => {
    if (kind === zero || openIndex(vocab, spec.feature, kind) <= 0) return;
    strengths.set(kind, Math.max(strengths.get(kind) ?? 0, Math.min(cap, n)));
  };
  add(view.level(at.kind), cap);
  const chain = odorChain(vocab).filter((st) => st.feature !== null && st.at !== null && st.kindFeature === spec.feature);
  for (const id of [...view.instances()].sort()) {
    if (!id.startsWith('OBJ')) continue;
    const where = view.whereIs(id);
    if (where !== place && where.startsWith('PLC')) continue; // 다른 장소에 있는 것 (놓임이 없는 것은 집 안 어디든 닿는다고 본다)
    for (const kind of view.keysOf(id)) {
      const k = parseStateKey(kind);
      if (k === null || k.feature !== spec.feature) continue;
      const strength = sibling(kind, spec.by);
      if (strength === null || !view.keysOf(id).includes(strength)) continue;
      const n = openIndex(vocab, spec.by, view.level(strength));
      if (n <= 0) continue;
      read.push(strength, kind);
      add(view.level(kind), n);
      // 원인마다 지금 닿은 가장 높은 단계의 종류만 (썩은 음식은 쉰 냄새를 더 내지 않는다)
      const reached = new Map<string, (typeof chain)[number]>();
      for (const st of chain) {
        const causeKey = sibling(kind, st.feature as string);
        if (causeKey === null || !view.keysOf(id).includes(causeKey)) continue;
        const ladder = vocab.levelOrder(st.feature as string) ?? [];
        const now = ladder.indexOf(view.level(causeKey));
        read.push(causeKey);
        if (now < 0 || now < ladder.indexOf(st.at as string)) continue;
        const had = reached.get(st.cause);
        if (had === undefined || ladder.indexOf(had.at as string) < ladder.indexOf(st.at as string)) reached.set(st.cause, st);
      }
      for (const st of reached.values()) for (const kk of st.kinds) add(kk, n);
    }
  }
  return { strengths, read: [...new Set(read)].sort() };
}

/** 비슷해서 헷갈리는 종류 (사전 odor_kind의 like). */
function likeOf(vocab: Vocab, kind: string): string[] {
  const l = vocab.entry('odor_kind', kind)?.attrs['like'];
  return Array.isArray(l) ? l.map(String) : [];
}

/**
 * 가려 낸 종류: 그 사람의 단계로 느낀 세기가 kind_pct 이상인 종류마다, clear_pct[감별 칸] 아래면 비슷한 종류까지.
 * 종류를 하나도 모르면 빈 목록(feel). 단계 순.
 */
export function discern(vocab: Vocab, spec: LadderSpec, strengths: ReadonlyMap<string, number>, scale: number, skillIndex: number): string[] {
  const top = openLadder(vocab, spec.by).length - 1;
  const clear = spec.clearPct[Math.max(0, Math.min(skillIndex, spec.clearPct.length - 1))] ?? 100;
  const out = new Set<string>();
  for (const [kind, n] of strengths) {
    const felt = Math.ceil((n * scale) / top - 1e-9);
    const pct = Math.round((felt * 100) / scale);
    if (pct < spec.kindPct) continue;
    out.add(kind);
    if (pct < clear) for (const l of likeOf(vocab, kind)) out.add(l);
  }
  const order = openLadder(vocab, spec.feature);
  return [...out].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** 냄새가 이어진 개념: 물건 정의 번호 또는 냄새 원인 키와 그 개념의 냄새 종류들 (단계 순). */
export interface Concept {
  readonly id: string;
  readonly kinds: readonly string[];
}

/** 한 사다리의 지금 자리. */
export interface LadderState {
  readonly rung: string;
  /** 남은 후보 종류, 믿는 순서 (맨 앞이 하루씨가 믿는 것: 먼저 떠올린 개념의 냄새가 맞는 종류) */
  readonly kinds: readonly string[];
  /** 떠올린 개념, 떠올리는 순서 (정체 칸이면 그 물건의 정의 하나) */
  readonly concepts: readonly string[];
  /** 정체 칸에서 그 종류라고 아는 물건 */
  readonly thing?: string;
  /** 이 사다리로 이미 좁히거나 정체를 알아 익숙함을 셌는가 */
  readonly settled: boolean;
}

export interface LadderInput {
  /** 가려 낸 종류 (discern) */
  readonly discerned: readonly string[];
  /** 그 사람이 종류를 아는 물건들: 물건 → 아는 종류 (이해함) */
  readonly known: ReadonlyMap<string, string>;
  /** 자주 겪은 개념 → 횟수 */
  readonly familiar: ReadonlyMap<string, number>;
  /** 감정이 붙은 기억의 정의들 */
  readonly remembered: ReadonlySet<string>;
  /** 냄새가 이어진 개념들 (conceptPool) */
  readonly concepts: readonly Concept[];
  /** 인스턴스 → 정의 (정체의 개념) */
  readonly defOf: (instance: string) => string | undefined;
}

/** 새 자리. 그대로면 null. fresh면 앞의 사다리를 닫고 새로 연 것이다. */
export function climb(vocab: Vocab, spec: LadderSpec, prev: LadderState | undefined, input: LadderInput): { state: LadderState; fresh: boolean } | null {
  const order = openLadder(vocab, spec.feature);
  const byOrder = (ks: Iterable<string>): string[] => [...ks].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (input.discerned.length === 0) return prev === undefined ? { state: { rung: FEEL, kinds: [], concepts: [], settled: false }, fresh: false } : null;
  let base = prev === undefined || prev.kinds.length === 0 ? [...input.discerned] : prev.kinds.filter((k) => input.discerned.includes(k));
  let fresh = false;
  let from = prev;
  if (base.length === 0) {
    fresh = true; // 남은 후보와 맞지 않는 냄새: 다른 냄새다
    from = undefined;
    base = [...input.discerned];
  }
  // 개념을 먼저 떠올린다: 남은 종류가 하나라도 맞는 개념, 기억 > 자주 겪음 > 맞는 종류가 순한 것 > 물건 먼저 > 번호
  const matched = (c: Concept): string[] => byOrder(c.kinds.filter((k) => base.includes(k)));
  const mem = (id: string): number => (input.remembered.has(id) ? 1 : 0);
  const isObject = (id: string): number => (id.startsWith('OBJ') ? 0 : 1);
  const minOrder = (c: Concept): number => order.indexOf(matched(c)[0] ?? '');
  const cands = input.concepts
    .filter((c) => matched(c).length > 0)
    .sort((a, b) => mem(b.id) - mem(a.id) || (input.familiar.get(b.id) ?? 0) - (input.familiar.get(a.id) ?? 0) || minOrder(a) - minOrder(b) || isObject(a.id) - isObject(b.id) || a.id.localeCompare(b.id));
  // 그다음 냄새를 대 본다: 맨 앞 개념의 냄새가 맞는 종류가 먼저, 나머지는 단계 순
  const top = cands[0];
  const fit = top === undefined ? [] : matched(top);
  const kinds = [...fit, ...byOrder(base).filter((k) => !fit.includes(k))];
  const things = [...input.known].filter(([, k]) => kinds.includes(k)).sort(([a, ka], [b, kb]) => kinds.indexOf(ka) - kinds.indexOf(kb) || a.localeCompare(b));
  const first = things[0];
  const thingDef = first === undefined ? undefined : input.defOf(first[0]);
  const next: Omit<LadderState, 'settled'> =
    first !== undefined
      ? { rung: THING, kinds: [first[1]], concepts: thingDef === undefined ? [] : [thingDef], thing: first[0] }
      : { rung: kinds.length === 1 ? NARROW : GUESS, kinds, concepts: cands.map((c) => c.id) };
  if (from !== undefined && rungRank(vocab, next.rung) < rungRank(vocab, from.rung)) return null; // 칸은 내려가지 않는다
  const settled = (from?.settled ?? false) || next.rung === NARROW || next.rung === THING;
  const state: LadderState = { ...next, settled };
  const same = (a: LadderState, b: LadderState): boolean => a.rung === b.rung && a.thing === b.thing && a.kinds.join(',') === b.kinds.join(',') && a.concepts.join(',') === b.concepts.join(',');
  if (!fresh && from !== undefined && same(from, state)) return null;
  return { state, fresh };
}

/** 처음으로 좁히거나 정체를 알았으면 그때 맨 앞의 개념 (익숙함을 하나 더한다). */
export function newlySettled(prev: LadderState | undefined, fresh: boolean, next: LadderState): string | null {
  const was = fresh ? false : (prev?.settled ?? false);
  return !was && next.settled ? (next.concepts[0] ?? null) : null;
}

/** 하루씨가 믿는 종류: 짐작 이상이면 맨 앞, 느낌이면 모른다(null). */
export function believed(state: LadderState | undefined): string | null {
  return state === undefined || state.rung === FEEL ? null : (state.kinds[0] ?? null);
}

/** 그 후보 종류들을 내는 냄새 원인들 (사슬의 지식, 키 순) — 문장이 "상했나 익었나"를 고를 때 쓴다. */
export function causesOf(vocab: Vocab, kinds: readonly string[]): string[] {
  return [...new Set(odorChain(vocab).filter((st) => st.kinds.some((k) => kinds.includes(k))).map((st) => st.cause))].sort();
}

/** 사다리 사건의 원인: 계산에 읽은 상태를 마지막으로 정한 사건들과 숙련, 정체의 앎 중 가장 최근. */
export function ladderCause(read: readonly string[], lastChange: (key: string) => string | null, extra: readonly (string | null | undefined)[]): string | null {
  return latestSeq([...read.map(lastChange), ...extra]);
}

/** 그 상태 키가 사다리로 아는 장소의 종류 키이면 그 사다리 (장소 자신의 종류 특징이고 같은 부위에 세기가 있다). */
export function ladderOfKey(specs: readonly LadderSpec[], view: LadderView, key: string): LadderSpec | null {
  const k = parseStateKey(key);
  if (k === null || !k.subject.startsWith('PLC')) return null;
  for (const spec of specs) if (spec.feature === k.feature && strengthKeyOf(view, spec, k.subject)?.kind === key) return spec;
  return null;
}

/** 그 사람이 이해함으로 아는 물건의 종류: 물건 → 아는 종류 (없음 칸·종결 단계는 뺀다). knows는 상태 키 → 앎. 장소의 공기는 정체가 아니다. */
export function knownKinds(vocab: Vocab, spec: LadderSpec, knows: Iterable<readonly [string, { readonly aw: string; readonly level: string }]>, understood: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, kn] of knows) {
    const k = parseStateKey(key);
    if (k === null || !k.subject.startsWith('OBJ') || k.feature !== spec.feature || kn.aw !== understood || openIndex(vocab, spec.feature, kn.level) <= 0) continue;
    out.set(k.subject, kn.level);
  }
  return out;
}

/** 감각질 → 그것을 주는 종류들: 어느 정의의 feels가 `부위:종류 특징@=종류`일 때 그 감각질을 준다 (정의 번호 순으로 모은다). */
export function kindsBySensation(db: Db, spec: LadderSpec): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const def of Object.keys(db.defs).sort()) {
    for (const f of db.defs[def]?.feels ?? []) {
      for (const w of f.when) {
        const c = parseLocalCondition(w);
        if (c === null || c.feature !== spec.feature || c.cond?.op !== '=') continue;
        const set = out.get(f.sensation) ?? new Set<string>();
        set.add(c.cond.level);
        out.set(f.sensation, set);
      }
    }
  }
  return out;
}

/** 그 정의(종류로 물려받은 것 포함)의 이 감각 감각질을 주는 종류들 (단계 순). */
export function conceptKinds(db: Db, vocab: Vocab, spec: LadderSpec, def: string, by: ReadonlyMap<string, ReadonlySet<string>> = kindsBySensation(db, spec)): string[] {
  const out = new Set<string>();
  for (const f of effectiveFeels(db, def)) {
    if (vocab.entry('sensation', f.sensation)?.attrs['sense'] !== spec.sense) continue;
    for (const k of by.get(f.sensation) ?? []) out.add(k);
  }
  const order = openLadder(vocab, spec.feature);
  return [...out].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * 그 사람이 아는 개념만 (작가 "고고고", 2026-11-09 기본안): 물건은 본 적 있는 것(그 정의의 개체에 대한 앎이 있음)과 기억 속의 것,
 * 냄새 원인은 상식이라 늘 안다. 순서는 conceptPool 그대로.
 */
export function knownConcepts(pool: readonly Concept[], seen: ReadonlySet<string>, remembered: ReadonlySet<string>): Concept[] {
  return pool.filter((c) => !c.id.startsWith('OBJ') || seen.has(c.id) || remembered.has(c.id));
}

/** 떠올린 물건 개념이 처음 알려진 사건 중 가장 최근 (그 개념이 후보가 된 원인). */
export function conceptCause(concepts: readonly string[], firstSeen: ReadonlyMap<string, string>): string | null {
  return latestSeq(concepts.map((c) => firstSeen.get(c)));
}

/**
 * 냄새가 이어진 개념들: 냄새 감각질이 냄새 종류로 이어지는 물건 정의(번호 순)와, 이 종류 특징으로 냄새가 나는 냄새 원인(키 순).
 * 개념은 사람이 아는 말이라 장소는 넣지 않는다. 코드에 물건 이름은 없다.
 */
export function conceptPool(db: Db, vocab: Vocab, spec: LadderSpec): Concept[] {
  const by = kindsBySensation(db, spec);
  const order = openLadder(vocab, spec.feature);
  const objects = Object.keys(db.defs).sort().filter((d) => d.startsWith('OBJ')).map((id) => ({ id, kinds: conceptKinds(db, vocab, spec, id, by) }));
  const causes = new Map<string, Set<string>>();
  for (const st of odorChain(vocab)) {
    if (st.kindFeature !== spec.feature) continue;
    const set = causes.get(st.cause) ?? new Set<string>();
    for (const k of st.kinds) set.add(k);
    causes.set(st.cause, set);
  }
  const fromCauses = [...causes.keys()].sort().map((id) => ({ id, kinds: [...(causes.get(id) ?? [])].sort((a, b) => order.indexOf(a) - order.indexOf(b)) }));
  return [...objects, ...fromCauses].filter((c) => c.kinds.length > 0);
}
