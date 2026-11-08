import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventLog } from '../src/core/log.ts';
import { Vocab, VocabError, normalizeWord, validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const VOCAB_DIR = fileURLToPath(new URL('../data/vocab', import.meta.url));

function messages(raw: VocabCategoryRaw[]): string {
  return validateVocab(raw)
    .map((i) => `${i.path}: ${i.message}`)
    .join('\n');
}

test('정규화: 대소문자·공백·하이픈·밑줄 차이를 없앤다', () => {
  assert.equal(normalizeWord('  Foot-Dust '), 'footdust');
  assert.equal(normalizeWord('foot_dust'), 'footdust');
  assert.equal(normalizeWord('환기·배수구'), '환기배수구');
});

test('같은 분류에서 한 말이 두 항목을 가리키면 오류', () => {
  const raw: VocabCategoryRaw[] = [
    {
      category: 'action',
      entries: [
        { key: 'wipe', ko: '닦기' },
        { key: 'clean', ko: '청소', aliases: ['닦 기'] },
      ],
    },
  ];
  assert.match(messages(raw), /같은 말로 취급/);
  assert.throws(() => new Vocab(raw), VocabError);
});

test('키 중복, 잘못된 키, 빈 이름은 오류', () => {
  assert.match(messages([{ category: 'a', entries: [{ key: 'x', ko: '하나' }, { key: 'x', ko: '둘' }] }]), /중복/);
  assert.match(messages([{ category: 'a', entries: [{ key: 'Bad Key', ko: '나쁨' }] }]), /키는 영소문자/);
  assert.match(messages([{ category: 'a', entries: [{ key: 'ok', ko: ' ' }] }]), /한국어 이름/);
  assert.match(messages([{ category: 'a', entries: [] }]), /항목이 없다/);
});

test('분류별 속성 검사: 단계 목록, 전달률, tuned', () => {
  assert.match(
    messages([{ category: 'feature', entries: [{ key: 'dirt', ko: '더러움', attrs: { levels: ['하나'] } }] }]),
    /단계 목록/,
  );
  assert.match(
    messages([{ category: 'contact', entries: [{ key: 'step', ko: '밟음', attrs: { transfer: 1500, tuned: false } }] }]),
    /0~1000/,
  );
  assert.match(
    messages([{ category: 'contact', entries: [{ key: 'step', ko: '밟음', attrs: { transfer: 300 } }] }]),
    /tuned/,
  );
});

test('분류 사이 참조 검사', () => {
  const raw: VocabCategoryRaw[] = [
    { category: 'medium', entries: [{ key: 'air', ko: '공기', attrs: { in_slice: true } }] },
    { category: 'sense', entries: [{ key: 'smell', ko: '후각' }] },
    {
      category: 'spreader',
      entries: [{ key: 'odor', ko: '냄새', attrs: { medium: 'water', stimulus: 'smell' } }],
    },
  ];
  assert.match(messages(raw), /"water"는 medium 분류에 없는 키/);
});

test('조회: 이름·별칭·키를 공식 키로 바꾼다', () => {
  const vocab = loadVocabDir(VOCAB_DIR);
  assert.equal(vocab.resolve('feature', '오염'), 'dirt');
  assert.equal(vocab.resolve('feature', 'Dirt'), 'dirt');
  assert.equal(vocab.resolve('feature', '더러움'), 'dirt');
  assert.equal(vocab.resolve('mobility', '가변'), 'portable');
  assert.equal(vocab.resolve('spreader', '발바닥 먼지'), 'grit');
  assert.equal(vocab.resolve('feature', '없는말'), null);
});

test('뜻이 여러 개인 말은 전역 조회에서 둘 이상으로 나온다', () => {
  const vocab = loadVocabDir(VOCAB_DIR);
  const hits = vocab.lookup('냄새');
  assert.deepEqual(hits.map((h) => h.category).sort(), ['feature', 'spreader']);
});

test('실제 사전 데이터가 검증을 통과한다', () => {
  const vocab = loadVocabDir(VOCAB_DIR);
  assert.ok(vocab.has('event_type', 'retract'));
  assert.ok(vocab.has('medium', 'air'));
  assert.equal(vocab.entry('contact', 'step')?.attrs['tuned'], false);
  assert.ok(vocab.categories().includes('mobility'));
});

test('기록은 사전의 사건 유형만 받는다', () => {
  const vocab = loadVocabDir(VOCAB_DIR);
  const log = new EventLog({ isKnownType: (t) => vocab.has('event_type', t) });
  assert.doesNotThrow(() => log.append({ t: 0, type: 'day_open', src: 'clock' }));
  assert.throws(() => log.append({ t: 0, type: 'unknown_event', src: 'clock' }), /사전에 없는/);
});

test('단계 사다리는 0~5 여섯 칸이고, 내구 배율은 정수 ×100 이다', () => {
  assert.match(
    messages([{ category: 'feature', entries: [{ key: 'dirt', ko: '더러움', attrs: { levels: [{ key: 'a', ko: '가' }, { key: 'b', ko: '나' }, { key: 'c', ko: '다' }, { key: 'd', ko: '라' }, { key: 'e', ko: '마' }] } }] }]),
    /정확히 6칸/,
  );
  assert.match(
    messages([{ category: 'durability', entries: [{ key: 'weak', ko: '취약', attrs: { mult100: 0.5 } }] }]),
    /내구 배율/,
  );
});

test('내면 특징(숙련): 감각이 없어야 하고, 쌓이는 표·시간 표·tuned를 검사하며, 메뉴의 필요 숙련은 내면 특징의 단계여야 한다', () => {
  const lad = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ key: k, ko: k }));
  const feature = (attrs: Record<string, unknown>): VocabCategoryRaw => ({ category: 'feature', entries: [{ key: 'knack', ko: '솜씨', attrs: { levels: lad, ...attrs } }, { key: 'look', ko: '모양', attrs: { sense: 'sight', levels: lad } }] });
  const sense: VocabCategoryRaw = { category: 'sense', entries: [{ key: 'sight', ko: '시각' }] };
  const ok = (attrs: Record<string, unknown>): string => messages([sense, feature(attrs)]);
  assert.equal(ok({ inner: true, practice: [0, 1, 2, 3, 4, 5], minutes_pct: [100, 90, 80, 70, 60, 50], tuned: false }), '');
  assert.match(ok({ inner: true, sense: 'sight', tuned: false }), /감각으로 느끼지 않는다/);
  assert.match(ok({ inner: true, practice: [0, 3, 2, 4, 5, 6], tuned: false }), /practice/);
  assert.match(ok({ inner: true, practice: [1, 2, 3, 4, 5, 6], tuned: false }), /practice/);
  assert.match(ok({ inner: true, minutes_pct: [100, 90, 95, 70, 60, 50], tuned: false }), /minutes_pct/);
  assert.match(ok({ inner: true }), /tuned/);
  assert.match(ok({}), /감각\(sense 키\)이 필요하다/, '내면이 아니면 감각이 있어야 한다');
  const menu = (ns: { [k: string]: string }): string => messages([sense, feature({ inner: true, tuned: false }), { category: 'menu', entries: [{ key: 'm', ko: '메뉴', attrs: { rank: 1, needs_skill: ns } }] }]);
  assert.equal(menu({ feature: 'knack', at_least: 'b' }), '');
  assert.match(menu({ feature: 'look', at_least: 'b' }), /내면 특징\(inner\)이 아니다/);
  assert.match(menu({ feature: 'knack', at_least: 'zz' }), /쓸 수 있는 단계 키가 아니다/);
  assert.match(menu({ feature: 'knack' }), /needs_skill은/);
});
