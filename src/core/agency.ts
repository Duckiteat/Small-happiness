// 행동 (6층) — 하루씨가 스스로 다음 행동을 고른다 (docs/상호작용-명세.md 3장 · 인물-명세 자율 행동)
//
// 후보는 물건·장소가 제공하는 행동(offers) 중 **하루씨가 아는 것으로 할 수 있는 것**뿐이다 (needs의 인지 단계).
// 하루씨가 집에 깨어 있고 다른 행동 중이 아닐 때 한 번에 하나를 고른다. 결과는 직접 쓰지 않는다:
//   - effect는 효과 요청으로 판(recent)에 올리고, 세계 상태(2층)가 행동이 끝나는 시각에 기록한다 (되먹임 길 F1).
//   - reveals(살피기)는 다음 단계의 지각(5층)이 그 장소의 물건까지 보게 한다 (F6).
//   - 행동이 끝나는 시각에 다음 단계가 돈다 (F5, schedule.ts).
// 이미 이루어진 결과를 다시 하지 않고, 같은 앎 상태에서 같은 행동을 되풀이하지 않는다.
//
// 고르는 방식 (기본안, 18번 점수 매기기 전까지): 할 수 있는 후보 중 정의 번호·행동 키 순서로 첫 번째. 난수 없음.

import { stateMatches } from './causal.ts';
import type { BoardValue } from './board.ts';
import type { Db } from './db.ts';
import { effectiveOffers, instancesOfKind } from './kinds.ts';
import { meaningOf } from './meaning.ts';
import type { EventLog } from './log.ts';
import type { AwareMap } from './perception.ts';
import { OBSERVED } from './schedule.ts';
import { formatStateKey, parsePattern } from './statekey.ts';
import type { StatePattern } from './statekey.ts';
import type { Vocab } from './vocab.ts';
import type { World } from './world.ts';

export const AGENCY_SRC = 'agency';
export const ACTION_CHOSEN = 'action_chosen';

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
  readonly offer: string;
  readonly at: string;
  readonly ends: number;
  readonly effects: readonly Effect[];
  readonly reveals?: string;
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
    offer: String(r['offer']),
    at: String(r['at']),
    ends: Number(r['ends']),
    effects: (Array.isArray(r['effects']) ? r['effects'] : []).filter(isObj).map((e) => ({ key: String(e['key']), op: String(e['op']), level: String(e['level']) })),
    ...(typeof r['reveals'] === 'string' ? { reveals: r['reveals'] } : {}),
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

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  /** 한 단계의 행동 선택. 고르지 않으면 빈 목록. */
  step(world: World, t: number, presence: string, aware: AwareMap): RecentAction[] {
    if (presence !== OBSERVED || t < this.#busyUntil) return [];
    const instances = world.instances();
    const who = instances.find((i) => i.startsWith('CHR'));
    if (who === undefined) return [];
    const knows = aware[who] ?? {};
    const rank = (k: string): number => {
      const r = this.#vocab.entry('awareness', k)?.attrs['rank'];
      return typeof r === 'number' ? r : 0;
    };
    for (const def of Object.keys(this.#db.defs).sort()) {
      for (const { owner, key, item: offer } of effectiveOffers(this.#db, def)) {
        for (const at of instances.filter((i) => world.defOfInstance(i) === def)) {
          const targets = (p: StatePattern): string[] =>
            (p.def === owner ? [at] : instancesOfKind(world, this.#db, p.def)).map((i) => formatStateKey({ subject: i, slot: p.slot, feature: p.feature }));
          const needs = offer.needs.map((n) => ({ keys: targets(pattern(n.aware)), min: rank(n.at_least) }));
          if (!needs.every((n) => n.keys.some((k) => rank(knows[k] ?? 'unknown') >= n.min))) continue;
          if (offer.when_meaning !== undefined) {
            const d = this.#db.defs[def];
            const levels: Record<string, number> = {};
            for (const k of world.keysOf(at)) {
              const idx = world.levelIndex(k);
              levels[k.slice(k.indexOf('|') + 1)] = idx ?? -1;
            }
            if (d === undefined || meaningOf(d, levels, this.#vocab)?.means !== offer.when_meaning) continue;
          }
          const when = (offer.when ?? []).map(pattern);
          if (!when.every((p) => targets(p).some((k) => stateMatches(world, this.#vocab, k, p.feature, p.cond)))) continue;
          const effects = offer.effect.flatMap((text) => {
            const p = pattern(text);
            return targets(p).map((k) => ({ key: k, feature: p.feature, cond: p.cond }));
          });
          if (effects.length > 0 && effects.every((e) => stateMatches(world, this.#vocab, e.key, e.feature, e.cond))) continue;
          const signature = `${owner}/${key}@${at}|${JSON.stringify(needs.map((n) => n.keys.map((k) => knows[k] ?? 'unknown')))}`;
          if (this.#tried.has(signature)) continue;

          this.#tried.add(signature);
          const ends = t + offer.minutes;
          this.#busyUntil = ends;
          const e = this.#log.append({ t, type: ACTION_CHOSEN, src: AGENCY_SRC, data: { who, verb: offer.verb, offer: `${owner}/${key}`, at, ends } });
          return [
            {
              event: e.seq,
              who,
              verb: offer.verb,
              offer: `${owner}/${key}`,
              at,
              ends,
              effects: effects.map((x) => ({ key: x.key, op: x.cond?.op ?? '=', level: x.cond?.level ?? '' })),
              ...(offer.reveals === true ? { reveals: at } : {}),
            },
          ];
        }
      }
    }
    return [];
  }
}
