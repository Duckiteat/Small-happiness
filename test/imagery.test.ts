// ② 공감각 심상과 ⓑ 해석 전 행동 (docs/내면-설계.md 9장): 서로 다른 감각 둘 이상이 함께 느껴지면 심상이 생기고, 몸이 먼저 반응한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import type { GameEvent } from '../src/core/events.ts';
import { imageDefs, momentary, responsesTo, sustained } from '../src/core/imagery.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const db = loadDb(ROOT);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sc = parseScenario(JSON.parse(readFileSync(join(ROOT, 'content', 'scenarios', 'kitchen-stew.json'), 'utf8')));
const events: GameEvent[] = runScenario(db, vocab, sc).log.map(parseEvent);
const images = events.filter((e) => e.type === 'image_formed');
const responses = events.filter((e) => e.type === 'body_response');

test('사전: 심상은 서로 다른 감각 둘 이상의 감각질이고, 몸의 반응은 심상에 붙는다', () => {
  for (const img of imageDefs(vocab)) {
    const senses = new Set(img.parts.map((p) => String(vocab.entry('sensation', p)?.attrs['sense'])));
    assert.ok(img.parts.length >= 2 && senses.size >= 2, img.key);
  }
  assert.deepEqual(responsesTo(vocab, 'cold_sour'), ['goosebumps', 'shiver']);
  assert.deepEqual(responsesTo(vocab, 'warm_savory'), ['face_relaxes', 'shoulders_drop']);
  const warm = imageDefs(vocab).find((x) => x.key === 'warm_savory');
  assert.ok(warm !== undefined);
  assert.equal(sustained(warm, new Set(['steaming', 'savory_scent'])), true);
  assert.equal(sustained(warm, new Set(['steaming'])), false);
  const cold = imageDefs(vocab).find((x) => x.key === 'cold_sour');
  assert.ok(cold !== undefined);
  assert.equal(momentary(cold, new Set(['sour_scent']), new Set(['cold_feel'])), true, '차가운 것을 만지는 순간 신향이 나고 있으면');
  assert.equal(momentary(cold, new Set(['sour_scent', 'cold_feel']), new Set()), false, '이 순간의 감각이 없으면 그 순간의 심상이 아니다');
});

test('이어지는 심상: 육수가 끓으면 따뜻한 구수함·끓어오르는 김이 생기고, 김이 그치면 깨진다', () => {
  const on = (k: string): number[] => images.filter((e) => e.data['image'] === k && e.data['on'] === true && e.data['moment'] !== true).map((e) => e.t);
  const off = (k: string): number[] => images.filter((e) => e.data['image'] === k && e.data['on'] === false).map((e) => e.t);
  assert.ok(on('warm_savory').length >= 1 && off('warm_savory').length >= 1 && (off('warm_savory')[0] as number) > (on('warm_savory')[0] as number));
  assert.ok(on('boiling_steam').length >= 1);
  // 원인은 그것을 갖춘 감각(멀리서 느끼기 시작한 것)
  const first = images.find((e) => e.data['image'] === 'warm_savory' && e.data['on'] === true);
  const c = events.find((x) => x.seq === first?.cause);
  assert.equal(c?.type, 'stimulus_perceived');
  assert.ok(['steaming', 'savory_scent'].includes(str(c?.data['sensation'])));
});

test('그 순간의 심상과 몸의 반응: 찌개를 먹으면 깊은 구수함에 표정이 풀리고, 김치 냄새 속에 찬 두부를 넣으면 몸이 떨리고 닭살이 돋는다', () => {
  const moment = (k: string): GameEvent[] => images.filter((e) => e.data['image'] === k && e.data['moment'] === true);
  assert.ok(moment('deep_savory').length >= 1);
  assert.ok(moment('cold_sour').length >= 1);
  const after = (img: GameEvent): string[] => responses.filter((r) => r.cause === img.seq).map((r) => str(r.data['response']));
  assert.deepEqual(after(moment('cold_sour')[0] as GameEvent), ['goosebumps', 'shiver']);
  assert.deepEqual(after(moment('deep_savory')[0] as GameEvent), ['face_relaxes', 'shoulders_drop']);
  // 몸의 반응은 심상이 생길 때만 (깨질 때는 없다), 같은 시각
  for (const r of responses) {
    const img = events.find((x) => x.seq === r.cause);
    assert.equal(img?.type, 'image_formed');
    assert.equal(img?.data['on'], true);
    assert.equal(img?.t, r.t);
  }
});

test('감사: 심상과 몸의 반응을 그때 느끼던 것으로 다시 맞춰, 빠지거나 지어낸 것을 잡는다', () => {
  const opts = { externalUntil: sc.start };
  assert.deepEqual(auditLog(events, db, vocab, opts).findings, []);
  const warmOn = images.find((e) => e.data['image'] === 'warm_savory' && e.data['on'] === true)?.seq;
  const warmOff = images.find((e) => e.data['image'] === 'warm_savory' && e.data['on'] === false)?.seq;
  const coldOne = images.find((e) => e.data['image'] === 'cold_sour')?.seq;
  const shiver = responses.find((e) => e.data['response'] === 'shiver')?.seq;
  const cases: { name: string; mutate: (es: GameEvent[]) => GameEvent[] }[] = [
    { name: '따뜻한 구수함이 생긴 기록을 지움', mutate: (es) => es.filter((e) => e.seq !== warmOn && !(e.type === 'body_response' && e.cause === warmOn)) },
    { name: '따뜻한 구수함이 깨진 기록을 지움', mutate: (es) => es.filter((e) => e.seq !== warmOff) },
    { name: '차가운 신향을 따뜻한 단향으로 고침', mutate: (es) => es.map((e) => (e.seq === coldOne ? { ...e, data: { ...e.data, image: 'warm_sweet' } } : e)) },
    { name: '몸이 떨린 반응을 지움', mutate: (es) => es.filter((e) => e.seq !== shiver) },
    { name: '몸이 떨린 반응을 다른 반응으로 고침', mutate: (es) => es.map((e) => (e.seq === shiver ? { ...e, data: { ...e.data, response: 'lean_in' } } : e)) },
  ];
  for (const c of cases) {
    const r = auditLog(c.mutate(structuredClone(events)), db, vocab, opts);
    assert.ok(r.findings.some((f) => f.check === 'awareness'), `${c.name}: 잡아야 한다 (잡은 것: ${r.findings.map((f) => f.check).join(', ') || '없음'})`);
  }
});
