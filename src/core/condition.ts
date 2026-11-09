// 컨디션과 모드 (S6 · 인물-명세 3~6장 · 내면-설계 13장, 작가 2026-11-09)
//
// 작가 결정: 여유·에너지·긴장 셋 다 둔다. 모드는 감정 축과 에너지로 정한다. 가라앉는 길은 잠·쉼·방출이고,
// "여러 번 온 사건은 임계점에 의해서 몸이 먼저 방출함에 의해서 터지기도 함".
//
// 컨디션은 인물의 내면 특징(사전 feature의 condition: reserve 여유 · energy 에너지 · tension 긴장)이고 인물의 condition 부위에 담긴다.
// 무엇이 움직이나 (모두 사전의 칸 수, 임시값):
//   - 감정 (emotion.ts appraise가 함께 계산): 좋은 감정은 여유 +1. 싫은 감정은 여유가 기준(보통)보다 넉넉하면 여유 −1로 버티고,
//     아니면 긴장 +1 — 여유가 기준보다 빠듯하면(취약) +1, 안심되지 않으면(안정이 tense_at 이하) +1 더.
//   - 행동 끝 (2층): 쉼이 아닌 행동은 활동한 분을 모아 drain_min분마다 에너지 −1. 쉼이 끝나면 on_rest (에너지 +1 · 불쾌 −1 · 긴장 −1).
//   - 잠에서 깸 (지각 층): sleep_to가 있으면 그 단계로(에너지 → 충분), settles가 있으면 기준 쪽으로 그만큼 (쾌·불쾌 → 없음, 여유 → 보통, 긴장 → 없음).
//   - 방출 (터짐, 지각 층): 모드가 방출하는 모드면 몸이 먼저 방출한다 — on_release (긴장 −3 · 불쾌 −1 · 에너지 −1). 해석 전이라 요정이 닿지 않는다.
// 모드 (사전 mode): rank 순으로 when_any의 조건 묶음 중 하나가 다 맞고 남은 집안일(미완)이 unfinished_at_least 이상인 첫 모드.
//   allows: 고를 수 있는 행동 갈래만 (방전 → 쉼). first: 그 갈래를 먼저, minutes_pct: 그 갈래는 그만큼 오래 (몰아침 → 집안일 300%).
// 난수 없음. 지각 층·행동 층·2층과 감사가 같은 계산을 쓴다. 코드에 수치·이름이 없다.

import { openLadder } from './amount.ts';
import type { Db } from './db.ts';
import { latestSeq } from './events.ts';
import { isUnfinished } from './emotion.ts';
import { levelMatches } from './causal.ts';
import { parseLocalCondition } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export const MODE_CHANGED = 'mode_changed';
export const RELEASED = 'released';
export const WOKE = 'woke';
export const CONDITION_SLOT = 'condition';

export type Change = { readonly key: string; readonly to: string };
type Level = (key: string) => string;

/** 컨디션(사전 condition 키)을 담는 내면 특징. */
export function conditionFeature(vocab: Vocab, condition: string): string | undefined {
  return vocab.keys('feature').sort().find((k) => vocab.entry('feature', k)?.attrs['condition'] === condition);
}

function num(vocab: Vocab, feature: string, attr: string): number | undefined {
  const v = vocab.entry('feature', feature)?.attrs[attr];
  return typeof v === 'number' ? v : undefined;
}

function str(vocab: Vocab, feature: string, attr: string): string | undefined {
  const v = vocab.entry('feature', feature)?.attrs[attr];
  return typeof v === 'string' ? v : undefined;
}

/** 인물 정의의 내면 특징 키들 (부위 순, 특징 순). */
export function innerKeys(db: Db, vocab: Vocab, who: string, def: string): { key: string; feature: string }[] {
  const slots = db.defs[def]?.slots ?? {};
  return Object.keys(slots).sort().flatMap((slot) => [...(slots[slot]?.features ?? [])].sort().filter((f) => vocab.entry('feature', f)?.attrs['inner'] === true).map((f) => ({ key: `${who}|${slot}:${f}`, feature: f })));
}

/** 열린 칸에서 n칸 옮긴 단계 (끝에서 멈춘다). */
export function stepped(vocab: Vocab, feature: string, cur: string, n: number): string {
  const open = openLadder(vocab, feature);
  const at = open.indexOf(cur);
  if (at < 0) return cur;
  return open[Math.min(open.length - 1, Math.max(0, at + n))] ?? cur;
}

/** 차례로 적용하는 변화 묶음 (같은 키를 두 번 옮기면 두 번 나온다). */
class Changes {
  readonly list: Change[] = [];
  readonly #local = new Map<string, string>();
  readonly level: Level;
  constructor(level: Level) {
    this.level = level;
  }
  get(key: string): string {
    return this.#local.get(key) ?? this.level(key);
  }
  set(key: string, to: string): void {
    if (to === this.get(key)) return;
    this.#local.set(key, to);
    this.list.push({ key, to });
  }
}

/** 그 속성(on_rest·on_release)만큼 인물의 내면 특징을 옮긴다. */
function byAttr(db: Db, vocab: Vocab, who: string, def: string, attr: string, level: Level): Change[] {
  const c = new Changes(level);
  for (const { key, feature } of innerKeys(db, vocab, who, def)) {
    const n = num(vocab, feature, attr);
    if (n !== undefined) c.set(key, stepped(vocab, feature, c.get(key), n));
  }
  return c.list;
}

/** 쉼이 끝났을 때. */
export function restChanges(db: Db, vocab: Vocab, who: string, def: string, level: Level): Change[] {
  return byAttr(db, vocab, who, def, 'on_rest', level);
}

/** 몸이 먼저 방출했을 때 (터짐). */
export function releaseChanges(db: Db, vocab: Vocab, who: string, def: string, level: Level): Change[] {
  return byAttr(db, vocab, who, def, 'on_release', level);
}

/** 잠에서 깼을 때: sleep_to가 있으면 그 단계로, settles가 있으면 기준(baseline, 없으면 0칸) 쪽으로 그만큼 (넘지 않는다). */
export function wakeChanges(db: Db, vocab: Vocab, who: string, def: string, level: Level): Change[] {
  const c = new Changes(level);
  for (const { key, feature } of innerKeys(db, vocab, who, def)) {
    const to = str(vocab, feature, 'sleep_to');
    if (to !== undefined) {
      c.set(key, to);
      continue;
    }
    const n = num(vocab, feature, 'settles');
    if (n === undefined) continue;
    const open = openLadder(vocab, feature);
    const base = open.indexOf(str(vocab, feature, 'baseline') ?? open[0] ?? '');
    const at = open.indexOf(c.get(key));
    if (at < 0 || base < 0) continue;
    const next = at > base ? Math.max(base, at - n) : Math.min(base, at + n);
    c.set(key, open[next] ?? c.get(key));
  }
  return c.list;
}

/**
 * 행동이 끝났을 때: 쉼이면 restChanges, 아니면 활동한 분을 모아(carry) drain_min분마다 그 컨디션을 한 칸 쓴다.
 * 돌려주는 carry는 다음에 넘길 남은 분.
 */
export function afterDone(db: Db, vocab: Vocab, who: string, def: string, pastime: boolean, minutes: number, carry: number, level: Level): { changes: Change[]; carry: number } {
  if (pastime) return { changes: restChanges(db, vocab, who, def, level), carry };
  const c = new Changes(level);
  let left = carry + minutes;
  for (const { key, feature } of innerKeys(db, vocab, who, def)) {
    const dm = num(vocab, feature, 'drain_min');
    if (dm === undefined) continue;
    const n = Math.floor(left / dm);
    left = left % dm;
    if (n > 0) c.set(key, stepped(vocab, feature, c.get(key), -n));
  }
  return { changes: c.list, carry: left };
}

/**
 * 감정이 컨디션을 움직인다 (emotion.ts appraise가 축의 변화 뒤에 덧붙인다). 여유·긴장 특징이 인물에게 없으면 아무것도 하지 않는다.
 * tense: 감정 전의 안정이 tense_at 이하 (안심되지 않음).
 */
export function emotionCondition(vocab: Vocab, who: string, tone: string, tense: boolean, has: (key: string) => boolean, level: Level): Change[] {
  const r = conditionFeature(vocab, 'reserve'), te = conditionFeature(vocab, 'tension');
  if (r === undefined || te === undefined) return [];
  const rk = `${who}|${CONDITION_SLOT}:${r}`, tk = `${who}|${CONDITION_SLOT}:${te}`;
  if (!has(rk) || !has(tk)) return [];
  const c = new Changes(level);
  if (tone === 'pleasant') {
    c.set(rk, stepped(vocab, r, c.get(rk), 1));
    return c.list;
  }
  const open = openLadder(vocab, r);
  const at = open.indexOf(c.get(rk));
  const base = open.indexOf(str(vocab, r, 'baseline') ?? open[0] ?? '');
  if (at > base) {
    c.set(rk, stepped(vocab, r, c.get(rk), -1)); // 버팀: 여유가 덜어진다
    return c.list;
  }
  const n = 1 + (at < base ? 1 : 0) + (tense ? 1 : 0); // 취약 · 안심되지 않음
  c.set(tk, stepped(vocab, te, c.get(tk), n));
  return c.list;
}

export interface ModeDef {
  readonly key: string;
  readonly rank: number;
  readonly whenAny?: readonly (readonly string[])[];
  readonly allows?: readonly string[];
  readonly first?: string;
  readonly minutesPct?: number;
  readonly unfinishedAtLeast?: number;
  readonly releases: boolean;
}

/** 사전의 모드 (판정 순). rank가 없는 사전이면 빈 목록 (모드를 쓰지 않는다). */
export function modeDefs(vocab: Vocab): ModeDef[] {
  return vocab.keys('mode').flatMap((key) => {
    const a = vocab.entry('mode', key)?.attrs ?? {};
    if (typeof a['rank'] !== 'number') return [];
    const w = a['when_any'];
    const whenAny = Array.isArray(w) ? w.map((g) => (Array.isArray(g) ? g.map(String) : [])) : undefined;
    const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
    return [{
      key,
      rank: a['rank'],
      ...(whenAny !== undefined ? { whenAny } : {}),
      ...(list(a['allows']) !== undefined ? { allows: list(a['allows']) } : {}),
      ...(typeof a['first'] === 'string' ? { first: a['first'] } : {}),
      ...(typeof a['minutes_pct'] === 'number' ? { minutesPct: a['minutes_pct'] } : {}),
      ...(typeof a['unfinished_at_least'] === 'number' ? { unfinishedAtLeast: a['unfinished_at_least'] } : {}),
      releases: a['releases'] === true,
    }];
  }).sort((a, b) => a.rank - b.rank);
}

/**
 * 지금의 모드와 판단에 읽은 상태 키들. 인물에게 조건의 특징이 없으면 그 묶음은 맞지 않는다.
 * 모드를 쓰지 않는 사전이거나 인물에게 컨디션 부위가 없으면 null.
 */
export function modeOf(vocab: Vocab, who: string, unfinished: number, has: (key: string) => boolean, level: Level): { mode: ModeDef; read: string[] } | null {
  const defs = modeDefs(vocab);
  if (defs.length === 0) return null;
  const read = new Set<string>();
  for (const m of defs) {
    if (m.whenAny === undefined) return { mode: m, read: [...read].sort() };
    if (m.unfinishedAtLeast !== undefined && unfinished < m.unfinishedAtLeast) continue;
    const hit = m.whenAny.some((g) =>
      g.every((text) => {
        const c = parseLocalCondition(text);
        if (c === null || c.cond === null) return false;
        const key = `${who}|${c.slot}:${c.feature}`;
        if (!has(key)) return false;
        read.add(key);
        return levelMatches(vocab, c.feature, level(key), c.cond);
      }),
    );
    if (hit) return { mode: m, read: [...read].sort() };
  }
  return null;
}

/** 인물에게 컨디션 부위가 있나 (모드를 판정하는가). */
export function hasCondition(db: Db, def: string): boolean {
  return db.defs[def]?.slots?.[CONDITION_SLOT] !== undefined;
}

/** 남은 집안일(미완)이 있는 정의의 수: 그 사람이 아는 단계로 (emotion.ts isUnfinished). */
export function unfinishedCount(db: Db, vocab: Vocab, instances: readonly string[], defOf: (i: string) => string | undefined, known: (key: string) => string | undefined): number {
  const byDef = new Map<string, string[]>();
  for (const i of [...instances].sort()) {
    if (!i.startsWith('OBJ') && !i.startsWith('PLC')) continue;
    const d = defOf(i);
    if (d === undefined) continue;
    byDef.set(d, [...(byDef.get(d) ?? []), i]);
  }
  return [...byDef].filter(([d, is]) => isUnfinished(db, vocab, d, is, known)).length;
}

/** 모드가 바뀐 원인: 판단에 읽은 상태를 마지막으로 정한 사건 중 가장 최근. */
export function modeCause(read: readonly string[], lastChange: (key: string) => string | null): string | null {
  return latestSeq(read.map(lastChange));
}

/** 그 모드에서 걸리는 시간: 먼저 하는 갈래(first)면 minutes_pct만큼 (내림, 최소 1). */
export function modeMinutes(minutes: number, mode: ModeDef | undefined, cls: string): number {
  if (mode?.first !== cls || mode.minutesPct === undefined) return minutes;
  return Math.max(1, Math.floor((minutes * mode.minutesPct) / 100));
}
