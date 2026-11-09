// 감각 자체 (내면-설계 2장, 작가 2026-11-08: "모든 감정은 감각 위에 서 있다. 감각 자체를 느끼는 거야")
//
// 물건·장소의 상태가 감각질(사전 sensation: 까끌까끌함·뜨거움·단맛·신향 …)을 준다 (정의의 feels, 종류로 물려받음).
// 감각마다 닿는 길(사전 sense의 reach)이 다르다:
//   - distance(후각·시각·청각): 머무는 곳에서. 장소 자신과 그곳에 놓여 보이는 물건이 주는 것을 느끼기 시작하고, 사라지면 그친다.
//   - contact(촉각): 손으로 다루는 행동(사전 action의 handles)이 끝날 때 그 물건에서 한 번.
//   - mouth(미각): 먹는 행동(eats)이 끝날 때 그 음식에서 한 번.
// 감각질은 **무엇에서 왔는지 모른 채** 느낀다 (기록에 원천을 적지 않는다). 해석은 그 위의 일이다.
// 지각 층과 감사가 같은 계산을 쓴다.

import { openLadder } from './amount.ts';
import { latestSeq } from './events.ts';
import { levelMatches } from './causal.ts';
import type { Db } from './db.ts';
import { effectiveFeels } from './kinds.ts';
import { parseLocalCondition } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export const STIMULUS_PERCEIVED = 'stimulus_perceived';

/** 세계를 읽는 창 (지각 층은 World, 감사는 따라간 단계로 만든다). */
export interface StateView {
  readonly defOf: (instance: string) => string | undefined;
  readonly has: (key: string) => boolean;
  readonly level: (key: string) => string;
}

export interface FeltOne {
  readonly sensation: string;
  readonly sense: string;
  /** 이 감각질을 준 조건의 상태 키들 (원인을 찾는 데 쓴다). */
  readonly keys: readonly string[];
  /** 준 개체 (기록에는 적지 않는다: 무엇에서 왔는지 모른 채 느낀다). 조건이 없는 감각질의 원인을 찾는 데만 쓴다. */
  readonly source: string;
  /** 느낀 세기: 1 ~ scale (그 감각을 몇 단계로 구분해 느끼는지에 맞춘 칸). */
  readonly level: number;
  readonly scale: number;
}

/** 이 감각으로 세기를 몇 단계로 구분하나 (인물 정의 senses의 levels, 없으면 3 — 임시값, 내면-설계 8장). */
export function scaleOf(db: Db, characterDef: string, sense: string): number {
  return db.defs[characterDef]?.senses?.[sense]?.levels ?? DEFAULT_SCALE;
}

export const DEFAULT_SCALE = 3;

/**
 * 세기: 세기를 정하는 상태(by)가 그 감각질을 주는 칸들 중 몇 번째로 센지를, 그 사람의 단계 수에 맞춰 올림한다 (1 ~ scale).
 * 그 감각질을 주는 칸 = by 특징에 걸린 조건(when)에 맞는 열린 칸, 조건이 없으면 0칸(없음)을 뺀 열린 칸.
 * 예: 차가움(온도 냉장 이하, reverse)은 냉장 < 냉동, 뜨거움(가열 뜨거움 이상)은 뜨거움 < 끓음 < 튀김.
 * 칸이 거칠면(2단계) 약한 것과 센 것만 가르고, 세밀하면(5단계) 더 나눈다. by가 없으면 가장 센 칸.
 */
export function feltLevel(vocab: Vocab, view: StateView, instance: string, by: string | undefined, reverse: boolean, scale: number, when: readonly string[] = []): number {
  if (by === undefined) return scale;
  const c = parseLocalCondition(by);
  if (c === null) return scale;
  const own = when.flatMap((w) => {
    const x = parseLocalCondition(w);
    return x !== null && x.slot === c.slot && x.feature === c.feature ? [x.cond] : [];
  });
  const open = openLadder(vocab, c.feature);
  const rungs = own.length > 0 ? open.filter((k) => own.every((cond) => levelMatches(vocab, c.feature, k, cond))) : open.slice(1);
  const ordered = reverse ? [...rungs].reverse() : rungs;
  const pos = ordered.indexOf(view.level(`${instance}|${c.slot}:${c.feature}`));
  if (ordered.length === 0) return scale;
  return Math.min(scale, Math.max(1, Math.ceil(((Math.max(0, pos) + 1) * scale) / ordered.length)));
}

/** 감각이 닿는 길 (사전 sense의 reach). */
export function reachOf(vocab: Vocab, sense: string): string {
  const r = vocab.entry('sense', sense)?.attrs['reach'];
  return typeof r === 'string' ? r : '';
}

/** 이 개체가 지금 주는 감각질 중, 그 길(reach)로 닿고 느끼는 이가 가진 감각인 것. */
export function sensationsOf(db: Db, vocab: Vocab, view: StateView, instance: string, reach: string, senses: ReadonlySet<string>, scale: (sense: string) => number = () => DEFAULT_SCALE): FeltOne[] {
  const def = view.defOf(instance);
  if (def === undefined) return [];
  const out: FeltOne[] = [];
  for (const f of effectiveFeels(db, def)) {
    const sense = vocab.entry('sensation', f.sensation)?.attrs['sense'];
    if (typeof sense !== 'string' || !senses.has(sense) || reachOf(vocab, sense) !== reach) continue;
    const keys: string[] = [];
    const ok = f.when.every((w) => {
      const c = parseLocalCondition(w);
      if (c === null) return false;
      const key = `${instance}|${c.slot}:${c.feature}`;
      keys.push(key);
      return view.has(key) && levelMatches(vocab, c.feature, view.level(key), c.cond);
    });
    if (ok) out.push({ sensation: f.sensation, sense, keys, source: instance, level: feltLevel(vocab, view, instance, f.by, f.reverse === true, scale(sense), f.when), scale: scale(sense) });
  }
  return out;
}

/** 여러 원천이 주는 감각질 (감각질마다 가장 센 것, 같으면 먼저 온 원천). 원천 순서는 부르는 쪽이 정한다 (장소, 그다음 보이는 물건, 각각 번호 순). */
export function feltFrom(db: Db, vocab: Vocab, view: StateView, sources: readonly string[], reach: string, senses: ReadonlySet<string>, scale?: (sense: string) => number): Map<string, FeltOne> {
  const out = new Map<string, FeltOne>();
  for (const s of sources) {
    for (const f of sensationsOf(db, vocab, view, s, reach, senses, scale)) {
      const had = out.get(f.sensation);
      if (had === undefined || f.level > had.level) out.set(f.sensation, f);
    }
  }
  return out;
}

/** 느끼기 시작한 것·그친 것의 원인: 그 조건 상태를 마지막으로 정한 사건 중 가장 최근. 조건이 없으면 그 개체가 생긴 사건. */
export function feltCause(f: FeltOne, lastChange: (key: string) => string | null, born: (id: string) => string | null): string | null {
  return f.keys.length === 0 ? born(f.source) : latestSeq(f.keys.map((k) => lastChange(k) ?? undefined));
}

/**
 * 그친 것의 원인: 지금 원천들 중 그 감각질을 줄 수 있었던 조건들의 상태를 마지막으로 정한 사건 중 가장 최근 (그 변화로 그쳤다).
 * 기억에 기대지 않고 지금 상태에서만 계산한다. 조건이 하나도 없으면(원천이 보이지 않게 됨) null.
 */
export function stopCause(db: Db, vocab: Vocab, sources: readonly string[], sensation: string, defOf: (i: string) => string | undefined, lastChange: (key: string) => string | null): string | null {
  const keys: string[] = [];
  for (const s of sources) {
    for (const f of effectiveFeels(db, defOf(s) ?? '')) {
      if (f.sensation !== sensation) continue;
      for (const w of f.when) {
        const c = parseLocalCondition(w);
        if (c !== null) keys.push(`${s}|${c.slot}:${c.feature}`);
      }
    }
  }
  return latestSeq(keys.map((k) => lastChange(k) ?? undefined));
}

/** 인물이 가진 감각 (인물 정의의 senses 키). */
export function sensesOf(db: Db, characterDef: string): Set<string> {
  return new Set(Object.keys(db.defs[characterDef]?.senses ?? {}));
}

/** 이 행동이 닿는 길: 손으로 다루면 contact, 먹으면 mouth (사전 action). */
export function actionReaches(vocab: Vocab, verb: string): string[] {
  const a = vocab.entry('action', verb)?.attrs ?? {};
  return [...(a['handles'] === true ? ['contact'] : []), ...(a['eats'] === true ? ['mouth'] : [])];
}
