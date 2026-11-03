// 패치 보고서 (docs/DB-개념-이식.md · 원 설계: make-bio-database 의 Patch Report)
//
//   범위(무엇이 바뀌었나) · 이유(why) · 영향(무엇이 따라 바뀌나) · 검증(관문 결과)
//
// 순수 함수: 병합 전후 저장소와 병합 보고, 관문 결과를 받아 보고서를 계산한다. 쓰기는 하지 않는다.

import { PREFIX_KIND } from './db.ts';
import type { Db } from './db.ts';
import { buildEdges, collectRules } from './chains.ts';
import type { Vocab } from './vocab.ts';
import { parseId } from './ids.ts';
import type { GateResult } from './gate.ts';
import type { MergeReport } from './patch.ts';
import { parsePattern } from './statekey.ts';

export interface PatchReport {
  readonly why: string;
  readonly scope: {
    readonly added: Record<string, string[]>;
    readonly updated: Record<string, { id: string; fields: string[] }[]>;
    readonly removed: Record<string, string[]>;
    readonly mapped: number;
  };
  readonly impact: {
    /** 바뀐 정의를 규칙 패턴으로 가리키는 다른 정의 */
    readonly referencedBy: Record<string, string[]>;
    /** 바뀐 정의가 소유하거나 가리키는 규칙이 있는 사슬 간선 */
    readonly chainEdges: { from: string; to: string }[];
    readonly newChainEdges: number;
  };
  readonly verification: {
    readonly pass: boolean;
    readonly reason: string;
    readonly errors: number;
    readonly warnings: number;
    readonly newErrors: number;
    readonly newWarnings: number;
  };
}

function kindOfId(id: string): string {
  const p = parseId(id);
  return p !== null && p.kind === 'def' ? PREFIX_KIND[p.prefix] : '?';
}

function groupByKind(ids: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of [...ids].sort()) (out[kindOfId(id)] ??= []).push(id);
  return out;
}

function targetsOf(db: Db, id: string): Set<string> {
  const out = new Set<string>();
  const def = db.defs[id];
  for (const rule of Object.values(def?.rules ?? {})) {
    for (const t of [...rule.on, ...rule.emits]) {
      const p = parsePattern(t);
      if (p !== null) out.add(p.def);
    }
  }
  return out;
}

export function patchReport(before: Db, after: Db, merge: MergeReport, gate: GateResult, vocab: Vocab): PatchReport {
  const changed = new Set<string>([...merge.added, ...merge.updated.map((u) => u.id), ...merge.removed]);

  const updated: Record<string, { id: string; fields: string[] }[]> = {};
  for (const u of [...merge.updated].sort((a, b) => a.id.localeCompare(b.id))) (updated[kindOfId(u.id)] ??= []).push(u);

  const referencedBy: Record<string, string[]> = {};
  for (const id of Object.keys(after.defs).sort()) {
    if (changed.has(id)) continue;
    const hit = [...targetsOf(after, id)].filter((t) => changed.has(t));
    for (const t of hit) (referencedBy[t] ??= []).push(id);
  }

  const edgesAfter = buildEdges(collectRules(after), vocab);
  const edgeKey = (e: { from: string; to: string }): string => `${e.from}>${e.to}`;
  const edgesBefore = new Set(buildEdges(collectRules(before), vocab).map(edgeKey));
  const touchesChanged = (ref: string): boolean => changed.has(ref.split('/rule/')[0] as string);
  const chainEdges = edgesAfter
    .filter((e) => touchesChanged(e.from) || touchesChanged(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  const newChainEdges = edgesAfter.filter((e) => !edgesBefore.has(edgeKey(e))).length;

  return {
    why: merge.why,
    scope: {
      added: groupByKind(merge.added),
      updated,
      removed: groupByKind(merge.removed),
      mapped: merge.mapped.length,
    },
    impact: { referencedBy, chainEdges, newChainEdges },
    verification: {
      pass: gate.pass,
      reason: gate.reason,
      errors: gate.errors.length,
      warnings: gate.warnings.length,
      newErrors: gate.newErrors.length + gate.mergeErrors.length,
      newWarnings: gate.newWarnings.length,
    },
  };
}

function nameOf(db: Db, id: string): string {
  return db.defs[id]?.names.ko ?? id;
}

export function patchReportMarkdown(report: PatchReport, after: Db): string {
  const out: string[] = [];
  out.push('## 패치 보고서', '', `**이유**: ${report.why}`, '');

  out.push('### 범위');
  const list = (title: string, rec: Record<string, string[]>): void => {
    for (const [kind, ids] of Object.entries(rec)) {
      out.push(`- ${title} ${kind} ${ids.length}: ${ids.map((i) => `${i}(${nameOf(after, i)})`).join(', ')}`);
    }
  };
  list('추가', report.scope.added);
  for (const [kind, items] of Object.entries(report.scope.updated)) {
    out.push(`- 수정 ${kind} ${items.length}: ${items.map((u) => `${u.id}(${u.fields.join('·')})`).join(', ')}`);
  }
  list('삭제', report.scope.removed);
  if (report.scope.mapped > 0) out.push(`- 이름·별칭을 번호·표준 키로 바꾼 곳: ${report.scope.mapped}`);
  if (out[out.length - 1] === '### 범위') out.push('- 바뀐 것 없음');
  out.push('');

  out.push('### 영향');
  const refs = Object.entries(report.impact.referencedBy);
  if (refs.length === 0) out.push('- 바뀐 정의를 규칙으로 가리키는 다른 정의: 없음');
  for (const [target, by] of refs) out.push(`- ${target}(${nameOf(after, target)})를 규칙으로 가리키는 정의: ${by.join(', ')}`);
  out.push(`- 새로 이어진 규칙 사슬 간선: ${report.impact.newChainEdges}`);
  for (const e of report.impact.chainEdges) out.push(`  - ${e.from} → ${e.to}`);
  out.push('');

  const v = report.verification;
  out.push('### 검증');
  out.push(v.pass ? '- 관문: **통과**' : `- 관문: **거부** (${v.reason})`);
  out.push(`- 오류 ${v.errors} (새 ${v.newErrors}) · 경고 ${v.warnings} (새 ${v.newWarnings})`);
  out.push('');
  return out.join('\n');
}
