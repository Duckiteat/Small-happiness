// 뼈대 층 (docs/구현-계획.md 1주차 · docs/기획서.md 10장)
//
// 아홉 층을 가장 얇게 세운 판이다. 하루가 처음부터 끝까지 돌고 판의 약속이 지켜지는지 보는 것이 목적이다.
//   - 0·1·2·3층은 실제로 돈다: 시각, 장소 목록, 그리고 규칙이 시간에 따라 바꾼 세계 상태
//     (3층의 인과 계산을 2층이 판을 쓰기 전에 불러 주인으로서 기록한다. 품질판-명세 2장 world.state의 "3 갱신 요청, 소유자 2").
//     4a층은 주어진 일정만 판에 옮긴다 (밖의 하루 카드는 아직 없다).
//   - 3층의 자극 원천, 4b층, 5층부터는 아직 계산하지 않고 **중립값**을 쓴다 (빈 목록·빈 객체). 중립값은 아무것도 바꾸지 않는다
//     (품질판-명세 8장). 층을 채울 때 이 파일의 해당 층만 바꾸고, 골든 트레이스의 변화를 결정 기록에 남긴다.
//   - 8층은 판을 읽어 한 단계를 한 줄로 요약한다 (문장 엔진 전의 임시 표현).

import { practicedLevel, skillKey } from './skill.ts';
import type { BoardValue } from './board.ts';
import { MINUTES_PER_DAY } from './clock.ts';
import { actionClass, Agency, parseRecent } from './agency.ts';
import { afterDone } from './condition.ts';
import type { RecentAction } from './agency.ts';
import { applyLevel, Causal, stateMatches } from './causal.ts';
import { parseAware, Perception } from './perception.ts';
import { defOf } from './ids.ts';
import { chainPairs, parseChain } from './placement.ts';
import { viaCheck } from './via.ts';
import { effectiveInitial } from './kinds.ts';
import { formatStateKey, parseStateKey } from './statekey.ts';
import { HEAT_FEATURE, readTemperature, STORAGE_FEATURE } from './temperature.ts';
import type { Db } from './db.ts';
import { EventLog } from './log.ts';
import { Rng } from './rng.ts';
import { mealAt, parsePlan, presenceAt } from './schedule.ts';
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

/**
 * 세계 상태를 사람이 읽는 말로: 이름은 정의에서, 특징·단계 이름은 사전에서 (코드에 이름을 박지 않는다).
 * 살 때의 상태(initial) 그대로인 것은 변화가 아니므로 빼고 보인다.
 */
function stateText(states: BoardValue, db: Db, vocab: Vocab): string {
  if (typeof states !== 'object' || Array.isArray(states)) return '';
  const byKey = new Map<string, unknown>(Object.entries(states));
  const parts: string[] = [];
  for (const [key, level] of Object.entries(states)) {
    const k = parseStateKey(key);
    if (k === null || typeof level !== 'string') continue;
    // 온도는 한 가지로 읽는다 (docs/온도-읽기.md): 가열 중이면 가열 온도만 보이고 보관 온도는 줄에서 뺀다
    if (k.feature === STORAGE_FEATURE) {
      const heat = byKey.get(formatStateKey({ subject: k.subject, slot: k.slot, feature: HEAT_FEATURE }));
      if (readTemperature(vocab, level, typeof heat === 'string' ? heat : undefined).band === 'heat') continue;
    }
    if (effectiveInitial(db, defOf(k.subject) ?? '')[`${k.slot}:${k.feature}`] === level) continue;
    const name = instanceName(db, k.subject);
    const feature = vocab.entry('feature', k.feature);
    const levels = feature?.attrs['levels'];
    const levelKo = Array.isArray(levels)
      ? levels.map((l) => (typeof l === 'object' && l !== null && !Array.isArray(l) && l['key'] === level ? l['ko'] : undefined)).find((x) => typeof x === 'string')
      : undefined;
    parts.push(`${name} ${feature?.ko ?? k.feature}=${typeof levelKo === 'string' ? levelKo : vocab.entry('terminal', level)?.ko ?? level}`);
  }
  return parts.join(', ');
}

/** 개체 이름. 같은 정의의 둘째부터는 번호를 붙여 구별한다 (예: 남은 치킨 #2). */
export function instanceName(db: Db, instance: string): string {
  const base = db.defs[defOf(instance) ?? instance]?.names.ko ?? instance;
  const n = /#(\d+)$/.exec(instance)?.[1];
  return n !== undefined && n !== '1' ? `${base} #${n}` : base;
}

function name(db: Db, instance: string): string {
  return instanceName(db, instance);
}

/** 하루씨가 이 단계에 느낀 것과 그 앎의 단계 (알아챔·이해함). */
function perceivedText(perceived: BoardValue, aware: BoardValue, db: Db, vocab: Vocab): string {
  if (!Array.isArray(perceived) || perceived.length === 0) return '';
  const knows = parseAware(aware);
  const parts = perceived.flatMap((p) => {
    const o = p as { who: string; key: string; level: string };
    const state = stateText({ [o.key]: o.level }, db, vocab);
    if (state === '') return []; // 살 때 그대로인 상태는 줄에서 뺀다
    const a = knows[o.who]?.[o.key]?.aw;
    return [`${state}(${a === undefined ? '' : vocab.entry('awareness', a)?.ko ?? a})`];
  });
  return parts.length === 0 ? '' : ` | 느낌: ${parts.join(', ')}`;
}

/** 하루씨가 이 단계에 고른 행동. */
/** 집을 비우는 동안의 상황 (사전 presence). */
const AWAY = 'out';

/** 오는 중인 주문 하나 (shopping.ts). */
interface Delivery {
  readonly t: number;
  readonly def: string;
  readonly rel?: 'on' | 'in';
  readonly to?: string;
  readonly cause: string;
  readonly who: string;
  readonly via: string;
}

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
export function skeletonLayers(db: Db, engine: Engine, routine: readonly PlanBlock[], vocab: Vocab, scripted: readonly ScriptedChange[] = []): Layer[] {
  const { world, causal, perception, agency, log } = engine;
  const pending: RecentAction[] = []; // 끝나기를 기다리는 행동의 효과 요청 (2층)
  let awayUntil = -1; // 집을 비우는 행동이 끝나는 시각
  const deliveries: Delivery[] = []; // 주문해 오는 중인 것 (온라인 장보기)
  const practice = new Map<string, number>(); // 숙련 상태 키 → 해 본 횟수 (기록의 행동 끝에서 다시 셀 수 있다)
  const activeCarry = new Map<string, number>(); // 인물 → 에너지를 아직 덜지 않은 활동 분 (condition.ts)
  const script = [...scripted].sort((a, b) => a.t - b.t); // 아직 일어나지 않은 외부 사건 (정전·문 열림 같은, 시나리오가 정한 것)
  return [
    {
      id: '0',
      run: (c) => c.write('time', { t: c.t }),
    },
    {
      id: '1',
      run: (c) => {
        const places = Object.keys(db.defs).filter((id) => id.startsWith('PLC')).sort();
        // 놓임(받치는 것·담긴 곳)이 하나라도 있을 때만 칸을 더한다: 놓임이 없는 세계의 판은 그대로다
        const layout = world.places();
        c.write('world.place', Object.keys(layout).length === 0 ? { places } : { places, layout });
      },
    },
    {
      id: '2',
      run: (c) => {
        // 끝난 행동의 효과 요청을 끝난 시각에 기록하고(F1), 그 사이 규칙이 만든 변화는 각자의 시각으로 기록한다
        pending.push(...parseRecent(c.prev('recent')));
        for (const a of parseRecent(c.prev('recent'))) if (a.away === true) awayUntil = Math.max(awayUntil, a.ends);
        const due = pending.filter((a) => a.ends <= c.t).sort((a, b) => a.ends - b.ends || a.event.localeCompare(b.event));
        pending.splice(0, pending.length, ...pending.filter((a) => a.ends > c.t));
        const scriptDue = script.filter((x) => x.t <= c.t);
        script.splice(0, script.length, ...script.filter((x) => x.t > c.t));
        // 끝난 행동과 외부 사건을 일어난 시각 순서로 기록한다 (같은 시각이면 외부 사건이 먼저: 정전 때 끝나는 행동은 정전 뒤에 일어난다)
        type Item = { t: number; order: number; x: (typeof script)[number] } | { t: number; order: number; a: RecentAction } | { t: number; order: number; d: Delivery };
        const timeline: Item[] = [
          ...scriptDue.map((x) => ({ t: x.t, order: 0, x })),
          ...due.map((a) => ({ t: a.ends, order: 1, a })),
          ...deliveries.filter((d) => d.t <= c.t).map((d) => ({ t: d.t, order: 2, d })),
        ];
        deliveries.splice(0, deliveries.length, ...deliveries.filter((d) => d.t > c.t));
        // 시각 순서로 하나씩 꺼낸다 (행동이 끝나며 생긴 배송이 이 단계 안에 오면 그 시각에 끼워 넣는다)
        for (;;) {
          timeline.sort((p, q) => p.t - q.t || p.order - q.order);
          const item = timeline.shift();
          if (item === undefined) break;
          if ('d' in item) {
            // 주문한 것이 온다 (원인은 주문이 끝난 사건): 새 개체로 생겨 놓이고, 주문한 사람은 무엇이 왔는지 안다
            const d = item.d;
            causal.advance(world, d.t);
            const { id } = world.spawn(d.def, { t: d.t, cause: d.cause });
            if (d.rel !== undefined && d.to !== undefined) world.place(id, d.rel, d.to, { t: d.t, cause: d.cause });
            for (const key of world.keysOf(id)) perception.learn(d.who, key, world.level(key), d.t, d.via, d.cause);
            continue;
          }
          if ('x' in item) {
            const x = item.x;
            causal.advance(world, x.t);
            const k = parseStateKey(x.key);
            if (k === null || world.defOfInstance(k.subject) === undefined || stateMatches(world, vocab, x.key, k.feature, { op: '=', level: x.level })) continue;
            const ext = log.append({ t: x.t, type: 'external_event', src: 'scenario', cause: null, data: { key: x.key, level: x.level, label: x.label } });
            applyLevel(world, vocab, x.key, k.feature, { op: '=', level: x.level }, { t: x.t, cause: ext.seq });
            continue;
          }
          const a = item.a;
          causal.advance(world, a.ends);
          const done = log.append({ t: a.ends, type: 'action_done', src: 'world', cause: a.event, data: { who: a.who, verb: a.verb, via: a.via, at: a.at } });
          perception.recordDone(a.event, done.seq);
          for (const e of a.effects) {
            const k = parseStateKey(e.key);
            if (k !== null && (e.op === '=' || e.op === '>=' || e.op === '<=')) {
              applyLevel(world, vocab, e.key, k.feature, { op: e.op, level: e.level }, { t: a.ends, cause: done.seq });
            }
          }
          // 숙련이 쌓인다 (요리-설계 11장): 결과 바로 뒤, 경계를 넘으면 인물의 숙련 칸이 오른다. 원인은 행동의 끝
          for (const tr of a.trains ?? []) {
            const key = skillKey(a.who, tr.feature);
            const count = (practice.get(key) ?? 0) + tr.gain;
            practice.set(key, count);
            world.set(key, practicedLevel(vocab, tr.feature, world.level(key), count), { t: a.ends, cause: done.seq });
          }
          // 컨디션 (condition.ts): 쉼이 끝나면 차고 가라앉는다. 다른 행동은 활동한 분만큼 에너지를 쓴다. 원인은 행동의 끝
          const startedAt = log.get(a.event)?.t ?? a.ends;
          const cond = afterDone(db, vocab, a.who, defOf(a.who) ?? '', actionClass(vocab, a.verb) === 'pastime', a.ends - startedAt, activeCarry.get(a.who) ?? 0, (k) => world.level(k));
          activeCarry.set(a.who, cond.carry);
          for (const ch of cond.changes) world.set(ch.key, ch.to, { t: a.ends, cause: done.seq });
          // 만들고 옮기기 (요리-설계 8장): 결과를 기록한 뒤 새 개체를 만들어 놓고, 물건을 옮긴다. 원인은 모두 행동의 끝
          const made: string[] = [];
          for (const cr of a.creates ?? []) {
            if (cr.at !== undefined && cr.at > a.ends) {
              const dl: Delivery = { t: cr.at, def: cr.def, ...(cr.rel !== undefined && cr.to !== undefined ? { rel: cr.rel, to: cr.to } : {}), cause: done.seq, who: a.who, via: a.via };
              if (dl.t <= c.t) timeline.push({ t: dl.t, order: 2, d: dl });
              else deliveries.push(dl);
              continue;
            }
            const { id } = world.spawn(cr.def, { t: a.ends, cause: done.seq });
            made.push(id);
            if (cr.rel !== undefined && cr.to !== undefined) world.place(id, cr.rel, cr.to, { t: a.ends, cause: done.seq });
          }
          for (const m of a.moves ?? []) world.place(m.id, m.rel, m.to, { t: a.ends, cause: done.seq });
          // 자기가 한 일이 바꾼 상태는 안다 (만든 것의 상태도)
          for (const e of a.effects) perception.learn(a.who, e.key, world.level(e.key), a.ends, a.via, done.seq);
          for (const key of made.flatMap((id) => world.keysOf(id))) perception.learn(a.who, key, world.level(key), a.ends, a.via, done.seq);
          // 손으로 다루거나 먹은 것을 느낀다 (촉각·미각): 행동을 내놓은 물건, 결과가 바뀐 물건 (번호 순)
          const handled = [a.at, ...[...new Set(a.effects.map((e) => e.key.slice(0, e.key.indexOf('|'))))].filter((x) => x !== a.at).sort()].filter((x) => x.startsWith('OBJ'));
          perception.touch(world, a.who, handled, a.verb, a.ends, a.via, done.seq);
        }
        causal.advance(world, c.t);
        c.write('world.state', world.snapshot().states);
        c.write('kit', {});
      },
    },
    {
      id: '3',
      // 자극의 원천은 아직 계산하지 않는다. 세계가 다음에 스스로 바뀔 시각만 올린다 (집에 있을 때 시계가 깨어나는 시각, F7)
      run: (c) => {
        const own = causal.nextChange(world);
        const soon = [...(script[0] !== undefined ? [script[0].t] : []), ...deliveries.map((d) => d.t)];
        const coming = soon.length === 0 ? undefined : Math.min(...soon);
        const next = own === null ? (coming ?? null) : coming === undefined ? own : Math.min(own, coming);
        c.write('world.stimulus_source', next === null ? {} : { next_change: next });
      },
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
        // 집을 비우는 행동(장보러 나감) 중에는 외출이다: 집을 지각하지 않는다
        const where = awayUntil > c.t ? AWAY : presenceAt(parsePlan(c.read('plan'), vocab), c.t);
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
        const plan = parsePlan(c.read('plan'), vocab);
        const chosen = agency.step(world, c.t, presenceAt(plan, c.t), parseAware(c.read('aware')), mealAt(plan, c.t, vocab));
        c.write('recent', chosen.map((a) => ({
          ...a,
          effects: a.effects.map((e) => ({ ...e })),
          ...(a.creates !== undefined ? { creates: a.creates.map((x) => ({ ...x })) } : {}),
          ...(a.trains !== undefined ? { trains: a.trains.map((x) => ({ ...x })) } : {}),
          ...(a.moves !== undefined ? { moves: a.moves.map((x) => ({ id: x.id, rel: x.rel, ...(x.to !== null ? { to: x.to } : {}) })) } : {}), // 푸는 변화는 to를 적지 않는다 (판은 null을 받지 않는다)
        })));
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

export interface ScriptedChange {
  readonly t: number;
  readonly key: string;
  readonly level: string;
  readonly label: string;
}

export interface Scenario {
  readonly why: string;
  /** 정의를 담은 패치들. 빈 저장소에 차례로 병합한다. use_db면 비어 있고 실제 저장소(data/db.json)를 쓴다. */
  readonly patches: readonly string[];
  readonly use_db: boolean;
  readonly seed: number;
  readonly spawn: readonly string[];
  readonly set: readonly { readonly t: number; readonly key: string; readonly level: string }[];
  /** 처음 놓임: 개체 번호를 `^`로 이은 줄들. 왼쪽이 아래, 오른쪽이 위 (예: `PLC000002#1^OBJ000012#1^OBJ000013#1`). 시작 전에 놓인다. */
  readonly layout: readonly string[];
  /** 처음 담김: 개체 `id`가 `in`에 담겨 있다. */
  readonly contain: readonly { readonly id: string; readonly in: string }[];
  /** 정해진 외부 사건: 시각 t에 상태 key가 level이 된다 (정전, 문 열림). 원인이 시나리오 밖에 있으므로 외부 사건(external_event)으로 기록한다. */
  readonly scripted: readonly ScriptedChange[];
  /** 하루의 시작과 끝(분). 단계 시각은 일정에서 정해진다 (schedule.ts). */
  readonly start: number;
  readonly end: number;
  /** 하루씨의 일정. 판의 plan과 같은 모양 { blocks: [...] }. */
  readonly routine: unknown;
  /** 이야기가 정한 지난 기억 (내면-설계 10장): 인물 개체 who가 정의 of에 감정 emotion이 붙은 기억을 갖고 시작한다. */
  readonly memories: readonly { readonly who: string; readonly of: string; readonly emotion: string }[];
  /** 요정의 작은 조언 (내면-설계 12장): 시각 t에 하루씨의 선택지 중 하나(offer 근거 참조, at 개체)를 권한다. 플레이어의 입력 자리다. */
  readonly advice: readonly { readonly t: number; readonly offer: string; readonly at: string }[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 시나리오 파일을 해석한다. 모양이 틀리면 던진다. */
export function parseScenario(raw: unknown): Scenario {
  if (!isObj(raw)) throw new TypeError('시나리오는 객체여야 한다');
  const { why, patches, use_db, seed, spawn, set, start, end, routine, layout, contain, scripted, memories, advice } = raw;
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
    if (s['t'] > start) throw new TypeError(`set[${i}]의 시각 ${s['t']}가 하루의 시작(${start})보다 뒤다 (set은 시작 전의 처음 상태다)`);
    return { t: s['t'], key: s['key'], level: s['level'] };
  });
  if (layout !== undefined && (!Array.isArray(layout) || !layout.every((x) => typeof x === 'string' && parseChain(x) !== null))) {
    throw new TypeError('layout은 개체 번호를 ^로 이은 줄의 목록이어야 한다');
  }
  if (contain !== undefined && (!Array.isArray(contain) || !contain.every((x) => isObj(x) && typeof x['id'] === 'string' && typeof x['in'] === 'string'))) {
    throw new TypeError('contain은 { id, in } 목록이어야 한다');
  }
  if (scripted !== undefined && !Array.isArray(scripted)) throw new TypeError('scripted는 목록이어야 한다');
  const scriptedChanges = ((scripted as unknown[] | undefined) ?? []).map((x, i) => {
    if (!isObj(x) || typeof x['t'] !== 'number' || typeof x['key'] !== 'string' || typeof x['level'] !== 'string' || typeof x['label'] !== 'string') {
      throw new TypeError(`scripted[${i}]는 { t, key, level, label }이어야 한다`);
    }
    if (x['t'] < start) throw new TypeError(`scripted[${i}]의 시각 ${x['t']}가 하루의 시작(${start})보다 앞선다 (시작 전의 설정은 set이다)`);
    return { t: x['t'], key: x['key'], level: x['level'], label: x['label'] };
  });
  if (memories !== undefined && (!Array.isArray(memories) || !memories.every((x) => isObj(x) && typeof x['who'] === 'string' && typeof x['of'] === 'string' && typeof x['emotion'] === 'string'))) {
    throw new TypeError('memories는 { who, of, emotion } 목록이어야 한다');
  }
  if (advice !== undefined && (!Array.isArray(advice) || !advice.every((x) => isObj(x) && typeof x['t'] === 'number' && Number.isInteger(x['t']) && typeof x['offer'] === 'string' && typeof x['at'] === 'string'))) {
    throw new TypeError('advice는 { t(분), offer(근거 참조), at(개체) } 목록이어야 한다');
  }
  return {
    advice: ((advice as { t: number; offer: string; at: string }[] | undefined) ?? []).map((x) => ({ t: x.t, offer: x.offer, at: x.at })),
    memories: ((memories as { who: string; of: string; emotion: string }[] | undefined) ?? []).map((x) => ({ who: x.who, of: x.of, emotion: x.emotion })),
    scripted: scriptedChanges,
    layout: [...((layout as string[] | undefined) ?? [])],
    contain: ((contain as { id: string; in: string }[] | undefined) ?? []).map((x) => ({ id: x.id, in: x.in })),
    why, patches: fromDb ? [] : ([...(patches as string[])] as string[]), use_db: fromDb, seed, spawn: [...spawn] as string[], set: sets, start, end, routine };
}

export interface DayTrace {
  readonly steps: readonly { readonly t: number; readonly values: { readonly [ns: string]: BoardValue }; readonly lines: readonly string[] }[];
  readonly log: readonly unknown[];
}

/** 시나리오대로 세계를 세우고 뼈대 층으로 하루를 돌린다. 같은 입력이면 같은 기록이 나온다. */
export function runScenario(db: Db, vocab: Vocab, scenario: Scenario, stepMin?: number): DayTrace {
  const log = new EventLog({ isKnownType: (type) => vocab.has('event_type', type), checkData: viaCheck(vocab) });
  const world = new World(db, vocab, log);
  for (const def of scenario.spawn) world.spawn(def, { t: 0 });
  for (const line of scenario.layout) {
    const ids = parseChain(line) ?? [];
    for (const { below, above } of chainPairs(ids)) world.place(above, 'on', below, { t: 0 });
  }
  for (const c of scenario.contain) world.place(c.id, 'in', c.in, { t: 0 });
  for (const s of scenario.set) world.set(s.key, s.level, { t: s.t });
  const setupEnd = Math.max(0, ...scenario.set.map((s) => s.t));
  const perception = new Perception(db, vocab, log);
  for (const m of scenario.memories) {
    if (!vocab.has('emotion', m.emotion)) throw new TypeError(`memories: 사전에 없는 감정 ${m.emotion}`);
    if (db.defs[m.of] === undefined || !world.instances().includes(m.who)) throw new TypeError(`memories: 없는 정의나 인물 (${m.of}, ${m.who})`);
    perception.remember(m.who, m.of, m.emotion, setupEnd);
  }
  const agency = new Agency(db, vocab, log);
  agency.advise(scenario.advice);
  const engine: Engine = {
    world,
    causal: new Causal(db, vocab, log, setupEnd),
    perception,
    agency,
    log,
  };
  const routine = parsePlan(scenario.routine, vocab);
  const layers = skeletonLayers(db, engine, routine, vocab, scenario.scripted);
  const results = runDay(layers, scenario.start, scenario.end, Rng.fromSeed(scenario.seed), vocab, stepMin);
  return {
    steps: results.map((r) => ({ ...r.board.snapshot(), lines: r.lines })),
    log: log.toJSON(),
  };
}

export function serializeTrace(trace: DayTrace): string {
  return JSON.stringify(trace, null, 2) + '\n';
}
