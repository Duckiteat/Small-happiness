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
  OBJ: [...COMMON_FIELDS, 'is_a', 'mobility', 'role', 'utility', 'holds', 'slots', 'meanings', 'feels', 'rules', 'offers', 'progress', 'initial'],
  PLC: [...COMMON_FIELDS, 'environment', 'passages', 'supplies', 'slots', 'meanings', 'feels', 'rules', 'offers'],
  CHR: [...COMMON_FIELDS, 'senses', 'stays', 'slots', 'initial', 'mind'],
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
/** 감각 자체 (내면-설계 2장): 이 물건·장소가 자기 상태(when, 소유자 안의 조건)일 때 주는 감각질(사전 sensation). 종류로 물려받는다. */
export interface FeelDef {
  readonly sensation: string;
  readonly when: readonly string[];
  /** 세기를 정하는 자기 상태 (`부위:특징`, 사다리 칸이 높을수록 세다). reverse면 낮을수록 세다 (차가움 ← 온도). 없으면 늘 가장 센 칸. */
  readonly by?: string;
  readonly reverse?: boolean;
}

export interface MeaningDef {
  readonly label: string;
  readonly when: readonly string[]; // 소유자 안의 조건 (예: body:rot@<=1)
  readonly means: string;
}

/**
 * 변화 규칙: `on` 패턴이 만족되면 `emits` 패턴의 상태가 생긴다. 사슬은 이 패턴에서 자동으로 이어진다.
 * `delay_s`가 있으면 조건이 성립한 뒤 그만큼 지나 발화하고, 발화 시점에 조건을 다시 본다 (축-상호작용-설계 9장).
 * 지연 값은 임시값일 수 있으므로 `tuned`(조정 완료 여부)를 반드시 함께 적는다.
 */
export interface RuleDef {
  readonly label?: string;
  /** 다른 정의를 가리키는 패턴은 그 정의(와 그 종류)의 인스턴스 중 **하나라도** 맞으면 된다. */
  readonly on: readonly string[];
  /** 다른 정의를 가리키는 패턴이 그 정의(와 그 종류)의 **모든** 인스턴스에서 맞아야 한다 (없으면 참). */
  readonly on_all?: readonly string[];
  /** true면 규칙을 선언한 정의가 아닌 다른 정의를 가리키는 패턴은, 이 인스턴스와 이어진(안이나 위에 있는) 것에만 걸린다. 없으면 그 종류 전부 */
  readonly linked?: boolean;
  readonly emits: readonly string[];
  readonly note?: string;
  /** 지연(초). 게임 시간은 분이므로 60의 배수. 없으면 0 (즉시). */
  readonly delay_s?: number;
  readonly tuned?: boolean;
}

/** 행동의 메뉴 목록 (하나만 적으면 문자열이다). */
export function menusOf(offer: { readonly menu?: string | readonly string[] }): readonly string[] {
  const m = offer.menu;
  return m === undefined ? [] : typeof m === 'string' ? [m] : m;
}

/** 장보기 (shopping.ts): 파는 재료, 산 것을 놓을 곳, 여는 시간(하루 중 분 [시작, 끝)), 온라인이면 배송 시각(하루 중 분). */
export interface BuysSpec {
  readonly sells: readonly string[];
  readonly on: string;
  readonly opens?: readonly [number, number];
  readonly arrives_at?: number;
}

/** 행동이 물건을 놓는 요청: what을 in(안에)·on(위에) 두거나 out(꺼내 놓임을 푼다). 셋 중 하나만. 참조는 정의 번호. */
export interface PlaceSpec {
  readonly what: string;
  readonly in?: string;
  readonly on?: string;
  readonly out?: boolean;
}

/** 행동이 새 개체를 만드는 요청: 그 정의의 인스턴스 하나, in·on을 주면 그곳에 놓는다. */
export interface CreateSpec {
  readonly def: string;
  readonly in?: string;
  readonly on?: string;
}

/** 놓임 조건: what이 in(안에)·on(위에) 바로 놓여 있을 때. 둘 중 하나만. */
export interface WhereSpec {
  readonly what: string;
  readonly in?: string;
  readonly on?: string;
}

/**
 * 제공 행동 (상호작용-명세 3장): 물건·장소가 자기가 줄 수 있는 행동을 선언한다. 인물은 앎(needs)이 갖춰진 것만 고른다.
 * `effect`는 효과 요청(세계 상태의 주인이 행동이 끝날 때 기록), `reveals`는 살피기(다음 단계 지각에서 그 장소의 물건까지 본다).
 */
export interface OfferDef {
  readonly label?: string;
  readonly verb: string; // 사전 action
  readonly needs: readonly { readonly aware: string; readonly at_least: string }[]; // 패턴(조건 없음) + 사전 awareness
  /** 행동할 수 있는 상태 (규칙의 on과 같은 패턴). 예: 상했을 때만 버린다. 없으면 언제나. */
  readonly when?: readonly string[];
  /** 그 물건의 상태 의미(meanings)가 이것일 때만 (예: inedible). 물건마다 다른 축을 한 줄로 묻는다. */
  readonly when_meaning?: string;
  readonly effect: readonly string[]; // 결과 패턴 (=, >=, <=)
  readonly reveals?: boolean;
  /** 이 상태(사전 presence)일 때만 하는 행동. 없으면 보는 시간 내내 (예: 요리는 식사 준비 시간에만) */
  readonly during?: readonly string[];
  /**
   * 쓰는 양: 그 상태를 지금 단계에서 steps칸 내린다 (된장 한 숟갈). 패턴은 단계 조건 없이 쓴다.
   * 그만큼 남아 있지 않으면 하지 않는다. 남은 양은 몸이 보는 것이라 세계로 본다 (요리-설계 3장).
   */
  readonly uses?: readonly { readonly key: string; readonly steps: number; readonly ingredient?: boolean }[];
  /**
   * 하루씨가 구상한 이 메뉴(사전 menu)를 만드는 끼니에만 하는 행동 (요리법의 한 단계). 없으면 메뉴와 상관없다.
   * 요리법은 이 메뉴를 가진 행동들이다. 그 행동의 uses 중 ingredient인 것이 구상할 때 있어야 하는 재료다 (요리-설계 10장).
   */
  readonly menu?: string | readonly string[];
  /** 이 행동을 끝내면 쌓이는 숙련 (사전 내면 특징). 재료를 쓰는 행동은 재료 하나에 한 번, 아니면 한 번 (요리-설계 11장). */
  readonly trains?: readonly string[];
  /** 걸리는 시간이 이 숙련(내면 특징의 minutes_pct)에 따라 줄어든다. */
  readonly minutes_by?: string;
  /** 장보기: 이 가게에서 장보기 목록을 산다 (산 것은 새 개체로 생긴다). */
  readonly buys?: BuysSpec;
  /** 이 행동을 하는 동안 집을 비운다 (지각하지 않는다). */
  readonly away?: boolean;
  /** 놓임 조건 (몸이 놓은 곳이라 세계로 본다). */
  readonly where?: readonly WhereSpec[];
  /** 새 개체를 만든다 (덜어 담은 찌개). */
  readonly creates?: readonly CreateSpec[];
  /** 물건을 옮긴다 (반찬통을 냉장고에). */
  readonly places?: readonly PlaceSpec[];
  readonly minutes: number;
  readonly tuned: boolean;
}

/**
 * 진행 법칙 (음식-변화-모델 4장 · 데이터-형식 5-2): 축의 양(0~1000)이 조건에 따라 쌓이고, 경계를 넘으면 단계가 오른다.
 * 속도 = (1000 / base_s) × 입력마다 계수/100. 계수 0이면 멈춘다 (냉동의 부패). 종류에 표를 두고 물건은 base_s만 덮어쓸 수 있다.
 * 키는 축(특징), slot은 그 특징이 있는 부위. 일부만 적은 항목은 종류의 항목과 합쳐 완성된다.
 */
export interface ProgressDef {
  readonly slot?: string;
  readonly base_s?: number;
  /** 입력 특징 → (단계 키 → 계수 ×100). 입력은 같은 물건의 다른 부위·특징(보관·수분·가공·온도). */
  readonly inputs?: { readonly [feature: string]: { readonly [level: string]: number } };
  /** 사다리 칸마다 경계 양(0~1000). 잠긴 칸은 null. 0칸은 0. */
  readonly edges?: readonly (number | null)[];
  readonly tuned?: boolean;
  readonly source?: string;
}

/** 감각 프로파일 (인물-명세): 감각마다 알아채는 사다리 칸(0~5). 낮을수록 예민하다. */
/** 장소 사이의 통로 (docs/번짐-명세.md 2장 · 데이터-형식 3-2). 한 쌍은 한쪽에만 적는다 (방향 없음). */
export interface PassageDef {
  readonly to: string; // 장소 번호
  readonly kind: string; // 사전 edge_kind
  /** 매질(사전 medium) → 투과율 0~1000 (천분율). 적지 않은 매질은 0 (지나가지 못함) */
  readonly medium_pass: { readonly [medium: string]: number };
  readonly tuned: boolean;
}

export interface SenseDef {
  readonly notice: number;
  /** 이 감각으로 세기를 몇 단계로 구분해 느끼나 (2~5, 신체 능력). 없으면 3 (내면-설계 8장). */
  readonly levels?: number;
  /**
   * 긴박함 (urgency.ts, 작가 2026-11-09 "하루라는 사람 세팅"): 이 사다리 칸 이상으로 머무는 곳의 공기를 느끼면 못 참는다.
   * 참는 동안 endure_min분마다 긴장 +1, habituate_min분 계속 맡으면 둔해진다. 셋이 함께 있다.
   */
  readonly unbearable?: number;
  readonly endure_min?: number;
  readonly habituate_min?: number;
  readonly tuned: boolean;
}

/**
 * 인물의 생각과 감정의 문턱 (내면-설계 10장). 칸은 감정 축 사다리의 칸 번호(0~5).
 *   - thought_days: 감정이 붙지 않은 일(생각)을 기억하는 날 수. 날에 따라 min~max (작가: 3일일 때도 5일일 때도). 무엇이 그날을 정하는지는 미정이라 지금은 min
 *   - binds_at: 감정으로 쾌·불쾌가 이 칸 이상이 되면 그 일이 감정과 이어져 잊지 않는다
 *   - tense_at: 안정이 이 칸 이하면 긴장 — 안심되지 않을수록 불쾌가 한 칸 더 오른다
 *   - overwhelm: 불쾌가 이 칸 이상이고 안정이 이 칸 이하면 스트레스 임계 — 생각하고 해석하지 못한다
 */
export interface MindDef {
  readonly thought_days: { readonly min: number; readonly max: number };
  readonly binds_at: number;
  readonly tense_at: number;
  readonly overwhelm: { readonly displeasure_at_least: number; readonly stability_at_most: number };
  readonly tuned: boolean;
}

export interface Definition {
  readonly id: string;
  readonly names: Names;
  /**
   * 종류 (한 단계): 이 정의는 그 정의의 한 종류다. 그 정의의 규칙과 제공 행동을 물려받고,
   * 같은 키의 규칙·행동을 자기가 가지면 그것이 이긴다 (덮어쓰기). 부위는 물려받지 않으므로 직접 갖는다.
   */
  readonly is_a?: string;
  readonly aliases: readonly string[];
  readonly desc: readonly string[];
  readonly mobility?: string;
  /** 가구의 역할: 사전 device_role (그냥 가구 / 기기). 설비를 쓰면 기기다 */
  readonly role?: string;
  /** 연결된 설비(전기·수도·가스, 사전 resource). 비어 있으면 비전자제품(완전한 아날로그). 그 장소가 공급해야 한다(출처 확인) */
  readonly utility?: readonly string[];
  /** 이 물건이 담을 수 있는 자원 (사전 resource). 밀폐 자원(가스)은 그 설비를 쓰는 기기만 담는다 */
  readonly holds?: readonly string[];
  /** 장소가 공급하는 설비 (사전 resource) */
  readonly supplies?: readonly string[];
  readonly slots?: { readonly [key: string]: SlotDef };
  readonly meanings?: readonly MeaningDef[];
  readonly feels?: readonly FeelDef[];
  readonly rules?: { readonly [key: string]: RuleDef };
  readonly offers?: { readonly [key: string]: OfferDef };
  readonly senses?: { readonly [sense: string]: SenseDef };
  /** 인물의 생각과 감정의 문턱 (내면-설계 10장) */
  readonly mind?: MindDef;
  /** 인물이 집에 있는 동안 머무는 장소 (번호 또는 이름). 그 장소의 냄새만 맡는다. 없으면 모든 장소 (위치를 아직 안 둔 것) */
  readonly stays?: string;
  /** 장소의 환경 특성: 사전 env_trait → 사전 env_level */
  readonly environment?: { readonly [trait: string]: string };
  readonly passages?: readonly PassageDef[];
  readonly progress?: { readonly [feature: string]: ProgressDef };
  /** 들여놓을 때(살 때)의 상태: `부위:특징` → 단계 키 (음식-변화-모델 8장: 처음 조건은 구매와 붙어 있다). */
  readonly initial?: { readonly [slotFeature: string]: string };
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
    onlyKeys(rule, ['label', 'on', 'on_all', 'emits', 'note', 'delay_s', 'tuned', 'linked'], at, push);
    const onAll = rule['on_all'] ?? [];
    if (!isStrArr(rule['on']) || !isStrArr(onAll) || rule['on'].length + onAll.length === 0 || !isStrArr(rule['emits']) || rule['emits'].length === 0) {
      push(at, 'on(또는 on_all)과 emits(패턴 문자열 목록, 1개 이상)가 필요하다');
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
    const delay = rule['delay_s'];
    if (delay !== undefined && (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay % 60 !== 0)) {
      push(at, 'delay_s는 0 이상이고 60의 배수인 정수(초)여야 한다 (게임 시간은 분 단위)');
      ok = false;
      continue;
    }
    if (rule['tuned'] !== undefined && typeof rule['tuned'] !== 'boolean') {
      push(at, 'tuned는 true/false여야 한다');
      ok = false;
      continue;
    }
    if (delay !== undefined && rule['tuned'] === undefined) {
      push(at, 'delay_s를 쓰면 tuned(조정 완료 여부)를 true/false로 적어야 한다 (임시값을 숨기지 않는다)');
      ok = false;
      continue;
    }
    const r: RuleDef = {
      ...(typeof rule['label'] === 'string' ? { label: rule['label'] } : {}),
      on: rule['on'].map((s) => s.trim()),
      ...(onAll.length > 0 ? { on_all: onAll.map((s) => s.trim()) } : {}),
      emits: rule['emits'].map((s) => s.trim()),
      ...(typeof rule['note'] === 'string' ? { note: rule['note'] } : {}),
      ...(typeof delay === 'number' ? { delay_s: delay } : {}),
      ...(typeof rule['tuned'] === 'boolean' ? { tuned: rule['tuned'] } : {}),
      ...(rule['linked'] === true ? { linked: true } : {}),
    };
    out[key] = r;
  }
  return ok ? out : undefined;
}

function fieldOffers(v: unknown, where: string, push: Push): Record<string, OfferDef> | undefined {
  if (!isObj(v)) return void push(where, 'offers는 객체여야 한다');
  const out: Record<string, OfferDef> = {};
  let ok = true;
  const bad = (at: string, msg: string): void => {
    push(at, msg);
    ok = false;
  };
  for (const key of Object.keys(v).sort()) {
    const o = v[key];
    const at = `${where}.${key}`;
    if (!TOKEN_RE.test(key)) {
      bad(at, '행동 키는 영소문자로 시작하는 영소문자·숫자·밑줄이어야 한다');
      continue;
    }
    if (!isObj(o)) {
      bad(at, '제공 행동은 객체여야 한다');
      continue;
    }
    onlyKeys(o, ['label', 'verb', 'needs', 'when', 'when_meaning', 'effect', 'reveals', 'during', 'uses', 'menu', 'trains', 'minutes_by', 'where', 'creates', 'places', 'buys', 'away', 'minutes', 'tuned'], at, push);
    const bu = o['buys'];
    const minuteOfDay = (x: unknown): boolean => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1440;
    const buysOk = bu === undefined || (isObj(bu) && Object.keys(bu).every((k) => ['sells', 'on', 'opens', 'arrives_at'].includes(k)) && isStrArr(bu['sells']) && bu['sells'].length > 0 && typeof bu['on'] === 'string'
      && (bu['opens'] === undefined || (Array.isArray(bu['opens']) && bu['opens'].length === 2 && bu['opens'].every(minuteOfDay) && (bu['opens'][0] as number) < (bu['opens'][1] as number)))
      && (bu['arrives_at'] === undefined || (minuteOfDay(bu['arrives_at']) && (bu['arrives_at'] as number) < 1440)));
    const refsOk = (v: unknown, keys: readonly string[], pick: (x: { readonly [k: string]: unknown }) => number): boolean =>
      v === undefined || (Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && Object.keys(x).every((k) => keys.includes(k)) && Object.entries(x).every(([k, y]) => (k === 'out' ? y === true : typeof y === 'string')) && pick(x) === 1));
    const relCount = (x: { readonly [k: string]: unknown }): number => ['in', 'on', 'out'].filter((k) => x[k] !== undefined).length;
    const whereOk = refsOk(o['where'], ['what', 'in', 'on'], (x) => (typeof x['what'] === 'string' ? relCount(x) : 0));
    const placesOk = refsOk(o['places'], ['what', 'in', 'on', 'out'], (x) => (typeof x['what'] === 'string' ? relCount(x) : 0));
    const createsOk = refsOk(o['creates'], ['def', 'in', 'on'], (x) => (typeof x['def'] === 'string' && relCount(x) <= 1 ? 1 : 0));
    const uses = o['uses'];
    const usesOk = uses === undefined || (Array.isArray(uses) && uses.length > 0 && uses.every((u) => isObj(u) && typeof u['key'] === 'string' && typeof u['steps'] === 'number' && Number.isInteger(u['steps']) && u['steps'] > 0 && (u['ingredient'] === undefined || u['ingredient'] === true) && Object.keys(u).every((k) => ['key', 'steps', 'ingredient'].includes(k))));
    const needs = o['needs'];
    const needsOk = Array.isArray(needs) && needs.every((n) => isObj(n) && typeof n['aware'] === 'string' && typeof n['at_least'] === 'string' && Object.keys(n).length === 2);
    if (typeof o['verb'] !== 'string') bad(at, 'verb(사전 action 키)가 필요하다');
    else if (!needsOk) bad(at, 'needs는 { aware, at_least } 목록이어야 한다 (앎이 필요 없으면 빈 목록)');
    else if (!isStrArr(o['effect'])) bad(at, 'effect는 결과 패턴 목록이어야 한다 (세계를 바꾸지 않으면 빈 목록)');
    else if (o['when'] !== undefined && !isStrArr(o['when'])) bad(at, 'when은 상태 패턴 목록이어야 한다');
    else if (o['when_meaning'] !== undefined && (typeof o['when_meaning'] !== 'string' || !TOKEN_RE.test(o['when_meaning']))) bad(at, 'when_meaning은 상태 의미(means) 토큰이어야 한다');
    else if (o['reveals'] !== undefined && typeof o['reveals'] !== 'boolean') bad(at, 'reveals는 true/false여야 한다');
    else if (o['during'] !== undefined && !(isStrArr(o['during']) && o['during'].length > 0)) bad(at, 'during은 상태(사전 presence) 키의 비어 있지 않은 목록이어야 한다');
    else if (!usesOk) bad(at, 'uses는 { key, steps, ingredient? } 목록이어야 한다 (steps는 양의 정수, ingredient는 true이거나 없음)');
    else if (o['menu'] !== undefined && !(typeof o['menu'] === 'string' ? TOKEN_RE.test(o['menu']) : isStrArr(o['menu']) && o['menu'].length > 0 && o['menu'].every((m) => TOKEN_RE.test(m)))) bad(at, 'menu는 사전 menu 키나 그 목록이어야 한다');
    else if (o['trains'] !== undefined && !(isStrArr(o['trains']) && o['trains'].length > 0)) bad(at, 'trains는 내면 특징 키의 비어 있지 않은 목록이어야 한다');
    else if (o['minutes_by'] !== undefined && typeof o['minutes_by'] !== 'string') bad(at, 'minutes_by는 내면 특징 키여야 한다');
    else if (!buysOk) bad(at, 'buys는 { sells: 정의 목록, on: 놓을 곳, opens?: [시작, 끝](하루 중 분), arrives_at?: 하루 중 분 }이어야 한다');
    else if (o['away'] !== undefined && o['away'] !== true) bad(at, 'away는 true이거나 없어야 한다');
    else if (!whereOk) bad(at, 'where는 { what, in 또는 on } 목록이어야 한다 (관계는 하나만)');
    else if (!placesOk) bad(at, 'places는 { what, in 또는 on 또는 out: true } 목록이어야 한다 (관계는 하나만)');
    else if (!createsOk) bad(at, 'creates는 { def, in 또는 on (없어도 됨) } 목록이어야 한다');
    else if (typeof o['minutes'] !== 'number' || !Number.isInteger(o['minutes']) || o['minutes'] <= 0) bad(at, 'minutes(걸리는 시간, 분)는 양의 정수여야 한다');
    else if (typeof o['tuned'] !== 'boolean') bad(at, 'tuned(걸리는 시간이 조정된 값인지)를 true/false로 적어야 한다');
    else if (o['label'] !== undefined && typeof o['label'] !== 'string') bad(at, 'label은 문자열이어야 한다');
    else {
      out[key] = {
        ...(typeof o['label'] === 'string' ? { label: o['label'] } : {}),
        verb: o['verb'],
        needs: (needs as { aware: string; at_least: string }[]).map((n) => ({ aware: n.aware.trim(), at_least: n.at_least })),
        ...(isStrArr(o['when']) && o['when'].length > 0 ? { when: o['when'].map((s) => s.trim()) } : {}),
        ...(typeof o['when_meaning'] === 'string' ? { when_meaning: o['when_meaning'] } : {}),
        effect: (o['effect'] as string[]).map((s) => s.trim()),
        ...(o['reveals'] === true ? { reveals: true } : {}),
        ...(isStrArr(o['during']) ? { during: o['during'].map((s) => s.trim()) } : {}),
        ...(Array.isArray(uses) ? { uses: (uses as { key: string; steps: number; ingredient?: boolean }[]).map((u) => ({ key: u.key.trim(), steps: u.steps, ...(u.ingredient === true ? { ingredient: true } : {}) })) } : {}),
        ...(typeof o['menu'] === 'string' || isStrArr(o['menu']) ? { menu: o['menu'] } : {}),
        ...(isStrArr(o['trains']) ? { trains: o['trains'] } : {}),
        ...(isObj(bu) && isStrArr(bu['sells']) && typeof bu['on'] === 'string'
          ? {
              buys: {
                sells: bu['sells'],
                on: bu['on'],
                ...(Array.isArray(bu['opens']) ? { opens: [Number(bu['opens'][0]), Number(bu['opens'][1])] as const } : {}),
                ...(typeof bu['arrives_at'] === 'number' ? { arrives_at: bu['arrives_at'] } : {}),
              },
            }
          : {}),
        ...(o['away'] === true ? { away: true } : {}),
        ...(typeof o['minutes_by'] === 'string' ? { minutes_by: o['minutes_by'] } : {}),
        ...(Array.isArray(o['where']) ? { where: o['where'] as WhereSpec[] } : {}),
        ...(Array.isArray(o['creates']) ? { creates: o['creates'] as CreateSpec[] } : {}),
        ...(Array.isArray(o['places']) ? { places: o['places'] as PlaceSpec[] } : {}),
        minutes: o['minutes'],
        tuned: o['tuned'],
      };
    }
  }
  return ok ? out : undefined;
}

function fieldMind(v: unknown, where: string, push: Push): MindDef | undefined {
  const rung = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 5;
  if (!isObj(v)) return void push(where, 'mind는 객체여야 한다');
  onlyKeys(v, ['thought_days', 'binds_at', 'tense_at', 'overwhelm', 'tuned'], where, push);
  const td = v['thought_days'], ow = v['overwhelm'];
  if (!isObj(td) || typeof td['min'] !== 'number' || typeof td['max'] !== 'number' || !Number.isInteger(td['min']) || !Number.isInteger(td['max']) || td['min'] < 1 || td['max'] < td['min']) {
    return void push(`${where}.thought_days`, 'thought_days는 { min, max } (1 이상 정수, min ≤ max)여야 한다');
  }
  if (!rung(v['binds_at']) || !rung(v['tense_at'])) return void push(where, 'binds_at · tense_at은 감정 축 사다리의 칸(0~5 정수)이어야 한다');
  if (!isObj(ow) || !rung(ow['displeasure_at_least']) || !rung(ow['stability_at_most'])) return void push(`${where}.overwhelm`, 'overwhelm은 { displeasure_at_least, stability_at_most } (0~5 칸)여야 한다');
  onlyKeys(ow, ['displeasure_at_least', 'stability_at_most'], `${where}.overwhelm`, push);
  if (typeof v['tuned'] !== 'boolean') return void push(`${where}.tuned`, '문턱이 조정된 값인지 tuned를 적어야 한다');
  return { thought_days: { min: td['min'], max: td['max'] }, binds_at: v['binds_at'], tense_at: v['tense_at'], overwhelm: { displeasure_at_least: ow['displeasure_at_least'], stability_at_most: ow['stability_at_most'] }, tuned: v['tuned'] };
}

function fieldSenses(v: unknown, where: string, push: Push): Record<string, SenseDef> | undefined {
  if (!isObj(v)) return void push(where, 'senses는 객체여야 한다');
  const out: Record<string, SenseDef> = {};
  let ok = true;
  for (const key of Object.keys(v).sort()) {
    const s = v[key];
    const at = `${where}.${key}`;
    if (!isObj(s) || typeof s['notice'] !== 'number' || !Number.isInteger(s['notice']) || s['notice'] < 1 || s['notice'] > 5 || typeof s['tuned'] !== 'boolean') {
      push(at, '감각은 { notice: 1~5 정수(알아채는 사다리 칸), tuned: true/false }여야 한다');
      ok = false;
      continue;
    }
    onlyKeys(s, ['notice', 'levels', 'unbearable', 'endure_min', 'habituate_min', 'tuned'], at, push);
    // 긴박함: 못 참는 칸(알아채는 칸 이상, 5 이하)과 긴장이 쌓이는 분·둔해지는 분(양의 정수, 둔해지는 것이 쌓이는 것보다 늦다)
    const urg = ['unbearable', 'endure_min', 'habituate_min'].filter((k) => s[k] !== undefined);
    if (urg.length > 0) {
      const u = s['unbearable'], en = s['endure_min'], ha = s['habituate_min'];
      const int = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
      if (urg.length !== 3 || !int(u) || !int(en) || !int(ha) || u < s['notice'] || u > 5 || en < 1 || ha < en) {
        push(`${at}.unbearable`, '긴박함은 unbearable(알아채는 칸 이상 5 이하) · endure_min(1 이상) · habituate_min(endure_min 이상)을 함께 적는다');
        ok = false;
        continue;
      }
    }
    const lv = s['levels'];
    if (lv !== undefined && (typeof lv !== 'number' || !Number.isInteger(lv) || lv < 2 || lv > 5)) {
      push(`${at}.levels`, 'levels(세기를 구분하는 단계 수)는 2~5 정수여야 한다');
      ok = false;
      continue;
    }
    const urgent = typeof s['unbearable'] === 'number' && typeof s['endure_min'] === 'number' && typeof s['habituate_min'] === 'number' ? { unbearable: s['unbearable'], endure_min: s['endure_min'], habituate_min: s['habituate_min'] } : {};
    out[key] = { notice: s['notice'], ...(typeof lv === 'number' ? { levels: lv } : {}), ...urgent, tuned: s['tuned'] };
  }
  return ok ? out : undefined;
}

function fieldEnvironment(v: unknown, where: string, push: Push): Record<string, string> | undefined {
  if (!isObj(v)) return void push(where, 'environment는 객체여야 한다 (환경 특성 → 등급)');
  const out: Record<string, string> = {};
  for (const k of Object.keys(v).sort()) {
    const x = v[k];
    if (typeof x !== 'string' || x.trim() === '') push(`${where}.${k}`, '환경 등급은 사전 키 문자열이어야 한다');
    else out[k] = x.trim();
  }
  return out;
}

function fieldPassages(v: unknown, where: string, push: Push): PassageDef[] | undefined {
  if (!Array.isArray(v)) return void push(where, 'passages는 목록이어야 한다');
  const out: PassageDef[] = [];
  let ok = true;
  v.forEach((p: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(p)) {
      push(at, '통로는 { to, kind, medium_pass, tuned }여야 한다');
      ok = false;
      return;
    }
    onlyKeys(p, ['to', 'kind', 'medium_pass', 'tuned'], at, push);
    const { to, kind, medium_pass: mp, tuned } = p;
    if (typeof to !== 'string' || typeof kind !== 'string' || !isObj(mp) || typeof tuned !== 'boolean') {
      push(at, '통로는 { to: 장소 번호, kind: 통로 종류, medium_pass: { 매질: 0~1000 }, tuned: true/false }여야 한다');
      ok = false;
      return;
    }
    const pass: Record<string, number> = {};
    for (const m of Object.keys(mp).sort()) {
      const x = mp[m];
      if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 1000) {
        push(`${at}.medium_pass.${m}`, '투과율은 0~1000 정수(천분율)여야 한다');
        ok = false;
      } else pass[m] = x;
    }
    out.push({ to: to.trim(), kind: kind.trim(), medium_pass: pass, tuned });
  });
  return ok ? out : undefined;
}

function fieldProgress(v: unknown, where: string, push: Push): Record<string, ProgressDef> | undefined {
  if (!isObj(v)) return void push(where, 'progress는 객체여야 한다');
  const out: Record<string, ProgressDef> = {};
  let ok = true;
  for (const key of Object.keys(v).sort()) {
    const p = v[key];
    const at = `${where}.${key}`;
    const bad = (msg: string): void => {
      push(at, msg);
      ok = false;
    };
    if (!TOKEN_RE.test(key) || !isObj(p)) {
      bad('진행 법칙은 특징 키 → 객체여야 한다');
      continue;
    }
    onlyKeys(p, ['slot', 'base_s', 'inputs', 'edges', 'tuned', 'source'], at, push);
    const base = p['base_s'];
    const inputs = p['inputs'];
    const edges = p['edges'];
    if (p['slot'] !== undefined && (typeof p['slot'] !== 'string' || !TOKEN_RE.test(p['slot']))) bad('slot은 부위 키여야 한다');
    else if (base !== undefined && (typeof base !== 'number' || !Number.isInteger(base) || base <= 0 || base % 60 !== 0)) bad('base_s는 60의 배수인 양의 정수(초)여야 한다');
    else if (inputs !== undefined && !(isObj(inputs) && Object.values(inputs).every((t) => isObj(t) && Object.values(t).every((c) => typeof c === 'number' && Number.isInteger(c) && c >= 0)))) {
      bad('inputs는 { 특징: { 단계 키: 계수(×100, 0 이상 정수) } }여야 한다');
    } else if (edges !== undefined && !(Array.isArray(edges) && edges.every((e) => e === null || (typeof e === 'number' && Number.isInteger(e) && e >= 0 && e <= 1000)))) {
      bad('edges는 칸마다 0~1000 정수 또는 null(잠긴 칸)이어야 한다');
    } else if (p['tuned'] !== undefined && typeof p['tuned'] !== 'boolean') bad('tuned는 true/false여야 한다');
    else if (p['source'] !== undefined && typeof p['source'] !== 'string') bad('source는 문자열이어야 한다');
    else {
      out[key] = {
        ...(typeof p['slot'] === 'string' ? { slot: p['slot'] } : {}),
        ...(typeof base === 'number' ? { base_s: base } : {}),
        ...(isObj(inputs) ? { inputs: inputs as ProgressDef['inputs'] } : {}),
        ...(Array.isArray(edges) ? { edges: edges as (number | null)[] } : {}),
        ...(typeof p['tuned'] === 'boolean' ? { tuned: p['tuned'] } : {}),
        ...(typeof p['source'] === 'string' ? { source: p['source'] } : {}),
      };
    }
  }
  return ok ? out : undefined;
}

function fieldInitial(v: unknown, where: string, push: Push): Record<string, string> | undefined {
  if (!isObj(v) || !Object.entries(v).every(([k, l]) => /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(k) && typeof l === 'string')) {
    return void push(where, 'initial은 { "부위:특징": 단계 키 }여야 한다');
  }
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k] as string]));
}

export type Fields = Partial<{
  id: string;
  is_a: string;
  names: Names;
  aliases: string[];
  desc: string[];
  mobility: string;
  role: string;
  utility: string[];
  holds: string[];
  supplies: string[];
  slots: Record<string, SlotDef>;
  meanings: MeaningDef[];
  feels: FeelDef[];
  rules: Record<string, RuleDef>;
  offers: Record<string, OfferDef>;
  senses: Record<string, SenseDef>;
  mind: MindDef;
  stays: string;
  environment: Record<string, string>;
  passages: PassageDef[];
  progress: Record<string, ProgressDef>;
  initial: Record<string, string>;
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
      case 'is_a':
        if (typeof value !== 'string' || value.trim() === '') push(at, 'is_a는 정의 번호 문자열이어야 한다');
        else out.is_a = value.trim();
        break;
      case 'mobility':
        if (typeof value !== 'string' || value.trim() === '') push(at, 'mobility는 문자열이어야 한다');
        else out.mobility = value.trim();
        break;
      case 'role':
        if (typeof value !== 'string' || value.trim() === '') push(at, 'role은 문자열이어야 한다');
        else out.role = value.trim();
        break;
      case 'utility':
      case 'holds':
      case 'supplies': {
        const v = fieldStringList(value, key, at, push);
        if (v !== undefined) out[key] = v;
        break;
      }
      case 'slots': {
        const v = fieldSlots(value, at, push);
        if (v !== undefined) out.slots = v;
        break;
      }
      case 'feels': {
        if (!Array.isArray(value) || !value.every((f) => isObj(f) && typeof f['sensation'] === 'string' && isStrArr(f['when']) && (f['by'] === undefined || typeof f['by'] === 'string') && (f['reverse'] === undefined || f['reverse'] === true) && Object.keys(f).every((k) => ['sensation', 'when', 'by', 'reverse'].includes(k)))) {
          push(at, 'feels는 { sensation: 감각질 키, when: 소유자 안의 조건 목록, by?: 세기를 정하는 부위:특징, reverse?: true } 목록이어야 한다');
        } else {
          out.feels = value.map((f) => ({
            sensation: String(f['sensation']),
            when: (f['when'] as string[]).map((w) => w.trim()),
            ...(typeof f['by'] === 'string' ? { by: f['by'].trim() } : {}),
            ...(f['reverse'] === true ? { reverse: true } : {}),
          }));
        }
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
      case 'offers': {
        const v = fieldOffers(value, at, push);
        if (v !== undefined) out.offers = v;
        break;
      }
      case 'mind': {
        const v = fieldMind(value, at, push);
        if (v !== undefined) out.mind = v;
        break;
      }
      case 'senses': {
        const v = fieldSenses(value, at, push);
        if (v !== undefined) out.senses = v;
        break;
      }
      case 'stays':
        if (typeof value !== 'string' || value.trim() === '') push(at, 'stays는 장소 번호나 이름 문자열이어야 한다');
        else out.stays = value.trim();
        break;
      case 'environment': {
        const v = fieldEnvironment(value, at, push);
        if (v !== undefined) out.environment = v;
        break;
      }
      case 'passages': {
        const v = fieldPassages(value, at, push);
        if (v !== undefined) out.passages = v;
        break;
      }
      case 'progress': {
        const v = fieldProgress(value, at, push);
        if (v !== undefined) out.progress = v;
        break;
      }
      case 'initial': {
        const v = fieldInitial(value, at, push);
        if (v !== undefined) out.initial = v;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * 정의의 모든 필드(id 제외)를 필드 묶음으로 되돌린다. 갱신 병합이 "옛 필드 전부 + 바뀐 필드"로 합칠 때 쓴다.
 * 필드를 이름으로 하나씩 옮기던 목록을 없애서, 새 필드를 더해도 부분 갱신이 그 필드를 지우지 못한다.
 */
export function fieldsOf(def: Definition): Fields {
  const { id, ...rest } = def;
  void id;
  return rest as Fields;
}

/** 필드 묶음을 정규 순서의 정의로 만든다. names가 없으면 undefined. */
export function buildDefinition(id: string, f: Fields): Definition | undefined {
  if (f.names === undefined) return undefined;
  return {
    id,
    names: f.names,
    ...(f.is_a !== undefined ? { is_a: f.is_a } : {}),
    aliases: f.aliases ?? [],
    ...(f.mobility !== undefined ? { mobility: f.mobility } : {}),
    ...(f.role !== undefined ? { role: f.role } : {}),
    ...(f.utility !== undefined ? { utility: f.utility } : {}),
    ...(f.holds !== undefined ? { holds: f.holds } : {}),
    ...(f.supplies !== undefined ? { supplies: f.supplies } : {}),
    ...(f.slots !== undefined ? { slots: f.slots } : {}),
    ...(f.meanings !== undefined ? { meanings: f.meanings } : {}),
    ...(f.feels !== undefined ? { feels: f.feels } : {}),
    ...(f.rules !== undefined ? { rules: f.rules } : {}),
    ...(f.offers !== undefined ? { offers: f.offers } : {}),
    ...(f.senses !== undefined ? { senses: f.senses } : {}),
    ...(f.mind !== undefined ? { mind: f.mind } : {}),
    ...(f.stays !== undefined ? { stays: f.stays } : {}),
    ...(f.environment !== undefined ? { environment: f.environment } : {}),
    ...(f.passages !== undefined ? { passages: f.passages } : {}),
    ...(f.progress !== undefined ? { progress: f.progress } : {}),
    ...(f.initial !== undefined ? { initial: f.initial } : {}),
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
