// 가열로 다시 먹을 수 있게 되는 것 (docs/온도-읽기.md): 아직 상하지 않은 음식을 가열하면 부패의 시계가 처음부터 다시 시작한다.
// 이미 상한 음식은 되살리지 않는다. 어느 특징이 얼마나 상했을 때까지 되돌릴 수 있는지는 사전 feature의 heat_reset 속성이 정한다:
//   { feature: 가열 특징, from: 이 단계 이상으로 가열되면, up_to: 이 단계 이하인 것만 }
// 규칙은 데이터에서 만든다: 두 특징을 모두 가진 정의마다 하나씩. 코드에 음식 이름은 없다. 시계 되돌림은 진행 층(progress.ts)이 한다.

import type { Db, Definition } from './db.ts';
import type { SpreadRule } from './spread.ts';
import type { Vocab } from './vocab.ts';

export interface HeatReset {
  readonly axis: string;
  readonly heat: string;
  readonly from: string;
  readonly upTo: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 사전에서 가열로 되돌릴 수 있는 축들. */
export function heatResets(vocab: Vocab): HeatReset[] {
  const out: HeatReset[] = [];
  for (const key of vocab.keys('feature')) {
    const e = vocab.entry('feature', key);
    const r = e?.attrs['heat_reset'];
    if (isObj(r) && typeof r['feature'] === 'string' && typeof r['from'] === 'string' && typeof r['up_to'] === 'string') {
      out.push({ axis: key, heat: r['feature'], from: r['from'], upTo: r['up_to'] });
    }
  }
  return out;
}

function slotOf(def: Definition | undefined, feature: string): string | null {
  const slots = def?.slots ?? {};
  return Object.keys(slots).sort().find((s) => (slots[s]?.features ?? []).includes(feature)) ?? null;
}

/** 가열로 시계를 되돌리는 규칙: 가열 온도가 from 이상이고 축이 up_to 이하면 축을 첫 칸으로 (지연 없음). */
export function heatResetRules(db: Db, vocab: Vocab): SpreadRule[] {
  const rules: SpreadRule[] = [];
  for (const r of heatResets(vocab)) {
    const zero = vocab.levelOrder(r.axis)?.[0];
    if (zero === undefined) continue;
    for (const def of Object.keys(db.defs).sort()) {
      const d = db.defs[def];
      const axisSlot = slotOf(d, r.axis);
      const heatSlot = slotOf(d, r.heat);
      if (axisSlot === null || heatSlot === null) continue;
      rules.push({
        def,
        owner: def,
        key: `heat_reset_${r.axis}`,
        on: [
          { def, slot: heatSlot, feature: r.heat, cond: { op: '>=', level: r.from } },
          { def, slot: axisSlot, feature: r.axis, cond: { op: '<=', level: r.upTo } },
        ],
        onAll: [],
        emits: [{ def, slot: axisSlot, feature: r.axis, cond: { op: '<=', level: zero } }],
        delayMin: 0,
      });
    }
  }
  return rules;
}
