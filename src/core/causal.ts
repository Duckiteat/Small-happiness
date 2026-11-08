// 인과 (3층) — 정의의 규칙을 시간에 따라 실행한다 (docs/축-상호작용-설계.md 7·9장 · 결정-기록 "시간 모델")
//
// 규칙: `on`이 모두 맞으면 `emits`의 상태를 만든다. `delay_s`가 있으면 그만큼 뒤에 발화하고, 발화 시점에 `on`을 다시 본다.
//   - 원인당 예약은 하나다 (규칙 × 인스턴스). 발화 시점에 조건이 풀려 있으면 취소한다.
//   - 이미 결과가 이루어져 있으면 예약하지 않는다 (같은 시각의 끝없는 반복을 막는다).
//   - 같은 시각에 발화하는 예약들은 모두 직전 값을 읽고 한꺼번에 쓴다 (동시 갱신, 결정 3).
//   - **정확한 시각**: 단계 사이에 일어난 일은 그 일이 일어난 시각으로 기록한다. 단계 간격은 "보는 때"일 뿐이라
//     간격을 바꿔도 결과(사건의 시각과 순서)가 같다. 시험이 확인한다.
//   - 난수를 받지 않는다. 같은 입력이면 같은 결과다.
//
// 번짐: 장소 그래프의 통로에서 만든 규칙(spread.ts)도 같은 규칙으로 돈다.
//
// 인스턴스 묶기 (기본안, 위치·번짐(11번) 전까지): 규칙은 그 규칙이 걸리는 인스턴스마다 따로 본다 (종류에서 물려받은 규칙 포함, kinds.ts).
//   규칙을 선언한 정의를 가리키는 패턴은 그 인스턴스 자신에, 다른 정의를 가리키는 패턴은 그 정의의 종류 전부에 건다:
//   `on`은 "하나라도", `on_all`은 "모두(없으면 참)", `emits`는 "모두".
//
// 상태를 바꾸는 것은 세계 상태(2층, 주인)다. 이 모듈은 언제 무엇을 바꿀지 정하고 World.set으로 요청한다.

import type { Db } from './db.ts';
import { effectiveRules, instancesOfKind } from './kinds.ts';
import { Progress } from './progress.ts';
import { generatedRules } from './generated.ts';
import { formatVia } from './via.ts';
import { latestSeq } from './events.ts';
import type { GameEvent } from './events.ts';
import type { EventLog } from './log.ts';
import { condRange, formatStateKey, parsePattern } from './statekey.ts';
import type { Cond, StatePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import type { World } from './world.ts';

export const CAUSAL_SRC = 'causal';
export const DELAY_SCHEDULED = 'delay_scheduled';
export const DELAY_FIRED = 'delay_fired';
export const DELAY_CANCELLED = 'delay_cancelled';

/** 한 번의 진행에서 같은 시각에 이어질 수 있는 발화의 상한. 넘으면 끝나지 않는 사슬이다. */
const MAX_FIRES_PER_ADVANCE = 10_000;

/** 상태 key가 조건 cond에 맞는가. 종결 단계(소멸·고정)는 = 조건으로만 맞는다. 인과·행동이 같이 쓴다. */
export function stateMatches(world: World, vocab: Vocab, key: string, feature: string, cond: Cond): boolean {
  return levelMatches(vocab, feature, world.level(key), cond);
}

/** 단계 키 level이 조건 cond에 맞는가. 세계의 상태와 인물의 앎(본 단계)이 같은 규칙으로 판정된다. */
export function levelMatches(vocab: Vocab, feature: string, level: string, cond: Cond): boolean {
  if (cond === null) return true;
  if (vocab.has('terminal', cond.level)) return cond.op === '=' && level === cond.level;
  if (level === 'gone') return cond.op === '<=' || cond.op === '<'; // 소멸 = 축에서 빠짐: "이하"에는 맞는다 (냄새 없음)
  const order = vocab.levelOrder(feature);
  const idx = order?.indexOf(level) ?? -1;
  if (idx < 0) return false; // 종결 단계는 사다리 조건에 맞지 않는다
  const r = condRange(cond, order);
  return r !== null && idx >= r.min && idx <= r.max;
}

/**
 * 결과 조건대로 상태를 바꿔 달라고 세계 상태(주인)에 요청한다. =는 그 단계로, >=는 아래면 올리고, <=는 위면 내린다.
 * 이미 맞으면 아무것도 하지 않는다. 종결 단계에서는 =로만 바뀐다. 바꿨으면 true.
 */
export function applyLevel(world: World, vocab: Vocab, key: string, feature: string, cond: Cond, meta: { t: number; cause: string }): boolean {
  if (cond === null || !['=', '>=', '<='].includes(cond.op)) throw new CausalError(`결과에는 =, >=, <= 조건이 필요하다 (${key}) — 관문을 지난 저장소만 쓴다`);
  if (stateMatches(world, vocab, key, feature, cond)) return false;
  if (cond.op !== '=' && world.levelIndex(key) === null) return false;
  world.set(key, cond.level, meta);
  return true;
}

export class CausalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CausalError';
  }
}

export interface Rule {
  readonly def: string; // 이 규칙이 걸리는 인스턴스의 정의
  readonly owner: string; // 규칙을 선언한 정의 (자기 자신에 묶이는 패턴의 정의)
  readonly key: string; // 규칙 키
  readonly on: readonly StatePattern[];
  readonly onAll: readonly StatePattern[];
  readonly emits: readonly StatePattern[];
  readonly delayMin: number;
  /** 선언한 정의가 아닌 정의의 패턴은 이 인스턴스와 이어진(안이나 위에 있는) 것에만 건다 */
  readonly linked?: boolean;
}

interface Reservation {
  readonly rule: Rule;
  readonly at: string; // 주인 인스턴스
  readonly due: number;
  readonly seq: string; // 예약 사건
}

function compileRules(db: Db): Rule[] {
  const rules: Rule[] = [];
  for (const def of Object.keys(db.defs).sort()) {
    for (const { owner, key, item: r } of effectiveRules(db, def)) {
      const parse = (text: string): StatePattern => {
        const p = parsePattern(text);
        if (p === null) throw new CausalError(`${owner}.rules.${key}: 패턴 형식이 아니다 (${text}) — 관문을 지난 저장소만 쓴다`);
        return p;
      };
      rules.push({ def, owner, key, on: r.on.map(parse), onAll: (r.on_all ?? []).map(parse), emits: r.emits.map(parse), delayMin: (r.delay_s ?? 0) / 60, ...(r.linked === true ? { linked: true } : {}) });
    }
  }
  return rules;
}

/** 저장소에서 돌아가는 모든 규칙: 정의의 규칙(종류에서 물려받은 것 포함) + 데이터에서 만든 규칙(장소 그래프의 번짐, 냄새 사슬의 종류). 감사(audit.ts)도 이 목록을 쓴다. */
export function allRules(db: Db, vocab: Vocab): Rule[] {
  return [...compileRules(db), ...generatedRules(db, vocab)];
}

export class Causal {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #rules: readonly Rule[];
  readonly #reservations = new Map<string, Reservation>(); // `${owner}/${key}@${instance}` → 예약
  readonly #progress: Progress;
  #now: number;

  /** @param start 인과가 시작되는 시각(분). 이 시각부터 규칙을 본다. */
  constructor(db: Db, vocab: Vocab, log: EventLog, start: number) {
    if (!Number.isInteger(start) || start < 0) throw new CausalError(`시작 시각은 0 이상의 정수(분)여야 한다: ${start}`);
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
    this.#rules = allRules(db, vocab); // 손으로 쓴 규칙 + 장소 그래프에서 만든 번짐 규칙
    this.#progress = new Progress(db, vocab, log);
    this.#now = start;
  }

  get now(): number {
    return this.#now;
  }

  /** 진행 법칙의 지금 양 (0~1000). 진행하지 않는 상태면 null. 시험·화면용. */
  amount(key: string): number | null {
    return this.#progress.amount(key);
  }

  /**
   * 세계가 다음에 스스로 바뀔 시각 (걸린 예약과 진행 법칙의 경계 중 가장 이른 것). 없으면 null.
   * 하루씨가 집에 있을 때 시계가 이 시각에 한 단계를 깨운다 (되먹임 길 F7).
   */
  nextChange(world: World): number | null {
    let min: number | null = null;
    for (const r of this.#reservations.values()) if (min === null || r.due < min) min = r.due;
    const p = this.#progress.next(world, Number.MAX_SAFE_INTEGER);
    if (p !== null && (min === null || p < min)) min = p;
    return min === null ? null : Math.max(min, this.#now);
  }

  /** 지금 걸려 있는 예약 (발화 시각, 규칙, 인스턴스). 화면의 예고와 시험에 쓴다. */
  pending(): { readonly due: number; readonly via: string; readonly at: string }[] {
    return [...this.#reservations.values()]
      .map((r) => ({ due: r.due, via: formatVia(r.rule.owner, 'rule', r.rule.key), at: r.at }))
      .sort((a, b) => a.due - b.due || a.via.localeCompare(b.via) || a.at.localeCompare(b.at));
  }

  /** 세계를 시각 to까지 진행한다. 그 사이의 발화는 각자의 시각으로 기록된다. */
  advance(world: World, to: number): void {
    if (!Number.isInteger(to) || to < this.#now) throw new CausalError(`시간은 거꾸로 가지 않는다 (${this.#now} → ${to})`);
    let fires = 0;
    this.#progress.integrate(world, this.#now);
    this.#schedule(world, this.#now);
    for (;;) {
      const dueRule = this.#nextDue(to);
      const dueProgress = this.#progress.next(world, to);
      const due = dueRule === null ? dueProgress : dueProgress === null ? dueRule : Math.min(dueRule, dueProgress);
      if (due === null) break;
      this.#progress.integrate(world, due); // 조건이 바뀌기 전까지 옛 속도로 쌓는다
      this.#now = due;
      const batch = [...this.#reservations.entries()].filter(([, r]) => r.due === due).sort(([a], [b]) => a.localeCompare(b));
      // 동시 갱신: 모든 조건을 먼저 판정하고(직전 값), 그다음 한꺼번에 쓴다
      const decided = batch.map(([id, r]) => ({ id, r, holds: this.#holds(world, r.rule, r.at) }));
      for (const { id, r, holds } of decided) {
        this.#reservations.delete(id);
        const data = { via: formatVia(r.rule.owner, 'rule', r.rule.key), at: r.at };
        if (!holds) {
          this.#log.append({ t: due, type: DELAY_CANCELLED, src: CAUSAL_SRC, cause: r.seq, data });
          continue;
        }
        const fired = this.#log.append({ t: due, type: DELAY_FIRED, src: CAUSAL_SRC, cause: r.seq, data });
        this.#emit(world, r.rule, r.at, fired);
        if (++fires > MAX_FIRES_PER_ADVANCE) throw new CausalError(`한 번에 ${MAX_FIRES_PER_ADVANCE}번 넘게 발화했다 — 끝나지 않는 규칙 사슬이 있다`);
      }
      this.#progress.integrate(world, due); // 규칙이 칸을 내렸으면 시계를 그 칸에서 다시 시작한 뒤에 경계를 본다
      this.#progress.fire(world, due); // 진행 법칙의 경계를 넘은 축
      if (++fires > MAX_FIRES_PER_ADVANCE) throw new CausalError(`한 번에 ${MAX_FIRES_PER_ADVANCE}번 넘게 돌았다 — 끝나지 않는 사슬이 있다`);
      this.#schedule(world, due);
    }
    this.#progress.integrate(world, to);
    this.#now = to;
  }

  // ---- 내부 ----

  #nextDue(to: number): number | null {
    let min: number | null = null;
    for (const r of this.#reservations.values()) if (r.due <= to && (min === null || r.due < min)) min = r.due;
    return min;
  }

  /** 조건이 맞고 결과가 아직 이루어지지 않은 원인마다 예약을 하나 건다. */
  #schedule(world: World, t: number): void {
    for (const rule of this.#rules) {
      for (const at of world.instances().filter((i) => world.defOfInstance(i) === rule.def)) {
        const id = `${rule.owner}/${rule.key}@${at}`;
        if (this.#reservations.has(id)) continue;
        if (!this.#holds(world, rule, at) || this.#done(world, rule, at)) continue;
        const due = t + rule.delayMin;
        const e = this.#log.append({ t, type: DELAY_SCHEDULED, src: CAUSAL_SRC, cause: this.#why(world, rule, at), data: { via: formatVia(rule.owner, 'rule', rule.key), at, due } });
        this.#reservations.set(id, { rule, at, due, seq: e.seq });
      }
    }
  }

  /**
   * 예약의 원인: 조건을 채운 상태 키들(on은 맞는 것, on_all은 걸리는 것 전부) 중 가장 최근에 바뀐 사건.
   * 조건이 처음부터 맞아서 한 번도 바뀐 적이 없으면 null (원인 사건이 없는 것이 맞다).
   */
  #why(world: World, rule: Rule, at: string): string | null {
    const keys = (p: StatePattern): string[] => this.#targets(world, p, rule, at).map((i) => formatStateKey({ subject: i, slot: p.slot, feature: p.feature }));
    return latestSeq([
      ...rule.on.flatMap((p) => this.#targets(world, p, rule, at).filter((i) => this.#matches(world, p, i)).map((i) => world.lastChange(formatStateKey({ subject: i, slot: p.slot, feature: p.feature })))),
      ...rule.onAll.flatMap((p) => keys(p).map((k) => world.lastChange(k))),
    ]);
  }

  /** 패턴이 걸리는 인스턴스들: 규칙을 선언한 정의면 그 인스턴스 하나, 아니면 그 정의의 종류 전부. */
  #targets(world: World, p: StatePattern, rule: { readonly owner: string; readonly linked?: boolean }, at: string): string[] {
    if (p.def === rule.owner) return [at];
    const all = instancesOfKind(world, this.#db, p.def);
    return rule.linked === true ? all.filter((i) => world.linked(i, at)) : all;
  }

  #matches(world: World, p: StatePattern, instance: string): boolean {
    return stateMatches(world, this.#vocab, formatStateKey({ subject: instance, slot: p.slot, feature: p.feature }), p.feature, p.cond);
  }

  /** on이 모두 맞는가 (다른 정의의 패턴은 하나라도), on_all도 모두 맞는가 (다른 정의의 패턴은 모두). */
  #holds(world: World, rule: Rule, at: string): boolean {
    return (
      rule.on.every((p) => this.#targets(world, p, rule, at).some((i) => this.#matches(world, p, i))) &&
      rule.onAll.every((p) => this.#targets(world, p, rule, at).every((i) => this.#matches(world, p, i)))
    );
  }

  /**
   * emits가 이미 모두 이루어져 있는가. 종결 단계(소멸·고정)는 = 로만 바뀌므로, >=·<= 결과가 종결 단계에 걸리면
   * 할 일이 없는 것으로 본다 (버린 음식의 "상하면 냄새" 규칙이 끝없이 다시 걸리지 않게).
   */
  #done(world: World, rule: Rule, at: string): boolean {
    return rule.emits.every((p) =>
      this.#targets(world, p, rule, at).every((i) => {
        if (this.#matches(world, p, i)) return true;
        const key = formatStateKey({ subject: i, slot: p.slot, feature: p.feature });
        return p.cond !== null && p.cond.op !== '=' && world.levelIndex(key) === null;
      }),
    );
  }

  /** 결과를 세계 상태(주인)에 요청한다. */
  #emit(world: World, rule: Rule, at: string, cause: GameEvent): void {
    for (const p of rule.emits) {
      for (const i of this.#targets(world, p, rule, at)) {
        const key = formatStateKey({ subject: i, slot: p.slot, feature: p.feature });
        applyLevel(world, this.#vocab, key, p.feature, p.cond, { t: cause.t, cause: cause.seq });
      }
    }
  }
}
