import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_VISIBLE_NODES, diffView, parseView } from '../src/core/viewmodel.ts';
import type { View } from '../src/core/viewmodel.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'examples', 'view', 'fridge-smell');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

interface Mut {
  version: number;
  scene: string;
  place: string;
  event: { id: string | null; status: string };
  prose: unknown[];
  anchors: { id: string; circle: string }[];
  nodes: { id: string; label: string; kind: string; rung?: string; ring: string; state: string; hint?: string }[];
  edges: { from: string; to: string; kind: string }[];
}

const raw = (name: string): Mut => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

function view(name: string): View {
  const r = parseView(raw(name));
  assert.deepEqual(r.problems, [], name);
  assert.ok(r.view, name);
  return r.view;
}

const visibleCount = (v: View): number => v.nodes.filter((n) => n.state !== 'faded').length;

test('장면 픽스처: 여섯 상태가 모두 계약을 지킨다', () => {
  assert.deepEqual(FILES, ['01-arrive.json', '02-circle.json', '03-guess.json', '04-thing.json', '05-closed.json', '06-cold.json']);
  for (const f of FILES) view(f);
});

test('노드 상한: 어느 상태도 5개를 넘지 않고, 04는 정확히 5개를 쓴다', () => {
  for (const f of FILES) assert.ok(visibleCount(view(f)) <= MAX_VISIBLE_NODES, f);
  assert.equal(visibleCount(view('04-thing.json')), MAX_VISIBLE_NODES);
});

test('심상 사다리: 같은 지각 노드의 칸은 feel → guess → thing으로만 올라간다', () => {
  const order = { feel: 0, guess: 1, thing: 2 } as const;
  const rungs = ['02-circle.json', '03-guess.json', '04-thing.json', '05-closed.json'].map((f) => {
    const s1 = view(f).nodes.find((n) => n.id === 's1');
    assert.ok(s1 && s1.rung, f);
    return s1.rung;
  });
  assert.deepEqual(rungs, ['feel', 'guess', 'thing', 'thing']);
  for (let i = 1; i < rungs.length; i++) {
    assert.ok(order[rungs[i] as keyof typeof order] >= order[rungs[i - 1] as keyof typeof order]);
  }
});

test('열린 호 → 닫힌 원: 이벤트가 닫힐 때만 동그라미가 닫힌다', () => {
  const circles = (f: string): string[] => view(f).anchors.map((a) => a.circle);
  assert.deepEqual(circles('01-arrive.json'), ['none']);
  assert.deepEqual(circles('02-circle.json'), ['open']);
  assert.deepEqual(circles('04-thing.json'), ['open', 'open', 'none']);
  assert.deepEqual(circles('05-closed.json'), ['closed', 'closed', 'closed']);
  assert.equal(view('05-closed.json').event.status, 'closed');
  for (const f of ['01-arrive.json', '02-circle.json', '03-guess.json', '04-thing.json']) {
    assert.equal(view(f).event.status, 'open', f);
  }
});

test('감기: 앵커가 없고 못 뜬 생각이 이유와 함께 점선 노드로 나온다', () => {
  const v = view('06-cold.json');
  assert.equal(v.event.status, 'none');
  assert.deepEqual(v.anchors, []);
  const ghost = v.nodes.find((n) => n.kind === 'ghost');
  assert.ok(ghost);
  assert.equal(ghost.hint, '머리가 무겁다');
});

test('차이 계산: 라벨 변화, 칸 이동, 노드 증감, 동그라미 닫힘', () => {
  const d23 = diffView(view('02-circle.json'), view('03-guess.json'));
  assert.deepEqual(d23.relabeled, [{ id: 's1', from: '꼬릿한 냄새?', to: '구수한가? 상한 건가?' }]);
  assert.deepEqual(d23.rungChanged, [{ id: 's1', from: 'feel', to: 'guess' }]);
  assert.deepEqual(d23.nodesAdded, ['n3', 'n4']);
  assert.deepEqual(d23.nodesRemoved, ['n2']);
  assert.equal(d23.proseAdded, 1);
  assert.equal(d23.eventStatus, null);

  const d34 = diffView(view('03-guess.json'), view('04-thing.json'));
  assert.deepEqual(d34.rungChanged, [{ id: 's1', from: 'guess', to: 'thing' }]);
  assert.deepEqual(d34.nodesAdded, ['n5', 'p1', 'p2']);
  assert.deepEqual(d34.nodesRemoved, ['n1', 'n3']);

  const d45 = diffView(view('04-thing.json'), view('05-closed.json'));
  assert.deepEqual(d45.eventStatus, { from: 'open', to: 'closed' });
  assert.deepEqual(
    d45.circles,
    [
      { id: 'a1', from: 'open', to: 'closed' },
      { id: 'a2', from: 'open', to: 'closed' },
      { id: 'a3', from: 'none', to: 'closed' },
    ],
  );
  assert.deepEqual(d45.nodesRemoved, ['n4', 'p2']);

  const same = diffView(view('02-circle.json'), view('02-circle.json'));
  assert.deepEqual([same.circles, same.nodesAdded, same.nodesRemoved, same.relabeled, same.rungChanged], [[], [], [], [], []]);
});

test('계약 위반은 거부된다 (검증기가 실제로 잡는다)', () => {
  const cases: [string, (v: Mut) => void, RegExp][] = [
    ['version', (v) => { v.version = 2; }, /version/],
    ['번호 중복', (v) => { v.nodes[1] = { ...v.nodes[1], id: 's1' } as Mut['nodes'][number]; }, /중복/],
    ['없는 번호를 가리키는 간선', (v) => { v.edges.push({ from: 'zz', to: 's1', kind: 'link' }); }, /없는 번호/],
    [
      '노드 상한 초과',
      (v) => {
        for (const id of ['x1', 'x2', 'x3']) v.nodes.push({ id, label: id, kind: 'action', ring: 'none', state: 'new' });
      },
      /상한/,
    ],
    ['열린 이벤트에 닫힌 원', (v) => { v.anchors[0] = { id: 'a1', circle: 'closed' }; }, /닫혔다/],
    ['닫힌 이벤트에 열린 원', (v) => { v.event.status = 'closed'; }, /열려 있다/],
    ['이벤트가 없는데 원', (v) => { v.event.status = 'none'; }, /이벤트가 없는데/],
    ['ghost에 이유가 없음', (v) => { v.nodes.push({ id: 'g1', label: '…', kind: 'ghost', ring: 'none', state: 'seen' }); }, /hint/],
    ['지각 노드에 칸이 없음', (v) => { delete v.nodes[0]?.rung; }, /rung/],
    ['행동 노드에 칸이 있음', (v) => { if (v.nodes[1]) v.nodes[1].rung = 'feel'; }, /rung이 있다/],
    ['ghost가 아닌데 hint', (v) => { if (v.nodes[1]) v.nodes[1].hint = '이유'; }, /hint가 있다/],
    ['줄글에 있는 앵커가 anchors에 없음', (v) => { v.anchors = []; }, /anchors에 없다/],
    ['anchors에 있는 앵커가 줄글에 없음', (v) => { v.anchors.push({ id: 'a9', circle: 'none' }); }, /줄글에 없다/],
    [
      '핵심 지각이 둘',
      (v) => {
        if (v.nodes[0]) v.nodes[0].ring = 'core';
        v.nodes.push({ id: 'p9', label: '다른 것', kind: 'percept', rung: 'feel', ring: 'core', state: 'new' });
      },
      /핵심 지각 노드가 둘/,
    ],
    ['알 수 없는 종류', (v) => { if (v.nodes[0]) v.nodes[0].kind = 'thing'; }, /kind/],
  ];
  assert.ok(cases.length >= 15);
  for (const [name, mutate, expected] of cases) {
    const v = raw('02-circle.json');
    mutate(v);
    const r = parseView(v);
    assert.equal(r.view, null, `${name}: 거부되어야 한다`);
    assert.match(r.problems.join('\n'), expected, `${name}: 이유가 다르다\n${r.problems.join('\n')}`);
  }
  assert.equal(parseView(null).view, null);
  assert.equal(parseView([]).view, null);
});
