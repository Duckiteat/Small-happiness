// 화면 계약 (docs/화면-계약.md)
//
// 코어가 상태에서 계산해 내는 뷰 모델이다. 화면은 이것을 그리기만 한다.
// 좌표는 넣지 않는다 — 배치는 화면의 일이지만 같은 뷰에서는 같은 배치가 나와야 한다(난수 금지).
// 순수 모듈: 모양 검사, 규칙 검사, 두 상태의 차이 계산만 한다.

export const VIEW_VERSION = 1;
/** 지도에 한 번에 보이는 노드의 상한 (faded 제외, ghost 포함). 결정 기록: 5개. */
export const MAX_VISIBLE_NODES = 5;

export const CIRCLES = ['none', 'open', 'closed'] as const;
export const EVENT_STATUSES = ['none', 'open', 'closed', 'reopened'] as const;
export const NODE_KINDS = ['percept', 'action', 'object', 'memory', 'ghost'] as const;
export const RUNGS = ['feel', 'guess', 'thing'] as const;
export const RINGS = ['core', 'periphery', 'none'] as const;
export const NODE_STATES = ['new', 'seen', 'done', 'faded'] as const;
export const EDGE_KINDS = ['option', 'link', 'unknown'] as const;

export type CircleState = (typeof CIRCLES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type Rung = (typeof RUNGS)[number];
export type Ring = (typeof RINGS)[number];
export type NodeState = (typeof NODE_STATES)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Segment {
  readonly text: string;
  /** 눌리는 단어이면 앵커 번호 */
  readonly anchor?: string;
}

export interface AnchorView {
  readonly id: string;
  readonly circle: CircleState;
}

export interface NodeView {
  readonly id: string;
  readonly label: string;
  readonly kind: NodeKind;
  /** percept 노드만: 심상 사다리의 칸 */
  readonly rung?: Rung;
  readonly ring: Ring;
  readonly state: NodeState;
  /** ghost 노드만: 못 뜬 이유를 알리는 서술 */
  readonly hint?: string;
}

export interface EdgeView {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

export interface View {
  readonly version: typeof VIEW_VERSION;
  readonly scene: string;
  readonly place: string;
  readonly event: { readonly id: string | null; readonly status: EventStatus };
  readonly prose: readonly (readonly Segment[])[];
  readonly anchors: readonly AnchorView[];
  readonly nodes: readonly NodeView[];
  readonly edges: readonly EdgeView[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

function arr(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 외부에서 온 값을 뷰로 해석하고 규칙을 검사한다. 문제가 있으면 view는 null. */
export function parseView(raw: unknown): { view: View | null; problems: string[] } {
  const problems: string[] = [];
  const bad = (msg: string): void => void problems.push(msg);

  if (!isObj(raw)) return { view: null, problems: ['뷰가 객체가 아니다'] };
  if (raw['version'] !== VIEW_VERSION) bad(`version이 ${VIEW_VERSION}이 아니다`);
  const scene = raw['scene'];
  const place = raw['place'];
  if (typeof scene !== 'string' || scene === '') bad('scene이 필요하다');
  if (typeof place !== 'string' || place === '') bad('place가 필요하다');

  const ev = raw['event'];
  let event: View['event'] = { id: null, status: 'none' };
  if (!isObj(ev) || !oneOf(ev['status'], EVENT_STATUSES) || !(ev['id'] === null || typeof ev['id'] === 'string')) {
    bad('event는 { id: 문자열|null, status }여야 한다');
  } else {
    event = { id: ev['id'], status: ev['status'] };
  }

  // 줄글
  const prose: Segment[][] = [];
  arr(raw['prose']).forEach((para, i) => {
    if (!Array.isArray(para)) return bad(`prose[${i}]가 문단(목록)이 아니다`);
    const segs: Segment[] = [];
    para.forEach((s: unknown, j) => {
      if (!isObj(s) || typeof s['text'] !== 'string' || s['text'] === '') return bad(`prose[${i}][${j}]에 text가 필요하다`);
      if (s['anchor'] !== undefined && typeof s['anchor'] !== 'string') return bad(`prose[${i}][${j}].anchor는 문자열이어야 한다`);
      segs.push(typeof s['anchor'] === 'string' ? { text: s['text'], anchor: s['anchor'] } : { text: s['text'] });
    });
    prose.push(segs);
  });
  if (prose.length === 0) bad('prose가 비어 있다');

  // 앵커
  const anchors: AnchorView[] = [];
  arr(raw['anchors']).forEach((a, i) => {
    if (!isObj(a) || typeof a['id'] !== 'string' || !oneOf(a['circle'], CIRCLES)) return bad(`anchors[${i}]는 { id, circle }이어야 한다`);
    anchors.push({ id: a['id'], circle: a['circle'] });
  });

  // 노드
  const nodes: NodeView[] = [];
  arr(raw['nodes']).forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!isObj(n) || typeof n['id'] !== 'string' || typeof n['label'] !== 'string' || n['label'] === '') return bad(`${at}에 id와 label이 필요하다`);
    if (!oneOf(n['kind'], NODE_KINDS) || !oneOf(n['ring'], RINGS) || !oneOf(n['state'], NODE_STATES)) return bad(`${at}의 kind/ring/state가 올바르지 않다`);
    if (n['rung'] !== undefined && !oneOf(n['rung'], RUNGS)) return bad(`${at}.rung이 올바르지 않다`);
    if (n['hint'] !== undefined && typeof n['hint'] !== 'string') return bad(`${at}.hint는 문자열이어야 한다`);
    const base = { id: n['id'], label: n['label'], kind: n['kind'], ring: n['ring'], state: n['state'] };
    nodes.push({
      ...base,
      ...(oneOf(n['rung'], RUNGS) ? { rung: n['rung'] } : {}),
      ...(typeof n['hint'] === 'string' ? { hint: n['hint'] } : {}),
    });
  });

  // 간선
  const edges: EdgeView[] = [];
  arr(raw['edges']).forEach((e, i) => {
    if (!isObj(e) || typeof e['from'] !== 'string' || typeof e['to'] !== 'string' || !oneOf(e['kind'], EDGE_KINDS)) {
      return bad(`edges[${i}]는 { from, to, kind }여야 한다`);
    }
    edges.push({ from: e['from'], to: e['to'], kind: e['kind'] });
  });

  if (problems.length > 0) return { view: null, problems };

  // ---- 규칙 ----
  const ids = new Set<string>();
  for (const id of [...anchors.map((a) => a.id), ...nodes.map((n) => n.id)]) {
    if (ids.has(id)) bad(`번호가 중복된다: ${id}`);
    ids.add(id);
  }

  const proseAnchors = new Set(prose.flat().flatMap((s) => (s.anchor === undefined ? [] : [s.anchor])));
  const anchorIds = new Set(anchors.map((a) => a.id));
  for (const id of proseAnchors) if (!anchorIds.has(id)) bad(`줄글의 앵커가 anchors에 없다: ${id}`);
  for (const id of anchorIds) if (!proseAnchors.has(id)) bad(`anchors의 앵커가 줄글에 없다: ${id}`);

  for (const e of edges) {
    if (!ids.has(e.from)) bad(`간선이 없는 번호를 가리킨다: ${e.from}`);
    if (!ids.has(e.to)) bad(`간선이 없는 번호를 가리킨다: ${e.to}`);
  }

  const visible = nodes.filter((n) => n.state !== 'faded').length;
  if (visible > MAX_VISIBLE_NODES) bad(`보이는 노드가 ${visible}개로 상한 ${MAX_VISIBLE_NODES}개를 넘는다`);

  for (const a of anchors) {
    if (event.status === 'closed' && a.circle === 'open') bad(`이벤트가 닫혔는데 앵커 ${a.id}의 동그라미가 열려 있다`);
    if ((event.status === 'open' || event.status === 'reopened') && a.circle === 'closed') {
      bad(`이벤트가 열려 있는데 앵커 ${a.id}의 동그라미가 닫혔다`);
    }
    if (event.status === 'none' && a.circle !== 'none') bad(`이벤트가 없는데 앵커 ${a.id}에 동그라미가 있다`);
  }

  for (const n of nodes) {
    if (n.kind === 'percept' && n.rung === undefined) bad(`지각 노드 ${n.id}에 rung(사다리 칸)이 필요하다`);
    if (n.kind !== 'percept' && n.rung !== undefined) bad(`지각 노드가 아닌 ${n.id}에 rung이 있다`);
    if (n.kind === 'ghost' && (n.hint === undefined || n.hint === '')) bad(`ghost 노드 ${n.id}에 못 뜬 이유(hint)가 필요하다`);
    if (n.kind !== 'ghost' && n.hint !== undefined) bad(`ghost가 아닌 ${n.id}에 hint가 있다`);
  }

  const corePercepts = nodes.filter((n) => n.kind === 'percept' && n.ring === 'core' && n.state !== 'faded');
  if (corePercepts.length > 1) bad('보이는 핵심 지각 노드가 둘 이상이다 (이벤트의 핵심은 하나)');

  if (problems.length > 0) return { view: null, problems };
  return { view: { version: VIEW_VERSION, scene: scene as string, place: place as string, event, prose, anchors, nodes, edges }, problems };
}

export interface ViewDiff {
  readonly eventStatus: { readonly from: EventStatus; readonly to: EventStatus } | null;
  readonly circles: readonly { readonly id: string; readonly from: CircleState | null; readonly to: CircleState | null }[];
  readonly nodesAdded: readonly string[];
  /** 사라졌거나 faded가 된 노드 */
  readonly nodesRemoved: readonly string[];
  readonly relabeled: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  readonly rungChanged: readonly { readonly id: string; readonly from: Rung | null; readonly to: Rung | null }[];
  readonly proseAdded: number;
}

/** 두 상태의 차이. 화면이 전환 연출(동그라미 그리기, 선 뻗기, 라벨 변화)을 계산하는 근거다. */
export function diffView(a: View, b: View): ViewDiff {
  const aCircle = new Map(a.anchors.map((x) => [x.id, x.circle]));
  const bCircle = new Map(b.anchors.map((x) => [x.id, x.circle]));
  const circles: { id: string; from: CircleState | null; to: CircleState | null }[] = [];
  for (const id of [...new Set([...aCircle.keys(), ...bCircle.keys()])].sort()) {
    const from = aCircle.get(id) ?? null;
    const to = bCircle.get(id) ?? null;
    if (from !== to) circles.push({ id, from, to });
  }

  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
  const visible = (n: NodeView | undefined): boolean => n !== undefined && n.state !== 'faded';
  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const relabeled: { id: string; from: string; to: string }[] = [];
  const rungChanged: { id: string; from: Rung | null; to: Rung | null }[] = [];

  for (const id of [...new Set([...aNodes.keys(), ...bNodes.keys()])].sort()) {
    const na = aNodes.get(id);
    const nb = bNodes.get(id);
    if (!visible(na) && visible(nb)) nodesAdded.push(id);
    if (visible(na) && !visible(nb)) nodesRemoved.push(id);
    if (na !== undefined && nb !== undefined) {
      if (na.label !== nb.label) relabeled.push({ id, from: na.label, to: nb.label });
      if ((na.rung ?? null) !== (nb.rung ?? null)) rungChanged.push({ id, from: na.rung ?? null, to: nb.rung ?? null });
    }
  }

  return {
    eventStatus: a.event.status === b.event.status ? null : { from: a.event.status, to: b.event.status },
    circles,
    nodesAdded,
    nodesRemoved,
    relabeled,
    rungChanged,
    proseAdded: Math.max(0, b.prose.length - a.prose.length),
  };
}
