// 메뉴 구상 (요리-설계 10장, 작가 2026-11-08: "일정에 적은 요리는 없고 하루씨가 계속 메뉴를 구상하고 해 먹으려 한다")
//
// 요리법은 따로 적지 않는다: 같은 메뉴(사전 menu)를 가진 제공 행동들이 그 요리법이고, 그 행동들의 uses 중
// ingredient인 것이 있어야 하는 재료다 (같은 재료를 여러 단계가 쓰면 칸을 더한다).
// 구상은 **아는 것**으로 한다: 하루씨가 있는 줄 아는 개체(앎이 하나라도 있는 것)만 보고, 남은 양은 믿는 단계로 본다.
// 사전의 메뉴 순서(rank, 작을수록 먼저)로 처음 맞는 것을 고른다. 남은 음식을 먼저 먹는다. 난수 없음.
// 행동 층과 감사가 같은 계산을 쓴다.

import { stepDown } from './amount.ts';
import type { Db } from './db.ts';
import { parsePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export interface Need {
  readonly def: string;
  readonly slot: string;
  readonly feature: string;
  readonly steps: number;
}

/** 메뉴의 재료: 그 메뉴를 가진 행동들의 ingredient uses (정의 번호·부위·특징마다 칸을 더한다). */
export function recipeNeeds(db: Db, menu: string): Need[] {
  const sum = new Map<string, Need>();
  for (const id of Object.keys(db.defs).sort()) {
    for (const offer of Object.values(db.defs[id]?.offers ?? {})) {
      if (offer.menu !== menu) continue;
      for (const u of offer.uses ?? []) {
        if (u.ingredient !== true) continue;
        const p = parsePattern(u.key);
        if (p === null) continue;
        const k = `${p.def}|${p.slot}:${p.feature}`;
        const prev = sum.get(k);
        sum.set(k, { def: p.def, slot: p.slot, feature: p.feature, steps: (prev?.steps ?? 0) + u.steps });
      }
    }
  }
  return [...sum.keys()].sort().map((k) => sum.get(k) as Need);
}

/** 구상할 메뉴 순서: rank, 같으면 키. */
export function menuOrder(vocab: Vocab): string[] {
  const rank = (k: string): number => {
    const r = vocab.entry('menu', k)?.attrs['rank'];
    return typeof r === 'number' ? r : Number.MAX_SAFE_INTEGER;
  };
  return vocab.keys('menu').sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface Belief {
  /** 그 종류(정의 번호)의 인스턴스 중 하루씨가 있는 줄 아는 것 (번호 순). */
  readonly known: (def: string) => readonly string[];
  /** 그 상태를 하루씨가 믿는 단계. */
  readonly level: (key: string) => string;
}

/** 아는 것으로 만들 수 있는 첫 메뉴와, 그 판단에 쓴 상태 키들. 없으면 null. 재료가 없는 메뉴는 고르지 않는다. */
export function conceive(db: Db, vocab: Vocab, belief: Belief): { readonly menu: string; readonly keys: readonly string[] } | null {
  for (const menu of menuOrder(vocab)) {
    const needs = recipeNeeds(db, menu);
    if (needs.length === 0) continue;
    const keys: string[] = [];
    const ok = needs.every((n) => {
      const hit = belief.known(n.def).map((i) => `${i}|${n.slot}:${n.feature}`).find((k) => stepDown(vocab, n.feature, belief.level(k), n.steps) !== null);
      if (hit !== undefined) keys.push(hit);
      return hit !== undefined;
    });
    if (ok) return { menu, keys };
  }
  return null;
}
