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
