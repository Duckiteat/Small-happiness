// 정의의 필드 (docs/데이터-형식.md): 새 필드를 더해도 부분 갱신이 다른 필드를 지우지 않고, 필드 목록은 한 곳에서 온다.
// (2026-11-07 점검: 갱신 병합이 필드를 이름으로 옮겨서 environment·passages·stays가 부분 갱신에 지워졌다)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedFields, buildDefinition, fieldsOf, parseFields } from '../src/core/db.ts';
import { sourceFields } from '../src/core/compile.ts';
import { DEF_PREFIXES } from '../src/core/ids.ts';
import type { DefPrefix } from '../src/core/ids.ts';
import { mergePatch, parsePatch } from '../src/core/patch.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const defs = Object.values(db.defs);

test('부분 갱신은 다른 필드를 지우지 않는다: 실제 정의 모두에서 설명만 갱신해도 나머지가 그대로다', () => {
  assert.ok(defs.some((d) => d.passages !== undefined) && defs.some((d) => d.stays !== undefined) && defs.some((d) => d.environment !== undefined), '장소의 통로·환경과 인물의 머무는 곳을 가진 정의가 있다');
  for (const def of defs) {
    const parsed = parsePatch({ format: 'small-happiness-patch', version: 1, why: '시험: 설명만 갱신', defs: [{ id: def.id, desc: [...def.desc, '추가한 설명'] }] });
    assert.ok(parsed.patch, def.id);
    const merged = mergePatch(db, parsed.patch, vocab).db.defs[def.id];
    assert.deepEqual(merged, { ...def, desc: [...def.desc, '추가한 설명'] }, `${def.id}(${def.names.ko}): 설명 말고 바뀐 필드가 있다`);
  }
});

test('필드는 한 곳에서 온다: 정의 → 필드 묶음 → 정의 왕복이 모든 정의에서 같고, 허용 필드를 파서가 모두 안다', () => {
  for (const def of defs) assert.deepEqual(buildDefinition(def.id, fieldsOf(def)), def, `${def.id}: 왕복에서 필드가 사라진다`);
  // 정의를 원본 모양으로 파서에 다시 넣어도 필드가 그대로 나온다 (허용만 하고 조용히 버리는 필드가 없다)
  for (const def of defs) {
    const prefix = def.id.slice(0, 3) as DefPrefix;
    assert.ok(DEF_PREFIXES.includes(prefix));
    const issues: string[] = [];
    const parsed = parseFields({ ...fieldsOf(def), id: def.id }, prefix, def.id, (w, m) => issues.push(`${w}: ${m}`));
    assert.deepEqual(issues, [], def.id);
    assert.deepEqual(Object.keys(parsed).sort(), [...Object.keys(def)].sort(), `${def.id}: 파서가 버리는 필드가 있다`);
  }
});

test('원본 컴파일러가 받는 필드는 정의 형식의 목록과 같다 (물건만 펼치기용 override를 더 받는다)', () => {
  assert.deepEqual([...sourceFields('objects')].sort(), [...allowedFields('OBJ'), 'override'].sort());
  assert.deepEqual([...sourceFields('places')].sort(), [...allowedFields('PLC')].sort());
  assert.deepEqual([...sourceFields('characters')].sort(), [...allowedFields('CHR')].sort());
  assert.ok(sourceFields('places').includes('passages') && sourceFields('characters').includes('stays'));
});
