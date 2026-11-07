// 사건의 근거 참조 via (docs/영수증-명세.md 7장): 규칙·행동·법칙·감각 중 무엇이 사건을 만들었는지 한 칸에 적는다.
// 사전이 필수 유형을 정하고, 기록이 빠진 사건을 받지 않으며, 영수증 검증이 지워진 via를 잡는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventLog } from '../src/core/log.ts';
import { canon, verifyReceipts } from '../src/core/receipt.ts';
import type { Receipt } from '../src/core/receipt.ts';
import { receiptText } from '../src/core/receipt-text.ts';
import { parseScenario } from '../src/core/skeleton.ts';
import { formatVia, parseVia, viaCheck, viaKindsLookup, viaProblem } from '../src/core/via.ts';
import { viaResolver } from '../src/core/via-resolve.ts';
import { validateVocab } from '../src/core/vocab.ts';
import { loadDb, receiptNames, receiptsFor, scenarioDb, scenarioRun, sha256 } from '../src/node/clerk.ts';
import { loadVocabDir } from '../src/node/vocab-files.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vocab = loadVocabDir(join(ROOT, 'data', 'vocab'));
const WEEK = 'content/scenarios/first-week.json';

test('via: 모양을 읽고 쓰며, 사건 유형의 규칙(필수·허용 종류·금지)을 지킨다', () => {
  assert.deepEqual(parseVia('PLC000002/rule/odor_thicken'), { owner: 'PLC000002', kind: 'rule', key: 'odor_thicken' });
  assert.equal(formatVia('CHR000001', 'sense', 'smell'), 'CHR000001/sense/smell');
  for (const bad of ['', 'rule/odor', 'PLC2/rule/x', 'PLC000002/spell/x', 'PLC000002/rule/X', 'PLC000002/rule/', 'PLC000002/rule/a/b']) assert.equal(parseVia(bad), null, bad);
  assert.equal(viaProblem(['rule'], { via: 'PLC000002/rule/odor_thicken' }), null);
  assert.match(viaProblem(['rule'], {}) ?? '', /via가 필요하다/);
  assert.match(viaProblem(['rule'], { via: 'PLC000002/offer/inspect' }) ?? '', /종류 offer는 이 사건 유형에 맞지 않는다/);
  assert.match(viaProblem(['rule'], { via: 'nonsense' }) ?? '', /모양이 아니다/);
  assert.match(viaProblem(undefined, { via: 'PLC000002/rule/odor_thicken' }) ?? '', /쓰지 않는다/);
  assert.equal(viaProblem(undefined, { key: 'x' }), null);
});

test('사전: via를 쓰는 유형은 8개이고 종류가 정해져 있다. 모르는 종류를 적으면 사전이 거부한다', () => {
  const lookup = viaKindsLookup(vocab);
  const withVia = vocab.keys('event_type').filter((t) => lookup(t) !== undefined).sort();
  assert.deepEqual(withVia, ['action_chosen', 'action_done', 'awareness_changed', 'awareness_up', 'delay_cancelled', 'delay_fired', 'delay_scheduled', 'stage_advanced']);
  assert.deepEqual(lookup('stage_advanced'), ['progress']);
  assert.deepEqual(lookup('awareness_up'), ['sense', 'offer']);
  assert.equal(lookup('state_changed'), undefined, '상태 변화의 근거는 cause가 가리키는 사건의 via로 찾는다');
  const raw = [{ category: 'event_type', entries: [{ key: 'x', ko: '엑스', attrs: { via_kinds: ['rule', 'spell'] } }] }];
  assert.match(validateVocab(raw).map((i) => i.message).join(), /via_kinds는 rule \/ offer \/ progress \/ sense/);
});

test('기록: via가 필수인 사건을 via 없이 받지 않는다 (엔진이 근거를 빠뜨리면 그 자리에서 터진다)', () => {
  const log = new EventLog({ isKnownType: (t) => vocab.has('event_type', t), checkData: viaCheck(vocab) });
  assert.throws(() => log.append({ t: 0, type: 'delay_fired', src: 'causal', data: { at: 'PLC000002#1' } }), /via가 필요하다/);
  assert.throws(() => log.append({ t: 0, type: 'delay_fired', src: 'causal', data: { via: 'PLC000002/offer/inspect' } }), /종류 offer/);
  assert.throws(() => log.append({ t: 0, type: 'state_changed', src: 'world', data: { key: 'k', from: 'a', to: 'b', via: 'PLC000002/rule/x' } }), /쓰지 않는다/);
  assert.equal(log.size, 0, '거부된 사건은 기록에 남지 않는다');
  log.append({ t: 0, type: 'delay_fired', src: 'causal', data: { via: 'PLC000002/rule/odor_thicken', at: 'PLC000002#1' } });
  assert.equal(log.size, 1);
});

test('실제 첫 주: 근거가 필요한 유형이 모두 나오고, 모든 via가 저장소에 실제로 있는 규칙·행동·법칙·감각을 가리킨다', () => {
  const trace = scenarioRun(ROOT, vocab, WEEK);
  const db = scenarioDb(ROOT, vocab, parseScenario(JSON.parse(readFileSync(join(ROOT, WEEK), 'utf8'))));
  const resolver = viaResolver(db, vocab);
  const kinds = new Map<string, Set<string>>();
  for (const raw of trace.log as readonly { seq: string; type: string; data: Record<string, unknown> }[]) {
    const via = raw.data['via'];
    if (via === undefined) continue;
    assert.equal(typeof via, 'string');
    assert.notEqual(resolver.resolve(String(via)), null, `${raw.seq} ${raw.type}: 없는 근거 ${String(via)}`);
    const set = kinds.get(raw.type) ?? new Set<string>();
    set.add(String(parseVia(String(via))?.kind));
    kinds.set(raw.type, set);
  }
  assert.deepEqual([...kinds.keys()].sort(), ['action_chosen', 'action_done', 'awareness_changed', 'awareness_up', 'delay_cancelled', 'delay_fired', 'delay_scheduled', 'stage_advanced']);
  assert.deepEqual([...(kinds.get('awareness_up') ?? [])].sort(), ['offer', 'sense'], '저절로 느낀 것은 감각, 살펴서 안 것은 그 살피기 행동이 근거다');
  assert.deepEqual([...(kinds.get('stage_advanced') ?? [])], ['progress']);
  assert.equal(resolver.resolve('PLC000002/rule/지어낸_규칙'), null);
  assert.equal(resolver.resolve('PLC000002/rule/spread_odor_ge_distinct'), null, '번짐 규칙은 그것을 받는 장소(현관)의 것이다');
  assert.notEqual(resolver.resolve('PLC000001/rule/spread_odor_ge_distinct'), null, '통로 그래프에서 만든 번짐 규칙도 근거가 된다');
  assert.equal(loadDb(ROOT).defs['PLC000002']?.rules?.['spread'], undefined);
});

test('영수증: 근거 참조를 지우거나 엉뚱한 종류로 바꾸면 봉인을 다시 맞춰도 검증이 잡고, 글자판은 근거를 사람의 말로 보인다', () => {
  const week = receiptsFor(ROOT, vocab, WEEK);
  const kinds = viaKindsLookup(vocab);
  // 날을 넘어 이어지는 지연 발화 하나 (주방 냄새가 짙어짐). 번호는 데이터가 바뀌면 밀리므로 찾아서 쓴다
  const target = week.flatMap((r) => r.items).find((it) => it.type === 'delay_fired' && it.data['via'] === 'PLC000002/rule/odor_thicken' && it.cause_day !== undefined);
  assert.ok(target, '날을 넘는 주방 냄새 발화가 있다');
  const errors = (rs: readonly Receipt[]): string => verifyReceipts(rs, sha256, kinds).errors.join('\n');
  assert.equal(errors(week), '');
  const reseal = (r: Receipt): Receipt => {
    const { seal, ...body } = r;
    void seal;
    return { ...body, seal: sha256(`${r.prev_seal}\n${canon(body)}`) };
  };
  // 사건 내용을 바꾸면 고리가 어긋나므로, via만 바꾼 영수증은 고리까지 다시 계산해 위조한다
  const forged = (change: (data: Record<string, unknown>) => Record<string, unknown>): Receipt[] => {
    const rs = JSON.parse(JSON.stringify(week)) as Receipt[];
    let head = rs[0]?.prev_seal ?? '';
    let prevSeal = head;
    const out: Receipt[] = [];
    for (const r of rs) {
      const items = r.items.map((it) => {
        const data = it.seq === target.seq ? (change({ ...it.data }) as Receipt['items'][number]['data']) : it.data;
        const body = { seq: it.seq, t: it.t, type: it.type, src: it.src, cause: it.cause, data };
        const root = sha256(`${head}\n${canon(body)}`);
        const next = { ...it, data, prev: head, root };
        head = root;
        return next;
      });
      const sealed = reseal({ ...r, prev_seal: prevSeal, items, head_in: items[0]?.prev ?? head });
      prevSeal = sealed.seal;
      out.push(sealed);
    }
    return out;
  };
  assert.equal(errors(forged((d) => d)), '', '아무것도 안 바꾼 위조본은 통과한다 (아래 거부는 via 때문이다)');
  assert.match(errors(forged(({ via, ...rest }) => (void via, rest))), new RegExp(`${target.seq}: via가 필요하다`));
  assert.match(errors(forged((d) => ({ ...d, via: 'PLC000002/offer/inspect' }))), new RegExp(`${target.seq}: via 종류 offer`));
  const names = receiptNames(ROOT, WEEK, vocab);
  const text = week.map((r) => receiptText(r, names)).join('\n');
  assert.match(text, new RegExp(`${target.seq} ← ${target.cause} \\(${target.cause_day}일\\) · 냄새나는 음식이 남아 있으면 주방 냄새가 짙어진다`), '규칙의 label로 보인다');
  assert.match(text, / · 하루씨의 후각/, '저절로 느낀 것의 근거는 감각');
  assert.match(text, / · 냄새가 어디서 나는지 주방과 냉장고를 살핀다/, '살펴서 안 것의 근거는 그 행동');
  assert.match(text, / · 남은 치킨 부패 진행/, '진행의 근거는 그 물건의 법칙');
});
