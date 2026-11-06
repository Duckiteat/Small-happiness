// 뼈대 층 (docs/구현-계획.md 1주차 · docs/기획서.md 10장)
//
// 아홉 층을 가장 얇게 세운 판이다. 하루가 처음부터 끝까지 돌고 판의 약속이 지켜지는지 보는 것이 목적이다.
//   - 0·1·2층은 실제 값을 낸다 (시각, 장소 목록, 세계 상태).
//   - 3층부터는 아직 계산하지 않고 **중립값**을 쓴다 (빈 목록·빈 객체). 중립값은 아무것도 바꾸지 않는다
//     (품질판-명세 8장). 층을 채울 때 이 파일의 해당 층만 바꾸고, 골든 트레이스의 변화를 결정 기록에 남긴다.
//   - 8층은 판을 읽어 한 단계를 한 줄로 요약한다 (문장 엔진 전의 임시 표현).

import type { BoardValue } from './board.ts';
import { MINUTES_PER_DAY } from './clock.ts';
import type { Db } from './db.ts';
import { EventLog } from './log.ts';
import { Rng } from './rng.ts';
import { runSteps } from './step.ts';
import type { Layer } from './step.ts';
import type { Vocab } from './vocab.ts';
import { World } from './world.ts';

function size(v: BoardValue): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length;
  return 0;
}

function clockText(t: number): string {
  const day = Math.floor(t / MINUTES_PER_DAY) + 1;
  const m = t % MINUTES_PER_DAY;
  return `${day}일 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 뼈대 층 아홉 개. world는 2층만 읽는다 (세계 상태의 주인). */
export function skeletonLayers(db: Db, world: World): Layer[] {
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
        c.write('plan', {});
      },
    },
    {
      id: '4b',
      run: (c) => c.write('self', {}), // 인물 번호를 키로 둔다. 인물 정의(CHR) 필드가 아직 없어 비어 있다
    },
    {
      id: '5',
      run: (c) => {
        c.write('perceived', []);
        c.write('visible_to_player', []);
        c.write('aware', {});
        c.write('memory', []);
      },
    },
    {
      id: '6',
      run: (c) => c.write('recent', []),
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
        const ext = c.read('ext');
        const cards = typeof ext === 'object' && !Array.isArray(ext) && ext !== null ? size((ext as { cards: BoardValue }).cards) : 0;
        return [
          `[${clockText(c.t)}] 장소 ${placeCount} · 바뀐 상태 ${size(c.read('world.state'))} · 자극 ${size(c.read('world.stimulus_source'))}` +
            ` · 외부 카드 ${cards} · 지각 ${size(c.read('perceived'))} · 최근 행동 ${size(c.read('recent'))} · 장면 ${size(c.read('scene'))}`,
        ];
      },
    },
  ];
}

// ── 뼈대 시험용 하루 (골든 트레이스) ─────────────────────────────────────────

export interface Scenario {
  readonly why: string;
  readonly patch: string;
  readonly seed: number;
  readonly spawn: readonly string[];
  readonly set: readonly { readonly t: number; readonly key: string; readonly level: string }[];
  readonly steps: readonly number[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 시나리오 파일을 해석한다. 모양이 틀리면 던진다. */
export function parseScenario(raw: unknown): Scenario {
  if (!isObj(raw)) throw new TypeError('시나리오는 객체여야 한다');
  const { why, patch, seed, spawn, set, steps } = raw;
  if (typeof why !== 'string' || why.trim() === '') throw new TypeError('why(이 시나리오를 두는 이유)가 필요하다');
  if (typeof patch !== 'string') throw new TypeError('patch(정의를 담은 패치 경로)가 필요하다');
  if (typeof seed !== 'number' || !Number.isInteger(seed)) throw new TypeError('seed는 정수여야 한다');
  if (!Array.isArray(spawn) || !spawn.every((s) => typeof s === 'string')) throw new TypeError('spawn은 정의 번호 목록이어야 한다');
  if (!Array.isArray(steps) || !steps.every((s) => typeof s === 'number' && Number.isInteger(s) && s >= 0)) {
    throw new TypeError('steps는 0 이상의 정수(분) 목록이어야 한다');
  }
  if (!Array.isArray(set)) throw new TypeError('set은 목록이어야 한다');
  const sets = set.map((s: unknown, i) => {
    if (!isObj(s) || typeof s['t'] !== 'number' || typeof s['key'] !== 'string' || typeof s['level'] !== 'string') {
      throw new TypeError(`set[${i}]은 { t, key, level }이어야 한다`);
    }
    return { t: s['t'], key: s['key'], level: s['level'] };
  });
  return { why, patch, seed, spawn: [...spawn] as string[], set: sets, steps: [...steps] as number[] };
}

export interface DayTrace {
  readonly steps: readonly { readonly t: number; readonly values: { readonly [ns: string]: BoardValue }; readonly lines: readonly string[] }[];
  readonly log: readonly unknown[];
}

/** 시나리오대로 세계를 세우고 뼈대 층으로 하루를 돌린다. 같은 입력이면 같은 기록이 나온다. */
export function runScenario(db: Db, vocab: Vocab, scenario: Scenario): DayTrace {
  const log = new EventLog({ isKnownType: (type) => vocab.has('event_type', type) });
  const world = new World(db, vocab, log);
  for (const def of scenario.spawn) world.spawn(def, { t: 0 });
  for (const s of scenario.set) world.set(s.key, s.level, { t: s.t });
  const results = runSteps(skeletonLayers(db, world), scenario.steps, Rng.fromSeed(scenario.seed));
  return {
    steps: results.map((r) => ({ ...r.board.snapshot(), lines: r.lines })),
    log: log.toJSON(),
  };
}

export function serializeTrace(trace: DayTrace): string {
  return JSON.stringify(trace, null, 2) + '\n';
}
