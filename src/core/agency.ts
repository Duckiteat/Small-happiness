// 행동 (6층) — 하루씨가 스스로 다음 행동을 고른다 (docs/상호작용-명세.md 3장 · 인물-명세 자율 행동)
//
// 후보는 물건·장소가 제공하는 행동(offers) 중 **하루씨가 아는 것으로 할 수 있는 것**뿐이다 (needs의 인지 단계).
// 하루씨가 집에 깨어 있고 다른 행동 중이 아닐 때 한 번에 하나를 고른다. 결과는 직접 쓰지 않는다:
//   - effect는 효과 요청으로 판(recent)에 올리고, 세계 상태(2층)가 행동이 끝나는 시각에 기록한다 (되먹임 길 F1).
//   - reveals(살피기)는 다음 단계의 지각(5층)이 그 장소의 물건까지 보게 한다 (F6).
//   - 행동이 끝나는 시각에 다음 단계가 돈다 (F5, schedule.ts).
// 이미 이루어진 결과를 다시 하지 않고, 같은 앎 상태에서 같은 행동을 되풀이하지 않는다.
// **판단은 앎으로 한다** (세계가 아니라): when·when_meaning은 하루씨가 마지막으로 본 단계로 본다.
// 본 적 없는 상태는 살 때의 상태(initial)로, 그것도 없으면 사다리 0칸으로 믿는다. 앎이 낡으면 판단도 낡는다.
// 다만 결과가 이미 세계에서 이루어졌는지(버린 것을 또 버리지 않기)는 몸이 하는 일이라 세계로 본다.
//
// 끼니가 시작되면 아는 재료로 메뉴를 구상하고(conceive.ts), 요리법의 단계(offer.menu)는 그 메뉴일 때만 후보가 된다. 쓰는 양(offer.uses)은 세계의 남은 양에서 칸을 내린다.
//
// 고르는 방식 (기본안, 18번 점수 매기기 전까지): 할 수 있는 후보 중 정의 번호·행동 키 순서로 첫 번째. 난수 없음.

import { pickUse } from './amount.ts';
import { pointerChanges, refInstance, targetPointers } from './moves.ts';
import type { PointerChange } from './moves.ts';
import { isRelation } from './placement.ts';
import type { Relation } from './placement.ts';
import { levelMatches, stateMatches } from './causal.ts';
import type { BoardValue } from './board.ts';
import { formatVia } from './via.ts';
import { latestSeq } from './events.ts';
import { menusOf } from './db.ts';
import type { Db } from './db.ts';
import { effectiveInitial, effectiveOffers, instancesOfKind } from './kinds.ts';
import { meaningOf } from './meaning.ts';
import type { EventLog } from './log.ts';
import type { AwareMap } from './perception.ts';
import { isObserved } from './schedule.ts';
import type { Meal } from './schedule.ts';
import { conceive } from './conceive.ts';
import { canBuy, readyAt, shoppingList } from './shopping.ts';
import { practiceGain, skilledMinutes, skillKey } from './skill.ts';
import { formatStateKey, parsePattern } from './statekey.ts';
import type { StatePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import { hasCondition, modeMinutes, modeOf, unfinishedCount } from './condition.ts';
import { ACTION_STOPPED, againstOdor } from './urgency.ts';
import { isOverwhelmed, MOOD_SLOT } from './emotion.ts';
import type { World } from './world.ts';

export const AGENCY_SRC = 'agency';
export const ACTION_CHOSEN = 'action_chosen';
export const MENU_PLANNED = 'menu_planned';
export const OPTIONS_FORMED = 'options_formed';
export const ADVICE_GIVEN = 'advice_given';
export const ADVICE_IGNORED = 'advice_ignored';
export const FAIRY_SRC = 'fairy';

/** 요정의 작은 조언 (내면-설계 12장): 그 시각에 하루씨의 선택지 중 하나(제공 행동 offer, 그것을 내놓는 개체 at)를 권한다. */
export interface Advice {
  readonly t: number;
  readonly offer: string;
  readonly at: string;
}

/** 행동의 갈래 (사전 action): pastime 쉼 · upkeep 집안일 · 나머지는 할 일. */
export function actionClass(vocab: Vocab, verb: string): 'task' | 'pastime' | 'upkeep' {
  const a = vocab.entry('action', verb)?.attrs ?? {};
  return a['pastime'] === true ? 'pastime' : a['upkeep'] === true ? 'upkeep' : 'task';
}

export interface Effect {
  readonly key: string;
  readonly op: string;
  readonly level: string;
}

/** 판의 recent 한 줄: 고른 행동과 그 효과 요청. */
export interface RecentAction {
  readonly event: string;
  readonly who: string;
  readonly verb: string;
  /** 이 행동을 내놓은 제공 행동의 근거 참조 (via.ts: 정의/offer/키) */
  readonly via: string;
  readonly at: string;
  readonly ends: number;
  readonly effects: readonly Effect[];
  readonly reveals?: string;
  /** 만들 개체: 정의와 놓을 곳(포인터 하나). */
  readonly creates?: readonly { readonly def: string; readonly rel?: Relation; readonly to?: string; readonly at?: number }[];
  /** 이 행동을 하는 동안 집을 비운다. */
  readonly away?: boolean;
  /** 놓임의 변화 (포인터 하나씩). */
  readonly moves?: readonly PointerChange[];
  /** 끝나면 쌓이는 숙련과 그 양 (skill.ts). */
  readonly trains?: readonly { readonly feature: string; readonly gain: number }[];
  /** 끝나기 전에 그만둔 행동 (urgency.ts): event의 행동을 2층이 끝내지 않고 버린다. 효과가 없다 */
  readonly stops?: boolean;
}

function isObj(v: unknown): v is { readonly [key: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 판의 recent 값을 읽는다. 중립값(빈 목록)이면 빈 목록. */
export function parseRecent(value: BoardValue | undefined): RecentAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).map((r) => ({
    event: String(r['event']),
    who: String(r['who']),
    verb: String(r['verb']),
    via: String(r['via']),
    at: String(r['at']),
    ends: Number(r['ends']),
    effects: (Array.isArray(r['effects']) ? r['effects'] : []).filter(isObj).map((e) => ({ key: String(e['key']), op: String(e['op']), level: String(e['level']) })),
    ...(typeof r['reveals'] === 'string' ? { reveals: r['reveals'] } : {}),
    ...(Array.isArray(r['creates'])
      ? { creates: r['creates'].filter(isObj).map((c) => ({ def: String(c['def']), ...(isRelation(c['rel']) && typeof c['to'] === 'string' ? { rel: c['rel'], to: c['to'] } : {}), ...(typeof c['at'] === 'number' ? { at: c['at'] } : {}) })) }
      : {}),
    ...(r['away'] === true ? { away: true } : {}),
    ...(r['stops'] === true ? { stops: true } : {}),
    ...(Array.isArray(r['trains']) ? { trains: r['trains'].filter(isObj).map((x) => ({ feature: String(x['feature']), gain: Number(x['gain']) })) } : {}),
    ...(Array.isArray(r['moves'])
      ? { moves: r['moves'].filter(isObj).flatMap((m) => (isRelation(m['rel']) ? [{ id: String(m['id']), rel: m['rel'], to: typeof m['to'] === 'string' ? m['to'] : null }] : [])) }
      : {}),
  }));
}

function pattern(text: string): StatePattern {
  const p = parsePattern(text);
  if (p === null) throw new Error(`패턴 형식이 아니다 (${text}) — 관문을 지난 저장소만 쓴다`);
  return p;
}

export class Agency {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #tried = new Set<string>();
  #busyUntil = -1;
  /** 지금 하고 있는 행동 (못 참는 냄새가 쉼을 끊을 때). */
  #current: { readonly event: string; readonly who: string; readonly verb: string; readonly via: string; readonly at: string } | null = null;
  /** 끼니(구간 시작 시각) → 구상한 메뉴. 한 끼에 한 번 정하면 그 끼니 동안 바꾸지 않는다. */
  readonly #menus = new Map<number, string>();
  /** 주문해 오는 중인 재료 → 오는 시각 (그때까지 다시 사지 않는다). */
  readonly #ordered = new Map<string, number>();
  /** 요정의 조언 (아직 닿지 않은 것, 시각 순). */
  readonly #advice: Advice[] = [];
  /** 쉼 → 마지막으로 한 시각 (덜 한 것부터 고른다). */
  readonly #lastPastime = new Map<string, number>();
  /** 마지막으로 기록한 선택지 (같으면 다시 적지 않는다). */
  #lastOptions = '';

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  /** 요정의 조언을 받아 둔다 (시나리오의 advice). 하루씨가 다음에 고를 때 닿는다. */
  advise(list: readonly Advice[]): void {
    this.#advice.push(...list);
    this.#advice.sort((a, b) => a.t - b.t);
  }

  /** 한 단계의 행동 선택. 고르지 않으면 빈 목록. */
  step(world: World, t: number, presence: string, aware: AwareMap, meal?: Meal): RecentAction[] {
    if (!isObserved(this.#vocab, presence)) return [];
    // 못 참는 냄새 (urgency.ts): 하던 쉼을 끊는다. 쉼이 아닌 일은 끝까지 한다
    const whoNow = world.instances().find((i) => i.startsWith('CHR'));
    const urgentSeq = whoNow === undefined ? undefined : Object.values(aware[whoNow] ?? {}).map((k) => k.urgent).filter((x): x is string => x !== undefined).sort().at(-1);
    const stopped: RecentAction[] = [];
    if (t < this.#busyUntil) {
      const cur = this.#current;
      if (urgentSeq === undefined || cur === null || actionClass(this.#vocab, cur.verb) !== 'pastime') return [];
      this.#log.append({ t, type: ACTION_STOPPED, src: AGENCY_SRC, cause: urgentSeq, data: { who: cur.who, stopped: cur.event } });
      stopped.push({ event: cur.event, who: cur.who, verb: cur.verb, via: cur.via, at: cur.at, ends: t, effects: [], stops: true });
      this.#busyUntil = t;
      this.#current = null;
    }
    const instances = world.instances();
    const who = instances.find((i) => i.startsWith('CHR'));
    if (who === undefined) return [];
    const knows = aware[who] ?? {};
    /**
     * 지금 쓸 수 있는 인지 단계. 알아챔은 "무언가 있다"는 앎이라, 본 단계가 0칸이거나 소멸이면(없어졌다고 앎) 알아챔이 아니다.
     * 이해함은 그 상태를 아는 것이라 단계와 상관없이 그대로다 (냄새 없는 곰팡이 사과도 버릴 수 있다).
     */
    const effective = (key: string): string => {
      const k = knows[key];
      if (k === undefined) return 'unknown';
      if (k.aw !== 'noticed') return k.aw;
      const feature = key.slice(key.lastIndexOf(':') + 1);
      const idx = this.#vocab.levelOrder(feature)?.indexOf(k.level) ?? -1;
      return idx > 0 ? k.aw : 'unknown';
    };
    /** 하루씨가 믿는 단계: 본 단계 → 살 때의 상태 → 사다리 0칸. */
    const believed = (key: string): string => {
      const seen = knows[key];
      if (seen !== undefined) return seen.level;
      const bar = key.indexOf('|');
      const sf = key.slice(bar + 1);
      const initial = effectiveInitial(this.#db, world.defOfInstance(key.slice(0, bar)) ?? '')[sf];
      return initial ?? this.#vocab.levelOrder(sf.slice(sf.indexOf(':') + 1))?.at(0) ?? '';
    };
    const rank = (k: string): number => {
      const r = this.#vocab.entry('awareness', k)?.attrs['rank'];
      return typeof r === 'number' ? r : 0;
    };
    /** 자기 숙련 단계 (자기 솜씨는 안다). 숙련 부위가 없는 인물은 빈 값. */
    const skillOf = (f: string): string => (world.keysOf(who).includes(skillKey(who, f)) ? world.level(skillKey(who, f)) : '');
    // 모드 (condition.ts): 지각 층이 남긴 것과 같은 계산. 고를 수 있는 갈래(allows)와 먼저 하는 갈래·걸리는 시간(first·minutes_pct)을 바꾼다
    const whoKeys = new Set(world.keysOf(who));
    const mode = hasCondition(this.#db, world.defOfInstance(who) ?? '')
      ? modeOf(this.#vocab, who, unfinishedCount(this.#db, this.#vocab, instances, (i) => world.defOfInstance(i), (k) => knows[k]?.level), (k) => whoKeys.has(k), (k) => world.level(k))?.mode
      : undefined;
    const lastPlanned = (m: string): number => Math.max(-1, ...[...this.#menus].filter(([, x]) => x === m).map(([from]) => from));
    const knownIds = new Set(Object.keys(knows).map((k) => k.slice(0, k.indexOf('|'))));
    const known = (d: string): string[] => instancesOfKind(world, this.#db, d).filter((i) => knownIds.has(i)).sort();
    // 끼니가 시작되면 메뉴를 구상한다: 있는 줄 아는 재료(앎이 하나라도 있는 개체)와 믿는 남은 양으로. 못 정하면 다음 단계에 다시 본다
    if (meal !== undefined && !this.#menus.has(meal.from)) {
      const pick = conceive(this.#db, this.#vocab, {
        known,
        level: believed,
        skill: skillOf,
        lastPlanned,
      });
      if (pick !== null) {
        this.#menus.set(meal.from, pick.menu);
        this.#log.append({ t, type: MENU_PLANNED, src: AGENCY_SRC, cause: latestSeq(pick.keys.map((k) => knows[k]?.seq)), data: { who, menu: pick.menu, meal: meal.from } });
      }
    }
    const menu = meal === undefined ? undefined : this.#menus.get(meal.from);
    // 장보기 (shopping.ts): 아는 것으로 만들 수 있는 요리가 없으면 모자란 재료를 산다. 오는 중인 주문은 빼고, 다 파는 곳 중 가장 빨리 손에 들어오는 곳
    for (const [d, due] of [...this.#ordered]) if (due <= t) this.#ordered.delete(d);
    const shop = menu !== undefined ? null : shoppingList(this.#db, this.#vocab, { known, level: believed, skill: skillOf, lastPlanned, ordered: (d) => this.#ordered.has(d) });
    let bestBuy: { readonly id: string; readonly ready: number } | null = null;
    if (shop !== null) {
      for (const def of Object.keys(this.#db.defs).sort()) {
        for (const { owner, key, item: offer } of effectiveOffers(this.#db, def)) {
          if (offer.buys === undefined || (offer.during !== undefined && !offer.during.includes(presence)) || !canBuy(offer, shop.items, t)) continue;
          for (const at of instances.filter((i) => world.defOfInstance(i) === def).sort()) {
            const ready = readyAt(offer, t + skilledMinutes(this.#vocab, offer, skillOf));
            if (bestBuy === null || ready < bestBuy.ready) bestBuy = { id: `${owner}/${key}@${at}`, ready };
          }
        }
      }
    }
    const cands: { readonly id: string; readonly offer: string; readonly at: string; readonly verb: string; readonly cls: 'task' | 'pastime' | 'upkeep'; readonly cause: string | null; readonly commit: (advised: string | null) => RecentAction[] }[] = [];
    for (const def of Object.keys(this.#db.defs).sort()) {
      for (const { owner, key, item: offer } of effectiveOffers(this.#db, def)) {
        for (const at of instances.filter((i) => world.defOfInstance(i) === def)) {
          if (offer.during !== undefined && !offer.during.includes(presence)) continue; // 정해진 시간에만 하는 행동 (요리는 식사 준비 시간)
          if (offer.menu !== undefined && (menu === undefined || !menusOf(offer).includes(menu))) continue; // 요리법의 단계는 하루씨가 그 끼니에 구상한 메뉴일 때만
          if (offer.buys !== undefined && (shop === null || bestBuy?.id !== `${owner}/${key}@${at}`)) continue; // 장보기는 고른 가게 하나에서만
          const targets = (p: StatePattern): string[] =>
            (p.def === owner ? [at] : instancesOfKind(world, this.#db, p.def)).map((i) => formatStateKey({ subject: i, slot: p.slot, feature: p.feature }));
          const needs = offer.needs.map((n) => ({ keys: targets(pattern(n.aware)), min: rank(n.at_least) }));
          if (!needs.every((n) => n.keys.some((k) => rank(effective(k)) >= n.min))) continue;
          if (offer.when_meaning !== undefined) {
            const d = this.#db.defs[def];
            const levels: Record<string, number> = {};
            for (const k of world.keysOf(at)) {
              const sf = k.slice(k.indexOf('|') + 1);
              levels[sf] = this.#vocab.levelOrder(sf.slice(sf.indexOf(':') + 1))?.indexOf(believed(k)) ?? -1;
            }
            if (d === undefined || meaningOf(d, levels, this.#vocab)?.means !== offer.when_meaning) continue;
          }
          const when = (offer.when ?? []).map(pattern);
          if (!when.every((p) => targets(p).some((k) => levelMatches(this.#vocab, p.feature, believed(k), p.cond)))) continue;
          const effects = offer.effect.flatMap((text) => {
            const p = pattern(text);
            return targets(p).map((k) => ({ key: k, feature: p.feature, cond: p.cond }));
          });
          if (effects.length > 0 && (offer.places ?? []).length === 0 && (offer.creates ?? []).length === 0 && effects.every((e) => stateMatches(world, this.#vocab, e.key, e.feature, e.cond))) continue;
          // 쓰는 양: 남은 양은 몸이 보는 것이라 세계로 본다. 모자라면 하지 않고, 있으면 steps칸 내린 단계가 결과에 더해진다
          const used = (offer.uses ?? []).map((u) => {
            const p = pattern(u.key);
            // 같은 정의의 조건(썬 양파)에 맞는 것에서 먼저 덜어 낸다
            const sameDef = when.filter((w) => w.def === p.def);
            const fits = (k: string): boolean => sameDef.every((w) => levelMatches(this.#vocab, w.feature, world.level(`${k.slice(0, k.indexOf('|'))}|${w.slot}:${w.feature}`), w.cond));
            return pickUse(this.#vocab, targets(p), p.feature, u.steps, (k) => world.level(k), fits);
          });
          if (used.some((u) => u === null)) continue;
          // 놓임: 조건·옮기기·만들기의 참조는 인스턴스 하나여야 한다. 어디에 두었는지는 몸이 아는 것이라 세계로 본다
          const one = (ref: string): string | null => refInstance(ref, owner, at, (d) => instancesOfKind(world, this.#db, d));
          const whereOk = (offer.where ?? []).every((w) => {
            const a = one(w.what), b = one(w.in ?? w.on ?? '');
            return a !== null && b !== null && world.placeOf(a)?.[w.in !== undefined ? 'in' : 'on'] === b;
          });
          if (!whereOk) continue;
          const moveSpecs = (offer.places ?? []).map((p) => ({ id: one(p.what), to: p.out === true ? null : one(p.in ?? p.on ?? ''), p }));
          if (moveSpecs.some((m) => m.id === null || (m.p.out !== true && m.to === null))) continue;
          const moves = moveSpecs.flatMap((m) => pointerChanges(m.id ?? '', world.placeOf(m.id ?? ''), targetPointers(m.p, m.to)));
          const creates = (offer.creates ?? []).map((c) => ({ def: c.def, rel: c.in !== undefined ? ('in' as const) : c.on !== undefined ? ('on' as const) : undefined, to: c.in ?? c.on }));
          const createTo = creates.map((c) => (c.to === undefined ? undefined : one(c.to)));
          if (createTo.some((x) => x === null)) continue;
          // 산 것: 장보기 목록의 재료가 손에 들어오는 시각에 새 개체로 생겨 그곳에 놓인다
          const shelf = offer.buys === undefined ? null : one(offer.buys.on);
          if (offer.buys !== undefined && shelf === null) continue;
          const bought = offer.buys === undefined || shop === null || shelf === null ? [] : shop.items.map((d) => ({ def: d, rel: 'on' as const, to: shelf, at: bestBuy?.ready ?? t }));
          // 이미 이루어졌으면 하지 않는다: 결과가 다 맞고, 옮길 것이 이미 그곳에 있고, 만들 것이 없을 때
          if (creates.length === 0 && moveSpecs.length > 0 && moves.length === 0 && (effects.length === 0 || effects.every((e) => stateMatches(world, this.#vocab, e.key, e.feature, e.cond)))) continue;
          // 같은 앎에서는 되풀이하지 않는다: 필요한 앎과 조건(when)에 걸린 앎(본 단계)이 바뀌면 다시 할 수 있다.
          // 상태 의미(when_meaning)로 고르는 행동은 그 물건의 모든 앎을 본다. 조건과 상관없는 상태(주방의 창문)가 바뀐 것은 새 앎이 아니다
          const sigKeys = offer.when_meaning !== undefined ? world.keysOf(at) : [...new Set(when.flatMap((p) => targets(p)))].sort();
          // 심상 사다리로 아는 종류는 단계 대신 그 사다리가 열린 사건으로 본다: 살펴서 정체를 알아 믿음이 바뀐 것은 새 냄새가 아니다
          const knowing = (k: string): string => `${knows[k]?.aw ?? 'unknown'}:${knows[k]?.since ?? knows[k]?.level ?? ''}`;
          // 요리법의 단계는 한 끼(일정 구간)에 한 번: 끝나고 시간이 남아도 같은 메뉴를 다시 만들지 않는다
          const cls = actionClass(this.#vocab, offer.verb);
          // 방전: 쉼만. 못 참는 냄새면 냄새를 없애려는 행동은 한다
          if (mode?.allows !== undefined && !mode.allows.includes(cls) && !(urgentSeq !== undefined && againstOdor(this.#vocab, offer.verb))) continue;
          const signature = offer.buys !== undefined || cls === 'pastime' // 장보기와 쉼은 되풀이할 수 있다
            ? `${owner}/${key}@${at}|again@${t}`
            : offer.menu !== undefined
            ? `${owner}/${key}@${at}|meal@${meal?.from ?? ''}`
            : `${owner}/${key}@${at}|${JSON.stringify([needs.map((n) => n.keys.map(knowing)), sigKeys.map(knowing)])}`;
          if (this.#tried.has(signature)) continue;
          // 원인: 이 행동의 조건을 채운 앎들 중 가장 최근에 생긴 것 (needs · when · 상태 의미를 만든 앎)
          const why = latestSeq([
            ...needs.flatMap((n) => n.keys.filter((k) => rank(effective(k)) >= n.min).map((k) => knows[k]?.seq)),
            ...when.flatMap((p) => targets(p).filter((k) => levelMatches(this.#vocab, p.feature, believed(k), p.cond)).map((k) => knows[k]?.seq)),
            ...(offer.when_meaning !== undefined ? world.keysOf(at).map((k) => knows[k]?.seq) : []),
          ]);
          const commit = (advised: string | null): RecentAction[] => {
          this.#tried.add(signature);
          const ends = t + modeMinutes(skilledMinutes(this.#vocab, offer, skillOf), mode, cls);
          for (const b of bought) if (b.at > ends) this.#ordered.set(b.def, b.at);
          this.#busyUntil = ends;
          if (cls === 'pastime') this.#lastPastime.set(`${formatVia(owner, 'offer', key)}@${at}`, t);
          const e = this.#log.append({ t, type: ACTION_CHOSEN, src: AGENCY_SRC, cause: why, data: { who, verb: offer.verb, via: formatVia(owner, 'offer', key), at, ends, ...(offer.menu !== undefined && menu !== undefined ? { menu, meal: meal?.from ?? null } : {}), ...(shop !== null && bought.length > 0 ? { buys: [...shop.items], for: shop.menu, ready: bestBuy?.ready ?? ends } : {}), ...(advised !== null ? { advised } : {}) } });
          return [
            {
              event: e.seq,
              who,
              verb: offer.verb,
              via: formatVia(owner, 'offer', key),
              at,
              ends,
              effects: [
                ...effects.map((x) => ({ key: x.key, op: x.cond?.op ?? '=', level: x.cond?.level ?? '' })),
                ...used.flatMap((u) => (u === null ? [] : [{ key: u.key, op: '=', level: u.to }])),
              ],
              ...(offer.reveals === true ? { reveals: at } : {}),
              ...(creates.length + bought.length > 0
                ? { creates: [...creates.map((c, i) => ({ def: c.def, ...(c.rel !== undefined && typeof createTo[i] === 'string' ? { rel: c.rel, to: createTo[i] } : {}) })), ...bought.map((b) => ({ def: b.def, rel: b.rel, to: b.to, ...(b.at > ends ? { at: b.at } : {}) }))] }
                : {}),
              ...(offer.away === true ? { away: true } : {}),
              ...(moves.length > 0 ? { moves } : {}),
              // 숙련 부위가 없는 인물은 쌓지 않는다
              ...((offer.trains ?? []).some((f) => world.keysOf(who).includes(skillKey(who, f)))
                ? { trains: (offer.trains ?? []).filter((f) => world.keysOf(who).includes(skillKey(who, f))).map((f) => ({ feature: f, gain: practiceGain(offer) })) }
                : {}),
            },
          ];
          };
          cands.push({ id: `${formatVia(owner, 'offer', key)}@${at}`, offer: formatVia(owner, 'offer', key), at, verb: offer.verb, cls, cause: why, commit });
        }
      }
    }
    const picked = this.#choose(world, t, who, cands, urgentSeq !== undefined ? 'against_odor' : mode?.first);
    const first = picked[0];
    if (first !== undefined) this.#current = { event: first.event, who: first.who, verb: first.verb, via: first.via, at: first.at };
    return [...stopped, ...picked];
  }

  /**
   * ⓒ 해석 후 행동 (내면-설계 12장): 하루씨가 떠올린 선택지 중 하나를 고른다.
   *   - 할 일(요리·설거지·장보기 …)이 있으면 하루씨가 먼저 한다 (정의 순).
   *   - 없으면 쉼(앉아 쉬기·눕기·드라마·웹툰) 중 덜 한 것을 고른다. 집안일(바닥 닦기·버리기)은 쉴 거리가 없을 때만 스스로 한다.
   *   - 할 일이 없는 때의 선택지가 둘 이상이면 선택지를 남긴다 (요정이 보는 것, 바뀔 때만).
   *   - 요정의 조언: 그 시각이 지난 조언 하나가 다음에 고를 때 닿는다. 선택지 중 하나면 그것을 고르고, 아니면 듣지 않는다.
   *     스트레스 임계(생각이 멈춤)에 있으면 해석하지 못해 듣지 않는다.
   */
  #choose(world: World, t: number, who: string, cands: readonly { readonly id: string; readonly offer: string; readonly at: string; readonly verb: string; readonly cls: 'task' | 'pastime' | 'upkeep'; readonly cause: string | null; readonly commit: (advised: string | null) => RecentAction[] }[], firstCls?: string): RecentAction[] {
    const tasks = cands.filter((c) => c.cls === 'task');
    const free = cands.filter((c) => c.cls !== 'task');
    if (tasks.length === 0 && free.length >= 2) {
      const options = free.map((c) => ({ offer: c.offer, at: c.at, verb: c.verb, kind: c.cls }));
      const sig = JSON.stringify(options);
      if (sig !== this.#lastOptions) {
        this.#lastOptions = sig;
        this.#log.append({ t, type: OPTIONS_FORMED, src: AGENCY_SRC, cause: latestSeq(free.map((c) => c.cause ?? undefined)), data: { who, options } });
      }
    }
    const adv = this.#advice[0];
    if (adv !== undefined && adv.t <= t) {
      this.#advice.shift();
      const given = this.#log.append({ t, type: ADVICE_GIVEN, src: FAIRY_SRC, cause: null, data: { who, offer: adv.offer, at: adv.at, asked: adv.t } });
      const def = this.#db.defs[world.defOfInstance(who) ?? ''];
      const mind = def?.mind;
      const stuck = mind !== undefined && def?.slots?.[MOOD_SLOT] !== undefined && isOverwhelmed(this.#vocab, mind, who, (k) => world.level(k));
      const pick = cands.find((c) => c.id === `${adv.offer}@${adv.at}`);
      if (stuck || pick === undefined) this.#log.append({ t, type: ADVICE_IGNORED, src: AGENCY_SRC, cause: given.seq, data: { who, reason: stuck ? 'overwhelmed' : 'not_option' } });
      else return pick.commit(given.seq);
    }
    const last = (c: { readonly id: string }): number => this.#lastPastime.get(c.id) ?? -1;
    const rest = cands.filter((c) => c.cls === 'pastime').sort((a, b) => last(a) - last(b))[0];
    // 몰아침: 그 갈래(집안일)를 먼저 한다. 못 참는 냄새면 냄새를 없애려는 행동을 먼저 (firstCls = against_odor)
    const lead = firstCls === 'against_odor' ? cands.find((c) => againstOdor(this.#vocab, c.verb)) : firstCls !== undefined ? cands.find((c) => c.cls === firstCls) : undefined;
    const first = lead ?? tasks[0] ?? rest ?? cands.find((c) => c.cls === 'upkeep');
    return first === undefined ? [] : first.commit(null);
  }
}
