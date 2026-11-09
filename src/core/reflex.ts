// 반사 (내면-설계 8장, 작가 2026-11-08): 감각 자체에 곧바로 붙는 즉각 반응 — 무조건반사와 조건반사. 요정이 닿지 않는다.
//
// 사전 reflex: { on: 감각질, at_least: 그 사람의 단계 중 몇 % 이상 세게 느끼면(1~100), kind: unconditioned | conditioned }.
// 조건반사는 pairs_with(그 감각이 예고하는 다른 감각질)와 times(짝지어 겪은 횟수)를 더 갖는다:
// on 감각질을 멀리서 느끼고 있는 동안 pairs_with를 닿거나 먹어서 느낄 때마다 한 번 짝지어지고, times번이 되면 배운다.
// 반사는 그 감각질을 새로 느끼거나, 세기가 올라 처음 문턱을 넘을 때, 또는 닿거나 먹은 순간에 일어난다. 난수 없음.
// 지각 층과 감사가 같은 계산을 쓴다. 반사는 지금 몸의 반응으로만 기록되고 세계를 바꾸지 않는다 (LIM032).

import type { Vocab } from './vocab.ts';

export const REFLEX = 'reflex';
export const REFLEX_LEARNED = 'reflex_learned';

export interface ReflexDef {
  readonly key: string;
  readonly on: string;
  readonly atLeast: number;
  readonly conditioned: boolean;
  readonly pairsWith?: string;
  readonly times?: number;
}

/** 사전의 반사 (키 순). */
export function reflexDefs(vocab: Vocab): ReflexDef[] {
  return vocab.keys('reflex').sort().flatMap((key) => {
    const a = vocab.entry('reflex', key)?.attrs ?? {};
    if (typeof a['on'] !== 'string' || typeof a['at_least'] !== 'number') return [];
    const conditioned = a['kind'] === 'conditioned';
    return [{ key, on: a['on'], atLeast: a['at_least'], conditioned, ...(conditioned ? { pairsWith: String(a['pairs_with']), times: Number(a['times']) } : {}) }];
  });
}

/** 그 세기가 문턱 이상인가 (그 사람의 단계 수 중 몇 %). */
export function reaches(r: ReflexDef, level: number, scale: number): boolean {
  return level * 100 >= r.atLeast * scale;
}

/** 이번에 일어나는가: 지금 문턱 이상이고, 전에는(세기가 바뀐 것이면) 문턱 아래였다. */
export function triggers(r: ReflexDef, level: number, scale: number, was: number | undefined): boolean {
  return reaches(r, level, scale) && (was === undefined || !reaches(r, was, scale));
}
