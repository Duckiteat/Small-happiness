// 엔진 입구 (src/core/session.ts, 게임화-방향 10장): 나눠 진행해도 같은 하루, 실시간 조언 = 시나리오의 조언, 저장·불러오기는 입력을 다시 돌린다
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLog } from '../src/core/audit.ts';
import { parseEvent } from '../src/core/events.ts';
import { fingerprint, parseSessionSave, scenarioToRaw, Session, SessionError } from '../src/core/session.ts';
import { parseScenario, runScenario } from '../src/core/skeleton.ts';
import type { Scenario } from '../src/core/skeleton.ts';
import { contentHash, scenarioDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const SC_DIR = join(ROOT, 'content', 'scenarios');
const rawOf = (f: string): Record<string, unknown> => JSON.parse(readFileSync(join(SC_DIR, f), 'utf8')) as Record<string, unknown>;
const load = (r: Record<string, unknown>): { sc: Scenario; db: ReturnType<typeof scenarioDb> } => {
  const sc = parseScenario(r);
  return { sc, db: scenarioDb(ROOT, vocab, sc) };
};
const CONTENT = contentHash(ROOT);
const WIPE = 'PLC000002/offer/wipe_floor';
const KITCHEN = 'PLC000002#1';

test('나눠 진행해도 같은 하루: 모든 시나리오를 37분씩 진행한 기록이 한 번에 돌린 것과 바이트까지 같다', () => {
  const files = readdirSync(SC_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.ok(files.length >= 6);
  for (const f of files) {
    const { sc, db } = load(rawOf(f));
    const whole = JSON.stringify(runScenario(db, vocab, sc));
    const s = Session.start(db, vocab, sc);
    let fresh = 0;
    for (let t = sc.start; t < sc.end; t += 37) fresh += s.advance(t).events.length;
    fresh += s.advance(sc.end).events.length;
    assert.ok(s.ended, f);
    assert.equal(JSON.stringify(s.trace()), whole, f);
    assert.equal(fresh, s.trace().log.length, `${f}: 진행할 때마다 새 사건을 빠짐없이 한 번씩 돌려준다`);
  }
});

test('실시간 조언 = 시나리오의 조언: 저녁에 화면이 그 시각에 권하면 시나리오에 적은 것과 같은 하루가 된다', () => {
  const r = rawOf('home-evening.json');
  const advice = r['advice'] as { t: number; offer: string; at: string }[];
  assert.ok(advice.length === 2);
  const { sc, db } = load(r);
  const scripted = JSON.stringify(runScenario(db, vocab, sc).log);
  const live = Session.start(db, vocab, parseScenario({ ...r, advice: [] }));
  for (const a of advice) {
    live.advance(a.t);
    live.advise(a.offer, a.at);
    assert.ok(live.view().pendingAdvice.some((p) => p.t === a.t && p.offer === a.offer), '닿기 전에는 남은 조언으로 보인다');
  }
  live.advance(sc.end);
  assert.equal(JSON.stringify(live.trace().log), scripted);
  assert.deepEqual(live.view().pendingAdvice, []);
  const events = live.trace().log.map(parseEvent);
  assert.deepEqual(auditLog(events, db, vocab, { externalUntil: sc.start }).findings, []);
});

test('화면이 보는 것: 시계·다음에 깨는 시각·마지막 판·요정이 고를 수 있는 선택지', () => {
  const { sc, db } = load({ ...rawOf('home-evening.json'), advice: [] });
  const s = Session.start(db, vocab, sc);
  const v0 = s.view();
  assert.equal(v0.step, null);
  assert.equal(v0.next, sc.start);
  s.advance(1180);
  const v = s.view();
  assert.equal(v.t, 1180);
  assert.ok(v.step !== null && v.step.t <= 1180 && 'scene' in v.step.values);
  assert.ok(v.next !== null && v.next > 1180);
  const mine = v.options.find((o) => o.who === 'CHR000001#1');
  assert.ok(mine !== undefined && mine.options.some((o) => o.offer === WIPE && o.at === KITCHEN), JSON.stringify(v.options));
  // 화면이 보여 준 선택지로 조언하면 하루씨가 다음에 고를 때 닦는다
  s.advise(WIPE, KITCHEN);
  const after = s.advance(sc.end).events;
  const given = after.find((e) => e.type === 'advice_given');
  assert.equal(after.find((e) => e.type === 'action_chosen' && e.data['advised'] === given?.seq)?.data['verb'], 'wipe');
});

test('저장·불러오기: 중간에 저장하고 불러와 이어 가면 끊지 않은 하루와 같다 (숙련·앎·예약 같은 속 상태도 다시 돌아온다)', () => {
  for (const f of ['first-week.json', 'home-evening.json', 'kitchen-stew.json']) {
    const { sc, db } = load(rawOf(f));
    const whole = JSON.stringify(runScenario(db, vocab, sc));
    const mid = Math.floor((sc.start + sc.end) / 2);
    const a = Session.start(db, vocab, sc);
    a.advance(mid);
    const text = a.save(CONTENT);
    assert.equal(text, a.save(CONTENT), '같은 상태는 같은 바이트');
    const { session: b, contentChanged } = Session.load(db, vocab, text, CONTENT);
    assert.equal(contentChanged, false);
    assert.equal(b.t, mid);
    assert.deepEqual(b.drain(), [], '불러온 것은 새 사건이 아니다');
    b.advance(sc.end);
    assert.equal(JSON.stringify(b.trace()), whole, f);
  }
});

test('저장 파일: 입력이 순서대로 남고, 시나리오는 다시 해석하면 같은 시나리오다', () => {
  const r = { ...rawOf('home-evening.json'), advice: [] };
  const { sc, db } = load(r);
  assert.deepEqual(parseScenario(scenarioToRaw(sc)), sc);
  const s = Session.start(db, vocab, sc);
  s.advance(1180);
  s.advise(WIPE, KITCHEN);
  s.advance(1200);
  const save = parseSessionSave(s.save(CONTENT));
  assert.deepEqual(save.inputs, [{ type: 'advance', until: 1180 }, { type: 'advise', t: 1180, offer: WIPE, at: KITCHEN }, { type: 'advance', until: 1200 }]);
  assert.equal(save.log.events, s.trace().log.length);
});

test('불러오기가 거부하는 것: 다른 하루가 나오면(지문·사건 수), 모르는 형식·버전·입력', () => {
  const { sc, db } = load({ ...rawOf('home-evening.json'), advice: [] });
  const s = Session.start(db, vocab, sc);
  s.advance(1200);
  const good = JSON.parse(s.save(CONTENT)) as Record<string, unknown>;
  const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch });
  const cases: { name: string; text: string; re: RegExp }[] = [
    { name: '지문이 다름', text: bad({ log: { ...(good['log'] as object), digest: '00000000' } }), re: /저장할 때와 다르다/ },
    { name: '시나리오를 고침 (처음 상태가 다른 하루)', text: bad({ scenario: { ...(good['scenario'] as object), set: [] } }), re: /저장할 때와 다르다/ },
    { name: '콘텐츠가 바뀐 뒤 다른 하루', text: bad({ content: 'other', log: { events: 1, digest: '00000000' } }), re: /콘텐츠\(정의·사전\)가 바뀌었다/ },
    { name: '형식', text: bad({ format: 'x' }), re: /저장 형식이 아니다/ },
    { name: '버전', text: bad({ version: 2 }), re: /모르는 저장 버전/ },
    { name: '입력 모양', text: bad({ inputs: [{ type: 'jump' }] }), re: /inputs\[0\]/ },
    { name: 'JSON 아님', text: '{', re: /JSON이 아니다/ },
    { name: '시계를 거꾸로', text: bad({ inputs: [{ type: 'advance', until: 1200 }, { type: 'advance', until: 1100 }] }), re: /거꾸로/ },
    { name: '지난 시각의 조언', text: bad({ inputs: [{ type: 'advance', until: 1200 }, { type: 'advise', t: 1100, offer: WIPE, at: KITCHEN }] }), re: /지금\(1200\)만/ },
  ];
  for (const c of cases) assert.throws(() => Session.load(db, vocab, c.text, CONTENT), (e: unknown) => e instanceof SessionError && c.re.test(e.message), c.name);
  // 콘텐츠 해시만 다르고 같은 하루가 나오면 불러오되 알린다
  const { contentChanged } = Session.load(db, vocab, bad({ content: 'other' }), CONTENT);
  assert.equal(contentChanged, true);
});

test('진행이 거부하는 것: 거꾸로·끝 너머·정수 아닌 시각, 끝난 뒤의 조언', () => {
  const { sc, db } = load({ ...rawOf('home-evening.json'), advice: [] });
  const s = Session.start(db, vocab, sc);
  s.advance(1200);
  assert.throws(() => s.advance(1199), /거꾸로/);
  assert.throws(() => s.advance(sc.end + 1), /하루의 끝/);
  assert.throws(() => s.advance(1200.5), /정수/);
  assert.throws(() => s.advise('', KITCHEN), /선택지\(offer\)/);
  s.advance(sc.end);
  assert.throws(() => s.advise(WIPE, KITCHEN), /하루가 끝나/);
  assert.equal(s.inputs().length, 2, '거부한 입력은 남지 않는다');
});

test('지문: 같은 글은 같은 지문, 한 글자만 달라도 다른 지문', () => {
  assert.equal(fingerprint('하루'), fingerprint('하루'));
  assert.notEqual(fingerprint('하루씨'), fingerprint('하루시'));
  assert.match(fingerprint(''), /^[0-9a-f]{8}$/);
});
