// 냄새의 원인 사슬 (docs/냄새-모델.md): 원인 → 균주 → 유기화합물 → 냄새 종류. 지식(사전)이 규칙을 만들고, 규칙이 세계의 냄새 종류를 바꾼다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEvent } from '../src/core/events.ts';
import { odorChain, odorRules, describeStage } from '../src/core/odor.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { viaResolver } from '../src/core/via-resolve.ts';
import { validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = join(ROOT, 'data', 'vocab');
const vocab = loadVocabDir(dir);
const db = loadDb(ROOT);
const WEEK = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'first-week.json'), 'utf8')));
const rawVocab = (): VocabCategoryRaw[] => readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as VocabCategoryRaw[]);

test('사전: 냄새 지식의 참조가 틀리면 거부한다 (화합물의 냄새, 균주의 화합물, 원인의 단계·균주, 종류의 순서, 확인 여부)', () => {
  assert.deepEqual(validateVocab(rawVocab()), []);
  const cases: readonly { name: string; change: (raw: VocabCategoryRaw[]) => void; message: RegExp }[] = [
    { name: '화합물의 냄새 종류가 없다', change: (r) => void (entry(r, 'compound', 'indole').attrs = { odor: 'perfume', verified: false }), message: /"perfume"는 odor_kind 분류에 없는 키다/ },
    { name: '균주가 만드는 화합물이 없다', change: (r) => void (entry(r, 'strain', 'pseudomonas').attrs = { produces: ['unobtainium'], verified: false }), message: /"unobtainium"는 compound 분류에 없는 키다/ },
    { name: '원인의 단계가 특징의 단계가 아니다', change: (r) => void (entry(r, 'odor_cause', 'mold').attrs = { feature: 'mold', stages: [{ at: 'bloom', strains: ['mold_fungi'] }], verified: false }), message: /"bloom"는 특징 "mold"의 단계 키가 아니다/ },
    { name: '원인의 균주가 없다', change: (r) => void (entry(r, 'odor_cause', 'mold').attrs = { feature: 'mold', stages: [{ at: 'spread', strains: ['yeti'] }], verified: false }), message: /"yeti"는 strain 분류에 없는 키다/ },
    { name: '종류의 순서가 사다리와 다르다', change: (r) => void (entry(r, 'odor_kind', 'musty').attrs = { rank: 4, feature: 'odor' }), message: /rank 4번 칸이 이 종류\(musty\)가 아니다/ },
    { name: '서지 확인 여부를 적지 않았다', change: (r) => void (entry(r, 'compound', 'geosmin').attrs = { odor: 'musty' }), message: /verified.*true\/false/ },
    { name: '원인에 단계도 화합물도 없다', change: (r) => void (entry(r, 'odor_cause', 'cooking').attrs = { verified: false }), message: /단계.*화합물.*하나는 있어야/ },
  ];
  for (const c of cases) {
    const raw = structuredClone(rawVocab());
    c.change(raw);
    assert.match(validateVocab(raw).map((i) => `${i.path}: ${i.message}`).join('\n'), c.message, c.name);
  }
});

const entry = (raw: VocabCategoryRaw[], category: string, key: string): { attrs?: { [k: string]: unknown } } => {
  const e = raw.filter((c) => c.category === category).flatMap((c) => c.entries).find((x) => x.key === key);
  assert.ok(e, `${category}.${key}`);
  return e as { attrs?: { [k: string]: unknown } };
};

test('사슬: 단계마다 균주 → 화합물 → 냄새가 계산되고 가장 심각한 종류가 대표다 (요리는 균주 없이 화합물이 바로)', () => {
  const chain = odorChain(vocab);
  const dominant = (cause: string, at: string | null) => chain.find((s) => s.cause === cause && s.at === at)?.dominant;
  assert.deepEqual(
    [['decay', 'turned'], ['decay', 'spoiled'], ['decay', 'rotten'], ['sour', 'sour'], ['sour', 'lumpy'], ['ripen', 'soured'], ['ripen', 'mushy'], ['wilt', 'shriveled'], ['mold', 'spread'], ['cooking', null]].map(([c, a]) => dominant(c as string, a as string | null)),
    ['sour', 'putrid', 'putrid', 'sour', 'sulfur', 'sour', 'sulfur', 'putrid', 'musty', 'savory'],
  );
  const spoiled = chain.find((s) => s.cause === 'decay' && s.at === 'spoiled');
  assert.deepEqual(spoiled?.strains, ['pseudomonas', 'enterobacteria']);
  assert.deepEqual(spoiled?.kinds, ['putrid', 'sulfur']);
  assert.equal(describeStage(vocab, spoiled as NonNullable<typeof spoiled>), '부패 · 상함: 슈도모나스 · 장내세균과 → 디메틸 이황화물 · 메탄티올 · 황화수소 · 푸트레신 · 카다베린 · 인돌 → 썩는 냄새 (황 냄새도 섞임)');
  const cooking = chain.find((s) => s.cause === 'cooking');
  assert.deepEqual([cooking?.feature, cooking?.strains, cooking?.compounds], [null, [], ['pyrazine', 'diallyl_disulfide']]);
  // 사슬의 끝은 모두 특징 사다리의 칸이다
  for (const s of chain) assert.ok(vocab.levelOrder(s.kindFeature)?.includes(s.dominant), `${s.cause}: ${s.dominant}`);
});

test('규칙: 원인 특징과 종류 특징을 둘 다 가진 정의마다 단계별 규칙이 만들어지고, 근거(via)로 찾을 수 있다', () => {
  const rules = odorRules(db, vocab);
  assert.equal(rules.length, 28, '부패 3단계 × 4 + 시어짐 2 × 2 + 익음 2 × 1 + 시듦 1 × 3 + 곰팡이 1 × 7');
  assert.ok(rules.every((r) => r.delayMin === 0 && r.owner === r.def && r.onAll.length === 0));
  assert.equal(rules.some((r) => r.def === 'OBJ000001' || r.def.startsWith('PLC')), false, '종류(음식)와 장소에는 만들지 않는다');
  const chicken = rules.find((r) => r.def === 'OBJ000010' && r.key === 'odor_decay_spoiled');
  assert.deepEqual([chicken?.on[0]?.feature, chicken?.on[0]?.cond, chicken?.emits[0]?.feature, chicken?.emits[0]?.cond], ['decay', { op: '>=', level: 'spoiled' }, 'odor', { op: '>=', level: 'putrid' }]);
  assert.notEqual(viaResolver(db, vocab).resolve('OBJ000010/rule/odor_decay_spoiled'), null);
});

test('세계: 치킨이 쉬면 시큼한 냄새, 상하면 썩는 냄새가 되고 주방으로 이어져 하루씨가 종류까지 알아챈다. 버리면 사라진다', () => {
  const events = runScenario(db, vocab, WEEK).log.map(parseEvent);
  const odor = (key: string) => events.filter((e) => e.type === 'state_changed' && e.data['key'] === key).map((e) => [e.data['from'], e.data['to']]);
  assert.deepEqual(odor('OBJ000010#1|body:odor'), [['none', 'sour'], ['sour', 'putrid'], ['putrid', 'gone']]);
  // 주방: 요리 냄새(구수함) 두 번, 그다음 치킨이 상한 뒤의 썩는 냄새. 냄새가 퍼진 뒤에야 종류가 생기고, 냄새가 가시면 종류도 사라진다
  assert.deepEqual(odor('PLC000002#1|space:odor'), [['none', 'savory'], ['savory', 'none'], ['none', 'savory'], ['savory', 'none'], ['none', 'putrid'], ['putrid', 'none']]);
  const sour = events.find((e) => e.type === 'state_changed' && e.data['key'] === 'OBJ000010#1|body:odor' && e.data['to'] === 'sour');
  assert.equal(events.find((e) => e.seq === sour?.cause)?.data['via'], 'OBJ000010/rule/odor_decay_turned', '원인은 부패의 쉼 단계 규칙');
  const noticed = events.filter((e) => e.type.startsWith('awareness') && e.data['key'] === 'PLC000002#1|space:odor' && e.data['via'] === 'CHR000001/sense/smell').map((e) => e.data['level']);
  assert.ok(noticed.includes('putrid'), '하루씨는 주방 냄새의 종류까지 알아챈다');
  // 종류가 여럿 섞이면 가장 심각한 것이 이긴다
  const mixed = runScenario(db, vocab, parseScenario({
    why: '시험: 섞인 냄새', use_db: true, seed: 1, start: 420, end: 480, routine: {},
    spawn: ['PLC000002', 'OBJ000002', 'OBJ000003'],
    set: [{ t: 420, key: 'PLC000002#1|space:smell', level: 'faint' }, { t: 420, key: 'OBJ000002#1|body:odor', level: 'sour' }, { t: 420, key: 'OBJ000003#1|body:odor', level: 'sulfur' }],
  }));
  const kitchen = mixed.steps.at(-1)?.values['world.state'] as Record<string, string>;
  assert.equal(kitchen['PLC000002#1|space:odor'], 'sulfur');
});
