// 화면에 보낼 뷰 모델 (화면-계약, 구현-계획 N1-1): 엔진의 사건 기록에서 화면 계약의 뷰(View)를 계산한다.
//
// 한 인물의 **가장 최근 이벤트**를 보여 준다 (열려 있으면 그것, 닫혔으면 닫힌 채로 다음 이벤트가 열릴 때까지).
//   - 줄글: 이벤트가 열린 뒤 고른 장면의 문장을 차례로 (문단 = 문장 한 줄). 앵커 번호는 나온 순서대로 a1, a2 …
//   - 지도: 핵심 지각 노드 하나 — 심상 사다리의 지금 칸과 그 칸의 이름 (느낌 → 짐작 → 좁힘 → 정체)
//   - 선: 앵커마다 핵심 노드로 이어지는 선 (link)
//   - 이벤트 상태: 열림 / 닫힘 / 다시 열림(같은 장소에서 전에 닫힌 적이 있으면)
//   - 동그라미: 누른 앵커(attention_drawn)는 열린 호, 이벤트가 닫히면 닫힌 원 (작가 2026-11-10)
// 아직 없는 것 (LIM045): 행동 노드, 주변부, 뜨지 못한 생각(ghost).
//
// 순수 모듈이다. 기록만 읽고 난수·시각을 쓰지 않는다: 같은 기록이면 같은 뷰.
// 이름은 코드에 없다 — 장소·물건·이벤트 이름은 정의의 names, 감각·종류·원인 이름은 사전에서 읽는다.

import type { Db } from './db.ts';
import type { GameEvent } from './events.ts';
import { EVENT_CLOSED, EVENT_OPENED, SCENE_SHOWN } from './scene.ts';
import { LADDER_MOVED, ladderSpecs } from './ladder.ts';
import { lineParts } from './script.ts';
import { parseView, VIEW_VERSION } from './viewmodel.ts';
import type { AnchorView, EdgeView, EventStatus, NodeView, Rung, Segment, View } from './viewmodel.ts';
import type { Vocab } from './vocab.ts';

/** 플레이어가 줄글 속 말을 누름 (사건 유형, 사전 event_type) */
export const ATTENTION_DRAWN = 'attention_drawn';
export const FAIRY_ATTENTION_SRC = 'fairy';

/** 누른 말의 동사(작가가 쓴 말)가 이끄는 행동들: 주의 단어면 사전의 leads_to, 행동 단어면 그 행동. 없으면 빈 목록. */
export function attentionVerbs(vocab: Vocab, word: string): string[] {
  // 문장에는 작가가 쓴 말 그대로 남는다 (킁킁 · 탐색 …): 컴파일러(script.ts)와 같은 순서로 사전 키를 찾는다
  const att = vocab.resolve('attention', word);
  if (att !== null) {
    const lead = vocab.entry('attention', att)?.attrs['leads_to'];
    return Array.isArray(lead) ? lead.filter((x): x is string => typeof x === 'string' && vocab.has('action', x)) : [];
  }
  const act = vocab.resolve('action', word);
  return act === null ? [] : [act];
}

/** 화면의 앵커 하나: 뷰 번호, 보이는 말, 동사, 어느 이벤트(열림 사건)의 것인지 */
export interface ScreenAnchor {
  readonly id: string;
  readonly text: string;
  readonly verb: string;
  readonly event: string;
  readonly place: string;
  readonly opened: string;
  readonly closed: boolean;
}

/** 핵심 지각 노드의 번호 (뷰 안에서) */
export const CORE_NODE = 'core';

const RUNG_OF: { readonly [k: string]: Rung } = { feel: 'feel', guess: 'guess', narrow: 'narrow', thing: 'thing' };

function str(e: GameEvent, k: string): string | null {
  const v = e.data[k];
  return typeof v === 'string' ? v : null;
}

function strs(e: GameEvent, k: string): string[] {
  const v = e.data[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 정의 번호(또는 인스턴스 번호)의 한국어 이름. */
function defName(db: Db, id: string): string | null {
  const def = db.defs[id.split('#')[0] ?? id];
  return def === undefined ? null : def.names.ko;
}

/** 특징 단계의 한국어 이름 (사전 feature의 levels). */
function levelName(vocab: Vocab, feature: string, key: string): string | null {
  const levels = vocab.entry('feature', feature)?.attrs['levels'];
  if (!Array.isArray(levels)) return null;
  for (const l of levels) if (typeof l === 'object' && l !== null && !Array.isArray(l) && l['key'] === key && typeof l['ko'] === 'string') return l['ko'];
  return null;
}

/** 떠올린 개념의 이름: 물건 정의면 그 이름, 아니면 사전의 냄새 원인 (그것도 없으면 키). */
function conceptName(db: Db, vocab: Vocab, key: string): string {
  return defName(db, key) ?? vocab.entry('odor_cause', key)?.ko ?? key;
}

/** 사다리의 지금 자리를 노드 이름으로. */
function rungLabel(db: Db, vocab: Vocab, feature: string, by: string, e: GameEvent): string {
  const rung = str(e, 'rung');
  const thing = str(e, 'thing');
  if (rung === 'thing' && thing !== null) return defName(db, thing) ?? thing;
  const kinds = strs(e, 'kinds');
  if (rung === 'narrow' && kinds[0] !== undefined) return levelName(vocab, feature, kinds[0]) ?? kinds[0];
  const concepts = strs(e, 'concepts');
  if (rung === 'guess' && concepts.length > 0) return concepts.slice(0, 2).map((c) => `${conceptName(db, vocab, c)}?`).join(' ');
  return `${vocab.entry('feature', by)?.ko ?? by}?`;
}

/** 인물의 가장 최근 이벤트의 앵커들 (뷰와 같은 번호). 이벤트가 없으면 빈 목록. */
export function screenAnchors(events: readonly GameEvent[], who: string): ScreenAnchor[] {
  const b = latestEvent(events, who);
  if (b === null) return [];
  const out: ScreenAnchor[] = [];
  for (const e of b.after) {
    if (e.type !== SCENE_SHOWN || !b.same(e)) continue;
    for (const line of strs(e, 'lines')) {
      for (const part of lineParts(line)) {
        if ('verb' in part) out.push({ id: `a${out.length + 1}`, text: part.text, verb: part.verb, event: b.evt, place: b.place, opened: b.opened.seq, closed: b.closed });
      }
    }
  }
  return out;
}

interface LatestEvent {
  readonly opened: GameEvent;
  readonly evt: string;
  readonly place: string;
  readonly before: readonly GameEvent[];
  readonly after: readonly GameEvent[];
  readonly closed: boolean;
  readonly same: (e: GameEvent) => boolean;
}

function latestEvent(events: readonly GameEvent[], who: string): LatestEvent | null {
  let openAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e !== undefined && e.type === EVENT_OPENED && str(e, 'who') === who) {
      openAt = i;
      break;
    }
  }
  const opened = events[openAt];
  if (opened === undefined) return null;
  const evt = str(opened, 'event') ?? '';
  const place = str(opened, 'place') ?? '';
  const same = (e: GameEvent): boolean => str(e, 'who') === who && str(e, 'event') === evt && str(e, 'place') === place;
  const after = events.slice(openAt + 1);
  return { opened, evt, place, before: events.slice(0, openAt), after, closed: after.some((e) => e.type === EVENT_CLOSED && same(e)), same };
}

/**
 * 인물 who의 가장 최근 이벤트를 뷰로. 보여 줄 이벤트가 없거나 아직 장면이 고르지 않았으면 null.
 * 결과는 늘 화면 계약(parseView)을 지킨다 — 어기면 던진다 (엔진의 잘못이므로 숨기지 않는다).
 */
export function screenView(db: Db, vocab: Vocab, events: readonly GameEvent[], who: string): View | null {
  const b = latestEvent(events, who);
  if (b === null) return null;
  const { opened, evt, place, before, after, closed, same } = b;
  const pressed = new Set(after.filter((e) => e.type === ATTENTION_DRAWN && str(e, 'who') === who && str(e, 'opened') === opened.seq).map((e) => str(e, 'anchor')));
  const status: EventStatus = closed ? 'closed' : before.some((e) => e.type === EVENT_CLOSED && same(e)) ? 'reopened' : 'open';

  // 줄글과 앵커
  const prose: Segment[][] = [];
  const anchors: AnchorView[] = [];
  for (const e of after) {
    if (e.type !== SCENE_SHOWN || !same(e)) continue;
    for (const line of strs(e, 'lines')) {
      const para: Segment[] = [];
      for (const part of lineParts(line)) {
        if ('verb' in part) {
          const id = `a${anchors.length + 1}`;
          anchors.push({ id, circle: pressed.has(id) ? (closed ? 'closed' : 'open') : 'none' });
          para.push({ text: part.text, anchor: id });
        } else if (part.text !== '') {
          para.push({ text: part.text });
        }
      }
      if (para.length > 0) prose.push(para);
    }
  }
  if (prose.length === 0) return null;

  // 핵심 지각 노드: 이벤트의 핵심 특징을 타는 사다리의 마지막 자리 (열린 뒤, 닫히기 전까지)
  const core = db.defs[evt]?.core;
  const feature = core?.split(':')[1]?.split('@')[0] ?? '';
  const spec = ladderSpecs(vocab).find((s) => s.feature === feature);
  const nodes: NodeView[] = [];
  const edges: EdgeView[] = [];
  let ladder: GameEvent | undefined;
  for (const e of [opened, ...after]) {
    if (e.type === EVENT_CLOSED && same(e)) break;
    if (e.type === LADDER_MOVED && str(e, 'who') === who && str(e, 'of') === place && str(e, 'feature') === feature && e.data['on'] === true) ladder = e;
  }
  // 열린 순간의 사다리는 열림 사건 바로 앞에 있다 (같은 단계)
  if (ladder === undefined) {
    for (let i = before.length - 1; i >= 0; i--) {
      const e = before[i];
      if (e === undefined || e.t !== opened.t) break;
      if (e.type === LADDER_MOVED && str(e, 'who') === who && str(e, 'of') === place && str(e, 'feature') === feature && e.data['on'] === true) {
        ladder = e;
        break;
      }
    }
  }
  const rung = ladder === undefined ? undefined : RUNG_OF[str(ladder, 'rung') ?? ''];
  if (ladder !== undefined && rung !== undefined && spec !== undefined) {
    nodes.push({ id: CORE_NODE, label: rungLabel(db, vocab, feature, spec.by, ladder), kind: 'percept', rung, ring: 'core', state: closed ? 'done' : 'seen' });
    for (const a of anchors) edges.push({ from: a.id, to: CORE_NODE, kind: 'link' });
  }

  const raw = {
    version: VIEW_VERSION,
    scene: db.defs[evt]?.names.ko ?? evt,
    place: defName(db, place) ?? place,
    event: { id: evt, status },
    prose,
    anchors,
    nodes,
    edges,
  };
  const { view, problems } = parseView(raw);
  if (view === null) throw new Error(`엔진이 낸 뷰가 화면 계약을 어긴다: ${problems.join(' · ')}`);
  return view;
}
