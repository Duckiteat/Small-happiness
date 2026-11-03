// 사전 (통제 어휘) — docs/사전-명세.md
//
// 게임이 쓰는 모든 단어에 공식 키를 하나씩 정하고, 한국어 이름·영어 이름·별칭을 그 키로 연결한다.
// 같은 분류 안에서 정규화한 말이 두 항목을 가리키면 오류다 ("이름 하나 = 개념 하나").

import type { JsonValue } from './events.ts';

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

/** 대소문자, 공백, 하이픈, 밑줄, 가운뎃점, 마침표, 쉼표 차이를 없앤다. */
export function normalizeWord(word: string): string {
  return word.normalize('NFC').toLowerCase().replace(/[\s\-_·.,]/g, '');
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
      const levels = attrs['levels'];
      if (!Array.isArray(levels) || levels.length < 2 || !levels.every((l) => typeof l === 'string' && l !== '')) {
        push(`${path}.attrs.levels`, '단계 이름 목록(2개 이상의 비어 있지 않은 문자열)이 필요하다');
      }
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

  return issues;
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
