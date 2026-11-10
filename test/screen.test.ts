// 화면에 보낼 뷰 모델 (src/core/screen.ts, 구현-계획 N1-1): 엔진의 기록에서 화면 계약의 뷰를 계산한다
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEvent } from '../src/core/events.ts';
import { CORE_NODE, screenView } from '../src/core/screen.ts';
import { lineParts, renderLine } from '../src/core/script.ts';
import { Session } from '../src/core/session.ts';
import { parseScenario } from '../src/core/skeleton.ts';
import type { Scenario } from '../src/core/skeleton.ts';
import { parseView } from '../src/core/viewmodel.ts';
import type { View } from '../src/core/viewmodel.ts';
import { scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const SC_DIR = join(ROOT, 'content', 'scenarios');
const FILES = readdirSync(SC_DIR).filter((f) => f.endsWith('.json')).sort();
const WHO = 'CHR000001#1';
const load = (f: string): { sc: Scenario; db: ReturnType<typeof scenarioDb> } => {
  const sc = parseScenario(JSON.parse(readFileSync(join(SC_DIR, f), 'utf8')) as Record<string, unknown>);
  return { sc, db: scenarioDb(ROOT, vocab, sc) };
};

/** 엔진이 깨어나는 단계마다 뷰를 모은다 (바뀐 것만). */
function viewsByStep(f: string): { t: number; view: View | null }[] {
  const { sc, db } = load(f);
  const s = Session.start(db, vocab, sc);
  const out: { t: number; view: View | null }[] = [];
  let last = '';
  for (let next = s.view().next; next !== null; next = s.view().next) {
    s.advance(next);
    const v = s.screen(WHO);
    const j = JSON.stringify(v);
    if (j !== last) out.push({ t: next, view: v });
    last = j;
  }
  return out;
}

const RUN = new Map(FILES.map((f) => [f, viewsByStep(f)]));
const firstWeek = RUN.get('first-week.json') ?? [];

test('모든 시나리오의 모든 단계에서 뷰가 화면 계약을 지킨다 (어기면 screenView가 던진다)', () => {
  assert.ok(FILES.length >= 6);
  let shown = 0;
  for (const [f, views] of RUN) {
    for (const { t, view } of views) {
      if (view === null) continue;
      shown++;
      assert.deepEqual(parseView(JSON.parse(JSON.stringify(view))).problems, [], `${f} ${t}`);
      // 앵커마다 핵심 노드로 선 하나, 번호는 나온 순서대로
      assert.deepEqual(view.anchors.map((a) => a.id), view.anchors.map((_a, i) => `a${i + 1}`), `${f} ${t}`);
      if (view.nodes.length > 0) assert.deepEqual(view.edges, view.anchors.map((a) => ({ from: a.id, to: CORE_NODE, kind: 'link' })), `${f} ${t}`);
    }
  }
  assert.ok(shown >= 10, `보여 준 뷰가 너무 적다 (${shown})`);
});

test('같은 기록이면 같은 뷰: 한 번에 돌린 하루와 나눠 돌린 하루의 마지막 뷰가 바이트까지 같다', () => {
  const { sc, db } = load('first-week.json');
  const whole = Session.start(db, vocab, sc);
  whole.advance(sc.end);
  const split = Session.start(db, vocab, sc);
  for (let t = sc.start; t < sc.end; t += 211) split.advance(t);
  split.advance(sc.end);
  assert.equal(JSON.stringify(split.screen(WHO)), JSON.stringify(whole.screen(WHO)));
  assert.equal(JSON.stringify(screenView(db, vocab, whole.trace().log.map(parseEvent), WHO)), JSON.stringify(whole.screen(WHO)));
});

test('첫 주: 열림 → 닫힘 → 다시 열림, 사다리가 정체에 이르면 노드 이름이 그 물건이 되고 닫히면 완료', () => {
  const statuses = firstWeek.flatMap((x) => (x.view === null ? [] : [x.view.event.status]));
  assert.equal(statuses[0], 'open');
  assert.ok(statuses.includes('closed'));
  assert.ok(statuses.includes('reopened'));
  const end = firstWeek.at(-1)?.view;
  assert.ok(end);
  assert.equal(end.event.status, 'closed');
  const core = end.nodes.find((n) => n.id === CORE_NODE);
  assert.ok(core);
  assert.equal(core.rung, 'thing');
  assert.equal(core.state, 'done');
  const { db } = load('first-week.json');
  const names = Object.values(db.defs).filter((d) => d.id.startsWith('OBJ')).map((d) => d.names.ko);
  assert.ok(names.includes(core.label), `정체 칸의 이름은 물건 정의의 이름이다 (${core.label})`);
  // 줄글은 열린 뒤 고른 장면의 문장이 쌓인다
  assert.ok(end.prose.length >= 2);
});

test('짐작 칸의 이름은 떠올린 개념 둘, 저마다 "?"가 붙는다', () => {
  const guess = firstWeek.find((x) => x.view?.nodes[0]?.rung === 'guess')?.view?.nodes[0];
  assert.ok(guess);
  assert.match(guess.label, /^\S+\? \S+\?$/);
});

test('이벤트가 열린 적 없으면 null (보여 줄 장면이 없다)', () => {
  const { sc, db } = load('kitchen-outage.json');
  const s = Session.start(db, vocab, sc);
  assert.equal(s.screen(WHO), null);
  s.advance(sc.end);
  assert.equal(s.screen(WHO), null);
  assert.equal(s.screen('CHR999999#1'), null);
});

test('문장 줄 조각: 앵커와 글이 차례대로 나오고, 이어 붙이면 보이는 글과 같다', () => {
  const line = '현관을 열자 {꼬릿한 냄새?|킁킁}가 훅 {끼쳤다|탐색|라벨}.';
  const parts = lineParts(line);
  assert.deepEqual(parts, [
    { text: '현관을 열자 ' },
    { text: '꼬릿한 냄새?', verb: '킁킁' },
    { text: '가 훅 ' },
    { text: '끼쳤다', verb: '탐색', label: '라벨' },
    { text: '.' },
  ]);
  assert.equal(parts.map((p) => p.text).join(''), renderLine(line));
  assert.deepEqual(lineParts('{앵커만|탐색}'), [{ text: '앵커만', verb: '탐색' }]);
  assert.deepEqual(lineParts('앵커 없음'), [{ text: '앵커 없음' }]);
});
