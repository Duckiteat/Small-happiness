// 원본 데이터 → 패치 (docs/데이터-형식.md 5장 ①~④)
//
// 순수 함수다: 파일을 읽거나 쓰지 않는다. 출력은 기존 패치 형식의 객체이며, 이를 parsePatch → mergePatch → runGate 가 검사한다.
// 아직 설계만 된 필드(명세 단계)는 조용히 버리지 않고 거부한다.

import type { Issue } from './db.ts';
import { PATCH_FORMAT, PATCH_VERSION } from './patch.ts';

export const SOURCE_FORMAT_VERSION = 1;

/** 지금 받는 종류와 그 접두. 나머지 종류는 명세 단계다. */
const KIND_PREFIX: Readonly<Record<string, string>> = { objects: 'OBJ', places: 'PLC' };

/** 종류별로 지금 받는 최상위 필드. */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  objects: ['id', 'names', 'aliases', 'desc', 'mobility', 'slots', 'meanings', 'rules', 'is_a', 'override'],
  places: ['id', 'names', 'aliases', 'desc', 'slots', 'meanings', 'rules'],
};

/** 펼치기(override)로 바꿀 수 있는 필드. */
const OVERRIDABLE: readonly string[] = ['mobility', 'slots', 'meanings', 'rules'];

/** 규칙 블록에서 받는 키. warn_before_s 는 명세 단계다. */
const RULE_FIELDS: readonly string[] = ['label', 'on', 'emits', 'delay_s', 'tuned'];

/** 명세 단계 필드가 쓰였을 때의 안내용 목록 (거부 메시지에 쓴다). */
const SPEC_ONLY: readonly string[] = [
  'material', 'parts', 'offers', 'traits', 'environment', 'passages', 'senses', 'params', 'habits',
  'verb', 'needs', 'cost', 'effect', 'warn_before_s',
];

export interface CompileResult {
  readonly patch: Record<string, unknown> | null;
  readonly issues: Issue[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TEMP_OR_REAL = /^[A-Z]{3}(\+\d+|\d{6})$/;

/** 원본 객체를 패치 객체로 바꾼다. 형식 검사와 펼치기를 함께 한다. */
export function compileSource(source: unknown): CompileResult {
  const issues: Issue[] = [];
  const err = (where: string, msg: string): void => void issues.push({ level: 'error', where, msg });

  if (!isObj(source)) return { patch: null, issues: [{ level: 'error', where: 'source', msg: '원본이 객체가 아니다' }] };

  // ① 파일 머리
  if (source['format_version'] !== SOURCE_FORMAT_VERSION) {
    err('format_version', `format_version은 ${SOURCE_FORMAT_VERSION}이어야 한다`);
  }
  const why = source['why'];
  if (typeof why !== 'string' || why.trim() === '') err('why', '변경 이유(why)가 필요하다');
  const fileKind = source['file_kind'];
  if (typeof fileKind !== 'string' || !(fileKind in KIND_PREFIX)) {
    err('file_kind', `지금 받는 종류는 ${Object.keys(KIND_PREFIX).join(', ')} 뿐이다 (그 밖은 명세 단계)`);
  }
  const defsRaw = source['defs'];
  if (!Array.isArray(defsRaw) || defsRaw.length === 0) err('defs', 'defs는 비어 있지 않은 목록이어야 한다');
  const unknownTop = Object.keys(source).filter((k) => !['format_version', 'why', 'file_kind', 'defs'].includes(k));
  for (const k of unknownTop) err(k, `알 수 없는 최상위 필드: ${k}`);
  if (issues.length > 0 || typeof fileKind !== 'string' || !Array.isArray(defsRaw)) return { patch: null, issues };

  const prefix = KIND_PREFIX[fileKind] ?? '';
  const allowed = FIELDS[fileKind] ?? [];
  const defs = defsRaw.filter(isObj);
  if (defs.length !== defsRaw.length) err('defs', '항목은 객체여야 한다');

  // ② 항목 형식 검사
  const byId = new Map<string, Obj>();
  for (const [i, d] of defs.entries()) {
    const at = `defs[${i}]`;
    const id = d['id'];
    if (typeof id !== 'string' || !TEMP_OR_REAL.test(id)) {
      err(`${at}.id`, '번호 형식이 아니다 (임시 번호 OBJ+1 또는 정식 번호)');
      continue;
    }
    if (!id.startsWith(prefix)) err(`${at}.id`, `${fileKind} 파일에는 ${prefix} 번호만 쓸 수 있다`);
    if (byId.has(id)) err(`${at}.id`, `같은 파일 안에서 번호 ${id}가 두 번 나온다`);
    byId.set(id, d);
    for (const k of Object.keys(d)) {
      if (SPEC_ONLY.includes(k)) err(`${at}.${k}`, '아직 받지 않는 필드 (명세 단계)');
      else if (!allowed.includes(k)) err(`${at}.${k}`, `${fileKind}에 쓸 수 없는 필드: ${k}`);
    }
    const rules = d['rules'];
    if (isObj(rules)) {
      for (const [rk, r] of Object.entries(rules)) {
        if (!isObj(r)) {
          err(`${at}.rules.${rk}`, '규칙은 객체여야 한다');
          continue;
        }
        for (const k of Object.keys(r)) {
          if (!RULE_FIELDS.includes(k)) err(`${at}.rules.${rk}.${k}`, SPEC_ONLY.includes(k) ? '아직 받지 않는 필드 (명세 단계)' : `규칙에 쓸 수 없는 필드: ${k}`);
        }
      }
    }
  }
  if (issues.length > 0) return { patch: null, issues };

  // ③ 펼치기: is_a 는 같은 파일의 기본 항목 하나만 가리킨다 (한 단계)
  const out: Obj[] = [];
  for (const [i, d] of defs.entries()) {
    const at = `defs[${i}]`;
    const id = String(d['id']);
    const isA = d['is_a'];
    const override = d['override'];
    if (isA === undefined) {
      if (override !== undefined) err(`${at}.override`, 'override는 is_a와 함께 쓴다');
      out.push(stripSource(d));
      continue;
    }
    if (typeof isA !== 'string') {
      err(`${at}.is_a`, 'is_a는 번호 문자열이어야 한다');
      continue;
    }
    const base = byId.get(isA);
    if (base === undefined) {
      err(`${at}.is_a`, `is_a가 가리키는 ${isA}가 같은 파일에 없다 (펼치기는 같은 파일 안에서만 한다)`);
      continue;
    }
    if (base['is_a'] !== undefined) {
      err(`${at}.is_a`, 'is_a는 한 단계만 가능하다 (기본 항목은 is_a를 쓸 수 없다)');
      continue;
    }
    if (override !== undefined) {
      if (!isObj(override)) {
        err(`${at}.override`, 'override는 객체여야 한다');
        continue;
      }
      for (const k of Object.keys(override)) {
        if (!OVERRIDABLE.includes(k)) err(`${at}.override.${k}`, `override로 바꿀 수 없는 필드: ${k}`);
      }
    }
    // 기본 항목의 필드 → 개별 항목 자신의 필드 → override 순서로 덮는다. 번호·names·aliases·desc 는 개별 항목 것이다.
    // 이름·별칭·설명은 개별 항목 것만 쓴다 (기본 항목의 별칭이 복사되면 이름 충돌이 난다)
    const { names: _n, aliases: _al, desc: _de, ...inherited } = stripSource(base);
    const merged: Obj = { ...inherited, id, names: d['names'] };
    for (const k of ['aliases', 'desc', 'mobility', 'slots', 'meanings', 'rules'] as const) {
      if (d[k] !== undefined) merged[k] = d[k];
    }
    if (isObj(override)) for (const [k, v] of Object.entries(override)) merged[k] = v;
    if (merged['names'] === undefined) err(`${at}.names`, '개별 항목에 names가 필요하다');
    out.push(stripSource(merged));
  }
  if (issues.length > 0) return { patch: null, issues };

  // ④ 패치 생성 (기존 패치 형식)
  return {
    patch: { format: PATCH_FORMAT, version: PATCH_VERSION, why, defs: out },
    issues,
  };
}

/** 패치에 넣지 않는 원본 전용 키(is_a, override)를 뺀다. */
function stripSource(d: Obj): Obj {
  const { is_a: _isA, override: _override, ...rest } = d;
  return rest;
}

/**
 * 여러 원본 파일을 한 패치로 묶는다. 서로 다른 파일의 규칙이 임시 번호로 이어질 수 있으므로
 * 한 배치 안에서는 번호가 겹치면 안 된다. 참조가 맞는지는 기존 관문이 병합 후에 검사한다.
 */
export function compileSources(sources: readonly unknown[]): CompileResult {
  const issues: Issue[] = [];
  const defs: Obj[] = [];
  const whys: string[] = [];
  const seen = new Set<string>();
  for (const [i, s] of sources.entries()) {
    const r = compileSource(s);
    for (const iss of r.issues) issues.push({ ...iss, where: `files[${i}].${iss.where}` });
    if (r.patch === null) continue;
    whys.push(String(r.patch['why']));
    for (const d of r.patch['defs'] as Obj[]) {
      const id = String(d['id']);
      if (seen.has(id)) issues.push({ level: 'error', where: `files[${i}].${id}`, msg: `배치 안에서 번호 ${id}가 다른 파일과 겹친다` });
      seen.add(id);
      defs.push(d);
    }
  }
  if (issues.length > 0) return { patch: null, issues };
  return { patch: { format: PATCH_FORMAT, version: PATCH_VERSION, why: whys.join(' / '), defs }, issues };
}
