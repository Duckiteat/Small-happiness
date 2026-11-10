// 줄글 스크립트 (S7 · 언어와-문법 4장 B안, 작가 2026-11-09): 파일 하나 = 이벤트 하나 → 이벤트 원본(file_kind events) → 컴파일 → 패치
//
//   # 이벤트: 냉장고 냄새
//   번호: EVT+1                        (없으면 EVT+1, 병합 뒤에는 정식 번호)
//   이유: 왜 이 이벤트를 두는가         (필수)
//   핵심: PLC000002|space:odor          (심상 사다리를 타는 장소의 종류 키)
//   닫힘: PLC000002|space:smell@<=none  (하나 이상, 모두 맞으면 닫힌다)
//   설명: 한 줄 설명                    (여러 번 써도 된다)
//   고침: 이번에 고친 이유              (있으면 패치의 이유가 된다)
//
//   ## 이름 / 감각 / 칸 [/ 조건 …]   — 조건: 하루 구간 · 모드 · 귀가 · 못 참음 · 카드:카드 · 떠올림:개념 · 종류:냄새 종류 · 특징>=단계
//   작가의 문장. 한 줄이 한 문장이다. 누를 말은 {보이는 말|동사} 또는 {보이는 말|동사|라벨}.
//
// 감각·칸·하루 구간·모드는 사전의 이름·별칭·키 어느 것이든 쓴다. 동사는 사전의 주의(attention)·행동(action) 단어이거나
// 같은 이벤트의 장면 이름이다 (관문이 다시 본다). 문장은 고치지 않고 그대로 저장한다 (원문 바이트 통과). 보간은 없다.
// 해석하지 못하면 줄 번호가 있는 오류다. 순수 함수: 파일을 읽지 않는다.

import type { Vocab } from './vocab.ts';

export interface ScriptIssue {
  readonly line: number;
  readonly msg: string;
}

type Obj = Record<string, unknown>;

const ANCHOR_RE = /\{([^{}|]+)\|([^{}|]+)(?:\|([^{}|]+))?\}/g;
const HEADER_KEYS: Readonly<Record<string, string>> = { 번호: 'id', 이유: 'why', 고침: 'fix', 핵심: 'core', 닫힘: 'closes', 설명: 'desc' };

/**
 * 장면 머리의 조건 하나: 하루 구간 · 모드 · 장면 조건(사전 scene_cond: 귀가 · 못 참음 · 카드:값 · 떠올림:값 · 종류:값) · 내면 특징 조건(불쾌>=큼).
 * 표준 모양: day_part·mode는 키, 나머지는 `came_home` · `urgent` · `card:키` · `concept:번호나 원인 키` · `kind:단계 키` · `inner:특징@조건`.
 */
export function sceneCond(word: string, vocab: Vocab, resolveDef: (name: string) => string | null): { kind: 'day_part' | 'mode' | 'cond'; value: string } | null {
  const w = word.trim();
  const op = /^(.+?)(>=|<=|=)(.+)$/.exec(w);
  if (op !== null && !w.includes(':')) {
    const f = vocab.resolve('feature', (op[1] ?? '').trim());
    if (f === null || vocab.entry('feature', f)?.attrs['inner'] !== true) return null;
    const lv = levelKey(vocab, f, (op[3] ?? '').trim());
    return lv === null ? null : { kind: 'cond', value: `inner:${f}@${op[2] ?? ''}${lv}` };
  }
  const colon = w.indexOf(':');
  if (colon > 0) {
    const key = vocab.resolve('scene_cond', w.slice(0, colon).trim());
    const raw = w.slice(colon + 1).trim();
    const value = key === null ? undefined : vocab.entry('scene_cond', key)?.attrs['value'];
    if (key === null || raw === '') return null;
    if (value === 'outside_card') {
      const c = vocab.resolve('outside_card', raw);
      return c === null ? null : { kind: 'cond', value: `card:${c}` };
    }
    if (value === 'concept') {
      const c = vocab.resolve('odor_cause', raw) ?? resolveDef(raw);
      return c === null ? null : { kind: 'cond', value: `concept:${c}` };
    }
    if (value === 'kind') {
      const c = vocab.resolve('odor_kind', raw);
      return c === null ? null : { kind: 'cond', value: `kind:${c}` };
    }
    return null;
  }
  const dp = vocab.resolve('day_part', w);
  if (dp !== null) return { kind: 'day_part', value: dp };
  const md = vocab.resolve('mode', w);
  if (md !== null) return { kind: 'mode', value: md };
  const sc = vocab.resolve('scene_cond', w);
  return sc !== null && vocab.entry('scene_cond', sc)?.attrs['value'] === 'none' ? { kind: 'cond', value: sc } : null;
}

/** 특징의 단계를 이름·키로 찾는다. */
function levelKey(vocab: Vocab, feature: string, word: string): string | null {
  const levels = vocab.entry('feature', feature)?.attrs['levels'];
  if (!Array.isArray(levels)) return null;
  for (const l of levels) {
    if (typeof l !== 'object' || l === null || Array.isArray(l) || l['locked'] === true) continue;
    if (l['key'] === word || l['ko'] === word) return String(l['key']);
  }
  return null;
}

/** 문장 줄을 보이는 글로: 앵커는 보이는 말만 남긴다. */
export function renderLine(line: string): string {
  return line.replace(ANCHOR_RE, (_m, text: string) => text);
}

/** 스크립트 → 이벤트 원본 (compile.ts의 file_kind events). 오류가 하나라도 있으면 source는 null. */
export function parseScript(text: string, vocab: Vocab, resolveDef: (name: string) => string | null = () => null): { source: Obj | null; issues: ScriptIssue[] } {
  const issues: ScriptIssue[] = [];
  const err = (line: number, msg: string): void => void issues.push({ line, msg });
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let name: string | null = null;
  const head: { id?: string; why?: string; fix?: string; core?: string; closes: string[]; desc: string[] } = { closes: [], desc: [] };
  const scenes: { name: string; sense: string; rung: string; day_part?: string; mode?: string; conds?: string[]; lines: string[]; anchors: { line: number; text: string; verb: string; label?: string }[]; at: number }[] = [];
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (raw.trim() === '') return;
    if (raw.startsWith('# ')) {
      const m = /^# 이벤트:\s*(.+)$/.exec(raw);
      if (m === null) return void err(n, '첫 머리는 "# 이벤트: 이름"이어야 한다');
      if (name !== null) return void err(n, '이벤트 머리는 파일에 하나뿐이다 (파일 하나 = 이벤트 하나)');
      if (n !== lines.findIndex((l) => l.trim() !== '') + 1) return void err(n, '이벤트 머리는 첫 줄이어야 한다');
      name = (m[1] ?? '').trim();
      return;
    }
    if (name === null) return void err(n, '"# 이벤트: 이름"이 먼저 와야 한다');
    if (raw.startsWith('## ')) {
      const parts = raw.slice(3).split('/').map((x) => x.trim());
      const [sceneName, senseWord, rungWord, ...conds] = parts;
      if (sceneName === undefined || sceneName === '' || senseWord === undefined || rungWord === undefined) return void err(n, '장면 머리는 "## 이름 / 감각 / 칸 [/ 하루 구간 / 모드]"이다');
      const sense = vocab.resolve('sense', senseWord);
      const rung = vocab.resolve('rung', rungWord);
      if (sense === null) err(n, `사전에 없는 감각: ${senseWord}`);
      if (rung === null) err(n, `사전에 없는 사다리 칸: ${rungWord}`);
      const sc: (typeof scenes)[number] = { name: sceneName, sense: sense ?? senseWord, rung: rung ?? rungWord, lines: [], anchors: [], at: n };
      for (const c of conds) {
        const r = sceneCond(c, vocab, resolveDef);
        if (r === null) {
          err(n, `장면 조건 "${c}"를 읽지 못했다 (하루 구간 · 모드 · 귀가 · 못 참음 · 카드:카드 · 떠올림:개념 · 종류:냄새 종류 · 특징>=단계)`);
          continue;
        }
        if (r.kind === 'day_part' && sc.day_part === undefined) sc.day_part = r.value;
        else if (r.kind === 'mode' && sc.mode === undefined) sc.mode = r.value;
        else if (r.kind === 'cond' && !(sc.conds ?? []).includes(r.value)) sc.conds = [...(sc.conds ?? []), r.value];
        else err(n, `장면 조건 "${c}"가 겹친다`);
      }
      scenes.push(sc);
      return;
    }
    const cur = scenes.at(-1);
    if (cur === undefined) {
      const m = /^([^:：]+):\s*(.*)$/.exec(raw);
      const key = m === null ? undefined : HEADER_KEYS[(m[1] ?? '').trim()];
      if (m === null || key === undefined) return void err(n, `머리 줄은 ${Object.keys(HEADER_KEYS).join(' · ')} 중 하나다 ("키: 값")`);
      const value = (m[2] ?? '').trim();
      if (value === '') return void err(n, `${(m[1] ?? '').trim()}의 값이 비었다`);
      if (key === 'closes') head.closes.push(value);
      else if (key === 'desc') head.desc.push(value);
      else if (head[key as 'id' | 'why' | 'fix' | 'core'] !== undefined) err(n, `${(m[1] ?? '').trim()}는 한 번만 쓴다`);
      else head[key as 'id' | 'why' | 'fix' | 'core'] = value;
      return;
    }
    // 장면의 문장 한 줄: 원문 그대로. 앵커를 읽고, 짝이 맞지 않는 괄호와 아직 받지 않는 태그는 오류
    if (raw.includes('#')) err(n, '태그(#)는 아직 받지 않는다');
    const stripped = raw.replace(ANCHOR_RE, '');
    if (/[{}|]/.test(stripped)) err(n, '앵커는 {보이는 말|동사} 또는 {보이는 말|동사|라벨}이다 (괄호나 | 가 남았다)');
    for (const m of raw.matchAll(ANCHOR_RE)) {
      const verbWord = (m[2] ?? '').trim();
      const verb = vocab.resolve('attention', verbWord) ?? vocab.resolve('action', verbWord) ?? verbWord;
      cur.anchors.push({ line: cur.lines.length, text: m[1] ?? '', verb, ...(m[3] !== undefined ? { label: m[3].trim() } : {}) });
    }
    cur.lines.push(raw);
  });
  if (name === null) err(1, '"# 이벤트: 이름"이 없다');
  if (head.why === undefined) err(1, '이유가 필요하다 ("이유: …")');
  if (head.core === undefined) err(1, '핵심이 필요하다 ("핵심: 장소|부위:특징")');
  if (head.closes.length === 0) err(1, '닫힘 조건이 없는 이벤트는 받지 않는다 ("닫힘: 패턴")');
  for (const sc of scenes) if (sc.lines.length === 0) err(sc.at, `장면 "${sc.name}"에 문장이 없다`);
  if (scenes.length === 0) err(1, '장면이 하나도 없다');
  if (issues.length > 0) return { source: null, issues };
  return {
    source: {
      format_version: 1,
      file_kind: 'events',
      why: head.fix ?? head.why, // 고친 패치는 '고침'을 이유로 (처음 이유는 이벤트의 것으로 남는다)
      defs: [
        {
          id: head.id ?? 'EVT+1',
          names: { ko: name },
          ...(head.desc.length > 0 ? { desc: head.desc } : {}),
          core: head.core,
          closes: head.closes,
          scenes: scenes.map(({ at: _at, ...sc }) => sc),
        },
      ],
    },
    issues,
  };
}
