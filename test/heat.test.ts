// 가열로 시계가 다시 시작된다 (docs/온도-읽기.md): 아직 상하지 않은 음식을 가열하면 부패의 시계가 처음부터 다시 시작하고,
// 이미 상한 음식은 되살아나지 않는다. 가열한 음식이 식는 것도 확인한다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import { heatResetRules, heatResets } from '../src/core/heat.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const CHICKEN = 'OBJ000010#1';

const base = {
  why: '시험: 가열과 부패의 시계', use_db: true, seed: 1, start: 420, end: 420 + 12 * 1440,
  routine: { blocks: [{ kind: 'meal', from: 420, to: 480 }] },
  spawn: ['CHR000001', 'PLC000002', 'OBJ000010'], set: [] as unknown[], layout: [] as string[], contain: [] as unknown[],
};
const run = (extra: Record<string, unknown>) => {
  const sc = parseScenario({ ...base, ...extra });
  return { sc, events: runScenario(db, vocab, sc).log.map(parseEvent) };
};
const at = (events: ReturnType<typeof run>['events'], key: string, to: string, after = -1) => events.find((e) => e.type === 'state_changed' && e.data['key'] === key && e.data['to'] === to && e.t >= after);
const decay = `${CHICKEN}|body:decay`;
const heat = `${CHICKEN}|cond:heat`;

test('가열 되돌림 규칙은 데이터(사전 heat_reset)에서 만들어지고, 두 특징을 가진 정의마다 하나다', () => {
  assert.deepEqual(heatResets(vocab), [{ axis: 'decay', heat: 'heat', from: 'hot', upTo: 'turned' }]);
  const rules = heatResetRules(db, vocab);
  assert.ok(rules.length >= 5, '부패 축을 가진 음식마다');
  assert.ok(rules.every((r) => r.key === 'heat_reset_decay' && r.def === r.owner && r.delayMin === 0));
  assert.equal(rules.some((r) => r.def === 'OBJ000001'), false, '종류(음식)에는 만들지 않는다 (부패 축이 없다)');
});

test('상하기 전(turned)의 음식을 뜨겁게 가열하면 부패가 처음으로 돌아가고 시계가 다시 시작한다', () => {
  const control = run({ set: [{ t: 420, key: decay, level: 'turned' }] });
  const heated = run({ set: [{ t: 420, key: decay, level: 'turned' }, { t: 420, key: heat, level: 'hot' }] });
  const spoiledControl = at(control.events, decay, 'spoiled');
  const spoiledHeated = at(heated.events, decay, 'spoiled');
  assert.ok(spoiledControl, '가열하지 않으면 며칠 뒤 상한다');
  const reset = at(heated.events, decay, 'fresh');
  assert.ok(reset, '가열하면 처음(신선)으로 돌아온다');
  assert.ok(reset.cause !== null, '규칙이 원인이다');
  assert.ok(spoiledHeated === undefined || spoiledHeated.t > spoiledControl.t + 1440, '시계가 다시 시작해서 상하는 때가 하루 넘게 미뤄진다');
  assert.deepEqual(auditLog(heated.events, db, vocab, { externalUntil: heated.sc.start }).findings, []);
});

test('이미 상한 음식(spoiled)은 가열해도 되살아나지 않는다', () => {
  const r = run({ set: [{ t: 420, key: decay, level: 'spoiled' }, { t: 420, key: heat, level: 'boil' }] });
  assert.equal(at(r.events, decay, 'fresh'), undefined);
  assert.equal(at(r.events, decay, 'turned'), undefined);
});

test('덜 가열하면(따뜻함) 되돌리지 않는다', () => {
  const r = run({ set: [{ t: 420, key: decay, level: 'turned' }, { t: 420, key: heat, level: 'warm' }] });
  assert.equal(at(r.events, decay, 'fresh'), undefined);
});

test('전자레인지로 데우면 같은 일이 일어난다 (행동 → 가열 → 시계 재시작), 상한 치킨은 데우지 않는다', () => {
  const layout = ['PLC000002#1^OBJ000016#1'];
  const ok = run({ spawn: [...base.spawn, 'OBJ000016'], layout, set: [{ t: 420, key: decay, level: 'turned' }] });
  assert.ok(ok.events.some((e) => e.type === 'action_chosen' && e.data['verb'] === 'reheat'));
  assert.ok(at(ok.events, heat, 'hot') && at(ok.events, decay, 'fresh'));
  // 상한 줄 모르고 데워도(하루씨는 보지 못했다) 되살아나지 않는다
  const bad = run({ spawn: [...base.spawn, 'OBJ000016'], layout, set: [{ t: 420, key: decay, level: 'spoiled' }] });
  assert.ok(at(bad.events, heat, 'hot'), '모르고 데운다');
  assert.equal(at(bad.events, decay, 'fresh'), undefined, '상한 음식은 되살아나지 않는다');
});

test('가열한 음식은 식는다: 뜨거움 → 따뜻함 → 없음 (30분씩)', () => {
  const r = run({ set: [{ t: 420, key: heat, level: 'hot' }] });
  const warm = at(r.events, heat, 'warm');
  const none = at(r.events, heat, 'none');
  assert.ok(warm && none);
  assert.equal(none.t - warm.t, 30);
});

test('사전: heat_reset의 단계는 쓸 수 있는 칸이어야 한다', () => {
  const levels = (keys: string[]): { [k: string]: string | boolean }[] => keys.map((k, i): { [k: string]: string | boolean } => (k.startsWith('s') ? { key: k, locked: true } : { key: k, ko: `${i}` }));
  type Reset = { readonly [key: string]: string };
  const raw = (reset: Reset): VocabCategoryRaw[] => [{ category: 'feature', entries: [
    { key: 'heat', ko: '가열', attrs: { sense: 'touch', levels: levels(['none', 'hot', 's2', 's3', 's4', 's5']) } },
    { key: 'decay', ko: '부패', attrs: { sense: 'smell', levels: levels(['fresh', 'turned', 's2', 's3', 's4', 's5']), heat_reset: reset } },
  ] }, { category: 'sense', entries: [{ key: 'touch', ko: '촉각' }, { key: 'smell', ko: '후각' }] }];
  const msgs = (reset: Reset) => validateVocab(raw(reset)).map((i) => `${i.path}: ${i.message}`).join('\n');
  assert.equal(msgs({ feature: 'heat', from: 'hot', up_to: 'turned' }).includes('heat_reset'), false);
  assert.match(msgs({ feature: 'heat', from: 'boil', up_to: 'turned' }), /"boil"는 특징 "heat"에서 쓸 수 있는 단계 키가 아니다/);
  assert.match(msgs({ feature: 'heat', from: 'hot', up_to: 's2' }), /up_to/);
  assert.match(msgs({ feature: 'heat' }), /heat_reset은/);
});
