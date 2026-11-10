// 텍스트 러너 (구현-계획 N2-1): 화면 없이 콘솔에서 하루를 진행하며 읽는다.
//
// 화면이 할 일을 글로 한다: 엔진 입구(Session)를 부르고, 새 사건 중 사람이 읽을 것과 화면 계약의 뷰(screen)를 글로 찍는다.
// 회색 상자 화면(N2-3)과 같은 입구·같은 뷰를 쓰므로, 여기서 읽히는 하루가 화면의 하루다.
//
//   (빈 줄) · n    보여 줄 것(행동·선택지·장면)이 생길 때까지 진행
//   +분           그만큼 진행 (하루의 끝에서 멈춘다)
//   a 번호        요정의 조언: 마지막으로 떠올린 선택지 중 하나를 권한다
//   p 번호        줄글 속 말 누르기 (주의 돌리기): [번호 말]의 번호
//   v            지금 화면을 다시 본다
//   ?            도움말
//   q            그만
//
// 순수 모듈이다: 입력 한 줄을 받아 찍을 줄을 돌려준다. 읽고 쓰는 일은 바깥(cli)이 한다.
// 이름은 코드에 없다 — 정의의 names와 사전의 ko에서 읽는다.

import { ACTION_CHOSEN, ADVICE_GIVEN, ADVICE_IGNORED, OPTIONS_FORMED } from './agency.ts';
import type { Db } from './db.ts';
import type { GameEvent } from './events.ts';
import { CORE_NODE } from './screen.ts';
import type { Session } from './session.ts';
import type { View } from './viewmodel.ts';
import type { Vocab } from './vocab.ts';

export const PLAY_HELP = '(빈 줄) 다음 일까지 · +분 그만큼 · a 번호 조언 · p 번호 말 누르기 · v 다시 보기 · ? 도움말 · q 그만';

const RUNG_KO: { readonly [k: string]: string } = { feel: '느낌', guess: '짐작', narrow: '좁힘', thing: '정체' };
const STATUS_KO: { readonly [k: string]: string } = { open: '열림', reopened: '다시 열림', closed: '닫힘', none: '없음' };

/** 절대 분 → "2일차 07:05" */
export function clockText(t: number): string {
  const day = Math.floor(t / 1440) + 1;
  const m = ((t % 1440) + 1440) % 1440;
  return `${day}일차 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 줄글 문단 하나를 글로: 눌리는 말은 [번호 말], 누른 말은 (번호 말) */
function paraText(view: View, para: View['prose'][number]): string {
  return para
    .map((s) => {
      if (s.anchor === undefined) return s.text;
      const n = s.anchor.replace(/^a/, '');
      return view.anchors.find((a) => a.id === s.anchor)?.circle === 'none' ? `[${n} ${s.text}]` : `(${n} ${s.text})`;
    })
    .join('');
}

/** 사람이 읽을 사건 하나 (텍스트 러너와 화면이 같이 쓴다) */
export type Narration =
  | { readonly kind: 'action'; readonly t: number; readonly verb: string; readonly text: string; readonly at: string | null }
  | { readonly kind: 'options'; readonly t: number; readonly options: readonly { readonly offer: string; readonly at: string; readonly verb: string; readonly label: string }[] }
  | { readonly kind: 'advice'; readonly t: number; readonly outcome: 'reached' | 'ignored' };

/** 새 사건 중 인물 who에 관해 사람이 읽을 것: 행동, 떠올린 선택지, 조언이 닿음·듣지 않음. 이름은 정의와 사전에서. */
export function narrate(db: Db, vocab: Vocab, who: string, events: readonly GameEvent[]): Narration[] {
  const name = (id: string): string => db.defs[id.split('#')[0] ?? id]?.names.ko ?? id;
  const ko = (key: string): string => vocab.entry('action', key)?.ko ?? key;
  const out: Narration[] = [];
  for (const e of events) {
    if (e.data['who'] !== who) continue;
    const at = typeof e.data['at'] === 'string' ? e.data['at'] : null;
    if (e.type === ACTION_CHOSEN && typeof e.data['verb'] === 'string') {
      out.push({ kind: 'action', t: e.t, verb: e.data['verb'], at, text: `${name(who)}: ${ko(e.data['verb'])}${at === null ? '' : ` — ${name(at)}`}` });
    } else if (e.type === OPTIONS_FORMED && Array.isArray(e.data['options'])) {
      const options = e.data['options'].flatMap((o) =>
        typeof o === 'object' && o !== null && !Array.isArray(o) && typeof o['offer'] === 'string' && typeof o['at'] === 'string' && typeof o['verb'] === 'string'
          ? [{ offer: o['offer'], at: o['at'], verb: o['verb'], label: `${ko(o['verb'])} — ${name(o['at'])}` }]
          : [],
      );
      out.push({ kind: 'options', t: e.t, options });
    } else if (e.type === ADVICE_GIVEN) out.push({ kind: 'advice', t: e.t, outcome: 'reached' });
    else if (e.type === ADVICE_IGNORED) out.push({ kind: 'advice', t: e.t, outcome: 'ignored' });
  }
  return out;
}

export class ConsolePlay {
  readonly #s: Session;
  readonly #db: Db;
  readonly #vocab: Vocab;
  readonly #who: string;
  #shown: View | null = null;
  #options: { offer: string; at: string; verb: string }[] = [];

  constructor(session: Session, db: Db, vocab: Vocab, who: string) {
    this.#s = session;
    this.#db = db;
    this.#vocab = vocab;
    this.#who = who;
  }

  #name(id: string): string {
    return this.#db.defs[id.split('#')[0] ?? id]?.names.ko ?? id;
  }

  #ko(category: string, key: string): string {
    return this.#vocab.entry(category, key)?.ko ?? key;
  }

  /** 처음 찍는 줄 */
  intro(): string[] {
    return [`— ${this.#name(this.#who)}의 하루 · ${clockText(this.#s.t)} —`, PLAY_HELP];
  }

  /** 입력 한 줄을 처리하고 찍을 줄을 돌려준다. */
  run(input: string): { lines: string[]; quit: boolean } {
    const cmd = input.trim();
    if (cmd === 'q') return { lines: ['그만.'], quit: true };
    if (cmd === '?') return { lines: [PLAY_HELP], quit: false };
    if (cmd === 'v') return { lines: this.#full(), quit: false };
    if (cmd === '' || cmd === 'n') {
      // 보여 줄 것이 생길 때까지 (또는 하루 끝까지) 엔진이 깨는 단계를 차례로 돈다
      for (let next = this.#s.view().next; next !== null; next = this.#s.view().next) {
        const lines = this.#advance(next);
        if (lines.length > 1) return { lines, quit: false };
      }
      return { lines: [`하루가 끝났다 (${clockText(this.#s.t)}).`], quit: false };
    }
    const plus = /^\+(\d+)$/.exec(cmd);
    if (plus !== null) {
      const end = this.#end();
      if (this.#s.t >= end) return { lines: [`하루가 끝났다 (${clockText(this.#s.t)}).`], quit: false };
      return { lines: this.#advance(Math.min(end, this.#s.t + Number(plus[1]))), quit: false };
    }
    const adv = /^a\s+(\d+)$/.exec(cmd);
    if (adv !== null) {
      const o = this.#options[Number(adv[1]) - 1];
      if (o === undefined) return { lines: [this.#options.length === 0 ? '권할 선택지가 아직 없다.' : `선택지는 1~${this.#options.length}번이다.`], quit: false };
      if (this.#s.ended) return { lines: ['하루가 끝나 조언이 닿지 않는다.'], quit: false };
      this.#s.advise(o.offer, o.at);
      return { lines: [`요정: "${this.#ko('action', o.verb)}, 어때?" (${this.#name(o.at)})`], quit: false };
    }
    const press = /^p\s+(\d+)$/.exec(cmd);
    if (press !== null) {
      const a = this.#s.anchors(this.#who).find((x) => x.id === `a${press[1]}`);
      if (a === undefined) return { lines: ['누를 수 있는 말이 아니다.'], quit: false };
      if (a.closed) return { lines: ['닫힌 장면의 말은 누를 수 없다.'], quit: false };
      if (this.#s.ended) return { lines: ['하루가 끝나 누를 수 없다.'], quit: false };
      this.#s.attend(this.#who, a.id);
      this.#shown = this.#s.screen(this.#who);
      return { lines: [`요정이 "${a.text}"에 동그라미를 그렸다.`], quit: false };
    }
    return { lines: [`모르는 입력이다. ${PLAY_HELP}`], quit: false };
  }

  /** 하루의 끝 (시나리오의 end). 그 너머로는 진행하지 않는다 */
  #end(): number {
    return this.#s.endTime;
  }

  #advance(until: number): string[] {
    const { events } = this.#s.advance(until);
    const out = [`· ${clockText(until)}`, ...this.#events(events), ...this.#scene()];
    if (this.#s.ended) out.push(`하루가 끝났다 (${clockText(this.#s.t)}).`);
    return out;
  }

  /** 사람이 읽을 사건: 행동, 선택지, 조언의 결과 */
  #events(events: readonly GameEvent[]): string[] {
    const out: string[] = [];
    for (const n of narrate(this.#db, this.#vocab, this.#who, events)) {
      if (n.kind === 'action') out.push(`  ${clockText(n.t).slice(-5)} ${n.text}`);
      else if (n.kind === 'options') {
        this.#options = n.options.map((o) => ({ offer: o.offer, at: o.at, verb: o.verb }));
        out.push(`  떠올린 선택지: ${n.options.map((o, i) => `${i + 1}) ${o.label}`).join(' · ')}`);
      } else out.push(n.outcome === 'reached' ? '  (조언이 닿았다)' : '  (조언을 듣지 않았다)');
    }
    return out;
  }

  /** 뷰가 바뀌었으면 바뀐 것만: 새 문단, 사다리 칸, 이벤트 상태 */
  #scene(): string[] {
    const v = this.#s.screen(this.#who);
    const prev = this.#shown;
    this.#shown = v;
    if (v === null || JSON.stringify(v) === JSON.stringify(prev)) return [];
    const sameEvent = prev !== null && prev.event.id === v.event.id && prev.event.status !== 'closed';
    const out: string[] = [];
    if (!sameEvent) out.push(`  【${v.scene} · ${v.place}】`);
    const from = sameEvent ? prev.prose.length : 0;
    for (const p of v.prose.slice(from)) out.push(`  ${paraText(v, p)}`);
    const core = v.nodes.find((n) => n.id === CORE_NODE);
    const prevCore = prev?.nodes.find((n) => n.id === CORE_NODE);
    if (core !== undefined && (!sameEvent || core.label !== prevCore?.label || core.rung !== prevCore?.rung)) out.push(`  ○ ${RUNG_KO[core.rung ?? ''] ?? ''}: ${core.label}`);
    if (v.event.status === 'closed' && prev?.event.status !== 'closed') out.push('  ● 닫힘');
    return out;
  }

  /** 지금 화면 전체 */
  #full(): string[] {
    const v = this.#s.screen(this.#who);
    const head = `· ${clockText(this.#s.t)}${this.#s.ended ? ' (하루 끝)' : ''}`;
    if (v === null) return [head, '  (보여 줄 장면이 없다)'];
    const core = v.nodes.find((n) => n.id === CORE_NODE);
    return [
      head,
      `  【${v.scene} · ${v.place}】 ${STATUS_KO[v.event.status] ?? v.event.status}`,
      ...v.prose.map((p) => `  ${paraText(v, p)}`),
      ...(core === undefined ? [] : [`  ○ ${RUNG_KO[core.rung ?? ''] ?? ''}: ${core.label}`]),
      ...(this.#options.length === 0 ? [] : [`  선택지: ${this.#options.map((o, i) => `${i + 1}) ${this.#ko('action', o.verb)} — ${this.#name(o.at)}`).join(' · ')}`]),
    ];
  }
}
