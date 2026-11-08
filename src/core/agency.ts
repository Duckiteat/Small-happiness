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
// 고르는 방식 (기본안, 18번 점수 매기기 전까지): 할 수 있는 후보 중 정의 번호·행동 키 순서로 첫 번째. 난수 없음.

import { levelMatches, stateMatches } from './causal.ts';
import type { BoardValue } from './board.ts';
import { formatVia } from './via.ts';
import { latestSeq } from './events.ts';
import type { Db } from './db.ts';
import { effectiveInitial, effectiveOffers, instancesOfKind } from './kinds.ts';
import { meaningOf } from './meaning.ts';
import type { EventLog } from './log.ts';
import type { AwareMap } from './perception.ts';
import { isObserved } from './schedule.ts';
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
  /** 이 행동을 내놓은 제공 행동의 근거 참조 (via.ts: 정의/offer/키) */
  readonly via: string;
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
    via: String(r['via']),
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
    if (!isObserved(this.#vocab, presence) || t < this.#busyUntil) return [];
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
    for (const def of Object.keys(this.#db.defs).sort()) {
      for (const { owner, key, item: offer } of effectiveOffers(this.#db, def)) {
        for (const at of instances.filter((i) => world.defOfInstance(i) === def)) {
          if (offer.during !== undefined && !offer.during.includes(presence)) continue; // 정해진 시간에만 하는 행동 (요리는 식사 준비 시간)
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
          if (effects.length > 0 && effects.every((e) => stateMatches(world, this.#vocab, e.key, e.feature, e.cond))) continue;
          // 같은 앎에서는 되풀이하지 않는다: 필요한 앎과 그 물건에 대한 앎(본 단계)이 바뀌면 다시 할 수 있다
          const knowing = (k: string): string => `${knows[k]?.aw ?? 'unknown'}:${knows[k]?.level ?? ''}`;
          const signature = `${owner}/${key}@${at}|${JSON.stringify([needs.map((n) => n.keys.map(knowing)), world.keysOf(at).map(knowing)])}`;
          if (this.#tried.has(signature)) continue;

          this.#tried.add(signature);
          const ends = t + offer.minutes;
          this.#busyUntil = ends;
          // 원인: 이 행동의 조건을 채운 앎들 중 가장 최근에 생긴 것 (needs · when · 상태 의미를 만든 앎)
          const why = latestSeq([
            ...needs.flatMap((n) => n.keys.filter((k) => rank(effective(k)) >= n.min).map((k) => knows[k]?.seq)),
            ...when.flatMap((p) => targets(p).filter((k) => levelMatches(this.#vocab, p.feature, believed(k), p.cond)).map((k) => knows[k]?.seq)),
            ...(offer.when_meaning !== undefined ? world.keysOf(at).map((k) => knows[k]?.seq) : []),
          ]);
          const e = this.#log.append({ t, type: ACTION_CHOSEN, src: AGENCY_SRC, cause: why, data: { who, verb: offer.verb, via: formatVia(owner, 'offer', key), at, ends } });
          return [
            {
              event: e.seq,
              who,
              verb: offer.verb,
              via: formatVia(owner, 'offer', key),
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
