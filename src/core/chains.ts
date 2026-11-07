// 규칙 사슬 (docs/DB-개념-이식.md 1-4)
//
// 한 규칙의 emits 패턴과 다른 규칙의 on 패턴이 맞으면 두 규칙은 자동으로 이어진다.
// 사람이 연결을 쓰지 않는다. "콘텐츠는 시스템에서 나온다"의 핵심 장치.

import type { Db, RuleDef } from './db.ts';
import { kindMembers } from './kinds.ts';
import { canLink, parsePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import type { StatePattern } from './statekey.ts';

export interface RuleNode {
  /** `소유자 정의 번호/rule/키` */
  readonly ref: string;
  readonly owner: string;
  readonly key: string;
  readonly rule: RuleDef;
  readonly on: readonly StatePattern[];
  readonly emits: readonly StatePattern[];
}

export interface ChainEdge {
  readonly from: string;
  readonly to: string;
  /** 이어 준 패턴 쌍 [from의 emits, to의 on] */
  readonly via: readonly [string, string];
}

function parseAll(texts: readonly string[]): StatePattern[] {
  return texts.map((t) => parsePattern(t)).filter((p): p is StatePattern => p !== null);
}

export function ruleRef(owner: string, key: string): string {
  return `${owner}/rule/${key}`;
}

export function collectRules(db: Db): RuleNode[] {
  const nodes: RuleNode[] = [];
  for (const id of Object.keys(db.defs).sort()) {
    const def = db.defs[id];
    if (def?.rules === undefined) continue;
    for (const key of Object.keys(def.rules).sort()) {
      const rule = def.rules[key] as RuleDef;
      nodes.push({ ref: ruleRef(id, key), owner: id, key, rule, on: parseAll(rule.on), emits: parseAll(rule.emits) });
    }
  }
  return nodes;
}

/** 저장소 밖에서 만든 규칙(번짐 규칙 등)을 사슬 노드로. 패턴은 이미 해석된 것이다. */
export function ruleNodes(list: readonly { readonly owner: string; readonly key: string; readonly on: readonly StatePattern[]; readonly emits: readonly StatePattern[] }[]): RuleNode[] {
  return list.map((r) => ({
    ref: ruleRef(r.owner, r.key),
    owner: r.owner,
    key: r.key,
    rule: { on: r.on.map(patternText), emits: r.emits.map(patternText) },
    on: r.on,
    emits: r.emits,
  }));
}

function patternText(p: StatePattern): string {
  const cond = p.cond === null ? '' : `@${p.cond.op}${p.cond.level}`;
  return `${p.def}|${p.slot}:${p.feature}${cond}`;
}

/**
 * 결과 패턴 e가 조건 패턴 o를 채울 수 있는가. 종류(is_a)를 안다: o가 종류 C를 가리키면 C의 종류에 속한 정의의 결과도 맞는다
 * (인과가 패턴을 "C의 종류 전부"에 거는 것과 같다, kinds.ts). db를 주지 않으면 같은 정의끼리만 본다.
 */
function links(e: StatePattern, o: StatePattern, vocab: Vocab, db: Db | undefined): boolean {
  const order = vocab.levelOrder(e.feature);
  if (e.def === o.def || db === undefined) return canLink(e, o, order);
  const sameKind = kindMembers(db, o.def).has(e.def) || kindMembers(db, e.def).has(o.def);
  return sameKind && canLink({ ...e, def: o.def }, o, order);
}

/** 자기 자신으로 돌아오는 연결(자기 순환)은 간선에 넣지 않는다 — selfLoops로 따로 찾는다. */
export function buildEdges(rules: readonly RuleNode[], vocab: Vocab, db?: Db): ChainEdge[] {
  const edges: ChainEdge[] = [];
  for (const a of rules) {
    for (const b of rules) {
      if (a.ref === b.ref) continue;
      let found: readonly [string, string] | null = null;
      for (const e of a.emits) {
        for (const o of b.on) {
          if (found === null && links(e, o, vocab, db)) found = [patternText(e), patternText(o)];
        }
      }
      if (found !== null) edges.push({ from: a.ref, to: b.ref, via: found });
    }
  }
  return edges;
}

/** 자기 emits가 자기 on을 다시 만족시키는 규칙. */
export function selfLoops(rules: readonly RuleNode[], vocab: Vocab, db?: Db): string[] {
  return rules
    .filter((r) => r.emits.some((e) => r.on.some((o) => links(e, o, vocab, db))))
    .map((r) => r.ref);
}

/** 시작 규칙에서 갈 수 있는 모든 끝까지의 단순 경로 (되돌아오지 않음). 가장 긴 것부터. */
export function chainsFrom(edges: readonly ChainEdge[], start: string, maxDepth = 8): string[][] {
  const out: string[][] = [];
  const walk = (path: string[]): void => {
    const last = path[path.length - 1] as string;
    const nexts = edges.filter((e) => e.from === last && !path.includes(e.to)).map((e) => e.to);
    if (nexts.length === 0 || path.length >= maxDepth) {
      out.push(path);
      return;
    }
    for (const n of [...new Set(nexts)].sort()) walk([...path, n]);
  };
  walk([start]);
  return out.sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()));
}

/** 다른 규칙이 일으키지 않는 규칙(사슬의 시작점). */
export function chainRoots(rules: readonly RuleNode[], edges: readonly ChainEdge[]): string[] {
  const hasIncoming = new Set(edges.map((e) => e.to));
  return rules.map((r) => r.ref).filter((ref) => !hasIncoming.has(ref));
}
