// 줄글 스크립트 (S7 · 언어와-문법 4장 B안, 작가 2026-11-09): 파일 하나 = 이벤트 하나 → 이벤트 원본(file_kind events) → 컴파일 → 패치
//
//   # 이벤트: 냉장고 냄새
//   번호: EVT+1                        (없으면 EVT+1, 병합 뒤에는 정식 번호)
//   이유: 왜 이 이벤트를 두는가         (필수)
//   핵심: PLC000002|space:odor          (심상 사다리를 타는 장소의 종류 키)
//   닫힘: PLC000002|space:smell@<=none  (하나 이상, 모두 맞으면 닫힌다)
//   설명: 한 줄 설명                    (여러 번 써도 된다)
//
//   ## 이름 / 감각 / 칸 [/ 하루 구간 / 모드]
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
const HEADER_KEYS: Readonly<Record<string, string>> = { 번호: 'id', 이유: 'why', 핵심: 'core', 닫힘: 'closes', 설명: 'desc' };

/** 문장 줄을 보이는 글로: 앵커는 보이는 말만 남긴다. */
export function renderLine(line: string): string {
  return line.replace(ANCHOR_RE, (_m, text: string) => text);
}

/** 스크립트 → 이벤트 원본 (compile.ts의 file_kind events). 오류가 하나라도 있으면 source는 null. */
export function parseScript(text: string, vocab: Vocab): { source: Obj | null; issues: ScriptIssue[] } {
  const issues: ScriptIssue[] = [];
  const err = (line: number, msg: string): void => void issues.push({ line, msg });
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let name: string | null = null;
  const head: { id?: string; why?: string; core?: string; closes: string[]; desc: string[] } = { closes: [], desc: [] };
  const scenes: { name: string; sense: string; rung: string; day_part?: string; mode?: string; lines: string[]; anchors: { line: number; text: string; verb: string; label?: string }[]; at: number }[] = [];
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
        const dp = vocab.resolve('day_part', c);
        const md = vocab.resolve('mode', c);
        if (dp !== null && sc.day_part === undefined) sc.day_part = dp;
        else if (md !== null && sc.mode === undefined) sc.mode = md;
        else err(n, `장면 조건 "${c}"는 사전의 하루 구간·모드가 아니거나 같은 종류가 두 번이다`);
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
      else if (head[key as 'id' | 'why' | 'core'] !== undefined) err(n, `${(m[1] ?? '').trim()}는 한 번만 쓴다`);
      else head[key as 'id' | 'why' | 'core'] = value;
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
      why: head.why,
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
