// 문장 자리 파일 검사 (docs/데이터-형식.md 6장)
//
// 순수 함수다: 파일을 읽지 않는다. 작가는 자리마다 `text`만 채우고, 조건·태그·힌트는 도구가 채워 둔 파일을 쓴다.
// 중첩 규칙: 모든 자리에 기본 문장이 하나 있고, 조건이 더 많이 맞는 변형이 위에 얹힌다(구체성 우선).
// 이 검사기는 중첩이 조용히 어긋나는 곳(빈 기본 문장, 구체성이 같아 충돌하는 변형, 켜질 수 없는 변형)을 잡는다.

import type { Issue } from './db.ts';
import { condRange } from './statekey.ts';
import type { CompareOp } from './statekey.ts';
import type { Vocab } from './vocab.ts';

export const SLOT_FORMAT_VERSION = 1;

export type SlotCond =
  | { readonly kind: 'state'; readonly feature: string; readonly op: CompareOp; readonly level: string }
  | { readonly kind: 'sense'; readonly sense: string; readonly value: 'high' | 'low' };

const STATE_RE = /^([a-z][a-z0-9_]*)@(>=|<=|=|>|<)([a-z][a-z0-9_]*)$/;
const SENSE_RE = /^sense:([a-z][a-z0-9_]*)=(high|low)$/;

/** `mold@>=spot` 또는 `sense:smell=high` 를 읽는다. 모양이 아니면 null. */
export function parseSlotCond(text: string): SlotCond | null {
  const s = STATE_RE.exec(text);
  if (s !== null) {
    const [, feature, op, level] = s;
    if (feature === undefined || op === undefined || level === undefined) return null;
    return { kind: 'state', feature, op: op as CompareOp, level };
  }
  const n = SENSE_RE.exec(text);
  if (n !== null) {
    const [, sense, value] = n;
    if (sense === undefined || (value !== 'high' && value !== 'low')) return null;
    return { kind: 'sense', sense, value };
  }
  return null;
}

/** 조건 하나가 사전과 맞는지. 맞으면 null, 아니면 이유. */
function condProblem(c: SlotCond, vocab: Vocab): string | null {
  if (c.kind === 'sense') return vocab.has('sense', c.sense) ? null : `사전에 없는 감각: ${c.sense}`;
  const order = vocab.levelOrder(c.feature);
  if (order === undefined) return `사전에 없는 특징: ${c.feature}`;
  if (vocab.has('terminal', c.level)) return c.op === '=' ? null : `종결 단계 "${c.level}"는 = 조건으로만 쓸 수 있다`;
  if (!order.includes(c.level)) return `"${c.feature}"에 없는 단계 키: ${c.level} (${order.join(', ')})`;
  if (vocab.isLocked(c.feature, c.level)) return `단계 "${c.level}"는 아직 잠겨 있다`;
  const r = condRange({ op: c.op, level: c.level }, order);
  return r === null || r.min > r.max ? `빈 범위 조건: ${c.feature}@${c.op}${c.level}` : null;
}

function rangeOf(c: Extract<SlotCond, { kind: 'state' }>, vocab: Vocab): { min: number; max: number } | null {
  if (vocab.has('terminal', c.level)) {
    const k = vocab.keys('terminal').indexOf(c.level);
    return { min: 1000 + k, max: 1000 + k }; // 종결 단계는 사다리 밖의 따로 선 자리
  }
  const order = vocab.levelOrder(c.feature);
  const r = condRange({ op: c.op, level: c.level }, order);
  // '이상' 조건의 끝은 무한대라서 사다리 끝(마지막 칸)에서 자른다. 종결 단계는 사다리 밖이라 포함되지 않는다
  return r === null || order === undefined ? null : { min: r.min, max: Math.min(r.max, order.length - 1) };
}

/** 조건들이 한꺼번에 참일 수 있는가 (같은 특징의 범위가 겹치고, 같은 감각이 서로 다른 값을 요구하지 않음). */
export function satisfiable(conds: readonly SlotCond[], vocab: Vocab): boolean {
  const ranges = new Map<string, { min: number; max: number }>();
  const senses = new Map<string, string>();
  for (const c of conds) {
    if (c.kind === 'sense') {
      const prev = senses.get(c.sense);
      if (prev !== undefined && prev !== c.value) return false;
      senses.set(c.sense, c.value);
      continue;
    }
    const r = rangeOf(c, vocab);
    if (r === null || r.min > r.max) return false;
    const prev = ranges.get(c.feature);
    const next = prev === undefined ? r : { min: Math.max(prev.min, r.min), max: Math.min(prev.max, r.max) };
    if (next.min > next.max) return false;
    ranges.set(c.feature, next);
  }
  return true;
}

export interface SlotReport {
  readonly slots: number;
  readonly required: number;
  readonly defaultsFilled: number;
  /** 비어 있는 필수 기본 문장의 자리 번호 */
  readonly requiredEmpty: readonly string[];
  readonly variants: number;
  readonly variantsFilled: number;
}

export interface SlotCheck {
  readonly issues: Issue[];
  readonly report: SlotReport;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

const TOP = ['format_version', 'context', 'why', 'slots'];
const SLOT = ['id', 'about', 'when', 'reactions', 'need', 'hint', 'action', 'default', 'variants'];
const VARIANT = ['id', 'label', 'when', 'text'];

/** 자리 파일 하나를 검사한다. strict 면 비어 있는 필수 기본 문장도 오류다. */
export function checkSlotFile(raw: unknown, vocab: Vocab, options: { strict?: boolean } = {}): SlotCheck {
  const issues: Issue[] = [];
  const err = (where: string, msg: string): void => void issues.push({ level: 'error', where, msg });
  const empty: SlotReport = { slots: 0, required: 0, defaultsFilled: 0, requiredEmpty: [], variants: 0, variantsFilled: 0 };

  if (!isObj(raw)) return { issues: [{ level: 'error', where: 'file', msg: '자리 파일이 객체가 아니다' }], report: empty };
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) err(k, `알 수 없는 최상위 필드: ${k}`);
  if (raw['format_version'] !== SLOT_FORMAT_VERSION) err('format_version', `format_version은 ${SLOT_FORMAT_VERSION}이어야 한다`);
  if (!filled(raw['context'])) err('context', '맥락 이름이 필요하다');
  if (!filled(raw['why'])) err('why', '이유(why)가 필요하다');
  const slots = raw['slots'];
  if (!Array.isArray(slots) || slots.length === 0) {
    err('slots', 'slots는 비어 있지 않은 목록이어야 한다');
    return { issues, report: empty };
  }

  const ids = new Set<string>();
  let required = 0;
  let defaultsFilled = 0;
  let variantsTotal = 0;
  let variantsFilled = 0;
  const requiredEmpty: string[] = [];

  const readConds = (list: unknown, where: string, mustHave: boolean): SlotCond[] => {
    if (!Array.isArray(list) || (mustHave && list.length === 0)) {
      err(where, mustHave ? '조건이 하나 이상 필요하다' : '조건은 목록이어야 한다');
      return [];
    }
    const out: SlotCond[] = [];
    list.forEach((t, i) => {
      const at = `${where}[${i}]`;
      const c = typeof t === 'string' ? parseSlotCond(t) : null;
      if (c === null) return err(at, `조건 형식이 아니다 (예: mold@>=spot, sense:smell=high): ${String(t)}`);
      const problem = condProblem(c, vocab);
      if (problem !== null) return err(at, problem);
      out.push(c);
    });
    return out;
  };

  slots.forEach((s, i) => {
    const at = `slots[${i}]`;
    if (!isObj(s)) return err(at, '자리는 객체여야 한다');
    for (const k of Object.keys(s)) if (!SLOT.includes(k)) err(`${at}.${k}`, `알 수 없는 필드: ${k}`);
    const id = s['id'];
    if (typeof id !== 'string' || !/^S-\S+$/.test(id)) err(`${at}.id`, '자리 번호는 "S-"로 시작하고 공백이 없어야 한다');
    else if (ids.has(id)) err(`${at}.id`, `자리 번호 ${id}가 두 번 나온다`);
    else ids.add(id);
    const label = typeof id === 'string' ? id : at;
    if (!filled(s['about'])) err(`${at}.about`, '자리 설명(about)이 필요하다');
    const need = s['need'] ?? 'required';
    if (need !== 'required' && need !== 'optional') err(`${at}.need`, 'need는 required 또는 optional이어야 한다');
    if (s['action'] !== undefined && (typeof s['action'] !== 'string' || !vocab.has('action', s['action']))) {
      err(`${at}.action`, `사전에 없는 행동: ${String(s['action'])}`);
    }
    if (s['reactions'] !== undefined && !(Array.isArray(s['reactions']) && s['reactions'].every((x) => typeof x === 'string'))) {
      err(`${at}.reactions`, 'reactions는 문자열 목록이어야 한다');
    }

    const trigger = readConds(s['when'], `${at}.when`, true);
    if (trigger.length > 0 && !satisfiable(trigger, vocab)) err(`${at}.when`, '트리거 조건이 서로 모순되어 켜질 수 없다');

    // 기본 문장
    const def = s['default'];
    if (!isObj(def) || !('text' in def)) err(`${at}.default`, '기본 문장(default.text)이 필요하다');
    else {
      for (const k of Object.keys(def)) if (k !== 'text') err(`${at}.default.${k}`, `알 수 없는 필드: ${k}`);
      if (typeof def['text'] !== 'string') err(`${at}.default.text`, 'text는 문자열이어야 한다');
    }
    const isRequired = need === 'required';
    const defFilled = isObj(def) && filled(def['text']);
    if (isRequired) {
      required += 1;
      if (defFilled) defaultsFilled += 1;
      else {
        requiredEmpty.push(label);
        if (options.strict === true) err(`${at}.default.text`, '필수 자리의 기본 문장이 비어 있다');
      }
    } else if (defFilled) defaultsFilled += 1;

    // 변형
    const list = s['variants'] ?? [];
    if (!Array.isArray(list)) return err(`${at}.variants`, 'variants는 목록이어야 한다');
    const parsed: { id: string; conds: SlotCond[] }[] = [];
    list.forEach((v, j) => {
      const vat = `${at}.variants[${j}]`;
      if (!isObj(v)) return err(vat, '변형은 객체여야 한다');
      for (const k of Object.keys(v)) if (!VARIANT.includes(k)) err(`${vat}.${k}`, `알 수 없는 필드: ${k}`);
      const vid = v['id'];
      if (typeof vid !== 'string' || vid === '') err(`${vat}.id`, '변형 번호가 필요하다');
      else if (ids.has(vid)) err(`${vat}.id`, `번호 ${vid}가 두 번 나온다`);
      else ids.add(vid);
      if (typeof v['text'] !== 'string') err(`${vat}.text`, 'text는 문자열이어야 한다');
      variantsTotal += 1;
      if (filled(v['text'])) variantsFilled += 1;
      const conds = readConds(v['when'], `${vat}.when`, true);
      if (conds.length === 0) return;
      const vname = typeof vid === 'string' ? vid : vat;
      if (!satisfiable(conds, vocab)) return err(`${vat}.when`, `변형 ${vname}의 조건이 서로 모순되어 켜질 수 없다`);
      if (trigger.length > 0 && !satisfiable([...trigger, ...conds], vocab)) {
        return err(`${vat}.when`, `변형 ${vname}이 트리거와 모순되어 켜질 수 없다`);
      }
      parsed.push({ id: vname, conds });
    });
    // 구체성(조건 수)이 같고 한꺼번에 참일 수 있는 변형 쌍은 어느 쪽이 이길지 모호하다
    for (let a = 0; a < parsed.length; a++) {
      for (let b = a + 1; b < parsed.length; b++) {
        const pa = parsed[a];
        const pb = parsed[b];
        if (pa === undefined || pb === undefined || pa.conds.length !== pb.conds.length) continue;
        if (satisfiable([...trigger, ...pa.conds, ...pb.conds], vocab)) {
          err(`${at}.variants`, `변형 ${pa.id}와 ${pb.id}는 구체성이 같고 함께 켜질 수 있어 어느 쪽이 이길지 모호하다 (조건을 더하거나 갈라 주세요)`);
        }
      }
    }
  });

  return {
    issues,
    report: { slots: slots.length, required, defaultsFilled, requiredEmpty, variants: variantsTotal, variantsFilled },
  };
}

/** 사람이 읽는 요약. */
export function slotReportText(r: SlotReport): string {
  const lines = [
    `자리 ${r.slots}개 (필수 ${r.required}) · 기본 문장 채움 ${r.defaultsFilled}/${r.slots} · 변형 채움 ${r.variantsFilled}/${r.variants}`,
  ];
  if (r.requiredEmpty.length > 0) lines.push(`비어 있는 필수 기본 문장: ${r.requiredEmpty.join(', ')}`);
  return lines.join('\n');
}
