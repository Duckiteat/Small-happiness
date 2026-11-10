// 엔진 입구 (게임화-방향 10장): 화면이 엔진을 부르는 좁은 문 하나.
//
//   들어가는 것: 진행하기(advance) · 요정의 조언(advise) · 불러오기(load)
//   나오는 것: 지금 보이는 것(view) · 새 사건 · 저장(save)
//
// 시나리오 실행(runScenario)도 이 문을 지난다. 그래서 지금까지의 시험이 모두 이 문을 시험한다.
//
// 저장은 **입력의 기록**이다 (기본안, 2026-11-10): 시나리오 + 플레이어가 넣은 입력을 순서대로 남기고, 불러올 때 처음부터 다시 돌린다.
// 엔진이 결정적이라 같은 입력이면 같은 하루가 나온다. 다시 돌린 기록이 저장할 때의 기록과 같은지 지문으로 확인한다.
// 엔진 속 상태(앎·숙련 횟수·예약 …)를 하나하나 저장하지 않아도 빠짐없이 돌아온다 (LIM029).
// 대가: 불러오는 시간이 플레이한 길이에 비례한다 (일주일 약 0.7초). 길어지면 하루 마감마다 스냅숏을 더한다.
//
// 순수 모듈이다: 파일을 읽거나 쓰지 않는다. 콘텐츠 해시는 바깥(node 어댑터)이 계산해 넘긴다.

import { ADVICE_GIVEN, Agency, OPTIONS_FORMED } from './agency.ts';
import type { BoardValue } from './board.ts';
import { Causal } from './causal.ts';
import type { Db } from './db.ts';
import type { GameEvent, JsonValue } from './events.ts';
import { EventLog } from './log.ts';
import { Perception } from './perception.ts';
import { chainPairs, parseChain } from './placement.ts';
import { Rng } from './rng.ts';
import { canonicalJson } from './save.ts';
import { parsePlan } from './schedule.ts';
import { screenView } from './screen.ts';
import type { View } from './viewmodel.ts';
import { parseScenario, skeletonLayers } from './skeleton.ts';
import type { DayTrace, Engine, Scenario } from './skeleton.ts';
import { DayRunner } from './step.ts';
import type { StepResult } from './step.ts';
import { viaCheck } from './via.ts';
import type { Vocab } from './vocab.ts';
import { World } from './world.ts';

export const SESSION_FORMAT = 'small-happiness-session';
export const SESSION_VERSION = 1;

/** 플레이어(화면)가 넣는 입력. 저장 파일에 이 순서 그대로 남는다. */
export type SessionInput =
  | { readonly type: 'advance'; readonly until: number }
  | { readonly type: 'advise'; readonly t: number; readonly offer: string; readonly at: string };

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** 화면이 지금 그릴 것. 판의 값은 마지막으로 돈 단계의 것이다. */
export interface SessionView {
  /** 화면의 시계 (마지막으로 진행한 시각) */
  readonly t: number;
  /** 엔진이 다음에 깨어나는 시각. 하루가 끝났으면 null */
  readonly next: number | null;
  readonly ended: boolean;
  /** 마지막 단계의 시각과 판 (아직 한 단계도 돌지 않았으면 null) */
  readonly step: { readonly t: number; readonly values: { readonly [ns: string]: BoardValue } } | null;
  /** 인물마다 마지막으로 떠올린 선택지 (요정이 조언할 수 있는 것) */
  readonly options: readonly { readonly who: string; readonly seq: string; readonly options: readonly { readonly offer: string; readonly at: string; readonly verb: string }[] }[];
  /** 아직 닿지 않은 조언 */
  readonly pendingAdvice: readonly { readonly t: number; readonly offer: string; readonly at: string }[];
}

/** 저장 파일 (정규 JSON). */
export interface SessionSave {
  readonly format: typeof SESSION_FORMAT;
  readonly version: typeof SESSION_VERSION;
  /** 저장할 때의 콘텐츠(정의·사전) 해시 */
  readonly content: string;
  readonly scenario: JsonValue;
  readonly inputs: readonly SessionInput[];
  /** 저장할 때까지의 기록: 사건 수와 지문 (다시 돌린 하루가 같은지 확인한다) */
  readonly log: { readonly events: number; readonly digest: string };
}

/** 문자열 지문 (FNV-1a 32비트, 16진수 8자리). 암호용이 아니라 같은지 확인용이다. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 해석한 시나리오를 다시 파일 모양으로 (저장에 넣는다). parseScenario에 다시 넣으면 같은 시나리오가 된다. */
export function scenarioToRaw(sc: Scenario): JsonValue {
  const { patches, use_db, routine, ...rest } = sc;
  const raw: { [k: string]: unknown } = { ...rest, routine, ...(use_db ? { use_db: true } : { patches: [...patches] }) };
  return JSON.parse(JSON.stringify(raw)) as JsonValue;
}

export class Session {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #scenario: Scenario;
  readonly #log: EventLog;
  readonly #agency: Agency;
  readonly #runner: DayRunner;
  readonly #inputs: SessionInput[] = [];
  readonly #steps: StepResult[] = [];
  readonly #live: { t: number; offer: string; at: string }[] = [];
  #t: number;
  #seen = 0;
  #lastAdvanceCount = 0;

  private constructor(db: Db, vocab: Vocab, scenario: Scenario, stepMin?: number) {
    this.#db = db;
    this.#vocab = vocab;
    this.#scenario = scenario;
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
    const engine: Engine = { world, causal: new Causal(db, vocab, log, setupEnd), perception, agency, log };
    const layers = skeletonLayers(db, engine, parsePlan(scenario.routine, vocab), vocab, scenario.scripted, scenario.outside, scenario.start);
    this.#log = log;
    this.#agency = agency;
    this.#runner = new DayRunner(layers, scenario.start, scenario.end, Rng.fromSeed(scenario.seed), vocab, stepMin);
    this.#t = scenario.start;
  }

  /** 시나리오로 세계를 세운다 (아직 한 단계도 돌지 않았다). stepMin은 시험용 (단계 간격 불변 시험). */
  static start(db: Db, vocab: Vocab, scenario: Scenario, stepMin?: number): Session {
    return new Session(db, vocab, scenario, stepMin);
  }

  /** 저장 파일로 세션을 되살린다: 시나리오를 세우고 입력을 다시 넣어 돌린 뒤, 기록이 저장할 때와 같은지 확인한다. */
  static load(db: Db, vocab: Vocab, text: string, content: string): { session: Session; contentChanged: boolean } {
    const save = parseSessionSave(text);
    const s = new Session(db, vocab, parseScenario(save.scenario));
    for (const input of save.inputs) s.#apply(input);
    const now = s.#digest();
    if (now.events !== save.log.events || now.digest !== save.log.digest) {
      throw new SessionError(
        `다시 돌린 하루가 저장할 때와 다르다 (사건 ${save.log.events} → ${now.events}, 지문 ${save.log.digest} → ${now.digest})` +
          (save.content !== content ? ' — 저장한 뒤 콘텐츠(정의·사전)가 바뀌었다' : ''),
      );
    }
    s.#seen = s.#log.size;
    return { session: s, contentChanged: save.content !== content };
  }

  /** 화면의 시계 */
  get t(): number {
    return this.#t;
  }

  /** 하루의 끝 (시나리오의 end). 그 너머로는 진행할 수 없다 */
  get endTime(): number {
    return this.#scenario.end;
  }

  get ended(): boolean {
    return this.#runner.next === null;
  }

  /** 시각 until까지 진행한다. 그 사이에 차례가 된 단계를 모두 돌리고, 새로 생긴 사건을 돌려준다. */
  advance(until: number): { steps: StepResult[]; events: GameEvent[] } {
    this.#apply({ type: 'advance', until });
    return { steps: this.#steps.slice(this.#steps.length - this.#lastAdvanceCount), events: this.drain() };
  }

  /**
   * 요정의 조언: 지금 시각에 선택지 하나(offer 근거 참조, at 개체)를 권한다. 하루씨가 다음에 고를 때 닿는다
   * (시나리오의 advice와 같다 — 같은 시각이면 같은 하루가 된다). 들을지는 하루씨가 정한다.
   */
  advise(offer: string, at: string): void {
    this.#apply({ type: 'advise', t: this.#t, offer, at });
  }

  /** 지난번에 꺼낸 뒤로 새로 생긴 사건. */
  drain(): GameEvent[] {
    const all = this.#log.list();
    const fresh = all.slice(this.#seen);
    this.#seen = all.length;
    return fresh;
  }

  view(): SessionView {
    const last = this.#runner.last;
    const events = this.#log.list();
    const latest = new Map<string, GameEvent>();
    for (const e of events) if (e.type === OPTIONS_FORMED) latest.set(String(e.data['who']), e);
    const options = [...latest.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([who, e]) => ({
        who,
        seq: e.seq,
        options: (Array.isArray(e.data['options']) ? e.data['options'] : []).flatMap((o) =>
          typeof o === 'object' && o !== null && !Array.isArray(o) && typeof o['offer'] === 'string' && typeof o['at'] === 'string' && typeof o['verb'] === 'string' ? [{ offer: o['offer'], at: o['at'], verb: o['verb'] }] : [],
        ),
      }));
    // 조언은 시각 순으로 하나씩 닿는다 (Agency.advise와 같은 순서): 닿은 수만큼 앞에서 빼면 남은 것
    const all = [...this.#scenario.advice, ...this.#live].sort((a, b) => a.t - b.t);
    const given = events.filter((e) => e.type === ADVICE_GIVEN).length;
    return {
      t: this.#t,
      next: this.#runner.next,
      ended: this.ended,
      step: last === null ? null : last.snapshot(),
      options,
      pendingAdvice: all.slice(given).map((a) => ({ t: a.t, offer: a.offer, at: a.at })),
    };
  }

  /** 화면 계약의 뷰 (노드·앵커): 인물 who의 가장 최근 이벤트. 보여 줄 장면이 없으면 null (screen.ts). */
  screen(who: string): View | null {
    return screenView(this.#db, this.#vocab, this.#log.list(), who);
  }

  /** 저장 파일 (정규 JSON 문자열). content는 바깥이 계산한 콘텐츠 해시. */
  save(content: string): string {
    const save: SessionSave = { format: SESSION_FORMAT, version: SESSION_VERSION, content, scenario: scenarioToRaw(this.#scenario), inputs: [...this.#inputs], log: this.#digest() };
    return canonicalJson(JSON.parse(JSON.stringify(save)) as JsonValue);
  }

  /** 지금까지의 하루 (runScenario와 같은 모양). */
  trace(): DayTrace {
    return { steps: this.#steps.map((r) => ({ ...r.board.snapshot(), lines: r.lines })), log: this.#log.toJSON() };
  }

  /** 지금까지 넣은 입력 */
  inputs(): readonly SessionInput[] {
    return [...this.#inputs];
  }

  #apply(input: SessionInput): void {
    if (input.type === 'advance') {
      if (!Number.isInteger(input.until)) throw new SessionError(`진행할 시각은 정수(분)여야 한다 (${input.until})`);
      if (input.until < this.#t) throw new SessionError(`시계는 거꾸로 가지 않는다 (${this.#t} → ${input.until})`);
      const end = this.#scenario.end;
      if (input.until > end) throw new SessionError(`하루의 끝(${end})을 넘어 진행할 수 없다 (${input.until})`);
      const r = this.#runner.runUntil(input.until);
      this.#steps.push(...r);
      this.#lastAdvanceCount = r.length;
      this.#t = input.until;
    } else {
      if (input.t !== this.#t) throw new SessionError(`조언은 지금(${this.#t})만 할 수 있다 (${input.t})`);
      if (this.ended) throw new SessionError('하루가 끝나 조언이 닿지 않는다');
      if (typeof input.offer !== 'string' || typeof input.at !== 'string' || input.offer === '' || input.at === '') throw new SessionError('조언은 선택지(offer)와 개체(at)가 필요하다');
      const a = { t: input.t, offer: input.offer, at: input.at };
      this.#agency.advise([a]);
      this.#live.push(a);
    }
    this.#inputs.push(input);
  }

  #digest(): { events: number; digest: string } {
    return { events: this.#log.size, digest: fingerprint(JSON.stringify(this.#log.toJSON())) };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 저장 파일을 해석한다. 모양이 틀리면 던진다. */
export function parseSessionSave(text: string): SessionSave {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SessionError(`저장 파일이 JSON이 아니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(raw)) throw new SessionError('저장 파일은 객체여야 한다');
  if (raw['format'] !== SESSION_FORMAT) throw new SessionError(`저장 형식이 아니다 (format: ${String(raw['format'])})`);
  if (raw['version'] !== SESSION_VERSION) throw new SessionError(`모르는 저장 버전 ${String(raw['version'])} (지금 ${SESSION_VERSION})`);
  if (typeof raw['content'] !== 'string') throw new SessionError('content(콘텐츠 해시)가 필요하다');
  if (!isObj(raw['scenario'])) throw new SessionError('scenario가 필요하다');
  const log = raw['log'];
  if (!isObj(log) || typeof log['events'] !== 'number' || typeof log['digest'] !== 'string') throw new SessionError('log는 { events, digest }여야 한다');
  const inputs = raw['inputs'];
  if (!Array.isArray(inputs)) throw new SessionError('inputs는 목록이어야 한다');
  const parsed = inputs.map((x, i): SessionInput => {
    if (isObj(x) && x['type'] === 'advance' && typeof x['until'] === 'number') return { type: 'advance', until: x['until'] };
    if (isObj(x) && x['type'] === 'advise' && typeof x['t'] === 'number' && typeof x['offer'] === 'string' && typeof x['at'] === 'string') return { type: 'advise', t: x['t'], offer: x['offer'], at: x['at'] };
    throw new SessionError(`inputs[${i}]는 { type: advance, until } 또는 { type: advise, t, offer, at }이다`);
  });
  return { format: SESSION_FORMAT, version: SESSION_VERSION, content: raw['content'], scenario: raw['scenario'] as JsonValue, inputs: parsed, log: { events: log['events'], digest: log['digest'] } };
}
