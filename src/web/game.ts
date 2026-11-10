// 회색 상자 화면 (구현-계획 N2-3): 브라우저에서 엔진 입구(Session)를 부르고 그리기만 한다.
//
// 엔진 · 정의 · 사전은 빌드 때 한 HTML에 묶인다 (clerk.ts buildGame). 이 파일은 화면의 일만 한다:
//   - 시계와 진행 (다음 일까지 · +30분 · 저절로)
//   - 방 전체 ↔ 하루씨 곁: 장면이 열리면 장면 카드가 커지고, 사다리 칸이 오를수록 가까이 간다
//   - 줄글 속 말 누르기(attend), 요정의 조언(advise)
//   - 저장·불러오기 (브라우저 저장소, 입력의 기록)
// 계산은 하지 않는다: 보이는 것은 Session.screen / view / 새 사건의 글(narrate)뿐이다.

import { clockText, narrate } from '../core/console-play.ts';
import type { Narration } from '../core/console-play.ts';
import { parseDb } from '../core/db.ts';
import { CORE_NODE } from '../core/screen.ts';
import { Session, SessionError } from '../core/session.ts';
import { parseScenario } from '../core/skeleton.ts';
import type { View } from '../core/viewmodel.ts';
import { Vocab } from '../core/vocab.ts';
import type { VocabCategoryRaw } from '../core/vocab.ts';

/** 빌드가 HTML에 넣는 자료 */
export interface GameData {
  readonly content: string;
  readonly who: string;
  readonly db: unknown;
  readonly vocab: readonly VocabCategoryRaw[];
  readonly scenarios: readonly { readonly file: string; readonly title: string; readonly raw: unknown }[];
}

const RUNGS = ['feel', 'guess', 'narrow', 'thing'] as const;
const RUNG_KO: { readonly [k: string]: string } = { feel: '느낌', guess: '짐작', narrow: '좁힘', thing: '정체' };
const STATUS_KO: { readonly [k: string]: string } = { open: '열림', reopened: '다시 열림', closed: '닫힘', none: '' };
const SAVE_KEY = 'small-happiness-save-v1';
const AUTO_MS = 1400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function byId(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`화면에 #${id}가 없다`);
  return e;
}

function storageGet(): string | null {
  try {
    return window.localStorage.getItem(SAVE_KEY);
  } catch (e) {
    console.warn('저장소를 읽지 못했다', e);
    return null;
  }
}

function storageSet(text: string): boolean {
  try {
    window.localStorage.setItem(SAVE_KEY, text);
    return true;
  } catch (e) {
    console.warn('저장소에 쓰지 못했다', e);
    return false;
  }
}

class Game {
  readonly #data: GameData;
  readonly #vocab: Vocab;
  readonly #db: ReturnType<typeof parseDb>['db'] & object;
  #file: string;
  #s: Session;
  #log: { t: number; text: string; kind: string }[] = [];
  #options: { offer: string; at: string; verb: string; label: string }[] = [];
  #last: string = '';
  #timer: number | null = null;

  constructor(data: GameData) {
    this.#data = data;
    this.#vocab = new Vocab(data.vocab);
    const { db, issues } = parseDb(data.db);
    if (db === null) throw new Error(`정의 저장소가 올바르지 않다: ${issues.map((i) => i.msg).join(' · ')}`);
    this.#db = db;
    const first = data.scenarios[0];
    if (first === undefined) throw new Error('시나리오가 없다');
    this.#file = first.file;
    this.#s = this.#start(first.file);
  }

  #start(file: string): Session {
    const sc = this.#data.scenarios.find((x) => x.file === file);
    if (sc === undefined) throw new Error(`없는 시나리오: ${file}`);
    this.#file = file;
    this.#log = [];
    this.#options = [];
    this.#last = '';
    return Session.start(this.#db, this.#vocab, parseScenario(sc.raw));
  }

  mount(): void {
    const pick = byId('scenario') as HTMLSelectElement;
    for (const sc of this.#data.scenarios) {
      const o = el('option', undefined, sc.title);
      o.value = sc.file;
      pick.append(o);
    }
    pick.addEventListener('change', () => {
      this.#stopAuto();
      this.#s = this.#start(pick.value);
      this.#say('새 하루를 시작했다.');
      this.render();
    });
    byId('next').addEventListener('click', () => this.next());
    byId('plus').addEventListener('click', () => this.plus(30));
    byId('auto').addEventListener('click', () => (this.#timer === null ? this.#startAuto() : this.#stopAuto()));
    byId('save').addEventListener('click', () => this.save());
    byId('load').addEventListener('click', () => this.load());
    byId('restart').addEventListener('click', () => {
      this.#stopAuto();
      this.#s = this.#start(this.#file);
      this.#say('처음부터.');
      this.render();
    });
    this.render();
  }

  /** 보여 줄 것(행동·선택지·장면 바뀜)이 생길 때까지 진행 */
  next(): void {
    for (let n = this.#s.view().next; n !== null; n = this.#s.view().next) {
      if (this.#advance(n)) break;
    }
    this.render();
  }

  plus(min: number): void {
    if (this.#s.ended) return;
    this.#advance(Math.min(this.#s.endTime, this.#s.t + min));
    this.render();
  }

  /** 진행하고, 보여 줄 것이 생겼으면 true */
  #advance(until: number): boolean {
    const { events } = this.#s.advance(until);
    const items = narrate(this.#db, this.#vocab, this.#data.who, events);
    for (const n of items) this.#note(n);
    const v = JSON.stringify(this.#s.screen(this.#data.who));
    const changed = v !== this.#last;
    this.#last = v;
    return items.length > 0 || changed || this.#s.ended;
  }

  #note(n: Narration): void {
    if (n.kind === 'action') this.#log.push({ t: n.t, text: n.text, kind: 'action' });
    else if (n.kind === 'options') {
      this.#options = n.options.map((o) => ({ ...o }));
      this.#log.push({ t: n.t, text: `떠올린 선택지 ${n.options.length}개`, kind: 'options' });
    } else this.#log.push({ t: n.t, text: n.outcome === 'reached' ? '요정의 말이 닿았다' : '요정의 말을 듣지 않았다', kind: 'advice' });
  }

  #say(text: string): void {
    this.#log.push({ t: this.#s.t, text, kind: 'system' });
  }

  #startAuto(): void {
    this.#timer = window.setInterval(() => {
      if (this.#s.ended) return this.#stopAuto();
      this.next();
    }, AUTO_MS);
    this.render();
  }

  #stopAuto(): void {
    if (this.#timer !== null) window.clearInterval(this.#timer);
    this.#timer = null;
    this.render();
  }

  advise(i: number): void {
    const o = this.#options[i];
    if (o === undefined || this.#s.ended) return;
    this.#s.advise(o.offer, o.at);
    this.#say(`요정: "${o.label.split(' — ')[0] ?? o.label}, 어때?"`);
    this.render();
  }

  attend(anchor: string): void {
    try {
      this.#s.attend(this.#data.who, anchor);
      const a = this.#s.anchors(this.#data.who).find((x) => x.id === anchor);
      this.#say(`요정이 "${a?.text ?? anchor}"에 동그라미를 그렸다`);
    } catch (e) {
      if (!(e instanceof SessionError)) throw e;
      this.#say(e.message);
    }
    this.#last = JSON.stringify(this.#s.screen(this.#data.who));
    this.render();
  }

  save(): void {
    const ok = storageSet(JSON.stringify({ file: this.#file, session: this.#s.save(this.#data.content) }));
    this.#say(ok ? `${clockText(this.#s.t)}에 저장했다` : '저장하지 못했다 (브라우저 저장소를 쓸 수 없다)');
    this.render();
  }

  load(): void {
    const text = storageGet();
    if (text === null) {
      this.#say('저장한 하루가 없다');
      return this.render();
    }
    this.#stopAuto();
    try {
      const saved = JSON.parse(text) as { file: string; session: string };
      this.#start(saved.file);
      const { session, contentChanged } = Session.load(this.#db, this.#vocab, saved.session, this.#data.content);
      this.#s = session;
      (byId('scenario') as HTMLSelectElement).value = saved.file;
      this.#last = JSON.stringify(this.#s.screen(this.#data.who));
      this.#say(`${clockText(this.#s.t)}의 하루를 불러왔다${contentChanged ? ' (그 뒤로 게임 내용이 바뀌었다)' : ''}`);
    } catch (e) {
      this.#say(`불러오지 못했다: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }

  render(): void {
    const who = this.#data.who;
    const v = this.#s.screen(who);
    const step = this.#s.view().step;
    byId('clock').textContent = clockText(this.#s.t) + (this.#s.ended ? ' · 끝' : '');
    // 컨디션: 세계 상태의 인물 condition 칸 (이름과 단계는 사전에서)
    const state = step === null ? {} : (step.values['world.state'] as { readonly [k: string]: unknown } | undefined) ?? {};
    const chips = byId('condition');
    chips.replaceChildren();
    const prefix = `${who}|condition:`;
    for (const key of Object.keys(state).filter((k) => k.startsWith(prefix)).sort()) {
      const feature = key.slice(prefix.length);
      const level = String(state[key]);
      const f = this.#vocab.entry('feature', feature);
      const levels = f?.attrs['levels'];
      const lv = Array.isArray(levels) ? levels.find((l) => typeof l === 'object' && l !== null && !Array.isArray(l) && l['key'] === level) : undefined;
      const lko = typeof lv === 'object' && lv !== null && !Array.isArray(lv) && typeof lv['ko'] === 'string' ? lv['ko'] : level;
      chips.append(el('span', 'chip', `${f?.ko ?? feature} ${lko}`));
    }
    (byId('auto') as HTMLButtonElement).textContent = this.#timer === null ? '저절로 ▶' : '멈춤 ❚❚';
    (byId('auto') as HTMLButtonElement).setAttribute('aria-pressed', String(this.#timer !== null));
    for (const id of ['next', 'plus', 'auto']) (byId(id) as HTMLButtonElement).disabled = this.#s.ended && id !== 'auto';

    // 시점: 장면이 열려 있으면 하루씨 곁으로 (사다리 칸이 오를수록 가까이)
    const stage = byId('stage');
    const open = v !== null && v.event.status !== 'closed';
    const core = v?.nodes.find((n) => n.id === CORE_NODE);
    stage.dataset['view'] = open ? 'near' : 'room';
    stage.dataset['rung'] = open && core?.rung !== undefined ? core.rung : '';

    const last = [...this.#log].reverse().find((l) => l.kind === 'action');
    byId('doing').textContent = last === undefined ? '하루씨가 있다.' : last.text;
    this.#renderScene(v);
    this.#renderFairy();
    this.#renderLog();
  }

  #renderScene(v: View | null): void {
    const box = byId('scene');
    box.replaceChildren();
    if (v === null) {
      box.append(el('p', 'quiet', '아직 눈에 띄는 일이 없다.'));
      return;
    }
    const head = el('div', 'scene-head');
    head.append(el('strong', undefined, v.scene), el('span', 'place', ` · ${v.place}`), el('span', `status s-${v.event.status}`, STATUS_KO[v.event.status] ?? ''));
    box.append(head);

    const core = v.nodes.find((n) => n.id === CORE_NODE);
    if (core !== undefined) {
      const ladder = el('ol', 'ladder');
      ladder.setAttribute('aria-label', '심상 사다리');
      const at = RUNGS.indexOf((core.rung ?? 'feel') as (typeof RUNGS)[number]);
      RUNGS.forEach((r, i) => {
        const li = el('li', i < at ? 'past' : i === at ? 'now' : 'later', RUNG_KO[r]);
        if (i === at) li.setAttribute('aria-current', 'step');
        ladder.append(li);
      });
      const node = el('div', `node${core.state === 'done' ? ' done' : ''}`);
      node.append(el('span', 'node-label', core.label));
      box.append(ladder, node);
    }

    const prose = el('div', 'prose');
    const closed = v.event.status === 'closed';
    for (const para of v.prose) {
      const p = el('p');
      for (const seg of para) {
        if (seg.anchor === undefined) {
          p.append(document.createTextNode(seg.text));
          continue;
        }
        const id = seg.anchor;
        const circle = v.anchors.find((a) => a.id === id)?.circle ?? 'none';
        const b = el('button', `anchor c-${circle}`, seg.text);
        b.type = 'button';
        b.disabled = closed || circle !== 'none' || this.#s.ended;
        b.title = circle === 'none' ? '눌러서 하루씨의 주의를 돌린다' : '주의를 돌렸다';
        b.addEventListener('click', () => this.attend(id));
        p.append(b);
      }
      prose.append(p);
    }
    box.append(prose);
  }

  #renderFairy(): void {
    const box = byId('fairy');
    box.replaceChildren();
    if (this.#options.length === 0 || this.#s.ended) {
      box.append(el('p', 'quiet', '요정은 지켜보는 중.'));
      return;
    }
    box.append(el('p', 'quiet', '하루씨가 떠올린 것 — 하나를 권할 수 있다:'));
    const row = el('div', 'options');
    this.#options.forEach((o, i) => {
      const b = el('button', 'option', o.label);
      b.type = 'button';
      b.addEventListener('click', () => this.advise(i));
      row.append(b);
    });
    box.append(row);
  }

  #renderLog(): void {
    const box = byId('log');
    box.replaceChildren();
    for (const l of [...this.#log].reverse().slice(0, 40)) {
      const li = el('li', `k-${l.kind}`);
      li.append(el('time', undefined, clockText(l.t)), document.createTextNode(` ${l.text}`));
      box.append(li);
    }
  }
}

/** 페이지가 부른다: <script id="game-data" type="application/json">의 자료로 시작 */
export function boot(): void {
  const raw = document.getElementById('game-data')?.textContent ?? '';
  const data = JSON.parse(raw) as GameData;
  new Game(data).mount();
}
