// 사전 파일 읽기 (코어 밖의 입출력 어댑터)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vocab } from '../core/vocab.ts';
import type { VocabCategoryRaw } from '../core/vocab.ts';

/** 폴더의 *.json을 이름순으로 읽어 하나의 사전으로 합친다. 같은 분류는 항목이 합쳐진다. */
export function loadVocabDir(dir: string): Vocab {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const all: VocabCategoryRaw[] = [];
  for (const name of files) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (!Array.isArray(parsed)) throw new TypeError(`${name}: 분류 배열이어야 한다`);
    all.push(...(parsed as VocabCategoryRaw[]));
  }
  return new Vocab(all);
}
