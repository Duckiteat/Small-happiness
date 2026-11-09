// 컨디션과 모드 (S6 · condition.ts): 여유·에너지·긴장, 방전·터짐·몰아침·평온, 가라앉는 길(잠·쉼·방출)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionClass } from '../src/core/agency.ts';
import { auditLog } from '../src/core/audit.ts';
import { afterDone, emotionCondition, modeOf, releaseChanges, wakeChanges } from '../src/core/condition.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent, JsonValue } from '../src/core/events.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { Vocab, validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { loadDb, scenarioRun } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOCAB_DIR = join(ROOT, 'data', 'vocab');
const vocab = loadVocabDir(VOCAB_DIR);
const db = loadDb(ROOT);
const WHO = 'CHR000001#1';
const DEF = 'CHR000001';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type Entry = { key: string; ko: string; desc?: string; aliases?: string[]; attrs?: { [k: string]: JsonValue } };
type Category = { category: string; entries: Entry[] };
const rawVocab = (): Category[] => readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(readFileSync(join(VOCAB_DIR, f), 'utf8')) as Category[]);
const asRaw = (raw: Category[]): VocabCategoryRaw[] => raw;

/** 하루씨의 상태 (주지 않은 것은 처음 값). */
const state = (s: Record<string, string>): ((key: string) => string) => {
  const base: Record<string, string> = { 'mood:pleasure': 'none', 'mood:displeasure': 'none', 'mood:stability': 'steady', 'condition:reserve': 'usual', 'condition:energy': 'full', 'condition:tension': 'none', 'skill:cooking': 'novice', 'skill:handling': 'novice', 'skill:judging': 'novice' };
  return (key) => s[key.slice(key.indexOf('|') + 1)] ?? base[key.slice(key.indexOf('|') + 1)] ?? '';
};
const has = (): boolean => true;
const show = (cs: readonly { key: string; to: string }[]): string[] => cs.map((c) => `${c.key.slice(c.key.indexOf('|') + 1)}=${c.to}`);

const evening = (): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'home-evening.json'), 'utf8')) as Record<string, unknown>;
const run = (r: Record<string, unknown>, v: Vocab = vocab): { events: GameEvent[]; start: number } => {
  const sc = parseScenario(r);
  return { events: runScenario(db, v, sc).log.map(parseEvent), start: sc.start };
};
const withSet = (sets: { key: string; level: string }[]): Record<string, unknown> => {
  const r = evening();
  r['set'] = [...(r['set'] as unknown[]), ...sets.map((x) => ({ t: 0, key: `${WHO}|${x.key}`, level: x.level }))];
  return r;
};
const of = (es: readonly GameEvent[], type: string): GameEvent[] => es.filter((e) => e.type === type);

test('감정이 컨디션을 움직인다: 좋은 감정은 여유를 채우고, 싫은 감정은 여유로 버티거나 긴장으로 쌓인다 (빠듯하면·안심되지 않으면 더)', () => {
  assert.deepEqual(show(emotionCondition(vocab, WHO, 'pleasant', false, has, state({}))), ['condition:reserve=ample']);
  assert.deepEqual(show(emotionCondition(vocab, WHO, 'unpleasant', false, has, state({ 'condition:reserve': 'ample' }))), ['condition:reserve=usual'], '버팀: 긴장 대신 여유가 덜어진다');
  assert.deepEqual(show(emotionCondition(vocab, WHO, 'unpleasant', false, has, state({}))), ['condition:tension=slight']);
  assert.deepEqual(show(emotionCondition(vocab, WHO, 'unpleasant', false, has, state({ 'condition:reserve': 'tight' }))), ['condition:tension=built'], '취약: 한 칸 더');
  assert.deepEqual(show(emotionCondition(vocab, WHO, 'unpleasant', true, has, state({ 'condition:reserve': 'tight' }))), ['condition:tension=high'], '안심되지 않으면 또 한 칸');
  assert.deepEqual(emotionCondition(vocab, WHO, 'unpleasant', false, () => false, state({})), [], '컨디션 부위가 없는 인물은 움직이지 않는다');
});

test('행동 끝: 쉼이 아닌 행동은 활동한 분을 모아 두 시간마다 에너지 한 칸, 쉼이 끝나면 에너지가 차고 불쾌·긴장이 가라앉는다', () => {
  const work = afterDone(db, vocab, WHO, DEF, false, 150, 0, state({}));
  assert.deepEqual(show(work.changes), ['condition:energy=usual']);
  assert.equal(work.carry, 30, '남은 30분은 다음으로 넘어간다');
  assert.deepEqual(show(afterDone(db, vocab, WHO, DEF, false, 100, 30, state({})).changes), ['condition:energy=usual'], '넘어온 분과 합쳐 두 시간');
  assert.deepEqual(show(afterDone(db, vocab, WHO, DEF, false, 20, 0, state({})).changes), []);
  const rest = afterDone(db, vocab, WHO, DEF, true, 30, 40, state({ 'condition:energy': 'low', 'mood:displeasure': 'clear', 'condition:tension': 'built' }));
  assert.deepEqual(show(rest.changes), ['condition:energy=little', 'condition:tension=slight', 'mood:displeasure=mild']);
  assert.equal(rest.carry, 40, '쉼은 활동한 분을 쌓지 않는다');
});

test('잠에서 깸: 에너지는 충분으로, 쾌·불쾌·여유·긴장은 기준 쪽으로 한 칸. 안정은 그대로', () => {
  const s = state({ 'condition:energy': 'low', 'mood:displeasure': 'strong', 'mood:pleasure': 'faint', 'condition:reserve': 'tight', 'condition:tension': 'high', 'mood:stability': 'uneasy' });
  assert.deepEqual(show(wakeChanges(db, vocab, WHO, DEF, s)), ['condition:energy=full', 'condition:reserve=usual', 'condition:tension=built', 'mood:displeasure=clear', 'mood:pleasure=none']);
  assert.deepEqual(show(wakeChanges(db, vocab, WHO, DEF, state({ 'condition:reserve': 'abundant' }))), ['condition:reserve=relaxed'], '넉넉한 쪽도 보통 쪽으로');
});

test('방출: 긴장이 크게(세 칸) 줄고 불쾌 한 칸, 에너지 한 칸을 쓴다', () => {
  assert.deepEqual(show(releaseChanges(db, vocab, WHO, DEF, state({ 'condition:tension': 'bursting', 'mood:displeasure': 'strong' }))), ['condition:energy=usual', 'condition:tension=slight', 'mood:displeasure=clear']);
});

test('모드: 판정 순서대로 — 방전(에너지 바닥, 또는 긴장이 높은데 에너지가 부족) > 터짐(긴장이 터질 듯, 또는 불쾌 큼·안정 불안정, 에너지가 남음) > 몰아침(긴장 조금 이상·에너지 충분·남은 집안일이 많음) > 평온', () => {
  const m = (s: Record<string, string>, unfinished = 0): string | undefined => modeOf(vocab, WHO, unfinished, has, state(s))?.mode.key;
  assert.equal(m({}), 'steady');
  assert.equal(m({ 'condition:energy': 'empty' }), 'drained');
  assert.equal(m({ 'condition:energy': 'empty', 'condition:tension': 'limit' }), 'drained', '에너지가 없으면 터지지도 못한다');
  assert.equal(m({ 'condition:energy': 'low', 'condition:tension': 'high' }), 'drained');
  assert.equal(m({ 'condition:energy': 'usual', 'condition:tension': 'bursting' }), 'release');
  assert.equal(m({ 'mood:displeasure': 'strong', 'mood:stability': 'uneasy', 'condition:energy': 'little' }), 'release', '생각이 멈춘 상태도 에너지가 남으면 터진다');
  assert.equal(m({ 'mood:displeasure': 'strong', 'mood:stability': 'uneasy', 'condition:energy': 'low' }), 'steady');
  assert.equal(m({ 'condition:tension': 'slight' }, 2), 'surge');
  assert.equal(m({ 'condition:tension': 'slight' }, 1), 'steady', '남은 집안일이 하나면 몰아치지 않는다');
  assert.equal(m({ 'condition:tension': 'slight', 'condition:energy': 'usual' }, 3), 'steady', '에너지가 충분해야');
  assert.equal(modeOf(vocab, WHO, 0, () => false, state({ 'condition:energy': 'empty' }))?.mode.key, 'steady', '조건의 특징이 없는 인물은 기본 모드뿐이다');
});

test('방전: 에너지가 바닥이면 쉼만 고르고, 요정이 바닥 닦기를 권해도 선택지가 아니라 듣지 않는다', () => {
  const r = withSet([{ key: 'condition:energy', level: 'empty' }]);
  r['advice'] = [{ t: 1140, offer: 'PLC000002/offer/wipe_floor', at: 'PLC000002#1' }]; // 방전 중에 닿는 조언
  const out = run(r);
  assert.equal(of(out.events, 'mode_changed')[0]?.data['mode'], 'drained');
  const verbs = of(out.events, 'action_chosen').map((e) => str(e.data['verb']));
  const first = verbs.findIndex((v) => actionClass(vocab, v) !== 'pastime');
  assert.ok(verbs.length > 0);
  const recovered = of(out.events, 'mode_changed').find((e) => e.data['mode'] !== 'drained');
  // 쉬어서 에너지가 오르면 방전에서 벗어난다. 그 전까지는 쉼만
  const beforeRecovery = of(out.events, 'action_chosen').filter((e) => recovered === undefined || e.t < recovered.t).map((e) => str(e.data['verb']));
  assert.ok(beforeRecovery.length > 0 && beforeRecovery.every((v) => actionClass(vocab, v) === 'pastime'), beforeRecovery.join(','));
  assert.ok(recovered !== undefined, '쉬면 에너지가 차서 방전에서 벗어난다');
  assert.ok(first === -1 || of(out.events, 'action_chosen')[first]!.t >= recovered.t);
  const ignored = of(out.events, 'advice_ignored')[0];
  assert.equal(ignored?.data['reason'], 'not_option', '방전에는 집안일이 선택지에 없다');
  assert.ok(ignored !== undefined && recovered !== undefined && ignored.t < recovered.t, '방전 중에 닿았다');
  assert.deepEqual(auditLog(out.events, db, vocab, { externalUntil: out.start }).findings, []);
});

test('터짐: 긴장이 터질 듯하면 집에 들어온 첫 단계에 몸이 먼저 방출하고(원인: 터짐으로 바뀐 모드), 긴장이 크게 줄어 평온으로 돌아온다', () => {
  const out = run(withSet([{ key: 'condition:tension', level: 'bursting' }]));
  const modes = of(out.events, 'mode_changed').map((e) => str(e.data['mode']));
  assert.deepEqual(modes.slice(0, 2), ['release', 'steady']);
  const released = of(out.events, 'released')[0];
  assert.ok(released !== undefined);
  assert.equal(out.events.find((e) => e.seq === released.cause)?.data['mode'], 'release');
  const after = out.events.filter((e) => e.type === 'state_changed' && e.cause === released.seq).map((e) => `${str(e.data['key']).split('|')[1]}=${str(e.data['to'])}`);
  assert.deepEqual(after, ['condition:energy=usual', 'condition:tension=slight']);
  assert.ok(of(out.events, 'action_chosen').every((e) => e.t >= released.t), '방출은 행동을 고르기 전 (해석 전, 요정이 닿지 않는다)');
  assert.deepEqual(auditLog(out.events, db, vocab, { externalUntil: out.start }).findings, []);
});

test('몰아침: 긴장이 조금 있고 에너지가 충분한데 남은 집안일이 있으면, 집안일을 먼저 세 배로 오래 한다 (시험용 사전: 남은 집안일 하나부터)', () => {
  const raw = rawVocab();
  for (const c of raw) for (const e of c.entries) if (c.category === 'mode' && e.key === 'surge' && e.attrs !== undefined) e.attrs['unfinished_at_least'] = 1;
  const v = new Vocab(asRaw(raw));
  const r = withSet([{ key: 'condition:tension', level: 'slight' }]);
  r['advice'] = [];
  const out = run(r, v);
  const surge = of(out.events, 'mode_changed').find((e) => e.data['mode'] === 'surge');
  assert.ok(surge !== undefined, '더러운 바닥을 알아채면 몰아친다');
  const wipe = of(out.events, 'action_chosen').find((e) => e.data['verb'] === 'wipe');
  assert.ok(wipe !== undefined && wipe.t >= surge.t, '쉴 거리가 있어도 집안일을 먼저');
  assert.equal(Number(wipe.data['ends']) - wipe.t, 45, '15분 닦기를 45분');
  assert.deepEqual(auditLog(out.events, db, v, { externalUntil: out.start }).findings, []);
  // 평소(사전 그대로)에는 남은 집안일이 하나뿐이라 몰아치지 않고 쉰다
  const calm = run(r);
  assert.equal(of(calm.events, 'mode_changed').some((e) => e.data['mode'] === 'surge'), false);
  assert.equal(of(calm.events, 'action_chosen').some((e) => e.data['verb'] === 'wipe'), false);
});

test('잠: 된장찌개 시나리오에서 자고 나면 원인 없이 깨고(원천), 저녁 요리로 쓴 에너지가 충분으로 돌아온다', () => {
  const tr = scenarioRun(ROOT, vocab, 'content/scenarios/kitchen-stew.json');
  const es = tr.log.map(parseEvent);
  const woke = of(es, 'woke');
  assert.ok(woke.length > 0 && woke.every((e) => e.cause === null));
  const energy = es.filter((e) => e.type === 'state_changed' && str(e.data['key']).endsWith('|condition:energy'));
  const drained = energy.filter((e) => es.find((x) => x.seq === e.cause)?.type === 'action_done');
  assert.ok(drained.length > 0, '요리·설거지 같은 활동이 에너지를 쓴다');
  const lastWoke = woke.at(-1);
  assert.ok(lastWoke !== undefined);
  const restored = es.filter((e) => e.type === 'state_changed' && e.cause === lastWoke.seq && str(e.data['key']).endsWith('|condition:energy'));
  assert.ok(restored.every((e) => e.data['to'] === 'full'));
});

test('감사: 모드·방출·잠에서 깸·행동 끝의 컨디션을 다시 계산해, 고치거나 빠뜨리면 잡는다', () => {
  const out = run(withSet([{ key: 'condition:tension', level: 'bursting' }]));
  const opts = { externalUntil: out.start };
  const es = out.events;
  assert.deepEqual(auditLog(es, db, vocab, opts).findings, []);
  const released = of(es, 'released')[0];
  const mode = of(es, 'mode_changed')[0];
  const restDone = es.find((e) => e.type === 'action_done' && actionClass(vocab, str(e.data['verb'])) === 'pastime');
  assert.ok(released !== undefined && mode !== undefined && restDone !== undefined);
  const cases: { name: string; mutate: (x: GameEvent[]) => GameEvent[] }[] = [
    { name: '모드를 평온으로 고침', mutate: (x) => x.map((e) => (e.seq === mode.seq ? { ...e, data: { ...e.data, mode: 'steady' } } : e)) },
    { name: '방출을 지움 (그 변화도)', mutate: (x) => x.filter((e) => e.seq !== released.seq && e.cause !== released.seq) },
    { name: '쉼 끝의 컨디션 변화를 지움', mutate: (x) => x.filter((e) => !(e.type === 'state_changed' && e.cause === restDone.seq && str(e.data['key']).includes('|condition:'))) },
    { name: '원인 없는 방출을 지어냄', mutate: (x) => [...x, { ...released, seq: 'L999999', t: x.at(-1)?.t ?? 0, cause: null }] },
  ];
  for (const c of cases) assert.ok(auditLog(c.mutate(structuredClone(es)), db, vocab, opts).findings.length > 0, c.name);
});

test('사전: 컨디션 특징·모드·잠의 형식을 검사한다', () => {
  const edit = (fn: (raw: Category[]) => void): string => {
    const raw = rawVocab();
    fn(raw);
    return validateVocab(asRaw(raw)).map((i) => `${i.path}: ${i.message}`).join('\n');
  };
  const mode = (raw: Category[], key: string): { [k: string]: JsonValue } => {
    for (const c of raw) for (const e of c.entries) if (c.category === 'mode' && e.key === key && e.attrs !== undefined) return e.attrs;
    throw new Error(key);
  };
  const feature = (raw: Category[], key: string): { [k: string]: JsonValue } => {
    for (const c of raw) for (const e of c.entries) if (c.category === 'feature' && e.key === key && e.attrs !== undefined) return e.attrs;
    throw new Error(key);
  };
  assert.equal(edit(() => undefined), '');
  assert.match(edit((r) => void (mode(r, 'surge')['rank'] = 1)), /판정 순서 1가 겹친다/);
  assert.match(edit((r) => void delete mode(r, 'drained')['when_any']), /기본 모드.*하나여야/);
  assert.match(edit((r) => void (mode(r, 'drained')['when_any'] = [['condition:energy@<=nowhere']])), /인물 안의 조건/);
  assert.match(edit((r) => void (mode(r, 'drained')['when_any'] = [['condition:smell@<=none']])), /인물 안의 조건/);
  assert.match(edit((r) => void delete mode(r, 'surge')['first']), /minutes_pct는 first와 함께/);
  assert.match(edit((r) => void (mode(r, 'release')['allows'] = ['pastime'])), /방출하는 모드는/);
  assert.match(edit((r) => void (mode(r, 'drained')['allows'] = ['nap'])), /allows는/);
  assert.match(edit((r) => void (feature(r, 'tension')['condition'] = 'energy')), /이미 energy에 있다/);
  assert.match(edit((r) => void (feature(r, 'energy')['sleep_to'] = 'tired')), /sleep_to는 이 특징의/);
  assert.match(edit((r) => void (feature(r, 'tension')['on_release'] = 0)), /0이 아닌/);
  assert.match(edit((r) => void (feature(r, 'odor')['condition'] = 'energy')), /condition은 내면 특징에만/);
  assert.match(
    edit((r) => {
      for (const c of r) for (const e of c.entries) if (c.category === 'presence' && e.key === 'home' && e.attrs !== undefined) e.attrs['sleeps'] = true;
    }),
    /자는 시간은 플레이어가 보지 않는 시간/,
  );
});
