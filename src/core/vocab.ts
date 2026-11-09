// 사전 (통제 어휘) — docs/사전-명세.md
//
// 게임이 쓰는 모든 단어에 공식 키를 하나씩 정하고, 한국어 이름·영어 이름·별칭을 그 키로 연결한다.
// 같은 분류 안에서 정규화한 말이 두 항목을 가리키면 오류다 ("이름 하나 = 개념 하나").

import type { JsonValue } from './events.ts';
import { VIA_KINDS } from './via.ts';

export interface VocabEntryRaw {
  readonly key: string;
  readonly ko: string;
  readonly en?: string;
  readonly aliases?: readonly string[];
  readonly desc?: string;
  readonly attrs?: { readonly [key: string]: JsonValue };
}

export interface VocabCategoryRaw {
  readonly category: string;
  readonly entries: readonly VocabEntryRaw[];
}

export interface VocabIssue {
  readonly path: string;
  readonly message: string;
}

export interface VocabEntry {
  readonly key: string;
  readonly ko: string;
  readonly en: string | null;
  readonly aliases: readonly string[];
  readonly desc: string;
  readonly attrs: { readonly [key: string]: JsonValue };
}

export class VocabError extends Error {
  readonly issues: readonly VocabIssue[];

  constructor(issues: readonly VocabIssue[]) {
    super(`사전 검증 실패 (${issues.length}건)\n` + issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n'));
    this.name = 'VocabError';
    this.issues = issues;
  }
}

const TOKEN_RE = /^[a-z][a-z0-9_]*$/;

/** 단계 사다리 칸 수 (0~5). 칸 번호가 단계 숫자다. */
export const LADDER_SIZE = 6;

/** 대소문자, 공백, 하이픈, 밑줄, 가운뎃점, 마침표, 쉼표 차이를 없앤다. */
export function normalizeWord(word: string): string {
  return word.normalize('NFC').toLowerCase().replace(/[\s\-_·.,]/g, '');
}

/** 단계 항목 {key, ko} 에서 키를 꺼낸다. 형식이 아니면 null. */
export function levelKeyOf(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const k = (v as { key?: unknown }).key;
  return typeof k === 'string' && TOKEN_RE.test(k) ? k : null;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

type Push = (path: string, message: string) => void;

// 분류별 속성 규칙. 규칙이 없는 분류는 속성을 검사하지 않는다.
function checkAttrs(category: string, entry: VocabEntryRaw, path: string, push: Push): void {
  const attrs = entry.attrs ?? {};
  switch (category) {
    case 'feature': {
      // 단계 사다리: 0~5 여섯 칸 고정. 칸 번호가 단계 숫자다. locked 칸은 아직 쓸 수 없다 (작가가 풀면 쓴다).
      // 내면 특징(inner: 숙련처럼 인물 자신의 상태)은 감각으로 느끼지 않는다. 나머지는 느끼는 감각이 있어야 한다
      if (attrs['inner'] === true) {
        if (attrs['sense'] !== undefined) push(`${path}.attrs.sense`, '내면 특징(inner)은 감각으로 느끼지 않는다 (sense를 쓰지 않는다)');
        const seq = (k: string, ok: (xs: number[]) => boolean): boolean => {
          const v = attrs[k];
          return Array.isArray(v) && v.length === LADDER_SIZE && v.every(isInt) && ok(v as number[]);
        };
        if (attrs['practice'] !== undefined && !seq('practice', (xs) => xs[0] === 0 && xs.every((x, i) => i === 0 || x > (xs[i - 1] as number)))) {
          push(`${path}.attrs.practice`, `practice(그 칸에 오르는 데 필요한 해 본 횟수)는 0에서 시작해 늘어나는 정수 ${LADDER_SIZE}개여야 한다`);
        }
        if (attrs['minutes_pct'] !== undefined && !seq('minutes_pct', (xs) => xs[0] === 100 && xs.every((x, i) => x > 0 && (i === 0 || x <= (xs[i - 1] as number))))) {
          push(`${path}.attrs.minutes_pct`, `minutes_pct(그 칸에서 걸리는 시간 %)는 100에서 시작해 줄어드는 양의 정수 ${LADDER_SIZE}개여야 한다`);
        }
        if (typeof attrs['tuned'] !== 'boolean') push(`${path}.attrs.tuned`, '내면 특징의 수치(practice·minutes_pct)가 조정된 값인지 tuned를 적어야 한다');
      } else if (typeof attrs['sense'] !== 'string') push(`${path}.attrs.sense`, '이 특징을 느끼는 감각(sense 키)이 필요하다');
      const levels = attrs['levels'];
      if (!Array.isArray(levels) || levels.length !== LADDER_SIZE) {
        push(`${path}.attrs.levels`, `단계 목록은 정확히 ${LADDER_SIZE}칸(0~${LADDER_SIZE - 1})이어야 한다`);
      } else {
        const seen = new Set<string>();
        levels.forEach((l, i) => {
          const k = levelKeyOf(l);
          const obj = typeof l === 'object' && l !== null && !Array.isArray(l) ? l : {};
          const ko = obj['ko'];
          const locked = obj['locked'];
          if (k === null) push(`${path}.attrs.levels[${i}].key`, '단계 키는 영소문자·숫자·밑줄 토큰이어야 한다');
          else if (seen.has(k)) push(`${path}.attrs.levels[${i}].key`, `단계 키 "${k}"가 중복된다`);
          else seen.add(k);
          if (locked !== undefined && typeof locked !== 'boolean') push(`${path}.attrs.levels[${i}].locked`, 'locked는 true/false여야 한다');
          if (locked === true) {
            if (ko !== undefined && (typeof ko !== 'string' || ko === '')) push(`${path}.attrs.levels[${i}].ko`, '잠긴 칸의 이름은 비우거나 비어 있지 않은 문자열이어야 한다');
          } else if (typeof ko !== 'string' || ko === '') {
            push(`${path}.attrs.levels[${i}].ko`, '쓸 수 있는 단계는 한국어 이름이 필요하다');
          }
        });
      }
      break;
    }
    case 'awareness': {
      // 인지 단계의 순서. 0 = 모름. 지각 층이 올리기만 하고 내리지 않는다
      const r = attrs['rank'];
      if (!isInt(r) || r < 0) push(`${path}.attrs.rank`, '인지 단계의 순서(rank)는 0 이상의 정수여야 한다');
      break;
    }
    case 'durability': {
      // 부위 배율 ×100 정수 (50 = 취약 0.5배, 100 = 평균, 150 = 강점 1.5배, 200 = 큰 강점 2배)
      const m = attrs['mult100'];
      if (!isInt(m) || m < 1 || m > 1000) push(`${path}.attrs.mult100`, '내구 배율은 1~1000 정수(×100)여야 한다');
      break;
    }
    case 'contact': {
      const transfer = attrs['transfer'];
      if (!isInt(transfer) || transfer < 0 || transfer > 1000) {
        push(`${path}.attrs.transfer`, '전달률은 0~1000(천분율) 정수여야 한다');
      }
      if (typeof attrs['tuned'] !== 'boolean') {
        push(`${path}.attrs.tuned`, 'tuned(조정 완료 여부)를 true/false로 적어야 한다');
      }
      break;
    }
    case 'medium': {
      if (typeof attrs['in_slice'] !== 'boolean') {
        push(`${path}.attrs.in_slice`, 'in_slice(슬라이스 포함 여부)를 true/false로 적어야 한다');
      }
      break;
    }
    case 'spreader': {
      if (typeof attrs['medium'] !== 'string') push(`${path}.attrs.medium`, '매질 키가 필요하다');
      if (typeof attrs['stimulus'] !== 'string') push(`${path}.attrs.stimulus`, '감각 키가 필요하다');
      // 번짐 계산 (spread.ts): 번지는 장소 특징, 칸마다 약해지는 단계 수, 칸마다 걸리는 시간(초, 60의 배수). 셋이 함께 있고 임시값 표시가 필요하다
      const calc = ['feature', 'attenuation', 'hop_s'].filter((k) => attrs[k] !== undefined);
      if (calc.length > 0) {
        if (calc.length !== 3) push(`${path}.attrs`, '번짐 계산에는 feature·attenuation·hop_s가 함께 필요하다');
        if (typeof attrs['feature'] !== 'string') push(`${path}.attrs.feature`, '번지는 특징 키가 필요하다');
        const a = attrs['attenuation'];
        if (!isInt(a) || a < 0 || a > 5) push(`${path}.attrs.attenuation`, '감쇠는 칸마다 줄어드는 단계 수(0~5 정수)여야 한다');
        const h = attrs['hop_s'];
        if (!isInt(h) || h < 0 || h % 60 !== 0) push(`${path}.attrs.hop_s`, '칸마다 걸리는 시간은 0 이상, 60의 배수 정수(초)여야 한다');
        if (typeof attrs['tuned'] !== 'boolean') push(`${path}.attrs.tuned`, 'tuned(조정 완료 여부)를 true/false로 적어야 한다');
      }
      break;
    }
    case 'event_type': {
      // via_kinds: 이 사건 유형이 근거 참조(data.via)로 가져야 하는 종류 (via.ts). 없으면 via를 갖지 않는다
      const k = attrs['via_kinds'];
      if (k !== undefined && (!Array.isArray(k) || k.length === 0 || !k.every((x) => typeof x === 'string' && (VIA_KINDS as readonly string[]).includes(x)))) {
        push(`${path}.attrs.via_kinds`, `via_kinds는 ${VIA_KINDS.join(' / ')} 중에서 고른 비어 있지 않은 목록이어야 한다`);
      }
      break;
    }
    case 'presence': {
      // observed: 이 상태를 플레이어가 함께 보는가 (집에 있음·식사 준비는 보고, 외출·잠은 보지 않는다). 지각·행동·시계가 읽는다
      if (typeof attrs['observed'] !== 'boolean') push(`${path}.attrs.observed`, 'observed(플레이어가 함께 보는가)를 true/false로 적어야 한다');
      // plans_menu: 이 구간이 시작되면 인물이 메뉴를 구상한다 (식사 준비)
      if (attrs['plans_menu'] !== undefined && attrs['plans_menu'] !== true) push(`${path}.attrs.plans_menu`, 'plans_menu는 true이거나 없어야 한다');
      if (attrs['plans_menu'] === true && attrs['observed'] !== true) push(`${path}.attrs.plans_menu`, '메뉴 구상은 플레이어가 함께 보는 구간에서만 한다');
      break;
    }
    case 'sense': {
      // reach: 감각이 닿는 길 — distance(머무는 곳에서 멀리서: 냄새·보기·소리), contact(손에 닿을 때), mouth(먹을 때), body(몸 안)
      if (!['distance', 'contact', 'mouth', 'body'].includes(String(attrs['reach']))) push(`${path}.attrs.reach`, 'reach(감각이 닿는 길)는 distance · contact · mouth · body 중 하나여야 한다');
      break;
    }
    case 'sensation': {
      // 감각 자체 (내면-설계 2장): 한 감각의 드라이한 성질. look은 보이는 것 중 '~해 보임'의 예측
      if (typeof attrs['sense'] !== 'string') push(`${path}.attrs.sense`, '이 감각질을 느끼는 감각(sense 키)이 필요하다');
      if (attrs['look'] !== undefined && attrs['look'] !== true) push(`${path}.attrs.look`, 'look은 true이거나 없어야 한다');
      break;
    }
    case 'action': {
      // handles: 이 행동은 그 물건을 손으로 다룬다 (촉각), eats: 먹는다 (미각)
      // tidies: 치우는 일 — 남아 있으면 그 물건의 생각이 미완으로 더 오래 간다 (내면-설계 11장)
      for (const k of ['handles', 'eats', 'tidies']) if (attrs[k] !== undefined && attrs[k] !== true) push(`${path}.attrs.${k}`, `${k}는 true이거나 없어야 한다`);
      break;
    }
    case 'emotion': {
      // 감정 (내면-설계 10장): tone(좋은·싫은 심상에서), thought(생각: new 처음 · familiar 며칠 안에 겪어 봄 · against 기억과 어긋남, 없으면 기억에서만 온다), shifts(축 특징 → 움직이는 칸 수)
      if (attrs['tone'] !== 'pleasant' && attrs['tone'] !== 'unpleasant') push(`${path}.attrs.tone`, 'tone은 pleasant(좋은 심상)나 unpleasant(싫은 심상)여야 한다');
      if (attrs['thought'] !== undefined && !['new', 'familiar', 'against'].includes(String(attrs['thought']))) push(`${path}.attrs.thought`, 'thought는 new · familiar · against 중 하나이거나 없어야 한다 (없으면 기억에서만 온다)');
      const sh = attrs['shifts'];
      if (typeof sh !== 'object' || sh === null || Array.isArray(sh) || Object.keys(sh).length === 0 || !Object.values(sh).every((x) => isInt(x) && x !== 0 && Math.abs(x) <= 2)) {
        push(`${path}.attrs.shifts`, 'shifts는 { 축 특징: 움직이는 칸 수(±1~2, 0이 아닌 정수) }이고 비어 있지 않아야 한다');
      }
      if (typeof attrs['tuned'] !== 'boolean') push(`${path}.attrs.tuned`, '움직이는 칸 수가 조정된 값인지 tuned를 적어야 한다');
      break;
    }
    case 'reflex': {
      // 반사: on(감각질)을 그 사람의 단계 중 at_least% 이상 세게 느끼면. 조건반사는 pairs_with와 times로 배운다
      const al = attrs['at_least'];
      if (!isInt(al) || al < 1 || al > 100) push(`${path}.attrs.at_least`, 'at_least(문턱, 그 사람의 단계 중 %)는 1~100 정수여야 한다');
      if (attrs['kind'] !== 'unconditioned' && attrs['kind'] !== 'conditioned') push(`${path}.attrs.kind`, 'kind는 unconditioned(무조건반사)나 conditioned(조건반사)여야 한다');
      if (attrs['kind'] === 'conditioned' && (typeof attrs['pairs_with'] !== 'string' || !isInt(attrs['times']) || (attrs['times'] as number) < 1)) push(`${path}.attrs`, '조건반사는 pairs_with(예고하는 감각질)와 times(짝지어 겪은 횟수, 1 이상)가 필요하다');
      if (attrs['kind'] === 'unconditioned' && (attrs['pairs_with'] !== undefined || attrs['times'] !== undefined)) push(`${path}.attrs`, '무조건반사는 배우지 않는다 (pairs_with·times를 쓰지 않는다)');
      if (typeof attrs['tuned'] !== 'boolean') push(`${path}.attrs.tuned`, '문턱·횟수가 조정된 값인지 tuned를 적어야 한다');
      break;
    }
    case 'menu': {
      // rank: 구상할 때 먼저 보는 순서 (작을수록 먼저, 남은 음식이 앞선다)
      const r = attrs['rank'];
      if (!isInt(r) || r < 1) push(`${path}.attrs.rank`, '메뉴의 순서(rank)는 1 이상의 정수여야 한다');
      const ns = attrs['needs_skill'];
      if (ns !== undefined && (typeof ns !== 'object' || ns === null || Array.isArray(ns) || typeof ns['feature'] !== 'string' || typeof ns['at_least'] !== 'string' || Object.keys(ns).length !== 2)) {
        push(`${path}.attrs.needs_skill`, 'needs_skill은 { feature, at_least } (내면 특징과 그 단계 키)여야 한다');
      }
      break;
    }
    case 'odor_kind': {
      // 냄새 종류: rank는 사다리 칸 번호(심각도), feature는 이 종류가 들어가는 특징
      const r = attrs['rank'];
      if (!isInt(r) || r < 1 || r > LADDER_SIZE - 1) push(`${path}.attrs.rank`, `냄새 종류의 순서(rank)는 1~${LADDER_SIZE - 1} 정수여야 한다 (사다리 칸 번호, 0은 없음)`);
      if (typeof attrs['feature'] !== 'string') push(`${path}.attrs.feature`, '이 종류가 들어가는 특징(feature 키)이 필요하다');
      break;
    }
    case 'compound':
    case 'strain':
    case 'odor_cause': {
      // 냄새의 지식 (원인 → 균주 → 유기화합물 → 냄새). 서지를 확인하기 전에는 verified:false로 적는다 (모르는 값은 지어내지 않는다)
      if (typeof attrs['verified'] !== 'boolean') push(`${path}.attrs.verified`, 'verified(서지로 확인했는가)를 true/false로 적어야 한다');
      const list = (name: string): boolean => {
        const v = attrs[name];
        return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
      };
      if (category === 'compound' && typeof attrs['odor'] !== 'string') push(`${path}.attrs.odor`, '어떤 냄새가 나는지(odor_kind 키)가 필요하다');
      if (category === 'strain' && !list('produces')) push(`${path}.attrs.produces`, '만드는 유기화합물(compound 키) 목록이 필요하다');
      if (category === 'odor_cause') {
        const stages = attrs['stages'];
        const hasStages = Array.isArray(stages) && stages.length > 0;
        if (hasStages && typeof attrs['feature'] !== 'string') push(`${path}.attrs.feature`, 'stages를 쓰면 단계를 가진 특징(feature 키)이 필요하다');
        if (hasStages && !stages.every((s) => typeof s === 'object' && s !== null && !Array.isArray(s) && typeof s['at'] === 'string' && Array.isArray(s['strains']) && s['strains'].length > 0 && s['strains'].every((x) => typeof x === 'string') && (s['strength'] === undefined || typeof s['strength'] === 'string'))) {
          push(`${path}.attrs.stages`, '단계마다 { at: 단계 키, strains: [균주 키 …], strength?: 냄새 세기 단계 키 }여야 한다');
        }
        // 단계마다 냄새의 세기(strength)를 적으면 그 세기를 가진 특징(strength_feature)이 필요하다
        const withStrength = hasStages && stages.some((s) => typeof s === 'object' && s !== null && !Array.isArray(s) && s['strength'] !== undefined);
        if (withStrength && typeof attrs['strength_feature'] !== 'string') push(`${path}.attrs.strength_feature`, '단계에 strength를 쓰면 냄새 세기를 가진 특징(strength_feature)이 필요하다');
        if (attrs['strength_feature'] !== undefined && typeof attrs['strength_feature'] !== 'string') push(`${path}.attrs.strength_feature`, 'strength_feature는 특징 키여야 한다');
        if (!hasStages && !list('compounds')) push(`${path}.attrs`, '단계(feature + stages)나 화합물(compounds) 중 하나는 있어야 한다');
        if (attrs['compounds'] !== undefined && !list('compounds')) push(`${path}.attrs.compounds`, 'compounds는 compound 키의 비어 있지 않은 목록이어야 한다');
      }
      break;
    }
    case 'resource': {
      // 설비 자원: 담을 수 있는가(holdable), 밀폐인가(sealed: 기기 안에서만), 사라지는 길(sinks, sink 분류의 키 목록)
      if (typeof attrs['holdable'] !== 'boolean') push(`${path}.attrs.holdable`, 'holdable(담을 수 있는가)을 true/false로 적어야 한다');
      if (typeof attrs['sealed'] !== 'boolean') push(`${path}.attrs.sealed`, 'sealed(밀폐인가)를 true/false로 적어야 한다');
      else if (attrs['sealed'] === true && attrs['holdable'] !== true) push(`${path}.attrs.sealed`, '밀폐된 자원은 담을 수 있어야 한다 (기기 안에 담긴다)');
      const sinks = attrs['sinks'];
      if (!Array.isArray(sinks) || sinks.length === 0 || !sinks.every((x) => typeof x === 'string')) {
        push(`${path}.attrs.sinks`, '사라지는 길(sinks)이 하나 이상 있어야 한다 — 쓰고 남는 것이 사라질 곳이 없는 자원은 거부');
      }
      break;
    }
    case 'env_level': {
      const r = attrs['rank'];
      if (!isInt(r) || r < 0) push(`${path}.attrs.rank`, '환경 등급의 순서(rank)는 0 이상의 정수여야 한다');
      break;
    }
    default:
      break;
  }
}

// 다른 분류의 키를 가리키는 속성. [분류, 속성 이름, 가리키는 분류]
const REFS: readonly (readonly [string, string, string])[] = [
  ['spreader', 'medium', 'medium'],
  ['spreader', 'stimulus', 'sense'],
  ['spreader', 'feature', 'feature'], // 번짐이 바꾸는 장소의 특징
  ['feature', 'sense', 'sense'], // 이 특징을 어느 감각으로 느끼는가 (5층 지각)
  ['sensation', 'sense', 'sense'], // 감각질을 느끼는 감각
  ['reflex', 'on', 'sensation'], // 반사가 붙는 감각질
  ['reflex', 'pairs_with', 'sensation'], // 조건반사가 예고로 배우는 감각질
  ['feature', 'resource', 'resource'], // 이 특징이 담는 설비 자원 (물 양 → 물). 사라지는 길을 관문이 요구한다
  ['odor_kind', 'feature', 'feature'], // 냄새 종류가 들어가는 특징
  ['compound', 'odor', 'odor_kind'], // 이 화합물이 어떤 냄새인가
  ['odor_cause', 'feature', 'feature'], // 냄새 원인의 단계를 가진 특징
  ['odor_cause', 'strength_feature', 'feature'], // 냄새의 세기를 가진 특징
];

function groupByCategory(raw: readonly VocabCategoryRaw[]): Map<string, VocabEntryRaw[]> {
  const grouped = new Map<string, VocabEntryRaw[]>();
  for (const cat of raw) {
    const list = grouped.get(cat.category) ?? [];
    list.push(...cat.entries);
    grouped.set(cat.category, list);
  }
  return grouped;
}

export function validateVocab(raw: readonly VocabCategoryRaw[]): VocabIssue[] {
  const issues: VocabIssue[] = [];
  const push: Push = (path, message) => issues.push({ path, message });
  const grouped = groupByCategory(raw);
  const keysByCategory = new Map<string, Set<string>>();

  for (const [category, entries] of grouped) {
    if (!TOKEN_RE.test(category)) push(category, '분류 이름은 영소문자·숫자·밑줄이어야 한다');
    if (entries.length === 0) push(category, '항목이 없다');

    const keys = new Set<string>();
    const wordOwner = new Map<string, string>(); // 정규화한 말 → 소유 키

    for (const entry of entries) {
      const path = `${category}.${entry.key}`;

      if (!TOKEN_RE.test(entry.key)) {
        push(path, '키는 영소문자로 시작하는 영소문자·숫자·밑줄이어야 한다');
      }
      if (keys.has(entry.key)) {
        push(path, '같은 분류 안에서 키가 중복된다');
        continue;
      }
      keys.add(entry.key);

      if (typeof entry.ko !== 'string' || entry.ko.trim() === '') {
        push(`${path}.ko`, '한국어 이름이 필요하다');
      }

      const words = [entry.key, entry.ko, entry.en, ...(entry.aliases ?? [])];
      for (const word of words) {
        if (word === undefined) continue;
        if (typeof word !== 'string' || word.trim() === '') {
          push(path, '이름·별칭은 비어 있지 않은 문자열이어야 한다');
          continue;
        }
        const normalized = normalizeWord(word);
        const owner = wordOwner.get(normalized);
        if (owner !== undefined && owner !== entry.key) {
          push(path, `"${word}"가 ${owner}와 같은 말로 취급된다 (한 말은 한 항목만 가리켜야 한다)`);
        } else {
          wordOwner.set(normalized, entry.key);
        }
      }

      checkAttrs(category, entry, path, push);
    }
    keysByCategory.set(category, keys);
  }

  for (const [category, attr, target] of REFS) {
    const entries = grouped.get(category);
    if (entries === undefined) continue;
    const targetKeys = keysByCategory.get(target);
    for (const entry of entries) {
      const value = entry.attrs?.[attr];
      if (typeof value !== 'string') continue; // 형식 오류는 checkAttrs가 이미 보고함
      if (targetKeys === undefined) {
        push(`${category}.${entry.key}.attrs.${attr}`, `참조하는 분류 "${target}"가 없다`);
      } else if (!targetKeys.has(value)) {
        push(`${category}.${entry.key}.attrs.${attr}`, `"${value}"는 ${target} 분류에 없는 키다`);
      }
    }
  }

  checkOdorKnowledge(grouped, keysByCategory, push);
  // 가열로 되돌리는 시계: 가열 특징과 두 단계가 실제 사다리의 쓸 수 있는 칸이어야 한다
  const featureLevels = (feature: unknown): string[] | undefined => {
    const levels = grouped.get('feature')?.find((x) => x.key === feature)?.attrs?.['levels'];
    return Array.isArray(levels) ? levels.flatMap((l) => (typeof l === 'object' && l !== null && !Array.isArray(l) && l['locked'] !== true && typeof l['key'] === 'string' ? [l['key']] : [])) : undefined;
  };
  // 공감각 심상: 사전의 감각질 둘 이상, 서로 다른 감각에서. 몸의 반응: 사전의 심상에 붙는다
  const sensationSense = (k: string): unknown => grouped.get('sensation')?.find((x) => x.key === k)?.attrs?.['sense'];
  for (const e of grouped.get('image') ?? []) {
    const parts = e.attrs?.['parts'];
    if (!Array.isArray(parts) || parts.length < 2 || !parts.every((p) => typeof p === 'string')) {
      push(`image.${e.key}.attrs.parts`, '공감각 심상은 감각질 둘 이상(parts)이어야 한다');
      continue;
    }
    for (const p of parts) if (sensationSense(String(p)) === undefined) push(`image.${e.key}.attrs.parts`, `"${String(p)}"는 sensation 분류에 없는 키다`);
    if (new Set(parts.map((p) => String(sensationSense(String(p))))).size < 2) push(`image.${e.key}.attrs.parts`, '공감각 심상은 서로 다른 감각 둘 이상에서 와야 한다 (한 감각끼리는 섞임이 아니다)');
  }
  // 감정의 축: 내면 특징의 axis는 pleasure · displeasure · stability 중 하나이고 겹치지 않는다
  const axes = new Map<string, string>();
  for (const e of grouped.get('feature') ?? []) {
    const ax = e.attrs?.['axis'];
    if (ax === undefined) continue;
    if (e.attrs?.['inner'] !== true || !['pleasure', 'displeasure', 'stability'].includes(String(ax))) push(`feature.${e.key}.attrs.axis`, 'axis(감정의 축)는 내면 특징에만 있고 pleasure · displeasure · stability 중 하나여야 한다');
    else if (axes.has(String(ax))) push(`feature.${e.key}.attrs.axis`, `감정의 축 ${String(ax)}가 이미 ${axes.get(String(ax))}에 있다`);
    else axes.set(String(ax), e.key);
    // 안정은 감정이 아니라 생각으로 움직인다: by_thought { new, familiar, recalled, against: 칸 수 }
    const bt = e.attrs?.['by_thought'];
    if (ax === 'stability' && (typeof bt !== 'object' || bt === null || Array.isArray(bt) || !['new', 'familiar', 'recalled', 'against'].every((k) => isInt(bt[k]) && Math.abs(bt[k] as number) <= 2) || Object.keys(bt).length !== 4)) {
      push(`feature.${e.key}.attrs.by_thought`, '안정 축은 by_thought { new, familiar, recalled, against: 움직이는 칸 수(-2~2 정수) }가 필요하다 (예측할 수 있음은 생각이 정한다)');
    }
    if (ax !== 'stability' && bt !== undefined) push(`feature.${e.key}.attrs.by_thought`, 'by_thought는 안정 축에만 있다');
  }
  const axisFeatures = new Set([...axes].filter(([a]) => a !== 'stability').map(([, f]) => f));
  const ruled = new Set<string>();
  for (const e of grouped.get('emotion') ?? []) {
    const sh = e.attrs?.['shifts'];
    if (typeof sh === 'object' && sh !== null && !Array.isArray(sh)) for (const f of Object.keys(sh)) if (!axisFeatures.has(f)) push(`emotion.${e.key}.attrs.shifts`, `"${f}"는 감정이 움직이는 축(쾌·불쾌의 내면 특징)이 아니다 (안정은 생각이 움직인다)`);
    const th = e.attrs?.['thought'];
    if (th === undefined) continue;
    const k = `${String(e.attrs?.['tone'])}/${String(th)}`;
    if (ruled.has(k)) push(`emotion.${e.key}.attrs.thought`, `같은 심상(${String(e.attrs?.['tone'])})과 생각(${String(th)})에서 오는 감정이 둘이다 (하나여야 같은 상태에서 같은 감정이 난다)`);
    ruled.add(k);
  }
  for (const e of grouped.get('image') ?? []) {
    const tone = e.attrs?.['tone'];
    if (tone !== undefined && tone !== 'pleasant' && tone !== 'unpleasant') push(`image.${e.key}.attrs.tone`, 'tone은 pleasant나 unpleasant이거나 없어야 한다 (없으면 감정이 생기지 않는다)');
  }
  const images = new Set((grouped.get('image') ?? []).map((x) => x.key));
  for (const e of grouped.get('response') ?? []) {
    const on = e.attrs?.['on'];
    if (!Array.isArray(on) || on.length === 0) push(`response.${e.key}.attrs.on`, '몸의 반응은 붙는 심상(on) 목록이 필요하다');
    else for (const x of on) if (!images.has(String(x))) push(`response.${e.key}.attrs.on`, `"${String(x)}"는 image 분류에 없는 키다`);
  }
  // 메뉴에 필요한 숙련: 내면 특징의 쓸 수 있는 단계여야 한다
  for (const e of grouped.get('menu') ?? []) {
    const ns = e.attrs?.['needs_skill'];
    if (typeof ns !== 'object' || ns === null || Array.isArray(ns) || typeof ns['feature'] !== 'string' || typeof ns['at_least'] !== 'string') continue;
    const f = grouped.get('feature')?.find((x) => x.key === ns['feature']);
    if (f === undefined || f.attrs?.['inner'] !== true) push(`menu.${e.key}.attrs.needs_skill.feature`, `"${ns['feature']}"는 내면 특징(inner)이 아니다`);
    else if (!(featureLevels(ns['feature'])?.includes(ns['at_least']) ?? false)) push(`menu.${e.key}.attrs.needs_skill.at_least`, `"${ns['at_least']}"는 "${ns['feature']}"에서 쓸 수 있는 단계 키가 아니다`);
  }
  for (const e of grouped.get('feature') ?? []) {
    const r = e.attrs?.['heat_reset'];
    if (r === undefined) continue;
    const at = `feature.${e.key}.attrs.heat_reset`;
    if (typeof r !== 'object' || r === null || Array.isArray(r) || typeof r['feature'] !== 'string' || typeof r['from'] !== 'string' || typeof r['up_to'] !== 'string') {
      push(at, 'heat_reset은 { feature, from, up_to } 문자열 셋이어야 한다');
      continue;
    }
    if (!(featureLevels(r['feature'])?.includes(r['from']) ?? false)) push(`${at}.from`, `"${r['from']}"는 특징 "${r['feature']}"에서 쓸 수 있는 단계 키가 아니다 (없거나 잠겼다)`);
    if (!(featureLevels(e.key)?.includes(r['up_to']) ?? false)) push(`${at}.up_to`, `"${r['up_to']}"는 특징 "${e.key}"에서 쓸 수 있는 단계 키가 아니다 (없거나 잠겼다)`);
  }
  for (const e of grouped.get('resource') ?? []) {
    const sinks = e.attrs?.['sinks'];
    if (Array.isArray(sinks)) for (const x of sinks) if (!(keysByCategory.get('sink')?.has(String(x)) ?? false)) push(`resource.${e.key}.attrs.sinks`, `"${String(x)}"는 sink 분류에 없는 키다`);
  }
  return issues;
}

/** 냄새 지식의 목록 참조와 정합: 균주가 만드는 화합물, 원인의 균주·화합물, 원인의 단계 키, 냄새 종류의 순서 = 특징 사다리 칸 번호. */
function checkOdorKnowledge(grouped: ReadonlyMap<string, VocabEntryRaw[]>, keys: ReadonlyMap<string, Set<string>>, push: Push): void {
  const has = (category: string, key: unknown): boolean => typeof key === 'string' && (keys.get(category)?.has(key) ?? false);
  const levelsOf = (feature: unknown): readonly (string | null)[] | undefined => {
    const e = grouped.get('feature')?.find((x) => x.key === feature);
    const levels = e?.attrs?.['levels'];
    return Array.isArray(levels) ? levels.map((l) => levelKeyOf(l)) : undefined;
  };
  /** 특징의 단계 키이고 잠기지 않았는가 */
  const usable = (feature: unknown, level: string): boolean => {
    const levels = grouped.get('feature')?.find((x) => x.key === feature)?.attrs?.['levels'];
    return Array.isArray(levels) && levels.some((l) => levelKeyOf(l) === level && !(typeof l === 'object' && l !== null && !Array.isArray(l) && l['locked'] === true));
  };
  for (const e of grouped.get('strain') ?? []) {
    const produces = e.attrs?.['produces'];
    if (Array.isArray(produces)) for (const c of produces) if (!has('compound', c)) push(`strain.${e.key}.attrs.produces`, `"${String(c)}"는 compound 분류에 없는 키다`);
  }
  for (const e of grouped.get('odor_cause') ?? []) {
    const compounds = e.attrs?.['compounds'];
    if (Array.isArray(compounds)) for (const c of compounds) if (!has('compound', c)) push(`odor_cause.${e.key}.attrs.compounds`, `"${String(c)}"는 compound 분류에 없는 키다`);
    const stages = e.attrs?.['stages'];
    if (!Array.isArray(stages)) continue;
    const order = levelsOf(e.attrs?.['feature']);
    stages.forEach((s, i) => {
      if (typeof s !== 'object' || s === null || Array.isArray(s)) return;
      const at = `odor_cause.${e.key}.attrs.stages[${i}]`;
      if (order !== undefined && typeof s['at'] === 'string' && !order.includes(s['at'])) push(`${at}.at`, `"${s['at']}"는 특징 "${String(e.attrs?.['feature'])}"의 단계 키가 아니다`);
      if (typeof s['strength'] === 'string' && !usable(e.attrs?.['strength_feature'], s['strength'])) push(`${at}.strength`, `"${s['strength']}"는 특징 "${String(e.attrs?.['strength_feature'])}"에서 쓸 수 있는 단계 키가 아니다 (없거나 잠겼다)`);
      if (Array.isArray(s['strains'])) for (const x of s['strains']) if (!has('strain', x)) push(`${at}.strains`, `"${String(x)}"는 strain 분류에 없는 키다`);
    });
  }
  for (const e of grouped.get('odor_kind') ?? []) {
    const order = levelsOf(e.attrs?.['feature']);
    const rank = e.attrs?.['rank'];
    if (order !== undefined && typeof rank === 'number' && order[rank] !== e.key) push(`odor_kind.${e.key}.attrs.rank`, `rank ${rank}번 칸이 이 종류(${e.key})가 아니다 — 특징 "${String(e.attrs?.['feature'])}"의 사다리 순서와 같아야 한다 (칸 ${rank} = ${String(order[rank])})`);
  }
}

export interface LookupHit {
  readonly category: string;
  readonly key: string;
}

export class Vocab {
  readonly #entries = new Map<string, Map<string, VocabEntry>>();
  readonly #words = new Map<string, Map<string, string>>(); // 분류 → (정규화한 말 → 키)

  constructor(raw: readonly VocabCategoryRaw[]) {
    const issues = validateVocab(raw);
    if (issues.length > 0) throw new VocabError(issues);

    for (const [category, entries] of groupByCategory(raw)) {
      const byKey = new Map<string, VocabEntry>();
      const byWord = new Map<string, string>();
      for (const e of entries) {
        const entry: VocabEntry = Object.freeze({
          key: e.key,
          ko: e.ko,
          en: e.en ?? null,
          aliases: Object.freeze([...(e.aliases ?? [])]),
          desc: e.desc ?? '',
          attrs: Object.freeze({ ...(e.attrs ?? {}) }),
        });
        byKey.set(entry.key, entry);
        for (const word of [entry.key, entry.ko, entry.en, ...entry.aliases]) {
          if (word !== null) byWord.set(normalizeWord(word), entry.key);
        }
      }
      this.#entries.set(category, byKey);
      this.#words.set(category, byWord);
    }
  }

  /** 잠긴 칸인가 (사다리 칸의 키가 아니면 false). */
  isLocked(feature: string, key: string): boolean {
    const levels = this.entry('feature', feature)?.attrs['levels'];
    if (!Array.isArray(levels)) return false;
    return levels.some((l) => levelKeyOf(l) === key && typeof l === 'object' && l !== null && !Array.isArray(l) && l['locked'] === true);
  }

  /** 특징의 단계 키 순서 (사전 levels 의 목록 순서). 특징이 없으면 undefined. */
  levelOrder(feature: string): readonly string[] | undefined {
    const levels = this.entry('feature', feature)?.attrs['levels'];
    if (!Array.isArray(levels)) return undefined;
    const keys = levels.map((l) => levelKeyOf(l));
    return keys.every((k): k is string => k !== null) ? keys : undefined;
  }

  categories(): string[] {
    return [...this.#entries.keys()].sort();
  }

  keys(category: string): string[] {
    return [...(this.#entries.get(category)?.keys() ?? [])];
  }

  has(category: string, key: string): boolean {
    return this.#entries.get(category)?.has(key) ?? false;
  }

  entry(category: string, key: string): VocabEntry | undefined {
    return this.#entries.get(category)?.get(key);
  }

  /** 분류 안에서 이름·별칭·키 어느 것이든 공식 키로 바꾼다. 없으면 null. */
  resolve(category: string, word: string): string | null {
    return this.#words.get(category)?.get(normalizeWord(word)) ?? null;
  }

  /** 분류를 모를 때 모든 분류에서 찾는다. 둘 이상이면 뜻이 여러 개인 말이다. */
  lookup(word: string): LookupHit[] {
    const normalized = normalizeWord(word);
    const hits: LookupHit[] = [];
    for (const [category, words] of this.#words) {
      const key = words.get(normalized);
      if (key !== undefined) hits.push({ category, key });
    }
    return hits;
  }
}
