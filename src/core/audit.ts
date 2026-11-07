// 영수증 감사 (docs/영수증-명세.md 8장 · 원 설계: make-bio-database의 사법부 검증기, 단계가 규칙과 맞는지 본다)
//
// 사건 기록 하나와 정의 저장소만 받아, 엔진을 돌리지 않고 **기록이 정의와 맞는지 처음부터 다시 계산한다.**
// 엔진이 기록을 만들고, 감사는 그 기록이 규칙·행동·진행·감각의 정의대로인지 따로 판단한다 (같은 판단을 둘이 하므로 어긋나면 한쪽의 버그다).
//   - 상태는 기록의 instance_created·state_changed로만 따라간다 (기본값은 사다리 0칸).
//   - via가 가리키는 정의를 찾아 사건과 맞춘다. 규칙 목록은 엔진과 같은 allRules를 쓰고(어떤 규칙이 있나), 실행은 여기서 다시 한다(언제 어떻게 도나).
//   - 결과는 빠짐도 덤도 없어야 한다: 발화·행동 끝·진행·살 때의 상태 바로 뒤에, 정의가 요구하는 상태 변화가 정확히 그 순서로 이어진다.
// 하지 않는 것 (한계-등록부): 진행의 경계 넘는 시각(양 계산), 행동을 고른 이유(앎이 필요를 채웠나), 조건이 성립했는데 예약이 없는 경우.
// 코어는 입출력이 없다. 시나리오를 읽는 일은 서기(clerk.ts)가 한다.

import type { Db } from './db.ts';
import { latestSeq } from './events.ts';
import type { GameEvent, JsonValue } from './events.ts';
import { allRules, levelMatches } from './causal.ts';
import type { Rule } from './causal.ts';
import { defOf } from './ids.ts';
import { effectiveInitial, effectiveOffers, effectiveProgress, kindMembers } from './kinds.ts';
import { formatStateKey, parsePattern, parseStateKey } from './statekey.ts';
import type { StatePattern } from './statekey.ts';
import { parseVia } from './via.ts';
import type { Vocab } from './vocab.ts';

export type AuditCheck = 'cause' | 'rule' | 'timing' | 'holds' | 'effects' | 'state' | 'progress' | 'action' | 'awareness';

export interface AuditFinding {
  readonly seq: string;
  readonly check: AuditCheck;
  readonly message: string;
}

export interface AuditOptions {
  /** 이 시각(분) 뒤에는 원인 없는 상태 변화(시나리오의 처음 설정)를 받지 않는다. 주지 않으면 늘 받는다. */
  readonly externalUntil?: number;
}

export interface AuditResult {
  readonly findings: readonly AuditFinding[];
  /** 검사 종류별로 맞춰 본 사건 수 (0이면 그 검사는 헛돌았다) */
  readonly checked: { readonly [check: string]: number };
  readonly events: number;
}

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '');
const num = (v: JsonValue | undefined): number => (typeof v === 'number' ? v : Number.NaN);

interface Expected {
  readonly key: string;
  readonly to: string;
}

interface Pending {
  readonly cause: string;
  readonly what: string;
  readonly expect: Expected[];
}

interface Reservation {
  readonly via: string;
  readonly at: string;
  readonly due: number;
}

interface Chosen {
  readonly via: string;
  readonly who: string;
  readonly verb: string;
  readonly at: string;
  readonly ends: number;
  readonly effects: readonly { readonly key: string; readonly feature: string; readonly cond: StatePattern['cond'] }[];
}

export function auditLog(events: readonly GameEvent[], db: Db, vocab: Vocab, options: AuditOptions = {}): AuditResult {
  const findings: AuditFinding[] = [];
  const checked: Record<string, number> = {};
  const bump = (c: AuditCheck): void => void (checked[c] = (checked[c] ?? 0) + 1);
  const bad = (seq: string, check: AuditCheck, message: string): void => void findings.push({ seq, check, message });

  const rules = new Map<string, Rule>();
  for (const r of allRules(db, vocab)) rules.set(`${r.def}|${r.owner}/${r.key}`, r);
  const instances = new Map<string, string>(); // 인스턴스 → 정의
  const levels = new Map<string, string>(); // 상태 키 → 단계 (기본값은 사다리 0칸)
  const bySeq = new Map<string, GameEvent>();
  const members = new Map<string, Set<string>>();
  const kindOf = (def: string): Set<string> => {
    const cached = members.get(def);
    if (cached !== undefined) return cached;
    const m = kindMembers(db, def);
    members.set(def, m);
    return m;
  };

  const ladder = (feature: string): readonly string[] => vocab.levelOrder(feature) ?? [];
  const levelIn = (state: ReadonlyMap<string, string>, key: string): string => {
    const k = parseStateKey(key);
    return state.get(key) ?? (k === null ? '' : ladder(k.feature)[0] ?? '');
  };
  const keyOf = (p: StatePattern, instance: string): string => formatStateKey({ subject: instance, slot: p.slot, feature: p.feature });
  const matches = (state: ReadonlyMap<string, string>, p: StatePattern, instance: string): boolean => levelMatches(vocab, p.feature, levelIn(state, keyOf(p, instance)), p.cond);
  /** 패턴이 걸리는 인스턴스: 선언한 정의면 그 인스턴스 하나, 아니면 그 정의의 종류 전부 (번호 순). */
  const targets = (p: StatePattern, owner: string, at: string): string[] =>
    p.def === owner ? [at] : [...instances.keys()].sort().filter((i) => kindOf(p.def).has(instances.get(i) ?? ''));
  const holds = (state: ReadonlyMap<string, string>, rule: Rule, at: string): boolean =>
    rule.on.every((p) => targets(p, rule.owner, at).some((i) => matches(state, p, i))) &&
    rule.onAll.every((p) => targets(p, rule.owner, at).every((i) => matches(state, p, i)));
  const isTerminal = (state: ReadonlyMap<string, string>, key: string, feature: string): boolean => ladder(feature).indexOf(levelIn(state, key)) < 0;
  /** emits가 이미 모두 이루어져 있는가 (종결 단계에 걸린 >=·<=은 할 일 없음으로 본다). */
  const done = (state: ReadonlyMap<string, string>, rule: Rule, at: string): boolean =>
    rule.emits.every((p) =>
      targets(p, rule.owner, at).every((i) => matches(state, p, i) || (p.cond !== null && p.cond.op !== '=' && isTerminal(state, keyOf(p, i), p.feature))),
    );
  /** 결과 요청을 차례로 적용했을 때 생겨야 할 상태 변화 (이미 맞거나 종결 단계에서 >=·<=이면 없음). 같은 키를 두 번 쓰면 두 번 나온다. */
  const expectChanges = (state: ReadonlyMap<string, string>, wanted: readonly { key: string; feature: string; cond: StatePattern['cond'] }[]): Expected[] => {
    const local = new Map(state);
    const out: Expected[] = [];
    for (const w of wanted) {
      if (w.cond === null) continue;
      if (levelMatches(vocab, w.feature, levelIn(local, w.key), w.cond)) continue;
      if (w.cond.op !== '=' && isTerminal(local, w.key, w.feature)) continue;
      out.push({ key: w.key, to: w.cond.level });
      local.set(w.key, w.cond.level);
    }
    return out;
  };

  const lastSeq = new Map<string, string>(); // 상태 키 → 마지막으로 바꾼 사건
  const born = new Map<string, string>(); // 개체 → 생긴 사건
  const doneBy = new Map<string, { who: string; via: string }>(); // action_done seq → 누가 무엇을
  const awarenessBy = new Map<string, string>(); // awareness 사건 seq → 누가
  /** 상태가 지금 값으로 정해진 마지막 사건: 마지막으로 바꾼 사건, 바뀐 적이 없으면 개체가 생긴 사건 (World.lastChange와 같은 약속). */
  const lastChangeOf = (key: string): string | null => lastSeq.get(key) ?? born.get(parseStateKey(key)?.subject ?? '') ?? null;
  const expectCause = (seq: string, check: 'cause', cause: string | null, expected: string | null, what: string): void => {
    bump(check);
    if (cause !== expected) bad(seq, check, `${what}의 원인이 ${cause ?? '없음'}인데 조건을 마지막으로 채운 사건은 ${expected ?? '없음'}이다`);
  };
  const open = new Map<string, Reservation>(); // delay_scheduled seq → 예약
  const openIds = new Set<string>(); // 같은 규칙 × 인스턴스의 예약은 하나
  const chosen = new Map<string, Chosen>();
  const inspected = new Set<string>(); // `${who}|${via}`: 끝난 행동
  const knows = new Map<string, { aw: string; level: string }>(); // `${who}|${key}`
  let pending: Pending | null = null;
  let batch: ReadonlyMap<string, string> | null = null; // 같은 시각 발화들은 직전 값을 읽는다: 첫 발화 직전의 상태
  const batchFired = new Set<string>();
  let batchT = -1;
  const rank = (aw: string): number => {
    const r = vocab.entry('awareness', aw)?.attrs['rank'];
    return typeof r === 'number' ? r : 0;
  };
  const closePending = (): void => {
    if (pending === null) return;
    for (const m of pending.expect) bad(pending.cause, 'effects', `${pending.what} 뒤에 결과가 빠졌다: ${m.key} → ${m.to}`);
    pending = null;
  };

  for (const e of events) {
    bySeq.set(e.seq, e);
    let consumed = false;
    // 직전 사건이 요구한 결과를 차례로 받는다
    if (pending !== null) {
      const next: Expected | undefined = pending.expect[0];
      if (e.type === 'state_changed' && e.cause === pending.cause) {
        consumed = true;
        if (next !== undefined && str(e.data['key']) === next.key && str(e.data['to']) === next.to) pending.expect.shift();
        else bad(e.seq, 'effects', `${pending.what}의 결과가 아니다: ${str(e.data['key'])} → ${str(e.data['to'])} (기대 ${next === undefined ? '없음' : `${next.key} → ${next.to}`})`);
        if (pending.expect.length === 0) pending = null;
      } else closePending();
    }
    // 같은 시각 발화 묶음이 끝나면 직전 값 기억을 버린다
    if (batch !== null && (e.t !== batchT || !(e.type === 'delay_fired' || e.type === 'delay_cancelled' || (e.type === 'state_changed' && e.cause !== null && batchFired.has(e.cause))))) {
      batch = null;
      batchFired.clear();
    }

    const via = str(e.data['via']);
    const pv = via === '' ? null : parseVia(via);

    switch (e.type) {
      case 'instance_created': {
        const id = str(e.data['id']), def = str(e.data['def']);
        if (defOf(id) !== def || db.defs[def] === undefined) {
          bad(e.seq, 'state', `개체 ${id}가 정의 ${def}의 것이 아니다`);
          break;
        }
        instances.set(id, def);
        born.set(id, e.seq);
        const slots = db.defs[def]?.slots ?? {};
        const expect: Expected[] = [];
        for (const [sf, level] of Object.entries(effectiveInitial(db, def))) {
          const [slot, feature] = sf.split(':') as [string, string];
          if (!(slots[slot]?.features ?? []).includes(feature)) continue;
          if (level === ladder(feature)[0]) continue;
          expect.push({ key: formatStateKey({ subject: id, slot, feature }), to: level });
        }
        if (expect.length > 0) pending = { cause: e.seq, what: `${id}의 처음 상태`, expect };
        break;
      }
      case 'state_changed': {
        const key = str(e.data['key']), from = str(e.data['from']), to = str(e.data['to']);
        const k = parseStateKey(key);
        if (k === null || !instances.has(k.subject)) {
          bad(e.seq, 'state', `없는 개체의 상태: ${key}`);
          break;
        }
        bump('state');
        const now = levelIn(levels, key);
        if (from !== now) bad(e.seq, 'state', `${key}의 지금 단계는 ${now}인데 사건은 ${from}에서 바꾼다`);
        if (from === to) bad(e.seq, 'state', `${key}의 from과 to가 같다`);
        levels.set(key, to);
        lastSeq.set(key, e.seq);
        // 이 변화는 무엇이 일으켰나: 처음 상태 · 규칙 발화 · 행동 끝 · 진행. 원인이 없으면 시나리오의 처음 설정뿐이다
        if (e.cause === null) {
          if (options.externalUntil !== undefined && e.t > options.externalUntil) bad(e.seq, 'state', `원인 없는 상태 변화가 처음 설정 시각(${options.externalUntil}분) 뒤에 있다: ${key}`);
        } else {
          const cause = bySeq.get(e.cause);
          if (cause === undefined || !['instance_created', 'delay_fired', 'action_done', 'stage_advanced'].includes(cause.type)) {
            bad(e.seq, 'state', `상태 변화의 원인이 ${cause?.type ?? '없는 사건'}이다 (처음 상태 · 발화 · 행동 끝 · 진행만 상태를 바꾼다)`);
          } else if (!consumed) bad(e.seq, 'effects', `${cause.type}의 정의가 요구하지 않는 결과다: ${key} → ${to}`);
        }
        break;
      }
      case 'delay_scheduled': {
        bump('timing');
        const at = str(e.data['at']);
        const rule = pv === null || pv.kind !== 'rule' ? undefined : rules.get(`${instances.get(at) ?? ''}|${pv.owner}/${pv.key}`);
        const due = num(e.data['due']);
        const id = `${via}@${at}`;
        if (openIds.has(id)) bad(e.seq, 'timing', `${id}의 예약이 이미 걸려 있다 (규칙 × 개체마다 하나)`);
        openIds.add(id);
        open.set(e.seq, { via, at, due }); // 규칙을 못 찾아도 예약은 걸린 것으로 둔다 (뒤따르는 발화가 연달아 틀리지 않게)
        if (rule === undefined) {
          bad(e.seq, 'rule', `${via}는 ${at}에 걸리는 규칙이 아니다`);
          break;
        }
        if (due !== e.t + rule.delayMin) bad(e.seq, 'timing', `발화 시각이 ${due}분인데 규칙의 지연으로는 ${e.t + rule.delayMin}분이다`);
        if (!holds(levels, rule, at)) bad(e.seq, 'holds', `예약할 때 ${via}의 조건이 맞지 않는다`);
        else if (done(levels, rule, at)) bad(e.seq, 'holds', `예약할 때 ${via}의 결과가 이미 이루어져 있다`);
        // 원인: 조건을 채운 키들(on은 맞는 것, on_all은 걸리는 것 전부) 중 가장 최근에 정해진 사건
        expectCause(
          e.seq,
          'cause',
          e.cause,
          latestSeq([
            ...rule.on.flatMap((p) => targets(p, rule.owner, at).filter((i) => matches(levels, p, i)).map((i) => lastChangeOf(keyOf(p, i)))),
            ...rule.onAll.flatMap((p) => targets(p, rule.owner, at).map((i) => lastChangeOf(keyOf(p, i)))),
          ]),
          via,
        );
        break;
      }
      case 'delay_fired':
      case 'delay_cancelled': {
        bump('timing');
        const at = str(e.data['at']);
        const res: Reservation | undefined = e.cause === null ? undefined : open.get(e.cause);
        if (res === undefined || e.cause === null) {
          bad(e.seq, 'timing', '걸린 예약이 없는데 발화·취소가 기록됐다');
          break;
        }
        open.delete(e.cause);
        openIds.delete(`${res.via}@${res.at}`);
        if (res.via !== via || res.at !== at) bad(e.seq, 'timing', `예약(${res.via}@${res.at})과 다른 규칙·개체의 발화다`);
        if (e.t !== res.due) bad(e.seq, 'timing', `예약 시각 ${res.due}분이 아닌 ${e.t}분에 기록됐다`);
        const rule = pv === null || pv.kind !== 'rule' ? undefined : rules.get(`${instances.get(at) ?? ''}|${pv.owner}/${pv.key}`);
        if (rule === undefined) {
          bad(e.seq, 'rule', `${via}는 ${at}에 걸리는 규칙이 아니다`);
          break;
        }
        if (batch === null) {
          batch = new Map(levels);
          batchT = e.t;
        }
        const hold = holds(batch, rule, at);
        if (e.type === 'delay_fired' && !hold) bad(e.seq, 'holds', `발화 시각에 ${via}의 조건이 풀려 있는데 발화했다`);
        if (e.type === 'delay_cancelled' && hold) bad(e.seq, 'holds', `발화 시각에 ${via}의 조건이 여전히 맞는데 취소했다`);
        if (e.type === 'delay_fired') {
          batchFired.add(e.seq);
          bump('effects');
          const wanted = rule.emits.flatMap((p) => targets(p, rule.owner, at).map((i) => ({ key: keyOf(p, i), feature: p.feature, cond: p.cond })));
          const expect = expectChanges(levels, wanted);
          if (expect.length > 0) pending = { cause: e.seq, what: `${via} 발화`, expect };
        }
        break;
      }
      case 'stage_advanced': {
        bump('progress');
        const key = str(e.data['key']), to = str(e.data['to']);
        const k = parseStateKey(key);
        const def = k === null ? undefined : instances.get(k.subject);
        const law = def === undefined || k === null ? undefined : effectiveProgress(db, def).full.find((p) => p.feature === k.feature && p.slot === k.slot);
        if (k === null || def === undefined || law === undefined) {
          bad(e.seq, 'progress', `${key}에 걸린 진행 법칙이 없다`);
          break;
        }
        if (pv === null || pv.kind !== 'progress' || pv.owner !== def || pv.key !== k.feature) bad(e.seq, 'progress', `via ${via}가 ${def}의 ${k.feature} 진행이 아니다`);
        const order = ladder(k.feature);
        const from = order.indexOf(levelIn(levels, key)), toAt = order.indexOf(to);
        if (from < 0 || toAt <= from) bad(e.seq, 'progress', `진행은 사다리를 올라가야 한다: ${levelIn(levels, key)} → ${to}`);
        else if (vocab.isLocked(k.feature, to)) bad(e.seq, 'progress', `잠긴 칸(${to})으로 올라갈 수 없다`);
        else pending = { cause: e.seq, what: `${key}의 진행`, expect: [{ key, to }] };
        break;
      }
      case 'action_chosen': {
        bump('action');
        const who = str(e.data['who']), at = str(e.data['at']), verb = str(e.data['verb']);
        const def = instances.get(at);
        const offer = pv === null || pv.kind !== 'offer' || def === undefined ? undefined : effectiveOffers(db, def).find((o) => o.owner === pv.owner && o.key === pv.key);
        if (offer === undefined || pv === null) {
          bad(e.seq, 'action', `${via}는 ${at}가 내놓는 행동이 아니다`);
          break;
        }
        if (!who.startsWith('CHR') || !instances.has(who)) bad(e.seq, 'action', `행동하는 이가 인물이 아니다: ${who}`);
        if (verb !== offer.item.verb) bad(e.seq, 'action', `동사가 ${verb}인데 행동의 동사는 ${offer.item.verb}이다`);
        const ends = num(e.data['ends']);
        if (ends !== e.t + offer.item.minutes) bad(e.seq, 'action', `끝나는 시각이 ${ends}분인데 행동은 ${offer.item.minutes}분 걸려 ${e.t + offer.item.minutes}분이다`);
        const effects = offer.item.effect.flatMap((text) => {
          const p = parsePattern(text);
          return p === null ? [] : targets(p, pv.owner, at).map((i) => ({ key: keyOf(p, i), feature: p.feature, cond: p.cond }));
        });
        chosen.set(e.seq, { via, who, verb, at, ends, effects });
        // 원인: 이 행동의 조건을 채운 하루씨의 앎(awareness 사건). 어느 앎인지까지는 행동을 고른 이유를 다시 계산해야 안다 (LIM014)
        bump('cause');
        if (e.cause === null || awarenessBy.get(e.cause) !== who) bad(e.seq, 'cause', `행동의 원인이 ${who}의 앎(awareness 사건)이 아니다: ${e.cause ?? '없음'}`);
        break;
      }
      case 'action_done': {
        bump('action');
        const c: Chosen | undefined = e.cause === null ? undefined : chosen.get(e.cause);
        if (c === undefined) {
          bad(e.seq, 'action', '고른 행동이 없는데 끝났다');
          break;
        }
        if (c.via !== via || c.who !== str(e.data['who']) || c.verb !== str(e.data['verb']) || c.at !== str(e.data['at'])) bad(e.seq, 'action', '고른 행동과 다른 행동이 끝났다');
        if (e.t !== c.ends) bad(e.seq, 'action', `끝나는 시각 ${c.ends}분이 아닌 ${e.t}분에 기록됐다`);
        inspected.add(`${c.who}|${via}`);
        doneBy.set(e.seq, { who: c.who, via });
        const expect = expectChanges(levels, c.effects);
        if (expect.length > 0) pending = { cause: e.seq, what: `${via} 끝`, expect };
        break;
      }
      case 'awareness_up':
      case 'awareness_changed': {
        bump('awareness');
        const who = str(e.data['who']), key = str(e.data['key']), aw = str(e.data['to']), level = str(e.data['level']);
        const k = parseStateKey(key);
        if (!instances.has(who) || !who.startsWith('CHR') || k === null || !instances.has(k.subject)) {
          bad(e.seq, 'awareness', `앎의 주체나 대상이 없다: ${who} → ${key}`);
          break;
        }
        awarenessBy.set(e.seq, who);
        const now = levelIn(levels, key);
        const prev = knows.get(`${who}|${key}`);
        const rose = prev === undefined || rank(aw) > rank(prev.aw);
        if (e.type === 'awareness_up' && !rose) bad(e.seq, 'awareness', `인지 단계가 오르지 않았는데 awareness_up이다 (${prev?.aw} → ${aw})`);
        if (e.type === 'awareness_changed' && (rose || prev === undefined || prev.aw !== aw || prev.level === level)) bad(e.seq, 'awareness', '이미 아는 단계에서 본 단계가 달라진 것이 아니다');
        if (pv === null) break;
        // 원인: 저절로 느낀 것은 그 상태를 마지막으로 정한 사건, 살펴서 안 것은 그 살피기가 끝난 사건
        if (pv.kind === 'sense') expectCause(e.seq, 'cause', e.cause, lastChangeOf(key), `${key} 느낌`);
        else {
          bump('cause');
          const d = e.cause === null ? undefined : doneBy.get(e.cause);
          if (d === undefined || d.who !== who || d.via !== via) bad(e.seq, 'cause', `살펴서 안 것의 원인이 그 살피기의 끝(action_done)이 아니다: ${e.cause ?? '없음'}`);
        }
        if (pv.kind === 'sense') {
          const sense = vocab.entry('feature', k.feature)?.attrs['sense'];
          const notice = db.defs[defOf(who) ?? '']?.senses?.[pv.key]?.notice;
          if (pv.owner !== defOf(who) || sense !== pv.key || notice === undefined) bad(e.seq, 'awareness', `${via}는 ${who}가 ${k.feature}를 느끼는 감각이 아니다`);
          else {
            const felt = ladder(k.feature).indexOf(now) >= notice;
            if (felt && level !== now) bad(e.seq, 'awareness', `느낀 단계(${level})가 세계의 단계(${now})와 다르다`);
            if (!felt && level !== ladder(k.feature)[0]) bad(e.seq, 'awareness', `알아채는 칸(${notice}) 아래인데 ${level}를 느꼈다고 적었다 (없어진 것은 0칸이어야 한다)`);
            if (e.type === 'awareness_up' && aw !== 'noticed') bad(e.seq, 'awareness', `저절로 느낀 것은 알아챔(noticed)이다 (${aw})`);
          }
        } else if (pv.kind === 'offer') {
          if (aw !== 'understood') bad(e.seq, 'awareness', `살펴서 안 것은 이해함(understood)이다 (${aw})`);
          if (level !== now) bad(e.seq, 'awareness', `본 단계(${level})가 세계의 단계(${now})와 다르다`);
          if (!inspected.has(`${who}|${via}`)) bad(e.seq, 'awareness', `${via} 행동이 끝난 기록이 없는데 살펴서 알았다고 적었다`);
        }
        knows.set(`${who}|${key}`, { aw: rose ? aw : (prev?.aw ?? aw), level });
        break;
      }
      default:
        break;
    }
  }
  closePending();
  const last = events.at(-1)?.t ?? 0;
  for (const [seq, r] of open) if (r.due <= last) bad(seq, 'timing', `예약 시각 ${r.due}분이 지났는데 발화·취소가 없다 (${r.via}@${r.at})`);
  return { findings, checked, events: events.length };
}

/** 사람이 읽는 한 줄 요약. */
export function auditSummary(r: AuditResult): string {
  const parts = Object.entries(r.checked).map(([k, n]) => `${k} ${n}`);
  return r.findings.length === 0 ? `감사 통과 — 사건 ${r.events}건 (${parts.join(' · ')})` : `감사 위반 ${r.findings.length}건 — 사건 ${r.events}건`;
}
