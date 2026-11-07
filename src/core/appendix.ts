// 자동 생성 부록 (원 설계: make-bio-database 의 교과서 부록 `textbook --write / --check`)
//
// 저장소와 사전에서 계산한 "지금 값"을 문서로 만든다. 손으로 고치지 않고, 현재 코드·데이터와 다르면
// `--check`가 실패해서 문서가 낡는 것을 막는다. 순수 함수: 마크다운 문자열만 돌려준다.

import { PREFIX_KIND } from './db.ts';
import type { Db } from './db.ts';
import { buildEdges, chainRoots, chainsFrom, collectRules } from './chains.ts';
import { parseId } from './ids.ts';
import { describeStage, odorChain } from './odor.ts';
import type { Vocab } from './vocab.ts';

export const APPENDIX_PATH = 'docs/자동생성-부록.md';

export function appendixMarkdown(db: Db, vocab: Vocab): string {
  const out: string[] = [];
  out.push('# 부록 — 자동 생성 (지금 값)', '');
  out.push('> `node src/node/cli.ts appendix --write`로 만든다. 손으로 고치지 말 것. `--check`가 최신인지 본다.', '');

  // 1. 정의
  const ids = Object.keys(db.defs).sort();
  out.push('## 1. 정의', '');
  if (ids.length === 0) {
    out.push('(아직 없음)', '');
  } else {
    out.push('| 번호 | 종류 | 이름 | 이동성 | 부위 | 규칙 |', '|---|---|---|---|---|---|');
    for (const id of ids) {
      const d = db.defs[id];
      if (d === undefined) continue;
      const p = parseId(id);
      const kind = p !== null && p.kind === 'def' ? PREFIX_KIND[p.prefix] : '?';
      const slots = Object.entries(d.slots ?? {})
        .map(([k, s]) => `${k}(${s.features.join('·')})`)
        .join(', ');
      out.push(`| ${id} | ${kind} | ${d.names.ko} | ${d.mobility ?? '—'} | ${slots || '—'} | ${Object.keys(d.rules ?? {}).length} |`);
    }
    out.push('');
  }

  // 2. 규칙 사슬
  const rules = collectRules(db);
  const edges = buildEdges(rules, vocab, db);
  out.push('## 2. 규칙 사슬', '');
  if (rules.length === 0) {
    out.push('(규칙 없음)', '');
  } else {
    out.push(`규칙 ${rules.length}개, 자동 연결 ${edges.length}개.`, '');
    const label = (ref: string): string => {
      const r = rules.find((x) => x.ref === ref);
      return r?.rule.label !== undefined ? `${ref} (${r.rule.label})` : ref;
    };
    for (const root of chainRoots(rules, edges)) {
      const paths = chainsFrom(edges, root).filter((p) => p.length > 1);
      if (paths.length === 0) continue;
      out.push(`- 시작: ${label(root)}`);
      for (const path of paths) out.push(`  - ${path.map((r) => r.split('/rule/')[1]).join(' → ')}`);
    }
    out.push('');
  }

  // 3. 냄새의 원인 사슬 (사전의 지식에서 계산)
  out.push('## 3. 냄새의 원인 사슬', '', '원인의 단계 → 균주 → 유기화합물 → 냄새 종류. 사전 `odor_cause`·`strain`·`compound`·`odor_kind`에서 계산한 것이고, 대표 냄새는 가장 심각한 종류다. 서지로 확인하지 않은 지식이다 (`verified: false`).', '');
  for (const st of odorChain(vocab)) out.push(`- ${describeStage(vocab, st)}`);
  out.push('');

  // 4. 사전
  out.push('## 4. 사전', '', '| 분류 | 항목 수 |', '|---|---|');
  for (const c of vocab.categories()) out.push(`| ${c} | ${vocab.keys(c).length} |`);
  out.push('');
  return out.join('\n');
}
