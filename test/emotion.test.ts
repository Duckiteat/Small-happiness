// ③ 감정 (docs/내면-설계.md 10장): 심상 + 생각(무엇에서 · 며칠 가는 기억 · 감정이 붙은 기억) → 감정. 쾌·불쾌·안정 세 축과 스트레스 임계.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import type { MindDef } from '../src/core/db.ts';
import { appraise, cueOf, emotionDefs, isOverwhelmed, isUnfinished, moodKey, remembered } from '../src/core/emotion.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const byName = (ko: string): string => Object.values(db.defs).find((d) => d.names.ko === ko)?.id ?? `없음:${ko}`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-stew.json'), 'utf8')));
const events: GameEvent[] = runScenario(db, vocab, sc).log.map(parseEvent);
const emotions = events.filter((e) => e.type === 'emotion_formed');
const WHO = 'CHR000001#1';
const mind: MindDef = { thought_days: { min: 3, max: 5 }, binds_at: 3, tense_at: 1, overwhelm: { displeasure_at_least: 4, stability_at_most: 1 }, tuned: false };
/** 축의 칸: 쾌·불쾌·안정 */
const mood = (p: string, d: string, s: string) => (key: string): string => (key.endsWith(':pleasure') ? p : key.endsWith(':displeasure') ? d : key.endsWith(':stability') ? s : '');

test('사전: 결과 생각마다 감정이 하나, 그리움은 기억에서만 온다. 하루씨는 생각과 감정의 문턱을 갖는다', () => {
  const ruled = emotionDefs(vocab).filter((d) => d.thought !== undefined).map((d) => `${d.tone}/${d.thought}`);
  assert.equal(new Set(ruled).size, ruled.length);
  assert.equal(emotionDefs(vocab).find((d) => d.key === 'longing')?.thought, undefined);
  assert.ok(db.defs[byName('하루씨')]?.mind !== undefined);
});

test('무엇에서 왔는지: 가장 가까이 느낀 것 하나 (입 > 손 > 보임), 장소의 공기만이면 모른다', () => {
  const def = (i: string): string => i.split('#')[0] ?? '';
  assert.deepEqual(cueOf([{ source: 'OBJ000031#1', reach: 'distance' }, { source: 'OBJ000034#1', reach: 'mouth' }], def), ['OBJ000034']);
  assert.deepEqual(cueOf([{ source: 'OBJ000003#1', reach: 'contact' }, { source: 'OBJ000011#1', reach: 'distance' }], def), ['OBJ000003']);
  assert.deepEqual(cueOf([{ source: 'PLC000002#1', reach: 'distance' }, { source: undefined, reach: 'distance' }], def), []);
});

test('생각: 처음이면 설렘(안정이 내려감), 며칠 안에 겪어 봤으면 포근함(안정이 오름), 생각을 잊으면 다시 처음', () => {
  const at = mood('none', 'none', 'steady');
  const first = appraise(vocab, mind, WHO, 'warm_savory', ['OBJ000031'], 1000, [], new Map(), at);
  assert.equal(first?.emotion, 'flutter');
  assert.deepEqual(first?.changes, [{ key: moodKey(WHO, 'pleasure'), to: 'faint' }, { key: moodKey(WHO, 'stability'), to: 'wary' }]);
  const eps = [{ image: 'warm_savory', of: ['OBJ000031'], t: 1000 }];
  const again = appraise(vocab, mind, WHO, 'warm_savory', ['OBJ000031'], 1000 + 2 * 1440, eps, new Map(), at);
  assert.equal(again?.emotion, 'comfort');
  assert.equal(again?.thought, 'familiar');
  assert.ok(again?.changes.some((c) => c.key.endsWith(':stability') && c.to === 'settled'));
  assert.equal(remembered(mind, eps, 1000 + 4 * 1440).length, 0, '3일이 지나면 잊는다');
  assert.equal(appraise(vocab, mind, WHO, 'warm_savory', ['OBJ000031'], 1000 + 4 * 1440, eps, new Map(), at)?.thought, 'new');
  assert.equal(appraise(vocab, mind, WHO, 'warm_savory', [], 1000 + 2 * 1440, eps, new Map(), at)?.thought, 'new', '무엇인지 모르면 겪어 본 일과 이어지지 않는다');
});

test('기억: 쾌·불쾌가 문턱을 넘으면 감정과 이어져 잊지 않고, 기억대로면 그 감정, 결이 다르면 덧씌운다. 긴장하면 불쾌가 더 오른다', () => {
  const strong = appraise(vocab, mind, WHO, 'deep_savory', ['OBJ000034'], 0, [], new Map(), mood('mild', 'none', 'steady'));
  assert.deepEqual(strong?.memories, [{ of: 'OBJ000034', emotion: 'flutter' }], '쾌가 뚜렷함(3칸)에 닿으면');
  assert.deepEqual(appraise(vocab, mind, WHO, 'deep_savory', ['OBJ000034'], 0, [], new Map(), mood('none', 'none', 'steady'))?.memories, [], '약하면 생각으로만 남는다');
  const longing = new Map([['OBJ000034', 'longing']]);
  const recall = appraise(vocab, mind, WHO, 'deep_savory', ['OBJ000034'], 9 * 1440, [], longing, mood('none', 'none', 'steady'));
  assert.equal(recall?.emotion, 'longing', '며칠이 지나도 감정이 붙은 기억은 남는다');
  assert.equal(recall?.thought, 'recalled');
  const sour = appraise(vocab, mind, WHO, 'sharp_sour', ['OBJ000034'], 0, [], longing, mood('none', 'none', 'steady'));
  assert.equal(sour?.emotion, 'disappointment');
  assert.deepEqual(sour?.memories, [{ of: 'OBJ000034', emotion: 'disappointment', replaces: 'longing' }]);
  const calm = appraise(vocab, mind, WHO, 'cold_sour', [], 0, [], new Map(), mood('none', 'none', 'steady'));
  const tense = appraise(vocab, mind, WHO, 'cold_sour', [], 0, [], new Map(), mood('none', 'none', 'uneasy'));
  assert.deepEqual([calm, tense].map((a) => a?.changes.find((c) => c.key.endsWith(':displeasure'))?.to), ['faint', 'mild'], '안심되지 않을수록 더 크게');
});

test('스트레스 임계: 불쾌가 높고 안정이 낮으면 생각이 멈추고, 몸이 방출하기 전까지는 심상과 몸의 반응만 오고 감정이 생기지 않는다', () => {
  assert.equal(isOverwhelmed(vocab, mind, WHO, mood('none', 'strong', 'uneasy')), true);
  assert.equal(isOverwhelmed(vocab, mind, WHO, mood('none', 'strong', 'wary')), false);
  assert.equal(appraise(vocab, mind, WHO, 'cold_sour', [], 0, [], new Map(), mood('none', 'clear', 'uneasy'))?.overwhelms, true);
  const over = events.find((e) => e.type === 'overwhelmed');
  assert.ok(over !== undefined, '둘째 날 김치찌개의 톡 쏘는 신맛이 냄비의 좋은 기억과 어긋나 생각이 멈춘다');
  // 생각이 멈춘 동안 (몸이 먼저 방출할 때까지, condition.ts): 감정이 생기지 않는다
  const later = events.slice(events.indexOf(over) + 1);
  const released = later.find((e) => e.type === 'released');
  assert.ok(released !== undefined, '에너지가 남아 있어 몸이 먼저 방출한다 (터짐)');
  assert.equal(later.slice(0, later.indexOf(released)).filter((e) => e.type === 'emotion_formed').length, 0);
  assert.equal(events.find((e) => e.seq === released.cause)?.data['mode'], 'release', '방출의 원인은 터짐으로 바뀐 모드');
});

test('된장찌개 시나리오: 지난 기억(그리움)이 둘째 날 남은 찌개를 먹을 때 되살아나고, 안정은 처음엔 내려가다 겪어 본 일에서 오른다', () => {
  const given = events.find((e) => e.type === 'memory_formed' && e.data['given'] === true);
  assert.equal(given?.data['emotion'], 'longing');
  const longing = emotions.find((e) => e.data['emotion'] === 'longing');
  assert.ok(longing !== undefined && longing.t > 1440 && str(longing.data['image']) === 'deep_savory');
  assert.deepEqual(longing.data['of'], [byName('된장찌개')]);
  assert.deepEqual(emotions.filter((e) => e.t < 1440).map((e) => e.data['thought']), ['new', 'new', 'new']);
  assert.ok(emotions.some((e) => e.t > 1440 && e.data['thought'] === 'recalled'));
  // 감정의 원인은 그 심상, 축의 변화의 원인은 그 감정
  for (const em of emotions) assert.equal(events.find((x) => x.seq === em.cause)?.type, 'image_formed');
  // (컨디션 이후: 잠에서 깸·몸의 방출도 축을 가라앉힌다 — condition.ts)
  for (const c of events.filter((e) => e.type === 'state_changed' && str(e.data['key']).includes('|mood:') && e.t > 0)) assert.ok(['emotion_formed', 'woke', 'released'].includes(events.find((x) => x.seq === c.cause)?.type ?? ''), str(c.data['key']));
  assert.ok(events.some((e) => e.type === 'state_changed' && str(e.data['key']).includes('|mood:') && events.find((x) => x.seq === e.cause)?.type === 'emotion_formed'));
});

test('감사: 감정·기억·생각이 멈춤·축의 변화를 그때의 생각으로 다시 계산해, 빠지거나 지어낸 것을 잡는다', () => {
  const opts = { externalUntil: sc.start };
  assert.deepEqual(auditLog(events, db, vocab, opts).findings, []);
  const longing = emotions.find((e) => e.data['emotion'] === 'longing')?.seq;
  const bound = events.find((e) => e.type === 'memory_formed' && e.data['given'] !== true)?.seq;
  const given = events.find((e) => e.type === 'memory_formed' && e.data['given'] === true)?.seq;
  const over = events.find((e) => e.type === 'overwhelmed')?.seq;
  const moodChange = events.find((e) => e.type === 'state_changed' && str(e.data['key']).endsWith('|mood:pleasure') && e.cause !== null)?.seq;
  const lastImage = events.filter((e) => e.type === 'image_formed' && e.data['on'] === true).at(-1);
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[]; check: string }[] = [
    { name: '그리움을 설렘으로 고침', mutate: (es) => es.map((e) => (e.seq === longing ? { ...e, data: { ...e.data, emotion: 'flutter' } } : e)), check: 'awareness' },
    { name: '그리움을 지움', mutate: (es) => es.filter((e) => e.seq !== longing && e.cause !== longing), check: 'awareness' },
    { name: '감정과 이어진 기억을 지움', mutate: (es) => es.filter((e) => e.seq !== bound), check: 'awareness' },
    { name: '지난 기억(그리움)을 지움 — 그 뒤 감정이 달라진다', mutate: (es) => es.filter((e) => e.seq !== given), check: 'awareness' },
    { name: '생각이 멈춤을 지움', mutate: (es) => es.filter((e) => e.seq !== over), check: 'awareness' },
    { name: '쾌의 변화를 다른 칸으로 고침', mutate: (es) => es.map((e) => (e.seq === moodChange ? { ...e, data: { ...e.data, to: 'full' } } : e)), check: 'effects' },
    {
      name: '생각이 멈춘 뒤 감정을 지어냄',
      mutate: (es) => {
        const i = es.findIndex((e) => e.seq === lastImage?.seq);
        const fake: GameEvent = { ...(lastImage as GameEvent), seq: 'E999999', type: 'emotion_formed', cause: lastImage?.seq ?? null, data: { who: WHO, emotion: 'comfort', image: str(lastImage?.data['image']), thought: 'familiar', of: [] } };
        return [...es.slice(0, i + 1), fake, ...es.slice(i + 1)];
      },
      check: 'awareness',
    },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(events)), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === c.check), `${c.name}: ${c.check}를 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});

test('미완: 치울 일이 남은 줄 아는 것의 생각은 더 오래 가고(5일), 다른 일로 생각하는 순간 하루 한 번 갑자기 떠오른다', () => {
  const POT = byName('냄비');
  const pot = `${POT}#1`;
  const knows = (dirt: string, soup: string) => (k: string): string | undefined => (k === `${pot}|body:dirt` ? dirt : k === `${pot}|pot:soup` ? soup : undefined);
  assert.equal(isUnfinished(db, vocab, POT, [pot], knows('dirty', 'none')), true, '먹고 비운 냄비가 더러운 줄 알면 설거지가 남았다');
  assert.equal(isUnfinished(db, vocab, POT, [pot], knows('clean', 'none')), false, '씻었으면 끝난 일');
  assert.equal(isUnfinished(db, vocab, POT, [pot], knows('dirty', 'stew')), false, '아직 국물이 있으면 설거지할 때가 아니다');
  assert.equal(isUnfinished(db, vocab, POT, [pot], () => undefined), false, '모르면 남은 일도 없다');
  const ep = [{ image: 'boiling_steam', of: [POT], t: 0 }];
  const left = (d: string): boolean => d === POT;
  assert.equal(remembered(mind, ep, 4 * 1440, left).length, 1, '미완이면 4일째에도 기억한다');
  assert.equal(remembered(mind, ep, 4 * 1440).length, 0, '끝난 일은 3일');
  assert.equal(remembered(mind, ep, 6 * 1440, left).length, 0, '미완도 5일이 지나면 잊는다');
  const at = mood('none', 'none', 'steady');
  const ctx = (surfacedAt: Map<string, number>) => ({ unfinished: left, surfacedAt });
  const now = 2 * 1440;
  assert.deepEqual(appraise(vocab, mind, WHO, 'deep_savory', [byName('된장찌개')], now, ep, new Map(), at, ctx(new Map()))?.surfaces, { of: POT, image: 'boiling_steam' }, '찌개를 먹다가 설거지 안 한 냄비가 떠오른다');
  assert.equal(appraise(vocab, mind, WHO, 'deep_savory', [byName('된장찌개')], now, ep, new Map(), at, ctx(new Map([[POT, now - 60]])))?.surfaces, undefined, '같은 것은 하루에 한 번');
  assert.equal(appraise(vocab, mind, WHO, 'boiling_steam', [POT], now, ep, new Map(), at, ctx(new Map()))?.surfaces, undefined, '지금 그것을 겪는 중이면 떠오르는 것이 아니다');
  assert.equal(appraise(vocab, mind, WHO, 'cold_sour', [], now, ep, new Map(), mood('none', 'clear', 'uneasy'), ctx(new Map()))?.surfaces, undefined, '생각이 멈추는 순간에는 떠오르지 않는다');
  // 시나리오의 하루씨는 먹고 바로 설거지해서 남은 일이 없다 → 떠오르는 것도 없다
  assert.equal(events.filter((e) => e.type === 'thought_surfaced').length, 0);
  // 감사: 남은 일이 없는데 떠오른 것을 지어내면 잡는다
  const em = emotions[0] as GameEvent;
  const i = events.indexOf(em);
  const fake: GameEvent = { ...em, seq: 'E999998', type: 'thought_surfaced', cause: em.seq, data: { who: WHO, of: POT, image: 'boiling_steam' } };
  const r = auditLog([...events.slice(0, i + 1), fake, ...events.slice(i + 1)], db, vocab, { externalUntil: sc.start });
  assert.ok(r.findings.some((f) => f.check === 'awareness'), r.findings.map((f) => f.message).join(' / '));
});
