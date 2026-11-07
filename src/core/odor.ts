// 냄새의 원인 사슬 (docs/냄새-모델.md · 결정-기록 "냄새의 원인과 종류")
//
// 지식 해상도(사전): 원인(부패·시어짐·곰팡이·요리 …) → 균주 → 유기화합물 → 냄새 종류.
// 시뮬레이션 해상도(규칙): 원인의 단계에 이르면 그 단계의 냄새 세기와 대표 냄새 종류가 물건에 생긴다.
// 이 파일은 둘 사이의 다리다 — 사슬을 계산하고(odorChain), 사슬에서 규칙을 만든다(odorRules).
// 번짐 규칙을 통로 그래프에서 만드는 것과 같은 방식이고, 엔진은 냄새·균주·화합물 이름을 모른다. 난수를 쓰지 않는다.
//
// 대표 냄새 = 그 단계의 화합물들이 내는 냄새 종류 중 가장 심각한 것 (사전 odor_kind의 rank = 특징 사다리 칸 번호).
// 여러 종류가 섞이는 것은 사다리의 `>=` 규칙(올리기만 함)으로 나타난다: 가장 심각한 종류가 이긴다.

import type { Db } from './db.ts';
import { slotOf } from './spread.ts';
import type { SpreadRule } from './spread.ts';
import type { Vocab } from './vocab.ts';

export interface OdorStage {
  /** 냄새 원인 (사전 odor_cause 키) */
  readonly cause: string;
  /** 원인의 단계를 가진 특징과 그 단계. 요리처럼 단계가 없는 원인은 null */
  readonly feature: string | null;
  readonly at: string | null;
  readonly strains: readonly string[];
  readonly compounds: readonly string[];
  /** 이 단계에서 나는 냄새 종류들, 심각한 것부터 */
  readonly kinds: readonly string[];
  /** 대표 냄새 종류 (가장 심각한 것)와 그것이 들어가는 특징 */
  readonly dominant: string;
  readonly kindFeature: string;
  /** 이 단계의 냄새 세기 (예: 상함 → smell 뚜렷함). 적지 않은 단계는 null */
  readonly strength: { readonly feature: string; readonly level: string } | null;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 사전의 냄새 지식에서 단계마다의 사슬을 계산한다 (원인 키 순, 단계 순). 사전 검증을 지난 것만 받는다. */
export function odorChain(vocab: Vocab): OdorStage[] {
  const out: OdorStage[] = [];
  const odorOf = (compound: string): string => {
    const o = vocab.entry('compound', compound)?.attrs['odor'];
    return typeof o === 'string' ? o : '';
  };
  const rankOf = (kind: string): number => {
    const r = vocab.entry('odor_kind', kind)?.attrs['rank'];
    return typeof r === 'number' ? r : 0;
  };
  const make = (cause: string, feature: string | null, at: string | null, strains: string[], direct: string[], strength: OdorStage['strength']): void => {
    const compounds = [...new Set([...strains.flatMap((s) => strs(vocab.entry('strain', s)?.attrs['produces'])), ...direct])];
    const kinds = [...new Set(compounds.map(odorOf).filter((k) => k !== ''))].sort((a, b) => rankOf(b) - rankOf(a) || a.localeCompare(b));
    const dominant = kinds[0];
    if (dominant === undefined) return; // 냄새가 나지 않는 단계
    const kindFeature = vocab.entry('odor_kind', dominant)?.attrs['feature'];
    if (typeof kindFeature !== 'string') return;
    out.push({ cause, feature, at, strains, compounds, kinds, dominant, kindFeature, strength });
  };
  for (const cause of vocab.keys('odor_cause')) {
    const attrs = vocab.entry('odor_cause', cause)?.attrs ?? {};
    const feature = typeof attrs['feature'] === 'string' ? attrs['feature'] : null;
    const stages = attrs['stages'];
    if (Array.isArray(stages) && feature !== null) {
      for (const s of stages) {
        if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
        const strengthFeature = attrs['strength_feature'];
        const level = s['strength'];
        const strength = typeof strengthFeature === 'string' && typeof level === 'string' ? { feature: strengthFeature, level } : null;
        if (typeof s['at'] === 'string') make(cause, feature, s['at'], strs(s['strains']), strs(s['compounds']), strength);
      }
    }
    if (!Array.isArray(stages)) make(cause, null, null, [], strs(attrs['compounds']), null);
  }
  return out;
}

/**
 * 사슬에서 만든 규칙: 원인의 단계 특징이 그 단계 이상이면 물건의 냄새 종류가 대표 종류 이상이 된다 (지연 없음).
 * 원인 특징과 종류 특징을 둘 다 가진 정의마다 하나씩. 코드에 물건 이름은 없다.
 */
export function odorRules(db: Db, vocab: Vocab): SpreadRule[] {
  const rules: SpreadRule[] = [];
  for (const st of odorChain(vocab)) {
    if (st.feature === null || st.at === null) continue;
    for (const def of Object.keys(db.defs).sort()) {
      const d = db.defs[def];
      const from = slotOf(d, st.feature);
      const to = slotOf(d, st.kindFeature);
      if (from === null || to === null) continue;
      // 결과: 냄새의 세기(그 단계의 강도)와 냄새 종류(대표 종류). 세기 특징이 없는 정의는 종류만
      const strengthSlot = st.strength === null ? null : slotOf(d, st.strength.feature);
      const emits: SpreadRule['emits'] = [
        ...(st.strength !== null && strengthSlot !== null ? [{ def, slot: strengthSlot, feature: st.strength.feature, cond: { op: '>=' as const, level: st.strength.level } }] : []),
        { def, slot: to, feature: st.kindFeature, cond: { op: '>=' as const, level: st.dominant } },
      ];
      rules.push({
        def,
        owner: def,
        key: `odor_${st.cause}_${st.at}`,
        on: [{ def, slot: from, feature: st.feature, cond: { op: '>=', level: st.at } }],
        onAll: [],
        emits,
        delayMin: 0,
      });
    }
  }
  return rules;
}

function nameOf(vocab: Vocab, category: string, key: string): string {
  return vocab.entry(category, key)?.ko ?? key;
}

function levelName(vocab: Vocab, feature: string, level: string): string {
  const levels = vocab.entry('feature', feature)?.attrs['levels'];
  if (Array.isArray(levels)) {
    for (const l of levels) if (typeof l === 'object' && l !== null && !Array.isArray(l) && l['key'] === level && typeof l['ko'] === 'string') return l['ko'];
  }
  return level;
}

/** 사슬 한 단계를 한 줄로: `부패 · 상함: 슈도모나스 · 장내세균과 → 황화수소 · … → 썩는 냄새 (황 냄새 · …)` */
export function describeStage(vocab: Vocab, st: OdorStage): string {
  const head = st.feature === null || st.at === null ? nameOf(vocab, 'odor_cause', st.cause) : `${nameOf(vocab, 'odor_cause', st.cause)} · ${levelName(vocab, st.feature, st.at)}`;
  const strains = st.strains.length === 0 ? '' : `${st.strains.map((s) => nameOf(vocab, 'strain', s)).join(' · ')} → `;
  const others = st.kinds.filter((k) => k !== st.dominant);
  const kinds = `${nameOf(vocab, 'odor_kind', st.dominant)}${others.length === 0 ? '' : ` (${others.map((k) => nameOf(vocab, 'odor_kind', k)).join(' · ')}도 섞임)`}`;
  const strength = st.strength === null ? '' : ` · 세기 ${levelName(vocab, st.strength.feature, st.strength.level)}`;
  return `${head}: ${strains}${st.compounds.map((c) => nameOf(vocab, 'compound', c)).join(' · ')} → ${kinds}${strength}`;
}
