// 세계 상태 (docs/구현-계획.md 9 · 품질판 `world.state` · docs/시스템-명세.md 3)
//
// 인스턴스별 상태를 가진다. 상태는 사건을 접은 결과다:
//   - 바꾸는 길은 set() 하나뿐이고, set()은 먼저 `state_changed` 사건을 기록에 남긴 뒤 같은 사건을 적용한다.
//   - fromLog()는 기록만으로 같은 상태를 다시 만든다. 사건의 from이 그때의 상태와 다르면 던진다 (사건과 상태 일치).
//   - 철회는 복원 때 반영된다. 실행 중인 세계는 철회를 따라가지 않으므로, 철회한 뒤에는 fromLog()로 다시 만든다.
//
// 값은 단계 키다 (사전 `levels`의 키 또는 종결 단계 `gone`·`fixed`). 한 번도 바뀌지 않은 상태는 사다리 0칸이다.
// 양(1/1000) 저장은 아직 하지 않는다 (결정-기록 9번 메모). 읽기는 level()·levelIndex()로만 하므로
// 나중에 단계를 양에서 파생하도록 바꿔도 부르는 쪽은 그대로다.
//
// 단계 사이의 이동 규칙(어디서 어디로 갈 수 있는가)은 여기서 정하지 않는다. 그것은 변화 규칙과 행동의 몫이고,
// 세계 상태는 값이 정의와 사전에 맞는지만 본다.

import type { Db } from './db.ts';
import type { GameEvent, JsonValue } from './events.ts';
import { defOf, IdAllocator, parseId } from './ids.ts';
import { effectiveInitial } from './kinds.ts';
import type { EventLog } from './log.ts';
import { distance, isRelation, rootOf, wouldCycle } from './placement.ts';
import type { PlaceMap, Relation } from './placement.ts';
import { formatStateKey, parseStateKey } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export const STATE_CHANGED = 'state_changed';
export const INSTANCE_CREATED = 'instance_created';
export const PLACED = 'placed';
export const WORLD_SRC = 'world';

export interface WriteMeta {
  readonly t: number;
  readonly cause?: string | null;
}

export class WorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldError';
  }
}

export interface WorldSnapshot {
  /** 인스턴스 번호 → 정의 번호 */
  readonly instances: { readonly [id: string]: string };
  /** 상태 키 → 단계 키. 사다리 0칸(기본값)인 상태는 넣지 않는다. */
  readonly states: { readonly [key: string]: string };
}

export class World {
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #log: EventLog;
  readonly #ids = new IdAllocator();
  readonly #instances = new Map<string, string>(); // 인스턴스 → 정의
  readonly #states = new Map<string, string>(); // 상태 키 → 단계 키
  readonly #last = new Map<string, string>(); // 상태 키 → 마지막으로 바꾼 사건 (기록에서 복원된다)
  readonly #born = new Map<string, string>(); // 인스턴스 → 생긴 사건
  readonly #place = new Map<string, { on?: string; in?: string }>(); // 인스턴스 → 받치는 것·담긴 곳 (docs/물건-관계-명세.md)

  constructor(db: Db, vocab: Vocab, log: EventLog) {
    this.#db = db;
    this.#vocab = vocab;
    this.#log = log;
  }

  /** 기록의 유효한 사건만으로 세계를 다시 만든다. 새 사건은 같은 기록에 이어서 쓴다. */
  static fromLog(db: Db, vocab: Vocab, log: EventLog): World {
    const world = new World(db, vocab, log);
    for (const e of log.effective()) {
      if (e.type === INSTANCE_CREATED || e.type === STATE_CHANGED || e.type === PLACED) world.#apply(e);
    }
    return world;
  }

  /** 정의의 인스턴스를 하나 만든다. 정의의 initial(살 때의 상태)이 있으면 같은 시각에 그 상태로 둔다. */
  spawn(defId: string, meta: WriteMeta): { readonly id: string; readonly event: GameEvent } {
    const parsed = parseId(defId);
    if (parsed === null || parsed.kind !== 'def') throw new WorldError(`정의 번호가 아니다: ${defId}`);
    if (this.#db.defs[defId] === undefined) throw new WorldError(`없는 정의다: ${defId}`);
    const id = new IdAllocator(this.#ids.snapshot()).nextInstance(defId); // 미리 보기: 기록에 성공해야 발급한다
    const event = this.#write(INSTANCE_CREATED, { id, def: defId }, meta);
    const slots = this.#db.defs[defId]?.slots ?? {};
    for (const [sf, level] of Object.entries(effectiveInitial(this.#db, defId))) {
      const [slot, feature] = sf.split(':') as [string, string];
      if (!(slots[slot]?.features ?? []).includes(feature)) continue; // 종류의 처음 상태 중 이 물건에 없는 특징
      this.set(formatStateKey({ subject: id, slot, feature }), level, { t: meta.t, cause: event.seq });
    }
    return { id, event };
  }

  /**
   * 상태를 바꾼다. 값이 같으면 사건을 남기지 않고 null을 돌려준다.
   * @param level 단계 키 (사다리의 잠기지 않은 칸, 또는 종결 단계)
   */
  set(key: string, level: string, meta: WriteMeta): GameEvent | null {
    const k = this.#checkKey(key);
    this.#checkLevel(k.feature, level, key);
    const from = this.level(key);
    if (from === level) return null;
    return this.#write(STATE_CHANGED, { key, from, to: level }, meta);
  }

  /**
   * 물건의 받치는 것(on)이나 담긴 곳(in)을 바꾼다. to가 null이면 그 관계를 푼다. 값이 같으면 사건을 남기지 않고 null.
   * 없는 개체, 자기 자신, 순환이 생기는 포인터는 던진다.
   */
  place(id: string, rel: Relation, to: string | null, meta: WriteMeta): GameEvent | null {
    this.#checkPlace(id, rel, to, 'place');
    const from = this.#place.get(id)?.[rel] ?? null;
    if (from === to) return null;
    return this.#write(PLACED, { id, rel, from, to }, meta);
  }

  /** 개체의 받치는 것·담긴 곳. 없으면 undefined. */
  placeOf(id: string): { readonly on?: string; readonly in?: string } | undefined {
    return this.#place.get(id);
  }

  /** 모든 개체의 받치는 것·담긴 곳 (포인터가 있는 개체만, 번호순). */
  places(): { readonly [id: string]: { readonly on?: string; readonly in?: string } } {
    const out: Record<string, { on?: string; in?: string }> = {};
    for (const id of [...this.#place.keys()].sort()) {
      const p = this.#place.get(id);
      if (p !== undefined && (p.on !== undefined || p.in !== undefined)) out[id] = { ...p };
    }
    return out;
  }

  /** 있는 곳: 받치는 것·담긴 곳을 따라 올라가 닿는 맨 위 개체 (장소 개체면 그 장소). */
  whereIs(id: string): string {
    return rootOf(this.#place, id);
  }

  /** 두 개체 사이의 거리 (포인터를 방향 없이 이은 최단 칸 수). 이어지지 않으면 null. */
  distanceBetween(a: string, b: string): number | null {
    return distance(this.#place, a, b);
  }

  placeMap(): PlaceMap {
    return this.#place;
  }

  /** 상태의 단계 키. 한 번도 바뀌지 않았으면 사다리 0칸. */
  level(key: string): string {
    const k = this.#checkKey(key);
    return this.#states.get(key) ?? (this.#ladder(k.feature, key)[0] as string);
  }

  /** 사다리 칸 번호 (0~5). 종결 단계면 null. */
  levelIndex(key: string): number | null {
    const k = this.#checkKey(key);
    const at = this.#ladder(k.feature, key).indexOf(this.level(key));
    return at < 0 ? null : at;
  }

  /**
   * 그 상태가 지금 값으로 정해진 마지막 사건 번호: 마지막으로 바꾼 state_changed, 한 번도 바뀌지 않았으면 그 개체가 생긴 사건.
   * 원인을 적을 때 쓴다 ("조건을 마지막으로 채운 사건", 영수증-명세 9장). 없는 키면 null.
   */
  lastChange(key: string): string | null {
    const k = parseStateKey(key);
    return this.#last.get(key) ?? (k === null ? null : this.#born.get(k.subject) ?? null);
  }

  defOfInstance(id: string): string | undefined {
    return this.#instances.get(id);
  }

  instances(): string[] {
    return [...this.#instances.keys()].sort();
  }

  /** 정의의 부위·특징에서 나오는 이 인스턴스의 모든 상태 키. */
  keysOf(id: string): string[] {
    const defId = this.#instances.get(id);
    if (defId === undefined) throw new WorldError(`없는 인스턴스다: ${id}`);
    const slots = this.#db.defs[defId]?.slots ?? {};
    const keys: string[] = [];
    for (const slot of Object.keys(slots).sort()) {
      for (const feature of [...(slots[slot]?.features ?? [])].sort()) {
        keys.push(formatStateKey({ subject: id, slot, feature }));
      }
    }
    return keys;
  }

  snapshot(): WorldSnapshot {
    const instances: Record<string, string> = {};
    for (const id of this.instances()) instances[id] = this.#instances.get(id) as string;
    const states: Record<string, string> = {};
    for (const key of [...this.#states.keys()].sort()) {
      const level = this.#states.get(key) as string;
      const k = parseStateKey(key);
      if (k !== null && this.#ladder(k.feature, key)[0] === level) continue;
      states[key] = level;
    }
    return { instances, states };
  }

  // ---- 내부 ----

  #write(type: string, data: { [key: string]: JsonValue }, meta: WriteMeta): GameEvent {
    const event = this.#log.append({ t: meta.t, type, src: WORLD_SRC, cause: meta.cause ?? null, data });
    this.#apply(event);
    return event;
  }

  /** 사건 하나를 상태에 적용한다. 기록과 상태가 어긋나면 던진다. */
  #apply(e: GameEvent): void {
    const at = `${e.seq} ${e.type}`;
    if (e.type === INSTANCE_CREATED) {
      const { id, def } = e.data;
      if (typeof id !== 'string' || typeof def !== 'string') throw new WorldError(`${at}: data.id와 data.def가 필요하다`);
      if (defOf(id) !== def) throw new WorldError(`${at}: 인스턴스 ${id}는 정의 ${def}의 것이 아니다`);
      if (this.#db.defs[def] === undefined) throw new WorldError(`${at}: 없는 정의다: ${def}`);
      const expected = new IdAllocator(this.#ids.snapshot()).nextInstance(def);
      if (id !== expected) throw new WorldError(`${at}: 인스턴스 번호 순서가 어긋난다 (기대 ${expected}, 실제 ${id})`);
      this.#ids.nextInstance(def);
      this.#instances.set(id, def);
      this.#born.set(id, e.seq);
      return;
    }
    if (e.type === STATE_CHANGED) {
      const { key, from, to } = e.data;
      if (typeof key !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
        throw new WorldError(`${at}: data.key·from·to(문자열)가 필요하다`);
      }
      const k = this.#checkKey(key, at);
      this.#checkLevel(k.feature, to, `${at} ${key}`);
      const now = this.level(key);
      if (from !== now) throw new WorldError(`${at}: ${key}의 지금 단계는 ${now}인데 사건은 ${from}에서 바꾼다`);
      if (from === to) throw new WorldError(`${at}: ${key}의 from과 to가 같다`);
      this.#states.set(key, to);
      this.#last.set(key, e.seq);
      return;
    }
    if (e.type === PLACED) {
      const { id, rel, from, to } = e.data;
      if (typeof id !== 'string' || !isRelation(rel) || (from !== null && typeof from !== 'string') || (to !== null && typeof to !== 'string')) {
        throw new WorldError(`${at}: data.id·rel(on/in)·from·to(문자열 또는 null)가 필요하다`);
      }
      this.#checkPlace(id, rel, to, at);
      const now = this.#place.get(id)?.[rel] ?? null;
      if (from !== now) throw new WorldError(`${at}: ${id}의 ${rel}는 지금 ${now ?? '없음'}인데 사건은 ${from ?? '없음'}에서 바꾼다`);
      if (from === to) throw new WorldError(`${at}: ${id}의 ${rel}의 from과 to가 같다`);
      const cur = { ...(this.#place.get(id) ?? {}) };
      if (to === null) delete cur[rel];
      else cur[rel] = to;
      this.#place.set(id, cur);
      return;
    }
    throw new WorldError(`${at}: 세계 상태가 다루지 않는 사건이다`);
  }

  #checkPlace(id: string, rel: string, to: string | null, at: string): void {
    if (!this.#instances.has(id)) throw new WorldError(`${at}: 없는 인스턴스다: ${id}`);
    if (to === null) return;
    if (!this.#instances.has(to)) throw new WorldError(`${at}: ${rel}가 가리키는 인스턴스가 없다: ${to}`);
    if (to === id) throw new WorldError(`${at}: ${id}가 자기 자신을 ${rel}로 가리킨다`);
    if (wouldCycle(this.#place, id, to)) throw new WorldError(`${at}: ${id}의 ${rel}를 ${to}로 하면 놓임이 돌아온다 (순환)`);
  }

  #checkKey(key: string, at = key): { slot: string; feature: string } {
    const k = parseStateKey(key);
    if (k === null) throw new WorldError(`${at}: 상태 키 형식이 아니다 (인스턴스|부위:특징)`);
    const defId = this.#instances.get(k.subject);
    if (defId === undefined) throw new WorldError(`${at}: 없는 인스턴스다: ${k.subject}`);
    const slot = this.#db.defs[defId]?.slots?.[k.slot];
    if (slot === undefined) throw new WorldError(`${at}: ${defId}에 부위 "${k.slot}"가 없다`);
    if (!slot.features.includes(k.feature)) throw new WorldError(`${at}: 부위 ${defId}.${k.slot}에 특징 "${k.feature}"가 없다`);
    return k;
  }

  #ladder(feature: string, at: string): readonly string[] {
    const order = this.#vocab.levelOrder(feature);
    if (order === undefined || order.length === 0) throw new WorldError(`${at}: 특징 "${feature}"에 단계 목록이 없다`);
    return order;
  }

  #checkLevel(feature: string, level: string, at: string): void {
    if (this.#vocab.has('terminal', level)) return;
    const order = this.#ladder(feature, at);
    if (!order.includes(level)) {
      throw new WorldError(`${at}: 단계 키 "${level}"가 "${feature}"의 단계에 없다 (${order.join(', ')})`);
    }
    if (this.#vocab.isLocked(feature, level)) throw new WorldError(`${at}: 단계 "${level}"는 아직 잠겨 있다`);
  }
}
