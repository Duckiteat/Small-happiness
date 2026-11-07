// 종류 (is_a) — 규칙과 제공 행동을 종류에 한 번만 쓰고 그 종류의 모든 물건이 물려받는다 (데이터-형식 4-1 분류의 첫 구현)
//
//   - 정의 D가 `is_a: C`이면 D의 인스턴스는 C의 규칙·행동을 물려받는다. D가 같은 키를 가지면 D의 것이 이긴다 (덮어쓰기).
//   - 패턴이 C를 가리키면 "C의 종류 전부"(C 자신과 is_a C인 정의들의 인스턴스)다.
//   - 규칙을 선언한 정의(주인)를 가리키는 패턴은 그 규칙이 돌고 있는 인스턴스 자신에 걸린다.
// 종류는 한 단계뿐이다 (관문이 검사한다).

import type { Db, OfferDef, RuleDef } from './db.ts';
import type { World } from './world.ts';

/** def 자신과 def의 종류인 정의들. */
export function kindMembers(db: Db, def: string): Set<string> {
  const out = new Set<string>([def]);
  for (const [id, d] of Object.entries(db.defs)) if (d.is_a === def) out.add(id);
  return out;
}

/** def 종류에 속하는 인스턴스 (번호 순). */
export function instancesOfKind(world: World, db: Db, def: string): string[] {
  const members = kindMembers(db, def);
  return world.instances().filter((i) => members.has(world.defOfInstance(i) ?? ''));
}

export interface Inherited<T> {
  /** 이것을 선언한 정의. 이 정의를 가리키는 패턴은 인스턴스 자신에 걸린다. */
  readonly owner: string;
  readonly key: string;
  readonly item: T;
}

function effective<T>(db: Db, def: string, pick: (d: Db['defs'][string]) => { readonly [key: string]: T } | undefined): Inherited<T>[] {
  const own = pick(db.defs[def] ?? ({} as Db['defs'][string])) ?? {};
  const baseId = db.defs[def]?.is_a;
  const base = baseId === undefined ? {} : pick(db.defs[baseId] ?? ({} as Db['defs'][string])) ?? {};
  const out: Inherited<T>[] = [];
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(own)])].sort()) {
    if (own[key] !== undefined) out.push({ owner: def, key, item: own[key] as T });
    else if (baseId !== undefined) out.push({ owner: baseId, key, item: base[key] as T });
  }
  return out;
}

/** 정의 def의 인스턴스에 걸리는 규칙: 자기 규칙 + 종류의 규칙 중 덮어쓰지 않은 것. */
export function effectiveRules(db: Db, def: string): Inherited<RuleDef>[] {
  return effective(db, def, (d) => d.rules);
}

/** 정의 def의 인스턴스가 제공하는 행동: 자기 행동 + 종류의 행동 중 덮어쓰지 않은 것. */
export function effectiveOffers(db: Db, def: string): Inherited<OfferDef>[] {
  return effective(db, def, (d) => d.offers);
}

/** 완성된 진행 법칙 하나 (종류의 표 + 물건의 덮어쓰기를 합친 것). */
export interface FullProgress {
  readonly feature: string;
  readonly slot: string;
  readonly base_s: number;
  readonly inputs: { readonly [feature: string]: { readonly [level: string]: number } };
  readonly edges: readonly (number | null)[];
  readonly tuned: boolean;
}

/**
 * 정의 def의 인스턴스에 걸리는 진행 법칙. 종류의 항목과 자기 항목을 필드별로 합친다(자기 것이 이김).
 * **그 특징을 가진 물건에만 걸린다** — 종류는 여러 과정(부패·시어짐·익음·시듦·곰팡이)의 표를 모두 갖고,
 * 물건은 자기 부위에 둔 특징의 과정만 받는다. 합쳐도 빈 칸이 있으면 완성되지 않은 것으로 돌려준다(관문이 거부).
 */
export function effectiveProgress(db: Db, def: string): { readonly full: FullProgress[]; readonly incomplete: string[] } {
  const own = db.defs[def]?.progress ?? {};
  const baseId = db.defs[def]?.is_a;
  const base = baseId === undefined ? {} : db.defs[baseId]?.progress ?? {};
  const slots = db.defs[def]?.slots ?? {};
  const full: FullProgress[] = [];
  const incomplete: string[] = [];
  for (const feature of [...new Set([...Object.keys(base), ...Object.keys(own)])].sort()) {
    const m = { ...(base[feature] ?? {}), ...(own[feature] ?? {}) };
    const has = m.slot !== undefined && (slots[m.slot]?.features ?? []).includes(feature);
    // 이 물건에 없는 과정: 종류의 표이거나(종류 자신은 표를 들고 있을 뿐), 종류에서 물려받은 것 → 걸지 않는다.
    // 종류에 속한 물건이 자기에게 없는 특징의 진행을 적었으면 잘못이다 → 완성되지 않은 것으로 보고 관문이 거부한다.
    if (!has && (own[feature] === undefined || db.defs[def]?.is_a === undefined)) continue;
    if (m.slot === undefined || m.base_s === undefined || m.inputs === undefined || m.edges === undefined || m.tuned === undefined || !has) {
      incomplete.push(feature);
      continue;
    }
    full.push({ feature, slot: m.slot, base_s: m.base_s, inputs: m.inputs, edges: m.edges, tuned: m.tuned });
  }
  return { full, incomplete };
}

/** 들여놓을 때의 상태: 종류의 것 + 자기 것 (자기 것이 이김). */
export function effectiveInitial(db: Db, def: string): { readonly [slotFeature: string]: string } {
  const baseId = db.defs[def]?.is_a;
  return { ...(baseId === undefined ? {} : db.defs[baseId]?.initial ?? {}), ...(db.defs[def]?.initial ?? {}) };
}
