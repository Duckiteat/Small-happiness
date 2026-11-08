// 행동이 개체를 만들고 옮긴다 (요리-설계 8장): 덜어 담은 찌개가 새 음식이 되고, 반찬통을 냉장고에 넣는다.
//
// 행동의 참조(ref)는 정의 번호다. 행동을 내놓은 정의 자신이면 그 인스턴스, 아니면 그 종류의 인스턴스가 **하나뿐**이어야 한다
// (여럿이면 어느 것인지 정하지 못해 행동하지 않는다). 행동 층과 감사가 같은 계산을 쓴다.
// 놓임을 바꾸는 것은 포인터 하나씩의 변화로 푼다: 안(in)에 넣으면 받치는 것(on)은 풀리고, 꺼내면(out) 둘 다 풀린다.

import type { PlaceSpec } from './db.ts';
import type { Relation } from './placement.ts';

export type Pointers = { readonly on?: string; readonly in?: string };

/** 포인터 하나의 변화 (to가 null이면 푼다). */
export interface PointerChange {
  readonly id: string;
  readonly rel: Relation;
  readonly to: string | null;
}

/** 참조를 인스턴스 하나로. 자기 정의면 at, 아니면 그 종류의 인스턴스가 하나일 때만. */
export function refInstance(ref: string, owner: string, at: string, membersOf: (def: string) => readonly string[]): string | null {
  if (ref === owner) return at;
  const xs = membersOf(ref);
  return xs.length === 1 ? (xs[0] ?? null) : null;
}

/** 놓임 요청의 목표: 어느 포인터를 무엇으로. out이면 둘 다 푼다. */
export function targetPointers(spec: { readonly in?: string; readonly on?: string; readonly out?: boolean }, to: string | null): Pointers {
  if (spec.out === true) return {};
  if (spec.in !== undefined) return to === null ? {} : { in: to };
  return to === null ? {} : { on: to };
}

/** 지금 놓임에서 목표 놓임으로 가는 포인터 변화 (이미 같으면 빈 목록). on을 먼저 본다. */
export function pointerChanges(id: string, now: Pointers | undefined, goal: Pointers): PointerChange[] {
  const out: PointerChange[] = [];
  for (const rel of ['on', 'in'] as const) {
    const cur = now?.[rel] ?? null;
    const want = goal[rel] ?? null;
    if (cur !== want) out.push({ id, rel, to: want });
  }
  // 넣기 전에 빼기: 푸는 변화를 먼저 (받치는 것을 풀고 안에 넣는다)
  return out.sort((a, b) => Number(a.to !== null) - Number(b.to !== null));
}

/** 놓임 요청이 가리키는 관계 (in/on/out) — 검사 메시지용. */
export function relationOf(spec: PlaceSpec): string {
  return spec.out === true ? 'out' : spec.in !== undefined ? `in ${spec.in}` : `on ${spec.on ?? ''}`;
}
