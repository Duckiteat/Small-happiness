// 물건 관계 (docs/물건-관계-명세.md): 물건이 어디에 있는가를 좌표 없이 "받치는 것"과 "담긴 곳" 포인터로 둔다.
//
//   - on: 이 물건을 받치는 것 하나 (식탁보의 on = 식탁). 맨 아래 물건의 on은 장소다.
//   - in: 이 물건이 담긴 곳 하나 (물병 속의 물의 in = 물병).
//   - 둘 다 사건(placed)으로만 바뀐다. 높이·거리·있는 장소는 저장하지 않고 포인터에서 계산한다.
//   - 순환(자기 자신 포함)은 만들 수 없다. 받치는 것 포인터와 담긴 곳 포인터를 모두 따라가며 검사한다.
//
// 이 모듈은 입출력이 없는 순수 함수다. 이름 같은 사실은 모르고 개체 번호만 안다.

export const RELATIONS = ['on', 'in'] as const;
export type Relation = (typeof RELATIONS)[number];

export function isRelation(v: unknown): v is Relation {
  return v === 'on' || v === 'in';
}

/** 개체 → { on?, in? }. 포인터가 없는 칸은 비어 있다. */
export type PlaceMap = ReadonlyMap<string, { readonly on?: string; readonly in?: string }>;

/** 개체가 기대는 곳들 (받치는 것, 담긴 곳). */
export function parents(map: PlaceMap, id: string): string[] {
  const p = map.get(id);
  const out: string[] = [];
  if (p?.on !== undefined) out.push(p.on);
  if (p?.in !== undefined) out.push(p.in);
  return out;
}

/** `id`의 포인터를 `to`로 바꾸면 순환이 생기는가. to에서 위로 올라가다 id를 만나면 순환이다. */
export function wouldCycle(map: PlaceMap, id: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === id) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...parents(map, cur));
  }
  return false;
}

/** x가 포인터(받치는 것·담긴 곳)를 따라 올라가다 anc를 만나는가 (x가 anc 위·안에 있는가). */
export function isUnder(map: PlaceMap, x: string, anc: string): boolean {
  const seen = new Set<string>();
  const stack = [...parents(map, x)];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...parents(map, cur));
  }
  return false;
}

/** 서로 이어진 것인가: 한쪽이 다른 쪽 안이나 위에 있다. 규칙의 `linked` 범위가 쓴다. */
export function isLinked(map: PlaceMap, a: string, b: string): boolean {
  return a === b || isUnder(map, a, b) || isUnder(map, b, a);
}

/** 눈에 보이는 곳: 받치는 것(on)만 따라 올라간다. 어딘가의 안(in)에 든 물건은 닫힌 곳에 있어 보이지 않으므로 그 물건 자신에서 멈춘다. */
export function visibleRoot(map: PlaceMap, id: string): string {
  let cur = id;
  for (;;) {
    const p = map.get(cur);
    if (p?.in !== undefined || p?.on === undefined) return cur;
    cur = p.on;
  }
}

/** 높이: 받치는 것(on)만 따라 맨 아래까지 가는 칸 수. 맨 아래(받치는 것이 없는 물건·장소)는 0. */
export function height(map: PlaceMap, id: string): number {
  let n = 0;
  for (let cur = map.get(id)?.on; cur !== undefined; cur = map.get(cur)?.on) n += 1;
  return n;
}

/** 있는 곳: on·in을 따라 올라가 닿는 가장 위의 개체. 장소 개체면 그 장소. 포인터가 없으면 자기 자신. */
export function rootOf(map: PlaceMap, id: string): string {
  let cur = id;
  for (;;) {
    const p = map.get(cur);
    const next = p?.on ?? p?.in;
    if (next === undefined) return cur;
    cur = next;
  }
}

/** 두 개체 사이의 거리: 포인터를 방향 없이 이은 그래프의 최단 칸 수. 이어지지 않으면 null. */
export function distance(map: PlaceMap, a: string, b: string): number | null {
  if (a === b) return 0;
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string): void => {
    (adj.get(x) ?? adj.set(x, new Set()).get(x))?.add(y);
    (adj.get(y) ?? adj.set(y, new Set()).get(y))?.add(x);
  };
  for (const id of map.keys()) for (const p of parents(map, id)) link(id, p);
  const dist = new Map<string, number>([[a, 0]]);
  const queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i] as string;
    for (const nx of [...(adj.get(cur) ?? [])].sort()) {
      if (dist.has(nx)) continue;
      dist.set(nx, (dist.get(cur) as number) + 1);
      if (nx === b) return dist.get(nx) as number;
      queue.push(nx);
    }
  }
  return null;
}

// ── 한 줄 표기 ───────────────────────────────────────────────────────────────

/** 표기 `A^B^C`는 A 위에 B, B 위에 C (왼쪽이 아래). 이름 조각들로 나눈다. 빈 조각이 있으면 null. */
export function parseChain(text: string): string[] | null {
  const parts = text.split('^').map((s) => s.trim());
  return parts.length >= 1 && parts.every((s) => s !== '') ? parts : null;
}

/** 한 줄 → (아래, 위) 쌍들. 개체 둘 이상이어야 쌍이 생긴다. */
export function chainPairs(ids: readonly string[]): { readonly below: string; readonly above: string }[] {
  const pairs: { below: string; above: string }[] = [];
  for (let i = 0; i + 1 < ids.length; i++) pairs.push({ below: ids[i] as string, above: ids[i + 1] as string });
  return pairs;
}

/** 받치는 것 포인터를 한 줄들로 되돌린다 (가지가 갈라지면 쉼표로 나뉜 줄들). 맨 아래부터 위로 올라가는 모든 길이 한 줄씩이다. */
export function chains(map: PlaceMap): string[][] {
  const above = new Map<string, string[]>();
  for (const [id, p] of map) if (p.on !== undefined) (above.get(p.on) ?? above.set(p.on, []).get(p.on))?.push(id);
  for (const list of above.values()) list.sort();
  const roots = [...above.keys()].filter((k) => map.get(k)?.on === undefined).sort();
  const out: string[][] = [];
  const walk = (path: string[]): void => {
    const next = above.get(path[path.length - 1] as string) ?? [];
    if (next.length === 0) {
      if (path.length > 1) out.push(path);
      return;
    }
    for (const n of next) walk([...path, n]);
  };
  for (const r of roots) walk([r]);
  return out;
}

/**
 * 등고선 보기 (파생, 화면용): 한 줄이면 `식탁^식탁보^컵^식탁보^식탁`처럼 꼭대기까지 갔다 내려온다.
 * 같은 물건 사이의 `^` 개수가 그 거리다. 가지가 갈라지면 줄이 길어져 셈이 최단 거리와 다를 수 있으므로 보기용이다.
 */
export function contour(path: readonly string[]): string[] {
  return [...path, ...path.slice(0, -1).reverse()];
}
