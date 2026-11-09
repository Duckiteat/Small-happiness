// 심상 사다리 (S5 · ladder.ts): 냄새의 세기·종류·감별·자주 겪음이 느낌 → 짐작 → 좁힘 → 정체를 정한다
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agency } from '../src/core/agency.ts';
import { auditLog } from '../src/core/audit.ts';
import { checkValue } from '../src/core/board.ts';
import type { BoardValue } from '../src/core/board.ts';
import type { GameEvent, JsonValue } from '../src/core/events.ts';
import { conceptKinds, conceptPool, discern, ladderSpecs } from '../src/core/ladder.ts';
import { EventLog } from '../src/core/log.ts';
import { Perception } from '../src/core/perception.ts';
import { skillKey } from '../src/core/skill.ts';
import { Vocab, validateVocab } from '../src/core/vocab.ts';
import type { VocabCategoryRaw } from '../src/core/vocab.ts';
import { World } from '../src/core/world.ts';
import { loadDb } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOCAB_DIR = join(ROOT, 'data', 'vocab');
const vocab = loadVocabDir(VOCAB_DIR);
const db = loadDb(ROOT);
/** 시험에서 고쳐 쓰는 사전 원본 (파일을 읽어 새로 만든 것이라 고쳐도 된다). */
type Entry = { key: string; ko: string; desc?: string; aliases?: string[]; attrs?: { [k: string]: JsonValue } };
type Category = { category: string; entries: Entry[] };
const rawVocab = (): Category[] => readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(readFileSync(join(VOCAB_DIR, f), 'utf8')) as Category[]);
const asRaw = (raw: Category[]): VocabCategoryRaw[] => raw;

const WHO = 'CHR000001#1';

/** 하루씨, 주방, 우유 하나. 주방 공기의 세기와 종류를 정해 한 번 지각하고 행동을 고른다. */
function kitchen(v: Vocab = vocab): {
  world: World;
  log: EventLog;
  perception: Perception;
  agency: Agency;
  kitchen: string;
  milk: string;
  look: (t: number, recent?: BoardValue) => string[];
} {
  const log = new EventLog({ isKnownType: (type) => v.has('event_type', type) });
  const world = new World(db, v, log);
  world.spawn('CHR000001', { t: 0 });
  const kitchen = world.spawn('PLC000002', { t: 0 }).id;
  const milk = world.spawn('OBJ000002', { t: 0 }).id;
  const perception = new Perception(db, v, log);
  const agency = new Agency(db, v, log);
  const look = (t: number, recent: BoardValue = []): string[] => {
    const p = perception.step(world, t, 'home', recent);
    return agency.step(world, t, 'home', p.aware).map((a) => a.verb);
  };
  return { world, log, perception, agency, kitchen, milk, look };
}
const ladders = (log: EventLog): GameEvent[] => log.list({ where: (e) => e.type === 'ladder_moved' });
const show = (e: GameEvent): string => (e.data['on'] === true ? `${String(e.data['rung'])} ${(e.data['kinds'] as string[]).join(',')}${e.data['thing'] !== undefined ? ` @${String(e.data['thing'])}` : ''}${e.data['fresh'] === true ? ' fresh' : ''}` : 'off');
const belief = (h: ReturnType<typeof kitchen>): string | undefined => h.perception.snapshot()[WHO]?.[`${h.kitchen}|space:odor`]?.level;
const inspected = (place: string, t: number): BoardValue =>
  checkValue([{ event: 'L000001', who: WHO, verb: 'inspect', offer: 'PLC000002/inspect', at: place, ends: t, effects: [], reveals: place }], 'recent');
const sourKitchen = (h: ReturnType<typeof kitchen>, strength: string, t: number): void => {
  h.world.set(`${h.kitchen}|space:smell`, strength, { t });
  h.world.set(`${h.kitchen}|space:odor`, 'sour', { t });
};

test('느낌: 은은한 냄새는 나는 것만 알고 종류를 모른다 — 믿는 종류가 없어 살피지 않는다', () => {
  const h = kitchen();
  sourKitchen(h, 'faint', 10);
  assert.deepEqual(h.look(10), []);
  assert.deepEqual(ladders(h.log).map(show), ['feel ']);
  assert.equal(belief(h), undefined, '종류에 대한 앎이 없다');
  assert.equal(h.perception.snapshot()[WHO]?.[`${h.kitchen}|space:smell`]?.level, 'faint', '세기는 안다');
});

test('오인: 뚜렷한 시큼한 냄새를 감별 입문은 구수함과 헷갈려 구수한 쪽을 믿고 살피지 않는다', () => {
  const h = kitchen();
  sourKitchen(h, 'distinct', 10);
  assert.deepEqual(h.look(10), [], '구수한 요리 냄새로 믿으면 살피지 않는다');
  assert.deepEqual(ladders(h.log).map(show), ['guess savory,sour']);
  assert.equal(belief(h), 'savory');
  assert.notEqual(belief(h), h.world.level(`${h.kitchen}|space:odor`), '믿는 것은 세계와 다르다 (해는 없고 시간만 든다)');
  // 냄새가 지독해지면 헷갈리지 않는다: 좁혀 시큼함을 믿고 살핀다 (늦어진 확인)
  h.world.set(`${h.kitchen}|space:smell`, 'foul', { t: 20 });
  assert.deepEqual(h.look(20), ['inspect']);
  assert.deepEqual(ladders(h.log).map(show), ['guess savory,sour', 'narrow sour']);
  assert.equal(belief(h), 'sour');
});

test('감별이 오인을 줄인다: 감별이 익숙이면 같은 뚜렷한 냄새를 바로 시큼함으로 좁혀 살핀다', () => {
  const h = kitchen();
  h.world.set(skillKey(WHO, 'judging'), 'familiar', { t: 0 });
  sourKitchen(h, 'distinct', 10);
  assert.deepEqual(h.look(10), ['inspect']);
  assert.deepEqual(ladders(h.log).map(show), ['narrow sour']);
  // 계산 자체도: 같은 세기에서 숙련 칸만 바꾸면 가려 내는 종류가 줄어든다
  const spec = ladderSpecs(vocab).find((s) => s.feature === 'odor');
  assert.ok(spec);
  const strengths = new Map([['sour', 2]]);
  assert.deepEqual(discern(vocab, spec, strengths, 3, 0), ['savory', 'sour']);
  assert.deepEqual(discern(vocab, spec, strengths, 3, 2), ['sour']);
  assert.deepEqual(discern(vocab, spec, new Map([['sour', 1]]), 3, 5), [], '아무리 감별이 좋아도 은은하면 종류를 모른다 (kind_pct)');
});

test('정체: 살펴서 그 종류의 물건을 알면 정체 칸에 오르고, 그 물건의 종류는 세계와 같다', () => {
  const h = kitchen();
  h.world.set(skillKey(WHO, 'judging'), 'familiar', { t: 0 });
  h.world.set(`${h.milk}|body:sour`, 'lumpy', { t: 5 });
  h.world.set(`${h.milk}|body:smell`, 'distinct', { t: 5 });
  h.world.set(`${h.milk}|body:odor`, 'sour', { t: 5 });
  sourKitchen(h, 'distinct', 10);
  assert.deepEqual(h.look(10), ['inspect']);
  h.look(15, inspected(h.kitchen, 15));
  const last = ladders(h.log).at(-1);
  assert.ok(last);
  assert.equal(show(last), `thing sour @${h.milk}`);
  assert.equal(h.world.level(`${String(last.data['thing'])}|body:odor`), (last.data['kinds'] as string[])[0], '구체 칸의 종류가 세계의 품질과 맞다');
  assert.deepEqual(last.data['causes'], ['decay', 'ripen', 'sour'], '그 종류를 내는 원인 (사슬의 지식)');
});

test('섞인 냄새: 종류마다의 세기는 물건에서 계산한다 — 썩는 냄새와 시큼한 냄새가 함께 남는다 (LIM019)', () => {
  const h = kitchen();
  h.world.set(skillKey(WHO, 'judging'), 'master', { t: 0 });
  const tofu = h.world.spawn('OBJ000003', { t: 0 }).id;
  h.world.set(`${h.milk}|body:sour`, 'lumpy', { t: 5 });
  h.world.set(`${h.milk}|body:smell`, 'distinct', { t: 5 });
  h.world.set(`${h.milk}|body:odor`, 'sour', { t: 5 });
  h.world.set(`${tofu}|body:smell`, 'distinct', { t: 5 });
  h.world.set(`${tofu}|body:odor`, 'putrid', { t: 5 });
  h.world.set(`${h.kitchen}|space:smell`, 'distinct', { t: 10 });
  h.world.set(`${h.kitchen}|space:odor`, 'putrid', { t: 10 }); // 장소에는 가장 심한 것 하나만 남는다
  h.look(10);
  const kinds = ladders(h.log).at(-1)?.data['kinds'] as string[];
  assert.ok(kinds.includes('sour') && kinds.includes('putrid'), `시큼함과 썩는 냄새가 함께 짐작된다: ${kinds.join(',')}`);
});

test('좁히기: 남은 후보와 새로 가려 낸 것의 교집합. 맞지 않으면 새 냄새로 보고 새 사다리를 연다. 냄새가 가시면 닫고 없어졌다고 안다', () => {
  const h = kitchen();
  sourKitchen(h, 'distinct', 10);
  h.look(10); // 짐작: 구수함·시큼함
  h.world.set(`${h.kitchen}|space:odor`, 'putrid', { t: 20 });
  h.look(20); // 썩는 냄새는 앞의 후보와 겹치지 않는다
  h.world.set(`${h.kitchen}|space:smell`, 'none', { t: 30 });
  h.look(30);
  assert.deepEqual(ladders(h.log).map(show), ['guess savory,sour', 'guess sulfur,putrid fresh', 'off']);
  assert.equal(belief(h), 'none');
});

test('자주 겪음: 시큼한 것(먼저 떠올린 우유)으로 좁힌 적이 많으면 다음에 헷갈릴 때 그것을 먼저 떠올려 시큼함을 믿는다 (순한 것보다 앞)', () => {
  const h = kitchen();
  let t = 10;
  for (let i = 0; i < 2; i++) {
    sourKitchen(h, 'foul', t);
    h.look(t);
    h.world.set(`${h.kitchen}|space:smell`, 'none', { t: t + 5 });
    h.look(t + 5);
    t += 10;
  }
  sourKitchen(h, 'distinct', t);
  h.look(t);
  assert.deepEqual(ladders(h.log).map(show).slice(-1), ['guess sour,savory']);
  assert.equal(belief(h), 'sour');
});

const conceptsOf = (e: GameEvent | undefined): string[] => (Array.isArray(e?.data['concepts']) ? e.data['concepts'].map(String) : []);

test('개념을 먼저 떠올리고 냄새를 대 본다: 기억이 없으면 순한 냄새의 물건(남은 치킨)을, 썩는 냄새뿐이면 맞는 물건이 없어 원인(부패)을 떠올린다', () => {
  const h = kitchen();
  sourKitchen(h, 'distinct', 10);
  h.look(10);
  assert.deepEqual(conceptsOf(ladders(h.log).at(-1)).slice(0, 2), ['OBJ000010', 'OBJ000026'], '구수한 냄새가 맞는 물건이 먼저 (번호 순)');
  const r = kitchen();
  r.world.set(`${r.kitchen}|space:smell`, 'foul', { t: 10 });
  r.world.set(`${r.kitchen}|space:odor`, 'putrid', { t: 10 });
  r.look(10);
  const last = ladders(r.log).at(-1);
  assert.equal(conceptsOf(last)[0], 'decay', '"상한 건가?"');
  assert.equal(conceptsOf(last).some((c) => c.startsWith('OBJ')), false, '썩는 냄새로 이어진 물건 개념은 없다');
  assert.deepEqual(auditLog(r.log.list(), db, vocab).findings, []);
});

test('기억: 감정이 붙은 기억의 물건을 먼저 떠올리고 그 냄새를 대 본다 — 김치를 그리워하면 뚜렷한 시큼함을 구수함보다 먼저 믿고 살핀다', () => {
  const without = kitchen();
  sourKitchen(without, 'distinct', 10);
  assert.deepEqual(without.look(10), [], '기억이 없으면 순한 구수함을 먼저 믿는다 (오인)');
  const h = kitchen();
  h.perception.remember(WHO, 'OBJ000005', 'longing', 0); // 김치 → 그리움 (이야기가 정한 지난 기억)
  sourKitchen(h, 'distinct', 10);
  assert.deepEqual(h.look(10), ['inspect']);
  assert.deepEqual(ladders(h.log).map(show), ['guess sour,savory'], '헷갈림은 그대로(감별 입문), 순서만 바뀐다');
  assert.equal(conceptsOf(ladders(h.log).at(-1))[0], 'OBJ000005', '김치인가?');
  assert.equal(belief(h), 'sour');
  // 기억한 것의 냄새가 지금 냄새와 맞지 않으면 떠올리지 않는다: 계란(냄새 없음)을 그리워해도 순서는 그대로
  const egg = kitchen();
  egg.perception.remember(WHO, 'OBJ000004', 'longing', 0);
  sourKitchen(egg, 'distinct', 10);
  assert.deepEqual(egg.look(10), []);
  assert.equal(conceptsOf(ladders(egg.log).at(-1)).includes('OBJ000004'), false);
  assert.deepEqual(auditLog(h.log.list(), db, vocab).findings, []);
});

test('기억 > 자주 겪음: 구수한 것(남은 치킨)으로 여러 번 좁혔어도, 김치의 기억이 있으면 김치를 먼저 떠올려 시큼함을 믿는다', () => {
  const run = (memory: boolean): string[] => {
    const h = kitchen();
    if (memory) h.perception.remember(WHO, 'OBJ000005', 'longing', 0);
    let t = 10;
    for (let i = 0; i < 2; i++) {
      h.world.set(`${h.kitchen}|space:smell`, 'foul', { t });
      h.world.set(`${h.kitchen}|space:odor`, 'savory', { t });
      h.look(t);
      h.world.set(`${h.kitchen}|space:smell`, 'none', { t: t + 5 });
      h.look(t + 5);
      t += 10;
    }
    sourKitchen(h, 'distinct', t);
    h.look(t);
    assert.deepEqual(auditLog(h.log.list(), db, vocab).findings, []);
    return ladders(h.log).map(show).slice(-1);
  };
  assert.deepEqual(run(false), ['guess savory,sour'], '자주 겪은 구수함이 먼저');
  assert.deepEqual(run(true), ['guess sour,savory'], '기억이 자주 겪음보다 앞선다');
});

test('개념의 냄새: 물건은 그 냄새 감각질을 주는 종류(데이터에서 거꾸로 따라감), 원인은 사슬의 종류. 장소는 개념이 아니다', () => {
  const spec = ladderSpecs(vocab).find((x) => x.feature === 'odor');
  assert.ok(spec);
  const kinds = (def: string): string[] => conceptKinds(db, vocab, spec, def);
  assert.deepEqual(kinds('OBJ000034'), ['savory'], '된장찌개: 구수한 냄새');
  assert.deepEqual(kinds('OBJ000005'), ['sour'], '김치: 신향');
  assert.deepEqual(kinds('OBJ000031'), ['savory', 'sour'], '냄비: 구수한 냄새와 (김치를 넣으면) 신향');
  assert.deepEqual(kinds('OBJ000006'), [], '사과: 단향을 주는 냄새 종류가 없다');
  assert.deepEqual(kinds('OBJ000004'), [], '계란: 냄새 감각질이 없다');
  const pool = conceptPool(db, vocab, spec);
  assert.ok(pool.some((c) => c.id === 'decay' && c.kinds.includes('putrid')), '부패는 썩는 냄새까지');
  assert.ok(pool.some((c) => c.id === 'cooking' && c.kinds.join() === 'savory'));
  assert.equal(pool.some((c) => c.id.startsWith('PLC') || c.id === 'OBJ000006'), false);
});

test('감사: 기억을 빼고 계산한 순서·떠올린 개념으로 고친 사다리를 잡는다', () => {
  const h = kitchen();
  h.perception.remember(WHO, 'OBJ000005', 'longing', 0);
  sourKitchen(h, 'distinct', 10);
  h.look(10);
  const events = h.log.list();
  const guess = events.find((e) => e.type === 'ladder_moved');
  assert.ok(guess);
  const forged = events.map((e) => (e.seq === guess.seq ? { ...e, data: { ...e.data, kinds: ['savory', 'sour'] } } : e));
  assert.ok(auditLog(forged, db, vocab).findings.some((f) => f.seq === guess.seq && /sour·savory/.test(f.message)));
  // 떠올린 개념만 바꿔도 잡는다
  const swapped = events.map((e) => (e.seq === guess.seq ? { ...e, data: { ...e.data, concepts: ['OBJ000010', ...conceptsOf(e).filter((c) => c !== 'OBJ000010')] } } : e));
  assert.ok(auditLog(swapped, db, vocab).findings.some((f) => f.seq === guess.seq && /떠올린 것 OBJ000005/.test(f.message)));
});

test('같은 관찰 같은 칸: 같은 순서로 보면 사다리 기록이 똑같다', () => {
  const once = (): string[] => {
    const h = kitchen();
    sourKitchen(h, 'faint', 10);
    h.look(10);
    h.world.set(`${h.kitchen}|space:smell`, 'distinct', { t: 20 });
    h.look(20);
    h.world.set(`${h.kitchen}|space:smell`, 'foul', { t: 30 });
    h.look(30);
    return h.log.list().map((e) => `${e.seq} ${e.type} ${JSON.stringify(e.data)}`);
  };
  const a = once();
  assert.deepEqual(a, once());
  assert.ok(a.some((x) => x.includes('"rung":"guess"')) && a.some((x) => x.includes('"rung":"narrow"')), '느낌 → 짐작 → 좁힘을 지난다');
});

test('칸과 이름을 더해도 기존 사건이 바뀌지 않는다 (칸은 키로 참조)', () => {
  const raw = rawVocab();
  for (const c of raw) {
    if (c.category !== 'rung') continue;
    c.entries.push({ key: 'named', ko: '이름 붙임', desc: '시험용: 쓰이지 않는 칸', attrs: { rank: 9 } });
    for (const e of c.entries) if (e.key === 'guess') e.aliases = ['연상'];
  }
  const run = (v: Vocab): string[] => {
    const h = kitchen(v);
    sourKitchen(h, 'distinct', 10);
    h.look(10);
    h.world.set(`${h.kitchen}|space:smell`, 'foul', { t: 20 });
    h.look(20);
    return h.log.list().map((e) => `${e.type} ${JSON.stringify(e.data)}`);
  };
  assert.deepEqual(run(new Vocab(asRaw(raw))), run(vocab));
});

test('감사: 사다리를 그때의 냄새·앎·감별로 다시 계산해, 고치거나 빠뜨리면 잡는다', () => {
  const h = kitchen();
  sourKitchen(h, 'distinct', 10);
  h.look(10);
  h.world.set(`${h.kitchen}|space:smell`, 'foul', { t: 20 });
  h.look(20);
  const events = h.log.list();
  assert.deepEqual(auditLog(events, db, vocab).findings, []);
  const guess = events.find((e) => e.type === 'ladder_moved' && e.data['rung'] === 'guess');
  assert.ok(guess);
  const tamper = (fn: (e: GameEvent) => GameEvent | null): GameEvent[] => events.flatMap((e) => {
    const x = fn(e);
    return x === null ? [] : [x];
  });
  // 믿는 종류를 세계의 것으로 바꿈 (오인을 지움)
  const truthful = tamper((e) => (e.seq === guess.seq ? { ...e, data: { ...e.data, kinds: ['sour', 'savory'] } } : e));
  assert.ok(auditLog(truthful, db, vocab).findings.some((f) => f.seq === guess.seq && /사다리가 guess/.test(f.message)));
  // 앎만 세계대로 고침
  const knew = tamper((e) => (e.type === 'awareness_up' && e.data['key'] === `${h.kitchen}|space:odor` ? { ...e, data: { ...e.data, level: 'sour' } } : e));
  assert.ok(auditLog(knew, db, vocab).findings.some((f) => /사다리로 믿는 종류는 savory/.test(f.message)));
  // 사다리 사건을 빠뜨림
  const missing = tamper((e) => (e.seq === guess.seq ? null : e));
  assert.ok(auditLog(missing, db, vocab).findings.some((f) => /사다리가 먼저 옮겨져야/.test(f.message)));
});

test('사전: 사다리 설정·비슷한 종류·칸을 검사한다', () => {
  const edit = (fn: (raw: Category[]) => void): string => {
    const raw = rawVocab();
    fn(raw);
    return validateVocab(asRaw(raw)).map((i) => `${i.path}: ${i.message}`).join('\n');
  };
  const odor = (raw: Category[]): { [k: string]: JsonValue } => {
    for (const c of raw) {
      for (const e of c.entries) {
        const l = e.attrs?.['ladder'];
        if (c.category === 'feature' && e.key === 'odor' && typeof l === 'object' && l !== null && !Array.isArray(l)) return l as { [k: string]: JsonValue };
      }
    }
    throw new Error('odor 없음');
  };
  assert.equal(edit(() => undefined), '');
  assert.match(edit((raw) => void (odor(raw)['clear_pct'] = [34, 34, 67, 67, 100, 100])), /숙련이 오를수록 같거나 낮아야/);
  assert.match(edit((raw) => void (odor(raw)['clear_pct'] = [100, 67])), /숙련의 칸마다 하나씩/);
  assert.match(edit((raw) => void (odor(raw)['skill'] = 'smell')), /내면 특징이어야/);
  assert.match(edit((raw) => void delete odor(raw)['tuned']), /tuned/);
  assert.match(
    edit((raw) => {
      for (const c of raw) for (const e of c.entries) if (c.category === 'odor_kind' && e.key === 'sour' && e.attrs !== undefined) e.attrs['like'] = ['sour'];
    }),
    /자기가 아닌 냄새 종류/,
  );
  assert.match(
    edit((raw) => {
      for (const c of raw) for (const e of c.entries) if (c.category === 'odor_kind' && e.key === 'sour' && e.attrs !== undefined) e.attrs['like'] = ['caramel'];
    }),
    /odor_kind 분류에 없는 키/,
  );
  assert.match(
    edit((raw) => {
      for (const c of raw) if (c.category === 'rung') c.entries = c.entries.filter((e) => e.key !== 'narrow');
    }),
    /칸 narrow가 사전에 있어야/,
  );
});
