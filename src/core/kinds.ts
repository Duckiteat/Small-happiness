// 종류 (is_a) — 규칙과 제공 행동을 종류에 한 번만 쓰고 그 종류의 모든 물건이 물려받는다 (데이터-형식 4-1 분류의 첫 구현)
//
//   - 정의 D가 `is_a: C`이면 D의 인스턴스는 C의 규칙·행동을 물려받는다. D가 같은 키를 가지면 D의 것이 이긴다 (덮어쓰기).
//   - 패턴이 C를 가리키면 "C의 종류 전부"(C 자신과 C를 조상으로 가진 모든 정의의 인스턴스)다.
//   - 규칙을 선언한 정의(주인)를 가리키는 패턴은 그 규칙이 돌고 있는 인스턴스 자신에 걸린다.
// 종류는 여러 단계로 이을 수 있다 (음식 > 유제품 > 우유). 가까운 조상이 먼 조상을 덮어쓴다. 순환은 관문이 막는다.

import type { Db, FeelDef, OfferDef, RuleDef } from './db.ts';
import type { World } from './world.ts';

/** def의 조상들 (가까운 것부터). 순환이 있어도 끝난다. */
export function ancestors(db: Db, def: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([def]);
  for (let cur = db.defs[def]?.is_a; cur !== undefined && !seen.has(cur); cur = db.defs[cur]?.is_a) {
    out.push(cur);
    seen.add(cur);
  }
  return out;
}

/** 종류 사슬이 돌아오는가 (A → B → A). 관문이 막는다. */
export function hasKindCycle(db: Db, def: string): boolean {
  const seen = new Set<string>([def]);
  for (let cur = db.defs[def]?.is_a; cur !== undefined; cur = db.defs[cur]?.is_a) {
    if (seen.has(cur)) return true;
    seen.add(cur);
  }
  return false;
}

const memberCache = new WeakMap<Db, Map<string, Set<string>>>();

/** def 자신과 def를 조상으로 가진 모든 정의 (몇 단계 아래든). 저장소마다 한 번만 계산한다. */
export function kindMembers(db: Db, def: string): Set<string> {
  let byDef = memberCache.get(db);
  if (byDef === undefined) memberCache.set(db, (byDef = new Map()));
  const cached = byDef.get(def);
  if (cached !== undefined) return cached;
  const out = new Set<string>([def]);
  for (const id of Object.keys(db.defs)) if (ancestors(db, id).includes(def)) out.add(id);
  byDef.set(def, out);
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
  // 가까운 정의부터 보며 같은 키는 가까운 쪽이 이긴다 (덮어쓰기). 선언한 정의(owner)를 함께 남긴다
  const found = new Map<string, Inherited<T>>();
  for (const id of [def, ...ancestors(db, def)]) {
    const items = pick(db.defs[id] ?? ({} as Db['defs'][string])) ?? {};
    for (const key of Object.keys(items)) if (!found.has(key)) found.set(key, { owner: id, key, item: items[key] as T });
  }
  return [...found.keys()].sort().map((key) => found.get(key) as Inherited<T>);
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
  // 먼 조상부터 가까운 순으로 필드별로 합친다 (가까운 것이 이김)
  const chain = [...ancestors(db, def)].reverse().map((id) => db.defs[id]?.progress ?? {});
  const slots = db.defs[def]?.slots ?? {};
  const full: FullProgress[] = [];
  const incomplete: string[] = [];
  const isKind = db.defs[def]?.is_a === undefined || kindMembers(db, def).size > 1; // 뿌리이거나 아래에 다른 정의가 있는 분류
  for (const feature of [...new Set([...chain.flatMap((p) => Object.keys(p)), ...Object.keys(own)])].sort()) {
    const m = chain.reduce((acc, p) => ({ ...acc, ...(p[feature] ?? {}) }), {} as NonNullable<Db['defs'][string]['progress']>[string]);
    Object.assign(m, own[feature] ?? {});
    const has = m.slot !== undefined && (slots[m.slot]?.features ?? []).includes(feature);
    // 이 물건에 없는 과정: 분류의 표이거나(분류 자신은 표를 들고 있을 뿐), 조상에게서 물려받은 것 → 걸지 않는다.
    // 분류가 아닌 물건이 자기에게 없는 특징의 진행을 적었으면 잘못이다 → 완성되지 않은 것으로 보고 관문이 거부한다.
    if (!has && (own[feature] === undefined || isKind)) continue;
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
  // 먼 조상부터 가까운 순으로 덮는다
  return Object.assign({}, ...[...ancestors(db, def)].reverse().map((id) => db.defs[id]?.initial ?? {}), db.defs[def]?.initial ?? {}) as { readonly [slotFeature: string]: string };
}

/** 물려받은 감각 (feels): 뿌리 종류부터 자기까지 차례로 모은다 (같은 감각질·조건은 한 번). */
export function effectiveFeels(db: Db, def: string): FeelDef[] {
  const chain = [...ancestors(db, def)].reverse().concat(def);
  const out: FeelDef[] = [];
  const seen = new Set<string>();
  for (const d of chain) {
    for (const f of db.defs[d]?.feels ?? []) {
      const k = `${f.sensation}|${f.when.join('&')}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
