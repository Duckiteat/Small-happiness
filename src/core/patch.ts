// 패치 병합 (입법: 정의와 수정만 하고 검사는 하지 않는다 — 검사는 gate.ts)
//
//   패치 ──▶ 병합 (임시 번호 → 실제 번호, 일부 필드 교체, 이름·별칭 → 번호·표준 키)
//        ──▶ 관문 (gate.ts) ──▶ 기록 (node/clerk.ts)
//
// 순수 함수다: (저장소, 패치) → 새 저장소 + 보고. 파일 쓰기와 현재 시각 읽기를 하지 않는다.

import { DEF_PREFIXES, formatDefId, isDefPrefix, parseId } from './ids.ts';
import type { DefPrefix } from './ids.ts';
import { buildDefinition, maxUsedNumber, parseFields, resolveDefRef } from './db.ts';
import type { Db, Definition, Fields, Issue } from './db.ts';
import type { Vocab } from './vocab.ts';

export const PATCH_FORMAT = 'small-happiness-patch';
export const PATCH_VERSION = 1;

export interface Patch {
  readonly format: typeof PATCH_FORMAT;
  readonly version: typeof PATCH_VERSION;
  readonly why: string;
  readonly defs: readonly Record<string, unknown>[];
  readonly remove: readonly string[];
}

export interface MappedNote {
  readonly where: string;
  readonly from: string;
  readonly to: string;
}

export interface MergeReport {
  readonly why: string;
  readonly added: string[];
  readonly updated: { readonly id: string; readonly fields: string[] }[];
  readonly removed: string[];
  readonly idmap: Record<string, string>;
  readonly mapped: MappedNote[];
  readonly errors: Issue[];
}

export interface MergeResult {
  readonly db: Db;
  readonly report: MergeReport;
}

const TEMP_RE = /^([A-Z]{3})\+(\d+)$/;
const TEMP_IN_TEXT_RE = /\b[A-Z]{3}\+\d+\b/g;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 외부에서 온 값을 패치로 해석한다. */
export function parsePatch(raw: unknown): { patch: Patch | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (where: string, msg: string): void => void issues.push({ level: 'error', where, msg });
  if (!isObj(raw)) return { patch: null, issues: [{ level: 'error', where: 'patch', msg: '패치가 객체가 아니다' }] };

  if (raw['format'] !== PATCH_FORMAT) err('format', `형식이 ${PATCH_FORMAT}이 아니다`);
  if (raw['version'] !== PATCH_VERSION) err('version', `패치 버전이 ${PATCH_VERSION}이 아니다`);
  const why = raw['why'];
  if (typeof why !== 'string' || why.trim() === '') err('why', '변경 이유(why)가 필요하다');

  const defs = raw['defs'] ?? [];
  const remove = raw['remove'] ?? [];
  if (!Array.isArray(defs) || !defs.every(isObj)) err('defs', 'defs는 객체 목록이어야 한다');
  if (!Array.isArray(remove) || !remove.every((x) => typeof x === 'string')) err('remove', 'remove는 번호 문자열 목록이어야 한다');
  for (const key of Object.keys(raw)) {
    if (!['format', 'version', 'why', 'defs', 'remove'].includes(key)) err(key, `알 수 없는 최상위 필드: ${key}`);
  }
  if (issues.length > 0) return { patch: null, issues };

  return {
    patch: {
      format: PATCH_FORMAT,
      version: PATCH_VERSION,
      why: (why as string).trim(),
      defs: defs as Record<string, unknown>[],
      remove: remove as string[],
    },
    issues,
  };
}

/** 문자열 안의 임시 번호를 실제 번호로 바꾼다 (깊이 우선). 선언되지 않은 임시 번호는 errors에 남긴다. */
function rewriteTemps(value: unknown, map: ReadonlyMap<string, string>, where: string, errors: Issue[]): unknown {
  if (typeof value === 'string') {
    return value.replace(TEMP_IN_TEXT_RE, (m) => {
      const real = map.get(m);
      if (real === undefined) {
        errors.push({ level: 'error', where, msg: `선언되지 않은 임시 번호: ${m}` });
        return m;
      }
      return real;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => rewriteTemps(v, map, `${where}[${i}]`, errors));
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteTemps(v, map, `${where}.${k}`, errors);
    return out;
  }
  return value;
}

const PATTERN_PARTS_RE = /^([^:@|]+):([^@]+)(@.+)?$/;

function mapFeature(vocab: Vocab | undefined, word: string): string | null {
  const w = word.trim();
  if (vocab === undefined) return w;
  return vocab.resolve('feature', w);
}

/** `정의|부위:특징@조건`의 정의(이름 가능)와 특징(별칭 가능)을 표준 형태로 바꾼다. */
function mapPattern(db: Db, vocab: Vocab | undefined, text: string): { text: string; error?: string } {
  const bar = text.indexOf('|');
  if (bar < 0) return { text, error: `패턴 형식이 아니다 (정의|부위:특징@조건): ${text}` };
  const ref = resolveDefRef(db, text.slice(0, bar));
  if ('error' in ref) return { text, error: ref.error };
  const m = PATTERN_PARTS_RE.exec(text.slice(bar + 1).trim());
  if (!m) return { text, error: `패턴 형식이 아니다: ${text}` };
  const [, slot, featureWord, cond] = m;
  const feature = mapFeature(vocab, featureWord as string);
  if (feature === null) return { text, error: `사전에 없는 특징: ${featureWord}` };
  return { text: `${ref.id}|${(slot as string).trim()}:${feature}${cond ?? ''}` };
}

/** `부위:특징@조건`의 특징을 표준 키로 바꾼다. */
function mapLocal(vocab: Vocab | undefined, text: string): { text: string; error?: string } {
  const m = PATTERN_PARTS_RE.exec(text.trim());
  if (!m) return { text, error: `조건 형식이 아니다 (부위:특징@조건): ${text}` };
  const [, slot, featureWord, cond] = m;
  const feature = mapFeature(vocab, featureWord as string);
  if (feature === null) return { text, error: `사전에 없는 특징: ${featureWord}` };
  return { text: `${(slot as string).trim()}:${feature}${cond ?? ''}` };
}

function mapDefinition(db: Db, vocab: Vocab | undefined, def: Definition, errors: Issue[], notes: MappedNote[]): Definition {
  let changed = false;
  const mapList = (list: readonly string[], where: string, mapper: (t: string) => { text: string; error?: string }): string[] =>
    list.map((t, i) => {
      const r = mapper(t);
      if (r.error !== undefined) errors.push({ level: 'error', where: `${where}[${i}]`, msg: r.error });
      else if (r.text !== t) {
        notes.push({ where: `${where}[${i}]`, from: t, to: r.text });
        changed = true;
      }
      return r.text;
    });

  const rules = def.rules === undefined ? undefined : Object.fromEntries(
    Object.entries(def.rules).map(([key, rule]) => {
      const at = `${def.id}.rules.${key}`;
      return [
        key,
        {
          ...rule,
          on: mapList(rule.on, `${at}.on`, (t) => mapPattern(db, vocab, t)),
          ...(rule.on_all !== undefined ? { on_all: mapList(rule.on_all, `${at}.on_all`, (t) => mapPattern(db, vocab, t)) } : {}),
          emits: mapList(rule.emits, `${at}.emits`, (t) => mapPattern(db, vocab, t)),
        },
      ];
    }),
  );
  const meanings = def.meanings?.map((m, i) => ({
    ...m,
    when: mapList(m.when, `${def.id}.meanings[${i}].when`, (t) => mapLocal(vocab, t)),
  }));
  const slots = def.slots === undefined || vocab === undefined ? def.slots : Object.fromEntries(
    Object.entries(def.slots).map(([key, slot]) => {
      const features = slot.features.map((f) => {
        const k = vocab.resolve('feature', f);
        if (k === null) return f; // 사전에 없는 특징은 관문이 보고한다
        if (k !== f) {
          notes.push({ where: `${def.id}.slots.${key}.features`, from: f, to: k });
          changed = true;
        }
        return k;
      });
      return [key, { ...slot, features: [...new Set(features)] }];
    }),
  );

  // 통로: 대상은 이름도 받고(번호로 바꾼다), 종류·매질과 환경 특성·등급은 별칭을 표준 키로 바꾼다
  const key = (category: string, word: string, where: string): string => {
    if (vocab === undefined) return word;
    const k = vocab.resolve(category, word);
    if (k === null || k === word) return word; // 사전에 없는 말은 관문이 보고한다
    notes.push({ where, from: word, to: k });
    changed = true;
    return k;
  };
  const passages = def.passages?.map((p, i) => {
    const at = `${def.id}.passages[${i}]`;
    const ref = resolveDefRef(db, p.to);
    let to = p.to;
    if ('error' in ref) errors.push({ level: 'error', where: `${at}.to`, msg: ref.error });
    else if (ref.id !== p.to) {
      notes.push({ where: `${at}.to`, from: p.to, to: ref.id });
      changed = true;
      to = ref.id;
    }
    const medium_pass = Object.fromEntries(Object.entries(p.medium_pass).map(([m, v]) => [key('medium', m, `${at}.medium_pass`), v]));
    return { ...p, to, kind: key('edge_kind', p.kind, `${at}.kind`), medium_pass };
  });
  const environment = def.environment === undefined ? undefined : Object.fromEntries(
    Object.entries(def.environment).map(([t, l]) => [key('env_trait', t, `${def.id}.environment`), key('env_level', l, `${def.id}.environment.${t}`)]),
  );

  let mobility = def.mobility;
  if (vocab !== undefined && mobility !== undefined) {
    const k = vocab.resolve('mobility', mobility);
    if (k !== null && k !== mobility) {
      notes.push({ where: `${def.id}.mobility`, from: mobility, to: k });
      mobility = k;
      changed = true;
    }
  }

  if (!changed) return def;
  return {
    ...def,
    ...(mobility !== undefined ? { mobility } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(passages !== undefined ? { passages } : {}),
    ...(slots !== undefined ? { slots } : {}),
    ...(meanings !== undefined ? { meanings } : {}),
    ...(rules !== undefined ? { rules } : {}),
  } as Definition;
}

export function mergePatch(dbIn: Db, patch: Patch, vocab?: Vocab): MergeResult {
  const errors: Issue[] = [];
  const err = (where: string, msg: string): void => void errors.push({ level: 'error', where, msg });
  const report = {
    why: patch.why,
    added: [] as string[],
    updated: [] as { id: string; fields: string[] }[],
    removed: [] as string[],
    idmap: {} as Record<string, string>,
    mapped: [] as MappedNote[],
    errors,
  };

  // 1. 임시 번호 → 실제 번호 (접두별로 임시 번호 순서대로 연속 배정)
  const next: Record<string, number> = { ...dbIn.meta.next };
  const declared = new Map<string, string>();
  const tempsByPrefix = new Map<DefPrefix, number[]>();
  patch.defs.forEach((d, i) => {
    const id = d['id'];
    if (typeof id !== 'string') return void err(`defs[${i}]`, 'id가 필요하다 (새 항목은 임시 번호, 수정은 실제 번호)');
    const m = TEMP_RE.exec(id);
    if (m === null) return;
    const prefix = m[1] as string;
    if (!isDefPrefix(prefix)) return void err(`defs[${i}]`, `알 수 없는 접두: ${prefix}`);
    const offset = Number(m[2]);
    const list = tempsByPrefix.get(prefix) ?? [];
    if (list.includes(offset)) err(`defs[${i}]`, `임시 번호가 중복된다: ${id}`);
    else list.push(offset);
    tempsByPrefix.set(prefix, list);
  });
  for (const [prefix, offsets] of tempsByPrefix) {
    const start = Math.max(next[prefix] ?? 1, maxUsedNumber(dbIn, prefix) + 1);
    offsets.sort((a, b) => a - b).forEach((offset, k) => {
      const real = formatDefId(prefix, start + k);
      declared.set(`${prefix}+${offset}`, real);
      report.idmap[`${prefix}+${offset}`] = real;
    });
  }

  const defsById: Record<string, Definition> = { ...dbIn.defs };

  // 2. 정의 추가·수정
  patch.defs.forEach((rawDef, i) => {
    const where = `defs[${i}]`;
    const rewritten = rewriteTemps(rawDef, declared, where, errors) as Record<string, unknown>;
    const id = rewritten['id'];
    if (typeof id !== 'string') return;
    const parsed = parseId(id);
    if (parsed === null || parsed.kind !== 'def') return void err(where, `정의 번호 형식이 아니다: ${id}`);

    const isNew = typeof rawDef['id'] === 'string' && TEMP_RE.test(rawDef['id']);
    const exists = defsById[id] !== undefined;
    if (!isNew && !exists) return void err(where, `없는 번호는 수정할 수 없다: ${id} (새 항목은 임시 번호를 쓴다)`);

    const issues: Issue[] = [];
    const fields = parseFields(rewritten, parsed.prefix, `${id}`, (w, msg) => issues.push({ level: 'error', where: w, msg }));
    errors.push(...issues);
    if (issues.length > 0) return;

    if (isNew) {
      const def = buildDefinition(id, fields);
      if (def === undefined) return void err(id, '새 정의에는 names가 필요하다');
      defsById[id] = def;
      report.added.push(id);
    } else {
      const old = defsById[id] as Definition;
      const changedFields = Object.keys(fields).filter((k) => k !== 'id');
      const merged = buildDefinition(id, {
        names: old.names,
        ...(old.is_a !== undefined ? { is_a: old.is_a } : {}),
        aliases: [...old.aliases],
        desc: [...old.desc],
        ...(old.mobility !== undefined ? { mobility: old.mobility } : {}),
        ...(old.slots !== undefined ? { slots: old.slots as Fields['slots'] } : {}),
        ...(old.meanings !== undefined ? { meanings: [...old.meanings] } : {}),
        ...(old.rules !== undefined ? { rules: old.rules as Fields['rules'] } : {}),
        ...(old.offers !== undefined ? { offers: old.offers as Fields['offers'] } : {}),
        ...(old.senses !== undefined ? { senses: old.senses as Fields['senses'] } : {}),
        ...(old.progress !== undefined ? { progress: old.progress as Fields['progress'] } : {}),
        ...(old.initial !== undefined ? { initial: old.initial as Fields['initial'] } : {}),
        ...fields,
      });
      if (merged === undefined) return;
      if (JSON.stringify(merged) !== JSON.stringify(old)) {
        defsById[id] = merged;
        report.updated.push({ id, fields: changedFields });
      }
    }
  });

  // 3. 삭제
  patch.remove.forEach((rawId, i) => {
    const id = rewriteTemps(rawId, declared, `remove[${i}]`, errors) as string;
    if (defsById[id] === undefined) return void err(`remove[${i}]`, `없는 번호는 지울 수 없다: ${id}`);
    delete defsById[id];
    report.removed.push(id);
  });

  // 4. 이름·별칭 → 번호·표준 키 (추가·수정된 정의만)
  const mid: Db = { ...dbIn, defs: defsById };
  const touched = new Set([...report.added, ...report.updated.map((u) => u.id)]);
  for (const id of touched) {
    const def = defsById[id];
    if (def !== undefined) defsById[id] = mapDefinition(mid, vocab, def, errors, report.mapped);
  }

  // 5. 번호 카운터는 줄어들지 않는다
  for (const p of DEF_PREFIXES) {
    next[p] = Math.max(next[p] ?? 1, maxUsedNumber({ ...mid, defs: defsById }, p) + 1);
  }

  return {
    db: { ...dbIn, meta: { next }, defs: defsById },
    report,
  };
}
