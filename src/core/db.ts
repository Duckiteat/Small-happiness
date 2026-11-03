// 정의 저장소 (docs/DB-개념-이식.md 1-2, 1-3 · docs/구현-계획.md 7)
//
// 정의가 구조(부위)와 규칙을 소유한다. 이름과 문장은 번호에 붙은 꼬리표이고 연결은 번호로만 건다.
// 이 파일은 순수 모듈이다: 읽기·모양 검사·정규화·직렬화만 하고 파일 입출력은 하지 않는다.
//
// 원 설계: make-bio-database 의 정의항(D) / 패치 / 번호 배정(meta.next). 생물 전용 부분은 가져오지 않았다.

import { DEF_PREFIXES, isDefPrefix, parseId } from './ids.ts';
import type { DefPrefix } from './ids.ts';
import { normalizeWord } from './vocab.ts';

export const DB_FORMAT = 'small-happiness-db';
export const DB_VERSION = 1;

export interface Issue {
  readonly level: 'error' | 'warning';
  readonly where: string;
  readonly msg: string;
}

export const PREFIX_KIND: Readonly<Record<DefPrefix, string>> = {
  OBJ: 'object',
  PLC: 'place',
  RUL: 'rule',
  ACT: 'action',
  EVT: 'event',
  ITM: 'item',
  AWR: 'awareness',
  FRG: 'fragment',
  CHR: 'character',
  HAB: 'habit',
  CMT: 'commitment',
};

const COMMON_FIELDS = ['id', 'names', 'aliases', 'desc'] as const;
const FIELDS_BY_PREFIX: Partial<Record<DefPrefix, readonly string[]>> = {
  OBJ: [...COMMON_FIELDS, 'mobility', 'slots', 'meanings', 'rules'],
  PLC: [...COMMON_FIELDS, 'slots', 'meanings', 'rules'],
};

/** 이 종류의 정의가 가질 수 있는 최상위 필드. 아직 설계되지 않은 종류는 공통 필드만 쓴다. */
export function allowedFields(prefix: DefPrefix): readonly string[] {
  return FIELDS_BY_PREFIX[prefix] ?? COMMON_FIELDS;
}

export interface Names {
  readonly ko: string;
  readonly en?: string;
}

/** 부위: 정의가 가진 상태 자리. 한 부위는 여러 특징을 가질 수 있다. */
export interface SlotDef {
  readonly features: readonly string[];
  readonly desc?: string;
}

/** 상태 의미: 위에서부터 보아 처음 맞는 규칙이 그 상태의 뜻이다. `when`이 비면 기본값. */
export interface MeaningDef {
  readonly label: string;
  readonly when: readonly string[]; // 소유자 안의 조건 (예: body:rot@<=1)
  readonly means: string;
}

/** 변화 규칙: `on` 패턴이 만족되면 `emits` 패턴의 상태가 생긴다. 사슬은 이 패턴에서 자동으로 이어진다. */
export interface RuleDef {
  readonly label?: string;
  readonly on: readonly string[];
  readonly emits: readonly string[];
  readonly note?: string;
}

export interface Definition {
  readonly id: string;
  readonly names: Names;
  readonly aliases: readonly string[];
  readonly desc: readonly string[];
  readonly mobility?: string;
  readonly slots?: { readonly [key: string]: SlotDef };
  readonly meanings?: readonly MeaningDef[];
  readonly rules?: { readonly [key: string]: RuleDef };
}

export interface Db {
  readonly format: typeof DB_FORMAT;
  readonly version: typeof DB_VERSION;
  readonly meta: { readonly next: { readonly [prefix: string]: number } };
  readonly defs: { readonly [id: string]: Definition };
}

const TOKEN_RE = /^[a-z][a-z0-9_]*$/;

type Push = (where: string, msg: string) => void;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function uniq(list: readonly string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter((s) => s !== ''))];
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string, push: Push): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) push(where, `알 수 없는 필드: ${key}`);
  }
}

// ---- 필드별 모양 검사 + 정규화. 틀리면 push 하고 undefined 를 돌려준다 ----

function fieldNames(v: unknown, where: string, push: Push): Names | undefined {
  if (!isObj(v)) return void push(where, 'names는 { ko, en? } 객체여야 한다');
  onlyKeys(v, ['ko', 'en'], where, push);
  if (typeof v['ko'] !== 'string' || v['ko'].trim() === '') return void push(where, 'names.ko(한국어 이름)가 필요하다');
  if (v['en'] !== undefined && typeof v['en'] !== 'string') return void push(where, 'names.en은 문자열이어야 한다');
  const ko = v['ko'].trim();
  return typeof v['en'] === 'string' && v['en'].trim() !== '' ? { ko, en: v['en'].trim() } : { ko };
}

function fieldStringList(v: unknown, name: string, where: string, push: Push): string[] | undefined {
  if (!isStrArr(v)) return void push(where, `${name}는 문자열 목록이어야 한다`);
  return uniq(v);
}

function fieldSlots(v: unknown, where: string, push: Push): Record<string, SlotDef> | undefined {
  if (!isObj(v)) return void push(where, 'slots는 객체여야 한다');
  const out: Record<string, SlotDef> = {};
  let ok = true;
  for (const key of Object.keys(v).sort()) {
    const slot = v[key];
    const at = `${where}.${key}`;
    if (!TOKEN_RE.test(key)) {
      push(at, '부위 키는 영소문자로 시작하는 영소문자·숫자·밑줄이어야 한다');
      ok = false;
      continue;
    }
    if (!isObj(slot)) {
      push(at, '부위는 객체여야 한다');
      ok = false;
      continue;
    }
    onlyKeys(slot, ['features', 'desc'], at, push);
    if (!isStrArr(slot['features']) || slot['features'].length === 0) {
      push(at, 'features(특징 목록)가 필요하다');
      ok = false;
      continue;
    }
    if (slot['desc'] !== undefined && typeof slot['desc'] !== 'string') {
      push(at, 'desc는 문자열이어야 한다');
      ok = false;
      continue;
    }
    const features = uniq(slot['features']);
    out[key] = typeof slot['desc'] === 'string' ? { features, desc: slot['desc'] } : { features };
  }
  return ok ? out : undefined;
}

function fieldMeanings(v: unknown, where: string, push: Push): MeaningDef[] | undefined {
  if (!Array.isArray(v)) return void push(where, 'meanings는 목록이어야 한다');
  const out: MeaningDef[] = [];
  let ok = true;
  v.forEach((m: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(m)) {
      push(at, '상태 의미는 객체여야 한다');
      ok = false;
      return;
    }
    onlyKeys(m, ['label', 'when', 'means'], at, push);
    if (typeof m['label'] !== 'string' || m['label'].trim() === '') {
      push(at, 'label이 필요하다');
      ok = false;
      return;
    }
    if (!isStrArr(m['when'])) {
      push(at, 'when은 조건 문자열 목록이어야 한다 (기본값이면 빈 목록)');
      ok = false;
      return;
    }
    if (typeof m['means'] !== 'string' || !TOKEN_RE.test(m['means'])) {
      push(at, 'means는 영소문자 토큰이어야 한다');
      ok = false;
      return;
    }
    out.push({ label: m['label'].trim(), when: m['when'].map((s) => s.trim()), means: m['means'] });
  });
  return ok ? out : undefined;
}

function fieldRules(v: unknown, where: string, push: Push): Record<string, RuleDef> | undefined {
  if (!isObj(v)) return void push(where, 'rules는 객체여야 한다');
  const out: Record<string, RuleDef> = {};
  let ok = true;
  for (const key of Object.keys(v).sort()) {
    const rule = v[key];
    const at = `${where}.${key}`;
    if (!TOKEN_RE.test(key)) {
      push(at, '규칙 키는 영소문자로 시작하는 영소문자·숫자·밑줄이어야 한다');
      ok = false;
      continue;
    }
    if (!isObj(rule)) {
      push(at, '규칙은 객체여야 한다');
      ok = false;
      continue;
    }
    onlyKeys(rule, ['label', 'on', 'emits', 'note'], at, push);
    if (!isStrArr(rule['on']) || rule['on'].length === 0 || !isStrArr(rule['emits']) || rule['emits'].length === 0) {
      push(at, 'on과 emits(패턴 문자열 목록, 1개 이상)가 필요하다');
      ok = false;
      continue;
    }
    if (rule['label'] !== undefined && typeof rule['label'] !== 'string') {
      push(at, 'label은 문자열이어야 한다');
      ok = false;
      continue;
    }
    if (rule['note'] !== undefined && typeof rule['note'] !== 'string') {
      push(at, 'note는 문자열이어야 한다');
      ok = false;
      continue;
    }
    const r: RuleDef = {
      ...(typeof rule['label'] === 'string' ? { label: rule['label'] } : {}),
      on: rule['on'].map((s) => s.trim()),
      emits: rule['emits'].map((s) => s.trim()),
      ...(typeof rule['note'] === 'string' ? { note: rule['note'] } : {}),
    };
    out[key] = r;
  }
  return ok ? out : undefined;
}

export type Fields = Partial<{
  id: string;
  names: Names;
  aliases: string[];
  desc: string[];
  mobility: string;
  slots: Record<string, SlotDef>;
  meanings: MeaningDef[];
  rules: Record<string, RuleDef>;
}>;

/**
 * 정의의 (일부) 필드를 검사하고 정규화한다. 패치의 갱신은 일부 필드만 담으므로 부분 검사가 된다.
 * 틀린 필드는 결과에서 빠지고 push로 보고된다.
 */
export function parseFields(raw: Record<string, unknown>, prefix: DefPrefix, where: string, push: Push): Fields {
  const allowed = allowedFields(prefix);
  const out: Fields = {};
  for (const [key, value] of Object.entries(raw)) {
    const at = `${where}.${key}`;
    if (!allowed.includes(key)) {
      push(where, `${PREFIX_KIND[prefix]} 정의에 쓸 수 없는 필드: ${key}`);
      continue;
    }
    switch (key) {
      case 'id':
        if (typeof value !== 'string') push(at, 'id는 문자열이어야 한다');
        else out.id = value;
        break;
      case 'names': {
        const v = fieldNames(value, at, push);
        if (v !== undefined) out.names = v;
        break;
      }
      case 'aliases': {
        const v = fieldStringList(value, 'aliases', at, push);
        if (v !== undefined) out.aliases = v;
        break;
      }
      case 'desc': {
        const v = fieldStringList(value, 'desc', at, push);
        if (v !== undefined) out.desc = v;
        break;
      }
      case 'mobility':
        if (typeof value !== 'string' || value.trim() === '') push(at, 'mobility는 문자열이어야 한다');
        else out.mobility = value.trim();
        break;
      case 'slots': {
        const v = fieldSlots(value, at, push);
        if (v !== undefined) out.slots = v;
        break;
      }
      case 'meanings': {
        const v = fieldMeanings(value, at, push);
        if (v !== undefined) out.meanings = v;
        break;
      }
      case 'rules': {
        const v = fieldRules(value, at, push);
        if (v !== undefined) out.rules = v;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 필드 묶음을 정규 순서의 정의로 만든다. names가 없으면 undefined. */
export function buildDefinition(id: string, f: Fields): Definition | undefined {
  if (f.names === undefined) return undefined;
  return {
    id,
    names: f.names,
    aliases: f.aliases ?? [],
    ...(f.mobility !== undefined ? { mobility: f.mobility } : {}),
    ...(f.slots !== undefined ? { slots: f.slots } : {}),
    ...(f.meanings !== undefined ? { meanings: f.meanings } : {}),
    ...(f.rules !== undefined ? { rules: f.rules } : {}),
    desc: f.desc ?? [],
  };
}

export function emptyDb(): Db {
  const next: Record<string, number> = {};
  for (const p of DEF_PREFIXES) next[p] = 1;
  return { format: DB_FORMAT, version: DB_VERSION, meta: { next }, defs: {} };
}

export function serializeDb(db: Db): string {
  const defs: Record<string, Definition> = {};
  for (const id of Object.keys(db.defs).sort()) defs[id] = db.defs[id] as Definition;
  const next: Record<string, number> = {};
  for (const p of Object.keys(db.meta.next).sort()) next[p] = db.meta.next[p] as number;
  return JSON.stringify({ format: db.format, version: db.version, meta: { next }, defs }, null, 2) + '\n';
}

/** 저장된 JSON을 저장소로 읽는다. 모양이 틀리면 issues에 담긴다 (db는 null). */
export function parseDb(raw: unknown): { db: Db | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const push: Push = (where, msg) => issues.push({ level: 'error', where, msg });

  if (!isObj(raw)) return { db: null, issues: [{ level: 'error', where: 'db', msg: '저장소가 객체가 아니다' }] };
  if (raw['format'] !== DB_FORMAT) push('format', `형식이 ${DB_FORMAT}이 아니다`);
  if (raw['version'] !== DB_VERSION) push('version', `형식 버전이 ${DB_VERSION}이 아니다 (마이그레이션 필요)`);

  const meta = raw['meta'];
  const nextRaw = isObj(meta) ? meta['next'] : undefined;
  const next: Record<string, number> = {};
  if (!isObj(nextRaw)) {
    push('meta.next', '번호 카운터가 없다');
  } else {
    for (const [prefix, n] of Object.entries(nextRaw)) {
      if (!isDefPrefix(prefix) || typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        push(`meta.next.${prefix}`, '접두는 알려진 값, 카운터는 1 이상의 정수여야 한다');
      } else {
        next[prefix] = n;
      }
    }
    for (const p of DEF_PREFIXES) if (next[p] === undefined) push(`meta.next.${p}`, '카운터가 없다');
  }

  const defsRaw = raw['defs'];
  const defs: Record<string, Definition> = {};
  if (!isObj(defsRaw)) {
    push('defs', 'defs가 객체가 아니다');
  } else {
    for (const [id, value] of Object.entries(defsRaw)) {
      const parsed = parseId(id);
      if (parsed === null || parsed.kind !== 'def') {
        push(`defs.${id}`, '정의 번호 형식이 아니다');
        continue;
      }
      if (!isObj(value)) {
        push(`defs.${id}`, '정의가 객체가 아니다');
        continue;
      }
      if (value['id'] !== id) push(`defs.${id}`, 'id 필드가 키와 다르다');
      const fields = parseFields(value, parsed.prefix, `defs.${id}`, push);
      const def = buildDefinition(id, fields);
      if (def === undefined) push(`defs.${id}`, 'names가 없거나 틀렸다');
      else defs[id] = def;
    }
  }

  if (issues.length > 0) return { db: null, issues };
  return { db: { format: DB_FORMAT, version: DB_VERSION, meta: { next }, defs }, issues };
}

/** 지금까지 쓰인 가장 큰 번호 (없으면 0). */
export function maxUsedNumber(db: Db, prefix: DefPrefix): number {
  let max = 0;
  for (const id of Object.keys(db.defs)) {
    const p = parseId(id);
    if (p !== null && p.kind === 'def' && p.prefix === prefix && p.num > max) max = p.num;
  }
  return max;
}

export function kindOf(id: string): string | null {
  const p = parseId(id);
  return p !== null && p.kind === 'def' ? PREFIX_KIND[p.prefix] : null;
}

/** 이름·별칭(정규화)으로 정의를 찾는다. 여러 개면 모호하다. */
export function findByName(db: Db, word: string): string[] {
  const key = normalizeWord(word);
  const hits: string[] = [];
  for (const [id, def] of Object.entries(db.defs)) {
    const words = [def.names.ko, def.names.en, ...def.aliases];
    if (words.some((w) => w !== undefined && normalizeWord(w) === key)) hits.push(id);
  }
  return hits.sort();
}

export type RefResult = { readonly id: string } | { readonly error: string };

/** 번호 또는 이름·별칭을 정의 번호로 바꾼다. 모호하거나 없으면 error. */
export function resolveDefRef(db: Db, text: string): RefResult {
  const t = text.trim();
  const parsed = parseId(t);
  if (parsed !== null && parsed.kind === 'def') {
    return db.defs[t] === undefined ? { error: `없는 정의 번호: ${t}` } : { id: t };
  }
  const hits = findByName(db, t);
  if (hits.length === 1) return { id: hits[0] as string };
  if (hits.length === 0) return { error: `이름을 찾을 수 없다: ${t}` };
  return { error: `뜻이 여러 개인 이름이다: ${t} → ${hits.join(', ')}` };
}
