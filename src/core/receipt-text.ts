// 하루 영수증 글자판 (docs/영수증-명세.md 4장)
//
// 영수증(JSON)을 사람이 읽는 영수증 모양으로 찍는다. 표시만 한다: 해시에 들어가지 않고, 검증은 JSON으로 한다.
// 이름은 정의 저장소(names.ko)와 사전(ko)에서 가져온다. 코드에 오브젝트·장소 이름을 박지 않는다.

import type { JsonValue } from './events.ts';
import type { Db } from './db.ts';
import { instanceName } from './skeleton.ts';
import { parseVia } from './via.ts';
import { MINUTES_PER_DAY } from './clock.ts';
import { parseStateKey } from './statekey.ts';
import type { Receipt, ReceiptItem } from './receipt.ts';
import type { Vocab } from './vocab.ts';

const RULE = '-'.repeat(44);
const DOUBLE = '='.repeat(44);

function hhmm(t: number): string {
  const m = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 다른 날의 시각이면 날을 붙인다. */
function when(t: number, day: number): string {
  const d = Math.floor(t / MINUTES_PER_DAY) + 1;
  return d === day ? hhmm(t) : `${d}일 ${hhmm(t)}`;
}

const s = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export class ReceiptNames {
  readonly #db: Db;
  readonly #vocab: Vocab;
  constructor(db: Db, vocab: Vocab) {
    this.#db = db;
    this.#vocab = vocab;
  }

  /** 인스턴스 번호(OBJ000010#1) 또는 정의 번호 → 이름. 모르면 번호 그대로. */
  thing(id: string): string {
    return instanceName(this.#db, id);
  }

  feature(feature: string): string {
    return this.#vocab.entry('feature', feature)?.ko ?? feature;
  }

  level(feature: string, level: string): string {
    const levels = this.#vocab.entry('feature', feature)?.attrs['levels'];
    if (Array.isArray(levels)) {
      for (const l of levels) {
        if (typeof l === 'object' && l !== null && !Array.isArray(l) && l['key'] === level && typeof l['ko'] === 'string') return l['ko'];
      }
    }
    return this.#vocab.entry('terminal', level)?.ko ?? level;
  }

  /** 상태 키 → "남은 치킨 부패" */
  key(key: string): { what: string; feature: string } {
    const k = parseStateKey(key);
    if (k === null) return { what: key, feature: '' };
    return { what: `${this.thing(k.subject)} ${this.feature(k.feature)}`, feature: k.feature };
  }

  word(category: string, key: string): string {
    return this.#vocab.entry(category, key)?.ko ?? key;
  }

  /** 근거 참조(정의/종류/키) → 사람이 읽는 말. 규칙·행동은 정의의 label, 없으면 키. 모양이 아니면 그대로. */
  via(ref: string): string {
    const v = parseVia(ref);
    if (v === null) return ref;
    const def = this.#db.defs[v.owner];
    const who = this.thing(v.owner);
    switch (v.kind) {
      case 'rule':
        return def?.rules?.[v.key]?.label ?? `${who} 규칙 ${v.key}`;
      case 'offer':
        return def?.offers?.[v.key]?.label ?? `${who} 행동 ${v.key}`;
      case 'progress':
        return `${who} ${this.feature(v.key)} 진행`;
      case 'sense':
        return `${who}의 ${this.word('sense', v.key)}`;
    }
  }
}

/** 사건 한 줄의 내용. 사전에 없는 유형은 유형 이름과 data를 그대로 보인다 (지어내지 않는다). */
export function itemText(it: ReceiptItem, n: ReceiptNames, day: number): string {
  const d = it.data;
  const typeKo = n.word('event_type', it.type);
  switch (it.type) {
    case 'instance_created':
      return `${typeKo}: ${n.thing(s(d['id']))}`;
    case 'placed': {
      const rel = s(d['rel']) === 'in' ? '담긴 곳' : '받치는 것';
      const to = s(d['to']);
      return `${typeKo}: ${n.thing(s(d['id']))}의 ${rel} → ${to === '' ? '없음' : n.thing(to)}`;
    }
    case 'state_changed': {
      const k = n.key(s(d['key']));
      return `${k.what}: ${n.level(k.feature, s(d['from']))} → ${n.level(k.feature, s(d['to']))}`;
    }
    case 'stage_advanced': {
      const k = n.key(s(d['key']));
      return `${typeKo}: ${k.what} → ${n.level(k.feature, s(d['to']))}`;
    }
    case 'delay_scheduled':
      return `${typeKo} (${when(Number(d['due']), day)})`;
    case 'delay_fired':
    case 'delay_cancelled':
      return typeKo;
    case 'awareness_up':
    case 'awareness_changed': {
      const k = n.key(s(d['key']));
      return `${n.thing(s(d['who']))} · ${k.what}=${n.level(k.feature, s(d['level']))} (${n.word('awareness', s(d['to']))})`;
    }
    case 'action_chosen':
      return `${n.thing(s(d['who']))} · ${n.thing(s(d['at']))} ${n.word('action', s(d['verb']))} 고름 (~${when(Number(d['ends']), day)})`;
    case 'stimulus_perceived':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('sensation', s(d['sensation']))}${typeof d['level'] === 'number' ? ` ${d['level']}/${String(d['scale'])}` : ''} (${d['moment'] === true ? '닿음' : d['on'] !== true ? '그침' : d['was'] !== undefined ? '세기 바뀜' : '느낌'})`;
    case 'reflex':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('reflex', s(d['reflex']))} (${n.word('sensation', s(d['sensation']))})`;
    case 'reflex_learned':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('reflex', s(d['reflex']))}`;
    case 'image_formed':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('image', s(d['image']))} (${d['moment'] === true ? '그 순간' : d['on'] === true ? '생김' : '깨짐'})`;
    case 'ladder_moved': {
      // 심상 사다리: 어느 곳의 냄새를 어디까지 아는가 (맨 앞이 믿는 종류)
      const where = n.thing(s(d['of']));
      if (d['on'] !== true) return `${n.thing(s(d['who']))} · ${typeKo}: ${where} (닫힘)`;
      const kinds = Array.isArray(d['kinds']) ? d['kinds'].map((x) => n.level(s(d['feature']), s(x))) : [];
      const thing = d['thing'] === undefined ? '' : ` · ${n.thing(s(d['thing']))}`;
      // 먼저 떠올린 개념 (정체 칸이 아니면 "~인가?"): 물건 정의는 이름, 냄새 원인은 사전의 말
      const c = Array.isArray(d['concepts']) ? s(d['concepts'][0]) : '';
      const concept = c === '' || d['thing'] !== undefined ? '' : ` · ${c.startsWith('OBJ') ? n.thing(c) : n.word('odor_cause', c)}인가?`;
      return `${n.thing(s(d['who']))} · ${typeKo}: ${where} ${n.word('rung', s(d['rung']))}${kinds.length > 0 ? ` (${kinds.join(' / ')})` : ''}${concept}${thing}${d['fresh'] === true ? ' · 새 냄새' : ''}`;
    }
    case 'body_response':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('response', s(d['response']))} (${n.word('image', s(d['image']))})`;
    case 'emotion_formed': {
      const of = Array.isArray(d['of']) ? d['of'].map((x) => n.thing(s(x))).join('·') : '';
      const th: Record<string, string> = { new: '처음', familiar: '겪어 봄', recalled: '기억대로', against: '기억과 어긋남' };
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('emotion', s(d['emotion']))} (${n.word('image', s(d['image']))} · ${of === '' ? '무엇인지 모름' : of} · ${th[s(d['thought'])] ?? s(d['thought'])})`;
    }
    case 'memory_formed':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.thing(s(d['of']))} → ${n.word('emotion', s(d['emotion']))}${d['replaces'] !== undefined ? ` (${n.word('emotion', s(d['replaces']))}을 덧씌움)` : d['given'] === true ? ' (지난 기억)' : ''}`;
    case 'options_formed': {
      const os = Array.isArray(d['options']) ? d['options'] : [];
      return `${n.thing(s(d['who']))} · ${typeKo}: ${os.map((o) => (typeof o === 'object' && o !== null && !Array.isArray(o) ? `${n.thing(s(o['at']))} ${n.word('action', s(o['verb']))}` : '')).join(' / ')}`;
    }
    case 'advice_given':
      return `요정 → ${n.thing(s(d['who']))} · ${typeKo}: ${n.via(s(d['offer']))}`;
    case 'advice_ignored':
      return `${n.thing(s(d['who']))} · ${typeKo} (${d['reason'] === 'overwhelmed' ? '생각이 멈춤' : '지금의 선택지가 아님'})`;
    case 'thought_surfaced':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.thing(s(d['of']))} (${n.word('image', s(d['image']))}을 겪은 일, 아직 치울 것이 남음)`;
    case 'overwhelmed':
      return `${n.thing(s(d['who']))} · ${typeKo}`;
    case 'menu_planned':
      return `${n.thing(s(d['who']))} · ${typeKo}: ${n.word('menu', s(d['menu']))}`;
    case 'action_done':
      return `${n.thing(s(d['who']))} · ${n.thing(s(d['at']))} ${n.word('action', s(d['verb']))} 끝`;
    default:
      return `${typeKo} ${JSON.stringify(d)}`;
  }
}

/** 영수증 한 장을 글자판으로. */
export function receiptText(r: Receipt, n: ReceiptNames): string {
  const out: string[] = [];
  out.push(DOUBLE, `  하루 영수증 · ${r.day}일차`, `  ${r.run.scenario} · seed ${r.run.seed}`, `  앞 영수증 ${r.prev_seal.slice(0, 12)}`, RULE);
  if (r.items.length === 0) out.push('  (이 날 기록된 사건 없음)');
  for (const it of r.items) {
    const cause = it.cause === null ? '' : ` ← ${it.cause}${it.cause_day !== undefined ? ` (${it.cause_day}일)` : ''}`;
    const via = typeof it.data['via'] === 'string' ? ` · ${n.via(it.data['via'])}` : '';
    out.push(`  ${hhmm(it.t)}  ${itemText(it, n, r.day)}`, `         ${it.seq}${cause}${via}`);
  }
  out.push(RULE, `  사건 ${r.tally.n}건`);
  for (const [type, c] of Object.entries(r.tally.by_type)) out.push(`    ${n.word('event_type', type)} ${c}`);
  out.push(RULE, '  마감 (다음 날로 넘어감)');
  const state = Object.entries(r.close.state);
  out.push(`    세계 ${state.length === 0 ? '없음' : ''}`);
  for (const [key, level] of state) {
    const k = n.key(key);
    out.push(`      ${k.what}=${n.level(k.feature, level)}`);
  }
  for (const [who, row] of Object.entries(r.close.aware)) {
    out.push(`    ${n.thing(who)}의 앎`);
    for (const [key, a] of Object.entries(row)) {
      const k = n.key(key);
      out.push(`      ${k.what}=${n.level(k.feature, a.level)} (${n.word('awareness', a.aw)})`);
    }
  }
  out.push(`    넘어가는 예약 ${r.close.open_delays.length}건${r.close.open_delays.length ? `: ${r.close.open_delays.join(', ')}` : ''}`);
  out.push(RULE, `  봉인 ${r.seal.slice(0, 12)}`, DOUBLE, '');
  return out.join('\n');
}
