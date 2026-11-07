// 번짐 (3층 인과의 일부) — 장소 그래프를 따라 장소의 상태가 이웃 장소로 번진다 (docs/번짐-명세.md · 결정-기록 "공간과 번짐 1차")
//
// 장소 그래프(1층 공간)의 통로와 사전의 번짐 개체(spreader)에서 **번짐 규칙을 만들어** 인과(causal.ts)에 넘긴다.
// 규칙은 손으로 쓴 규칙과 같은 모양이라 지연·재판정·취소·정확한 시각을 그대로 쓴다. 난수를 쓰지 않는다.
//
//   - 원천: 어떤 규칙이 그 장소의 그 특징을 바꾸는 장소 (예: 음식 냄새가 주방 냄새를 만든다 → 주방이 냄새의 원천).
//     받는 장소: 같은 특징을 가졌고 규칙이 바꾸지 않는 장소. 받는 장소의 단계는 번짐만 정한다.
//   - 받는 단계 = floor(원천 단계 × 경로의 투과율 곱 ÷ 1000^칸) − 감쇠 × 칸, 그 아래의 잠기지 않은 칸으로 내린다.
//     경로는 그 매질의 투과율이 0보다 큰 통로만 지난다. 경로가 여럿이면 가장 높은 단계를 주는 것 (같으면 칸이 적은 것, 그다음 번호 순).
//   - 지연 = 칸 × hop_s. 올라갈 때와 내려갈 때 모두 (원천이 약해지면 받는 장소도 약해진다).
//   - 1차의 한계 (한계-등록부): 단계 사다리로 계산한다 (개체의 양 단위는 미정), 원천이 하나인 특징만 계산한다,
//     문은 늘 닫힌 상태의 투과율이다 (문 자동 규칙 보류), 운반 매질(접촉)은 계산하지 않는다.
// 코드에 장소·개체 이름을 박지 않는다. 무엇이 어떻게 번지는지는 사전과 데이터에 있다.

import type { Db, Definition } from './db.ts';
import { effectiveRules } from './kinds.ts';
import { parsePattern } from './statekey.ts';
import type { StatePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';

/** 인과가 받는 규칙의 모양 (causal.ts의 Rule과 같다). */
export interface SpreadRule {
  readonly def: string;
  readonly owner: string;
  readonly key: string;
  readonly on: readonly StatePattern[];
  readonly onAll: readonly StatePattern[];
  readonly emits: readonly StatePattern[];
  readonly delayMin: number;
}

export interface Spreader {
  readonly key: string;
  readonly feature: string;
  readonly medium: string;
  readonly attenuation: number;
  readonly hopMin: number;
}

export interface Edge {
  readonly to: string;
  readonly kind: string;
  readonly pass: { readonly [medium: string]: number };
}

const isPlace = (d: Definition | undefined): boolean => d !== undefined && d.id.startsWith('PLC');

/** 장소 그래프 (방향 없음). 통로는 한쪽에만 적혀 있어도 양쪽에서 보인다. */
export function placeGraph(db: Db): Map<string, Edge[]> {
  const g = new Map<string, Edge[]>();
  for (const id of Object.keys(db.defs).sort()) if (isPlace(db.defs[id])) g.set(id, []);
  for (const id of [...g.keys()]) {
    for (const p of db.defs[id]?.passages ?? []) {
      if (!g.has(p.to)) continue; // 없는 장소는 관문이 보고한다
      g.get(id)?.push({ to: p.to, kind: p.kind, pass: p.medium_pass });
      g.get(p.to)?.push({ to: id, kind: p.kind, pass: p.medium_pass });
    }
  }
  for (const list of g.values()) list.sort((a, b) => a.to.localeCompare(b.to));
  return g;
}

export function hasPassages(db: Db): boolean {
  return Object.values(db.defs).some((d) => isPlace(d) && (d.passages?.length ?? 0) > 0);
}

/** 사전의 번짐 개체 중 계산할 수 있는 것 (feature·attenuation·hop_s가 있는 것). */
export function spreaders(vocab: Vocab): Spreader[] {
  return vocab.keys('spreader').flatMap((key) => {
    const a = vocab.entry('spreader', key)?.attrs ?? {};
    const { feature, medium, attenuation, hop_s: hop } = a;
    if (typeof feature !== 'string' || typeof medium !== 'string' || typeof attenuation !== 'number' || typeof hop !== 'number') return [];
    return [{ key, feature, medium, attenuation, hopMin: hop / 60 }];
  });
}

/** 장소에서 그 특징을 가진 부위 (번호 순 첫 부위). 없으면 null. */
export function slotOf(def: Definition | undefined, feature: string): string | null {
  if (def === undefined) return null;
  return Object.keys(def.slots ?? {}).sort().find((s) => def.slots?.[s]?.features.includes(feature)) ?? null;
}

/** 그 특징의 원천 장소: 어떤 정의의 규칙이 그 장소의 그 특징을 결과로 바꾼다. */
export function spreadSources(db: Db, feature: string): string[] {
  const out = new Set<string>();
  for (const def of Object.keys(db.defs)) {
    for (const { item } of effectiveRules(db, def)) {
      for (const text of item.emits) {
        const p = parsePattern(text);
        if (p !== null && p.feature === feature && isPlace(db.defs[p.def])) out.add(p.def);
      }
    }
  }
  return [...out].sort();
}

export class SpreadError extends Error {
  override name = 'SpreadError';
}

/** 번짐 계산 전에 확인할 것. 관문이 같은 목록을 오류로 보고한다. */
export function spreadIssues(db: Db, vocab: Vocab): string[] {
  if (!hasPassages(db)) return [];
  const issues: string[] = [];
  for (const s of spreaders(vocab)) {
    const sources = spreadSources(db, s.feature);
    if (sources.length > 1) issues.push(`번짐 "${s.key}"(${s.feature})의 원천 장소가 둘 이상이다 (${sources.join(', ')}) — 원천이 여럿인 번짐은 아직 계산하지 않는다 (한계-등록부)`);
  }
  return issues;
}

interface Path {
  readonly hops: number;
  readonly product: bigint; // 투과율의 곱
  readonly nodes: readonly string[];
}

/** 원천에서 각 장소로 가는 단순 경로들 (그 매질의 투과율이 0보다 큰 통로만). */
function paths(g: ReadonlyMap<string, readonly Edge[]>, from: string, medium: string): Map<string, Path[]> {
  const out = new Map<string, Path[]>();
  const walk = (node: string, path: Path): void => {
    for (const e of g.get(node) ?? []) {
      const pass = e.pass[medium] ?? 0;
      if (pass <= 0 || path.nodes.includes(e.to)) continue;
      const next: Path = { hops: path.hops + 1, product: path.product * BigInt(pass), nodes: [...path.nodes, e.to] };
      out.set(e.to, [...(out.get(e.to) ?? []), next]);
      walk(e.to, next);
    }
  };
  walk(from, { hops: 0, product: 1n, nodes: [from] });
  return out;
}

/** 칸 번호 v 이하의 잠기지 않은 칸 (0칸 이상). */
function snapDown(vocab: Vocab, feature: string, order: readonly string[], v: number): number {
  for (let i = Math.min(v, order.length - 1); i > 0; i--) if (!vocab.isLocked(feature, order[i] ?? '')) return i;
  return 0;
}

/** 원천 단계 i가 경로를 지나 받는 장소에 만드는 칸. */
function received(vocab: Vocab, s: Spreader, order: readonly string[], i: number, p: Path): number {
  const scaled = Number((BigInt(i) * p.product) / 1000n ** BigInt(p.hops));
  return snapDown(vocab, s.feature, order, scaled - s.attenuation * p.hops);
}

/** 장소 그래프와 사전에서 번짐 규칙을 만든다. 통로가 없으면 빈 목록. 관문을 지난 저장소만 받는다. */
export function spreadRules(db: Db, vocab: Vocab): SpreadRule[] {
  if (!hasPassages(db)) return [];
  const problems = spreadIssues(db, vocab);
  if (problems.length > 0) throw new SpreadError(problems.join('\n'));
  const g = placeGraph(db);
  const rules: SpreadRule[] = [];
  for (const s of spreaders(vocab)) {
    const order = vocab.levelOrder(s.feature);
    if (order === undefined) continue;
    const top = snapDown(vocab, s.feature, order, order.length - 1);
    const sources = new Set(spreadSources(db, s.feature));
    for (const source of sources) {
      const sourceSlot = slotOf(db.defs[source], s.feature);
      if (sourceSlot === null) continue;
      for (const [to, list] of paths(g, source, s.medium)) {
        const slot = slotOf(db.defs[to], s.feature);
        if (slot === null || sources.has(to)) continue;
        const best = [...list].sort(
          (a, b) => received(vocab, s, order, top, b) - received(vocab, s, order, top, a) || a.hops - b.hops || a.nodes.join().localeCompare(b.nodes.join()),
        )[0];
        if (best === undefined || received(vocab, s, order, top, best) === 0) continue; // 가장 짙어도 닿지 않으면 규칙이 없다
        const delayMin = best.hops * s.hopMin;
        const at = (def: string, sl: string, op: '>=' | '<=', level: string): StatePattern => ({ def, slot: sl, feature: s.feature, cond: { op, level } });
        order.forEach((level, i) => {
          if (vocab.isLocked(s.feature, level)) return;
          const got = order[received(vocab, s, order, i, best)] ?? order[0] ?? '';
          // 올라감: 원천이 이 단계 이상이면 받는 장소는 적어도 그만큼 (0칸이면 만들 것이 없다)
          if (i > 0 && got !== order[0]) {
            rules.push({ def: to, owner: to, key: `spread_${s.key}_ge_${level}`, on: [at(source, sourceSlot, '>=', level)], onAll: [], emits: [at(to, slot, '>=', got)], delayMin });
          }
          // 내려감: 원천이 이 단계 이하면 받는 장소는 많아야 그만큼
          if (i < top) {
            rules.push({ def: to, owner: to, key: `spread_${s.key}_le_${level}`, on: [at(source, sourceSlot, '<=', level)], onAll: [], emits: [at(to, slot, '<=', got)], delayMin });
          }
        });
      }
    }
  }
  return rules;
}
