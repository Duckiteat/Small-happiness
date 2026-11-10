// 화면에 보낼 뷰 모델 (화면-계약, 구현-계획 N1-1): 엔진의 사건 기록에서 화면 계약의 뷰(View)를 계산한다.
//
// 한 인물의 **가장 최근 이벤트**를 보여 준다 (열려 있으면 그것, 닫혔으면 닫힌 채로 다음 이벤트가 열릴 때까지).
//   - 줄글: 이벤트가 열린 뒤 고른 장면의 문장을 차례로 (문단 = 문장 한 줄). 앵커 번호는 나온 순서대로 a1, a2 …
//   - 지도: 핵심 지각 노드 하나 — 심상 사다리의 지금 칸과 그 칸의 이름 (느낌 → 짐작 → 좁힘 → 정체)
//   - 선: 앵커마다 핵심 노드로 이어지는 선 (link)
//   - 이벤트 상태: 열림 / 닫힘 / 다시 열림(같은 장소에서 전에 닫힌 적이 있으면)
// 아직 없는 것 (LIM045): 앵커를 누른 동그라미(늘 none), 행동 노드, 주변부, 뜨지 못한 생각(ghost).
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

/**
 * 인물 who의 가장 최근 이벤트를 뷰로. 보여 줄 이벤트가 없거나 아직 장면이 고르지 않았으면 null.
 * 결과는 늘 화면 계약(parseView)을 지킨다 — 어기면 던진다 (엔진의 잘못이므로 숨기지 않는다).
 */
export function screenView(db: Db, vocab: Vocab, events: readonly GameEvent[], who: string): View | null {
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
  const before = events.slice(0, openAt);
  const after = events.slice(openAt + 1);

  const closed = after.some((e) => e.type === EVENT_CLOSED && same(e));
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
          anchors.push({ id, circle: 'none' });
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
