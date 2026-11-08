// 장보기 (요리-설계 12장, 작가 2026-11-08: "장보기도 만들자. 온라인, 오프라인(편의점, 마트, 시장)")
//
// 무엇을 살지: 아는 것으로 만들 수 있는 요리가 하나도 없을 때, 구상 순서(conceive.ts)로 처음 나오는 요리 중
// 모자란 재료를 모두 어딘가에서 파는 것의 **모자란 재료**가 장보기 목록이다. 이미 주문해 오는 중인 것은 빼고 본다.
// 어디서 살지: 목록을 **다 파는** 곳 중 지금 열려 있고 가장 빨리 손에 들어오는 곳. 오프라인은 다녀오는 시간(minutes) 뒤,
// 온라인은 주문 시간 뒤 다음 배송 시각(arrives_at, 하루 중 분)에 온다. 같으면 정의 번호 순. 난수 없음. 돈은 아직 없다.
// 행동 층과 감사가 같은 계산을 쓴다.

import { haveFor, menuOrder, recipeNeeds, skillAllows } from './conceive.ts';
import type { Belief } from './conceive.ts';
import type { Db, OfferDef } from './db.ts';
import type { Vocab } from './vocab.ts';

export const DAY_MIN = 1440;

export interface ShoppingBelief extends Belief {
  /** 주문해 오는 중이라 살 필요가 없는 재료(정의 번호). */
  readonly ordered?: (def: string) => boolean;
}

/** 파는 정의 전부 (어떤 가게의 buys.sells에든 있는 것). */
function soldAnywhere(db: Db): Set<string> {
  const out = new Set<string>();
  for (const d of Object.values(db.defs)) for (const o of Object.values(d.offers ?? {})) for (const s of o.buys?.sells ?? []) out.add(s);
  return out;
}

/** 장보기 목록: 무엇을 위한 장보기인지(메뉴)와 살 재료(정의 번호, 번호 순). 살 것이 없으면 null. */
export function shoppingList(db: Db, vocab: Vocab, belief: ShoppingBelief): { readonly menu: string; readonly items: readonly string[] } | null {
  const sold = soldAnywhere(db);
  let target: { menu: string; items: string[] } | null = null;
  for (const menu of menuOrder(vocab, belief.lastPlanned)) {
    if (!skillAllows(vocab, menu, belief.skill ?? (() => ''))) continue;
    const needs = recipeNeeds(db, menu);
    if (needs.length === 0) continue;
    const missing = needs.filter((n) => haveFor(vocab, belief, n) === undefined);
    if (missing.length === 0) return null; // 지금 만들 수 있는 요리가 있으면 사지 않는다
    if (target === null && missing.every((n) => sold.has(n.def))) target = { menu, items: [...new Set(missing.map((n) => n.def))].sort() };
  }
  if (target === null) return null;
  const items = target.items.filter((d) => belief.ordered?.(d) !== true);
  return items.length === 0 ? null : { menu: target.menu, items };
}

/** 이 가게가 지금 그 목록을 살 수 있는가 (다 팔고, 열려 있다). */
export function canBuy(offer: OfferDef, items: readonly string[], t: number): boolean {
  const b = offer.buys;
  if (b === undefined || !items.every((d) => b.sells.includes(d))) return false;
  if (b.opens === undefined) return true;
  const m = ((t % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return m >= b.opens[0] && m < b.opens[1];
}

/** 물건이 손에 들어오는 시각: 행동이 끝나는 때, 온라인이면 그 뒤 처음 오는 배송 시각. */
export function readyAt(offer: OfferDef, ends: number): number {
  const at = offer.buys?.arrives_at;
  if (at === undefined) return ends;
  const day = Math.floor(ends / DAY_MIN) * DAY_MIN;
  return day + at > ends ? day + at : day + DAY_MIN + at;
}
