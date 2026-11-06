// 뼈대 층 (docs/구현-계획.md 1주차 · docs/기획서.md 10장)
//
// 아홉 층을 가장 얇게 세운 판이다. 하루가 처음부터 끝까지 돌고 판의 약속이 지켜지는지 보는 것이 목적이다.
//   - 0·1·2·3층은 실제로 돈다: 시각, 장소 목록, 그리고 규칙이 시간에 따라 바꾼 세계 상태
//     (3층의 인과 계산을 2층이 판을 쓰기 전에 불러 주인으로서 기록한다. 품질판-명세 2장 world.state의 "3 갱신 요청, 소유자 2").
//     4a층은 주어진 일정만 판에 옮긴다 (밖의 하루 카드는 아직 없다).
//   - 3층의 자극 원천, 4b층, 5층부터는 아직 계산하지 않고 **중립값**을 쓴다 (빈 목록·빈 객체). 중립값은 아무것도 바꾸지 않는다
//     (품질판-명세 8장). 층을 채울 때 이 파일의 해당 층만 바꾸고, 골든 트레이스의 변화를 결정 기록에 남긴다.
//   - 8층은 판을 읽어 한 단계를 한 줄로 요약한다 (문장 엔진 전의 임시 표현).

import type { BoardValue } from './board.ts';
import { MINUTES_PER_DAY } from './clock.ts';
import { Agency, parseRecent } from './agency.ts';
import type { RecentAction } from './agency.ts';
import { applyLevel, Causal } from './causal.ts';
import { parseAware, Perception } from './perception.ts';
import { defOf } from './ids.ts';
import { parseStateKey } from './statekey.ts';
import type { Db } from './db.ts';
import { EventLog } from './log.ts';
import { Rng } from './rng.ts';
import { parsePlan, presenceAt } from './schedule.ts';
import type { PlanBlock } from './schedule.ts';
import { runDay } from './step.ts';
import type { Layer } from './step.ts';
import type { Vocab } from './vocab.ts';
import { World } from './world.ts';

function size(v: BoardValue): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length;
  return 0;
}

/** 세계 상태를 사람이 읽는 말로: 이름은 정의에서, 특징·단계 이름은 사전에서 (코드에 이름을 박지 않는다). */
function stateText(states: BoardValue, db: Db, vocab: Vocab): string {
  if (typeof states !== 'object' || Array.isArray(states)) return '';
  const parts: string[] = [];
  for (const [key, level] of Object.entries(states)) {
    const k = parseStateKey(key);
    if (k === null || typeof level !== 'string') continue;
    const name = db.defs[defOf(k.subject) ?? '']?.names.ko ?? k.subject;
    const feature = vocab.entry('feature', k.feature);
    const levels = feature?.attrs['levels'];
    const levelKo = Array.isArray(levels)
      ? levels.map((l) => (typeof l === 'object' && l !== null && !Array.isArray(l) && l['key'] === level ? l['ko'] : undefined)).find((x) => typeof x === 'string')
      : undefined;
    parts.push(`${name} ${feature?.ko ?? k.feature}=${typeof levelKo === 'string' ? levelKo : vocab.entry('terminal', level)?.ko ?? level}`);
  }
  return parts.join(', ');
}

function name(db: Db, instance: string): string {
  return db.defs[defOf(instance) ?? '']?.names.ko ?? instance;
}

/** 하루씨가 이 단계에 느낀 것과 그 앎의 단계 (알아챔·이해함). */
function perceivedText(perceived: BoardValue, aware: BoardValue, db: Db, vocab: Vocab): string {
  if (!Array.isArray(perceived) || perceived.length === 0) return '';
  const knows = parseAware(aware);
  const parts = perceived.map((p) => {
    const o = p as { who: string; key: string; level: string };
    const k = parseStateKey(o.key);
    const state = k === null ? o.key : stateText({ [o.key]: o.level }, db, vocab);
    const a = knows[o.who]?.[o.key];
    return `${state}(${a === undefined ? '' : vocab.entry('awareness', a)?.ko ?? a})`;
  });
  return ` | 느낌: ${parts.join(', ')}`;
}

/** 하루씨가 이 단계에 고른 행동. */
function actionText(recent: BoardValue, db: Db, vocab: Vocab): string {
  const acts = parseRecent(recent);
  if (acts.length === 0) return '';
  return ` | 행동: ${acts.map((a) => `${name(db, a.at)} ${vocab.entry('action', a.verb)?.ko ?? a.verb}`).join(', ')}`;
}

function clockText(t: number): string {
  const day = Math.floor(t / MINUTES_PER_DAY) + 1;
  const m = t % MINUTES_PER_DAY;
  return `${day}일 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface Engine {
  readonly world: World;
  readonly causal: Causal;
  readonly perception: Perception;
  readonly agency: Agency;
  readonly log: EventLog;
}

/** 층 아홉 개. world·causal은 2층, perception은 5층, agency는 6층, routine(하루씨의 일정)은 4a층만 쓴다. */
export function skeletonLayers(db: Db, engine: Engine, routine: readonly PlanBlock[], vocab: Vocab): Layer[] {
  const { world, causal, perception, agency, log } = engine;
  const pending: RecentAction[] = []; // 끝나기를 기다리는 행동의 효과 요청 (2층)
  return [
    {
      id: '0',
      run: (c) => c.write('time', { t: c.t }),
    },
    {
      id: '1',
      run: (c) => c.write('world.place', { places: Object.keys(db.defs).filter((id) => id.startsWith('PLC')).sort() }),
    },
    {
      id: '2',
      run: (c) => {
        // 끝난 행동의 효과 요청을 끝난 시각에 기록하고(F1), 그 사이 규칙이 만든 변화는 각자의 시각으로 기록한다
        pending.push(...parseRecent(c.prev('recent')));
        const due = pending.filter((a) => a.ends <= c.t).sort((a, b) => a.ends - b.ends || a.event.localeCompare(b.event));
        pending.splice(0, pending.length, ...pending.filter((a) => a.ends > c.t));
        for (const a of due) {
          causal.advance(world, a.ends);
          const done = log.append({ t: a.ends, type: 'action_done', src: 'world', cause: a.event, data: { who: a.who, verb: a.verb, at: a.at } });
          for (const e of a.effects) {
            const k = parseStateKey(e.key);
            if (k !== null && (e.op === '=' || e.op === '>=' || e.op === '<=')) {
              applyLevel(world, vocab, e.key, k.feature, { op: e.op, level: e.level }, { t: a.ends, cause: done.seq });
            }
          }
        }
        causal.advance(world, c.t);
        c.write('world.state', world.snapshot().states);
        c.write('kit', {});
      },
    },
    {
      id: '3',
      run: (c) => c.write('world.stimulus_source', {}),
    },
    {
      id: '4a',
      run: (c) => {
        c.write('ext', { cards: [] });
        c.write('plan', { blocks: routine.map((b) => ({ kind: b.kind, from: b.from, to: b.to })) });
      },
    },
    {
      id: '4b',
      run: (c) => c.write('self', {}), // 인물 번호를 키로 둔다. 인물 정의(CHR) 필드가 아직 없어 비어 있다
    },
    {
      id: '5',
      run: (c) => {
        const where = presenceAt(parsePlan(c.read('plan'), vocab), c.t);
        const r = perception.step(world, c.t, where, c.prev('recent'));
        const perceived = r.perceived.map((p) => ({ who: p.who, key: p.key, level: p.level }));
        c.write('perceived', perceived);
        c.write('visible_to_player', perceived); // 지금은 하루씨가 느낀 만큼만 보인다 (넓히는 규칙은 미정)
        c.write('aware', r.aware);
        c.write('memory', []);
      },
    },
    {
      id: '6',
      run: (c) => {
        const where = presenceAt(parsePlan(c.read('plan'), vocab), c.t);
        const chosen = agency.step(world, c.t, where, parseAware(c.read('aware')));
        c.write('recent', chosen.map((a) => ({ ...a, effects: a.effects.map((e) => ({ ...e })) })));
      },
    },
    {
      id: '7',
      run: (c) => c.write('scene', {}),
    },
    {
      id: '8',
      run: (c) => {
        const places = c.read('world.place');
        const placeCount = typeof places === 'object' && !Array.isArray(places) && places !== null ? size((places as { places: BoardValue }).places) : 0;
        const where = presenceAt(parsePlan(c.read('plan'), vocab), c.t);
        const ext = c.read('ext');
        const cards = typeof ext === 'object' && !Array.isArray(ext) && ext !== null ? size((ext as { cards: BoardValue }).cards) : 0;
        return [
          `[${clockText(c.t)}] ${vocab.entry('presence', where)?.ko ?? where} · 장소 ${placeCount} · 자극 ${size(c.read('world.stimulus_source'))}` +
            ` · 외부 카드 ${cards} · 지각 ${size(c.read('perceived'))} · 최근 행동 ${size(c.read('recent'))} · 장면 ${size(c.read('scene'))}` +
            ` | ${stateText(c.read('world.state'), db, vocab) || '변화 없음'}` +
            perceivedText(c.read('perceived'), c.read('aware'), db, vocab) +
            actionText(c.read('recent'), db, vocab),
        ];
      },
    },
  ];
}

// ── 뼈대 시험용 하루 (골든 트레이스) ─────────────────────────────────────────

export interface Scenario {
  readonly why: string;
  /** 정의를 담은 패치들. 빈 저장소에 차례로 병합한다. use_db면 비어 있고 실제 저장소(data/db.json)를 쓴다. */
  readonly patches: readonly string[];
  readonly use_db: boolean;
  readonly seed: number;
  readonly spawn: readonly string[];
  readonly set: readonly { readonly t: number; readonly key: string; readonly level: string }[];
  /** 하루의 시작과 끝(분). 단계 시각은 일정에서 정해진다 (schedule.ts). */
  readonly start: number;
  readonly end: number;
  /** 하루씨의 일정. 판의 plan과 같은 모양 { blocks: [...] }. */
  readonly routine: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 시나리오 파일을 해석한다. 모양이 틀리면 던진다. */
export function parseScenario(raw: unknown): Scenario {
  if (!isObj(raw)) throw new TypeError('시나리오는 객체여야 한다');
  const { why, patches, use_db, seed, spawn, set, start, end, routine } = raw;
  if (typeof why !== 'string' || why.trim() === '') throw new TypeError('why(이 시나리오를 두는 이유)가 필요하다');
  if (use_db !== undefined && typeof use_db !== 'boolean') throw new TypeError('use_db는 true/false여야 한다');
  const fromDb = use_db === true;
  if (fromDb ? patches !== undefined : !Array.isArray(patches) || patches.length === 0 || !patches.every((x) => typeof x === 'string')) {
    throw new TypeError('patches(정의를 담은 패치 경로 목록)가 필요하다 (실제 저장소를 쓰려면 patches 없이 use_db: true)');
  }
  if (typeof seed !== 'number' || !Number.isInteger(seed)) throw new TypeError('seed는 정수여야 한다');
  if (!Array.isArray(spawn) || !spawn.every((s) => typeof s === 'string')) throw new TypeError('spawn은 정의 번호 목록이어야 한다');
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new TypeError('start와 end는 0 이상의 정수(분)이고 end가 start보다 앞서지 않아야 한다');
  }
  if (!Array.isArray(set)) throw new TypeError('set은 목록이어야 한다');
  const sets = set.map((s: unknown, i) => {
    if (!isObj(s) || typeof s['t'] !== 'number' || typeof s['key'] !== 'string' || typeof s['level'] !== 'string') {
      throw new TypeError(`set[${i}]은 { t, key, level }이어야 한다`);
    }
    return { t: s['t'], key: s['key'], level: s['level'] };
  });
  return { why, patches: fromDb ? [] : ([...(patches as string[])] as string[]), use_db: fromDb, seed, spawn: [...spawn] as string[], set: sets, start, end, routine };
}

export interface DayTrace {
  readonly steps: readonly { readonly t: number; readonly values: { readonly [ns: string]: BoardValue }; readonly lines: readonly string[] }[];
  readonly log: readonly unknown[];
}

/** 시나리오대로 세계를 세우고 뼈대 층으로 하루를 돌린다. 같은 입력이면 같은 기록이 나온다. */
export function runScenario(db: Db, vocab: Vocab, scenario: Scenario, stepMin?: number): DayTrace {
  const log = new EventLog({ isKnownType: (type) => vocab.has('event_type', type) });
  const world = new World(db, vocab, log);
  for (const def of scenario.spawn) world.spawn(def, { t: 0 });
  for (const s of scenario.set) world.set(s.key, s.level, { t: s.t });
  const setupEnd = Math.max(0, ...scenario.set.map((s) => s.t));
  const engine: Engine = {
    world,
    causal: new Causal(db, vocab, log, setupEnd),
    perception: new Perception(db, vocab, log),
    agency: new Agency(db, vocab, log),
    log,
  };
  const routine = parsePlan(scenario.routine, vocab);
  const layers = skeletonLayers(db, engine, routine, vocab);
  const results = runDay(layers, scenario.start, scenario.end, Rng.fromSeed(scenario.seed), vocab, stepMin);
  return {
    steps: results.map((r) => ({ ...r.board.snapshot(), lines: r.lines })),
    log: log.toJSON(),
  };
}

export function serializeTrace(trace: DayTrace): string {
  return JSON.stringify(trace, null, 2) + '\n';
}
