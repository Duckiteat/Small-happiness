import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseView } from '../src/core/viewmodel.ts';
import { syncWeb, VIEW_DIR, WEB_PAGE } from '../src/node/clerk.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(join(ROOT, WEB_PAGE), 'utf8');

function inlineViews(): unknown[] {
  const m = /<script id="fixtures" type="application\/json">\n([\s\S]*?)\n<\/script>/.exec(html);
  assert.ok(m?.[1], '장면 JSON 블록이 없다');
  return JSON.parse(m[1]) as unknown[];
}

test('시제품 안의 장면은 examples/view 파일과 같다', () => {
  const names = readdirSync(join(ROOT, VIEW_DIR)).filter((n) => n.endsWith('.json')).sort();
  const files = names.map((n) => JSON.parse(readFileSync(join(ROOT, VIEW_DIR, n), 'utf8')) as unknown);
  assert.ok(files.length >= 6);
  assert.deepEqual(inlineViews(), files);
  assert.equal(syncWeb(ROOT, 'check').ok, true);
});

test('시제품 안의 장면은 모두 뷰 계약을 통과한다', () => {
  for (const v of inlineViews()) assert.deepEqual(parseView(v).problems, []);
});

test('시제품은 바깥 주소나 캔바 흔적을 갖지 않는다', () => {
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /canva/i);
});

test('시제품의 자리표는 보이는 모든 노드를 덮는다', () => {
  const m = /const SLOT = (\{[^}]*\})/.exec(html);
  assert.ok(m?.[1]);
  const slots = Object.fromEntries([...m[1].matchAll(/(\w+)\s*:\s*'([A-Z-]+)'/g)].map((x) => [x[1], x[2]]));
  for (const v of inlineViews()) {
    const r = parseView(v);
    const used = new Map<string, string>();
    for (const n of r.view?.nodes ?? []) {
      if (n.state === 'faded') continue;
      const s = slots[n.id];
      assert.ok(s, `자리 없음: ${n.id}`);
      assert.equal(used.has(s), false, `자리 겹침: ${n.id}/${used.get(s)}`);
      used.set(s, n.id);
    }
  }
});
