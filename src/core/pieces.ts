// 인물 조각과 인물 기록의 대조 (docs/데이터-형식.md 6B장)
//
// 순수 함수다: 파일을 읽지 않는다. 조각은 작가 쪽 기록(인터뷰 답·원문·작가의 말)을 번호로 나눈 것이고,
// 인물 기록은 조각에서 뽑은 인격·사건·외부 사건 항목이다. 이 검사기는 둘 사이의 사슬이 끊긴 곳
// (없는 조각을 가리킴, 대체된 조각을 씀, 출처 없는 항목)을 잡고, 양쪽 방향의 쓰임을 보고한다.

import type { Issue } from './db.ts';
import type { Vocab } from './vocab.ts';

export const PIECE_FORMAT_VERSION = 1;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

const PIECE_ID = /^H-\d{3}$/;
/** 원천: 인터뷰 답(Q-번호) · S = 작가의 원문 · A = 작가가 직접 한 말 */
const SOURCE = /^(Q-\d{3}|S|A)$/;

const PIECES_TOP = ['format_version', 'file_kind', 'person', 'why', 'pieces'];
const PIECE = ['id', 'text', 'source', 'tracks', 'replaced_by'];
const SHEET_TOP = ['format_version', 'file_kind', 'person', 'why', 'persona', 'events', 'external'];
const ITEM = ['id', 'about', 'from', 'basis', 'note', 'value', 'tuned'];

/** 인물 기록의 구역과 그 항목 번호의 머리글자 */
export const SECTIONS = [
  { key: 'persona', letter: 'P', ko: '인격' },
  { key: 'events', letter: 'E', ko: '사건' },
  { key: 'external', letter: 'X', ko: '외부 사건' },
] as const;

/** 조각 없이 선 항목이 밝혀야 하는 근거: 임시값이거나 시험 보정 */
const BASES = ['provisional', 'calibrated'];

export interface Piece {
  readonly id: string;
  readonly tracks: readonly string[];
  readonly replacedBy: string | null;
}

export interface PiecesCheck {
  readonly issues: Issue[];
  readonly person: string | null;
  readonly pieces: readonly Piece[];
}

function head(raw: Obj, kind: string, top: readonly string[], err: (w: string, m: string) => void): void {
  for (const k of Object.keys(raw)) if (!top.includes(k)) err(k, `알 수 없는 최상위 필드: ${k}`);
  if (raw['format_version'] !== PIECE_FORMAT_VERSION) err('format_version', `format_version은 ${PIECE_FORMAT_VERSION}이어야 한다`);
  if (raw['file_kind'] !== kind) err('file_kind', `file_kind는 ${kind}여야 한다`);
  if (!filled(raw['person'])) err('person', '인물 이름(person)이 필요하다');
  if (!filled(raw['why'])) err('why', '이유(why)가 필요하다');
}

/** 조각 파일 하나를 검사한다. */
export function checkPieces(raw: unknown, vocab: Vocab): PiecesCheck {
  const issues: Issue[] = [];
  const err = (where: string, msg: string): void => void issues.push({ level: 'error', where, msg });
  if (!isObj(raw)) return { issues: [{ level: 'error', where: 'file', msg: '조각 파일이 객체가 아니다' }], person: null, pieces: [] };
  head(raw, 'pieces', PIECES_TOP, err);
  const person = filled(raw['person']) ? raw['person'] : null;
  const list = raw['pieces'];
  if (!Array.isArray(list) || list.length === 0) {
    err('pieces', 'pieces는 비어 있지 않은 목록이어야 한다');
    return { issues, person, pieces: [] };
  }

  const pieces: Piece[] = [];
  const ids = new Set<string>();
  list.forEach((p, i) => {
    const at = `pieces[${i}]`;
    if (!isObj(p)) return err(at, '조각은 객체여야 한다');
    for (const k of Object.keys(p)) if (!PIECE.includes(k)) err(`${at}.${k}`, `알 수 없는 필드: ${k}`);
    const id = p['id'];
    if (typeof id !== 'string' || !PIECE_ID.test(id)) return err(`${at}.id`, '조각 번호는 H-001 꼴이어야 한다');
    if (ids.has(id)) return err(`${at}.id`, `조각 번호 ${id}가 두 번 나온다`);
    ids.add(id);
    if (!filled(p['text'])) err(`${at}.text`, '조각의 내용(text)이 필요하다');
    const source = p['source'];
    if (!isStrList(source) || source.length === 0) err(`${at}.source`, '원천이 하나 이상 필요하다 (Q-001, S, A)');
    else for (const s of source) if (!SOURCE.test(s)) err(`${at}.source`, `원천 형식이 아니다 (Q-001, S, A): ${s}`);
    const tracks = p['tracks'];
    const okTracks: string[] = [];
    if (!isStrList(tracks) || tracks.length === 0) err(`${at}.tracks`, '궤도가 하나 이상 필요하다');
    else {
      for (const t of tracks) {
        if (!vocab.has('track', t)) err(`${at}.tracks`, `사전에 없는 궤도: ${t}`);
        else if (okTracks.includes(t)) err(`${at}.tracks`, `궤도 ${t}가 두 번 나온다`);
        else okTracks.push(t);
      }
    }
    const rep = p['replaced_by'];
    if (rep !== undefined && typeof rep !== 'string') err(`${at}.replaced_by`, 'replaced_by는 조각 번호여야 한다');
    pieces.push({ id, tracks: okTracks, replacedBy: typeof rep === 'string' ? rep : null });
  });

  // 대체는 있는 조각만, 자기 자신이 아닌 조각만 가리킨다. 돌아오는 고리는 끝이 없으므로 거부한다
  const byId = new Map(pieces.map((p) => [p.id, p]));
  for (const p of pieces) {
    if (p.replacedBy === null) continue;
    if (p.replacedBy === p.id) err(p.id, '조각이 자기 자신으로 대체될 수 없다');
    else if (!byId.has(p.replacedBy)) err(p.id, `대체하는 조각 ${p.replacedBy}가 없다`);
    else {
      const seen = new Set<string>([p.id]);
      let cur = byId.get(p.replacedBy);
      while (cur !== undefined && cur.replacedBy !== null) {
        if (seen.has(cur.id)) {
          err(p.id, '대체가 고리를 이룬다');
          break;
        }
        seen.add(cur.id);
        cur = byId.get(cur.replacedBy);
      }
    }
  }
  return { issues, person, pieces };
}

export interface TraceItem {
  readonly id: string;
  readonly section: string;
  readonly from: readonly string[];
  readonly basis: string | null;
}

export interface TraceReport {
  readonly pieces: number;
  readonly replaced: number;
  readonly items: number;
  /** 구역별 항목 수 */
  readonly bySection: Readonly<Record<string, number>>;
  /** 조각 번호 → 그 조각을 쓰는 항목 번호 */
  readonly usedBy: Readonly<Record<string, readonly string[]>>;
  /** 어느 항목에도 쓰이지 않은 살아 있는 조각 */
  readonly unused: readonly string[];
  /** 조각 없이 선 항목 (임시값·시험 보정) */
  readonly withoutPiece: readonly string[];
  /** 궤도별: 살아 있는 조각 수와 그 가운데 쓰인 수 */
  readonly byTrack: Readonly<Record<string, { pieces: number; used: number }>>;
}

export interface TraceCheck {
  readonly issues: Issue[];
  readonly report: TraceReport | null;
}

/** 조각 파일과 인물 기록을 대조한다. 조각 파일의 문제는 `pieces.` 머리로 함께 낸다. */
export function tracePerson(piecesRaw: unknown, sheetRaw: unknown, vocab: Vocab): TraceCheck {
  const pc = checkPieces(piecesRaw, vocab);
  const issues: Issue[] = pc.issues.map((i) => ({ ...i, where: `pieces.${i.where}` }));
  const err = (where: string, msg: string): void => void issues.push({ level: 'error', where: `sheet.${where}`, msg });
  if (!isObj(sheetRaw)) {
    issues.push({ level: 'error', where: 'sheet', msg: '인물 기록이 객체가 아니다' });
    return { issues, report: null };
  }
  head(sheetRaw, 'person_sheet', SHEET_TOP, err);
  if (pc.person !== null && filled(sheetRaw['person']) && sheetRaw['person'] !== pc.person) {
    err('person', `조각 파일의 인물(${pc.person})과 다르다`);
  }

  const byId = new Map(pc.pieces.map((p) => [p.id, p]));
  const items: TraceItem[] = [];
  const ids = new Set<string>();
  const bySection: Record<string, number> = {};
  for (const sec of SECTIONS) {
    const list = sheetRaw[sec.key] ?? [];
    bySection[sec.key] = 0;
    if (!Array.isArray(list)) {
      err(sec.key, `${sec.key}는 목록이어야 한다`);
      continue;
    }
    list.forEach((it, i) => {
      const at = `${sec.key}[${i}]`;
      if (!isObj(it)) return err(at, '항목은 객체여야 한다');
      for (const k of Object.keys(it)) if (!ITEM.includes(k)) err(`${at}.${k}`, `알 수 없는 필드: ${k}`);
      const id = it['id'];
      if (typeof id !== 'string' || !new RegExp(`^${sec.letter}-\\d{2,3}$`).test(id)) {
        return err(`${at}.id`, `${sec.ko} 항목 번호는 ${sec.letter}-01 꼴이어야 한다`);
      }
      if (ids.has(id)) return err(`${at}.id`, `항목 번호 ${id}가 두 번 나온다`);
      ids.add(id);
      if (!filled(it['about'])) err(`${at}.about`, '항목의 내용(about)이 필요하다');

      const from = it['from'] ?? [];
      const okFrom: string[] = [];
      if (!isStrList(from)) err(`${at}.from`, 'from은 조각 번호 목록이어야 한다');
      else {
        for (const h of from) {
          const piece = byId.get(h);
          if (piece === undefined) err(`${at}.from`, `없는 조각을 가리킨다: ${h}`);
          else if (piece.replacedBy !== null) err(`${at}.from`, `대체된 조각을 가리킨다: ${h} → ${piece.replacedBy}`);
          else if (okFrom.includes(h)) err(`${at}.from`, `조각 ${h}가 두 번 나온다`);
          else okFrom.push(h);
        }
      }

      // 조각에서 오지 않은 항목은 근거(임시값 또는 시험 보정)와 그 설명을 밝힌다
      const basis = it['basis'];
      if (basis !== undefined && (typeof basis !== 'string' || !BASES.includes(basis))) {
        err(`${at}.basis`, `basis는 ${BASES.join(' 또는 ')}여야 한다`);
      }
      const noPiece = isStrList(from) && from.length === 0;
      if (noPiece && basis === undefined) err(`${at}.from`, '조각도 근거(basis)도 없는 항목이다');
      if (basis !== undefined && !filled(it['note'])) err(`${at}.note`, 'basis를 쓰면 설명(note)이 필요하다');

      // 수치: 정수만. 보정하지 않은 값은 tuned:false, 보정한 값은 근거가 calibrated 여야 한다
      const value = it['value'];
      const tuned = it['tuned'];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isInteger(value)) err(`${at}.value`, 'value는 정수여야 한다');
        if (typeof tuned !== 'boolean') err(`${at}.tuned`, 'value가 있으면 tuned(true/false)가 필요하다');
        else if (tuned && basis !== 'calibrated') err(`${at}.tuned`, 'tuned:true는 basis가 calibrated일 때만 쓴다');
      } else if (tuned !== undefined) err(`${at}.tuned`, 'tuned는 value와 함께 쓴다');

      bySection[sec.key] = (bySection[sec.key] ?? 0) + 1;
      items.push({ id, section: sec.key, from: okFrom, basis: typeof basis === 'string' ? basis : null });
    });
  }
  if (items.length === 0) err('persona', '항목이 하나도 없다');

  const usedBy: Record<string, string[]> = {};
  for (const it of items) for (const h of it.from) (usedBy[h] ??= []).push(it.id);
  const live = pc.pieces.filter((p) => p.replacedBy === null);
  const byTrack: Record<string, { pieces: number; used: number }> = {};
  for (const t of vocab.keys('track')) byTrack[t] = { pieces: 0, used: 0 };
  for (const p of live) {
    for (const t of p.tracks) {
      const row = byTrack[t];
      if (row === undefined) continue;
      row.pieces += 1;
      if (usedBy[p.id] !== undefined) row.used += 1;
    }
  }
  return {
    issues,
    report: {
      pieces: pc.pieces.length,
      replaced: pc.pieces.length - live.length,
      items: items.length,
      bySection,
      usedBy,
      unused: live.filter((p) => usedBy[p.id] === undefined).map((p) => p.id),
      withoutPiece: items.filter((it) => it.from.length === 0).map((it) => it.id),
      byTrack,
    },
  };
}

/** 사람이 읽는 요약. */
export function traceReportText(r: TraceReport, vocab: Vocab): string {
  const lines = [
    `조각 ${r.pieces}개 (대체됨 ${r.replaced}) · 항목 ${r.items}개 (${SECTIONS.map((s) => `${s.ko} ${r.bySection[s.key] ?? 0}`).join(' · ')})`,
    `궤도: ${Object.entries(r.byTrack).map(([t, v]) => `${vocab.entry('track', t)?.ko ?? t} ${v.used}/${v.pieces}`).join(' · ')}  (쓰인 조각/조각)`,
  ];
  lines.push(r.unused.length > 0 ? `아직 쓰이지 않은 조각: ${r.unused.join(', ')}` : '모든 조각이 쓰였다');
  if (r.withoutPiece.length > 0) lines.push(`조각 없이 선 항목 (임시값·보정): ${r.withoutPiece.join(', ')}`);
  return lines.join('\n');
}
