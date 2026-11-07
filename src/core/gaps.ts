// 원인 빈칸과 한계 등록부 (docs/영수증-명세.md 6장 · 원 설계: make-bio-database limitations.md)
//
// 영수증에서 원인(cause)이 비어 있는 사건을 걸러 내고, 한계 등록부(data/limitations.json)의 항목과 맞춘다.
//   - 원인 빈칸 파일(docs/원인-빈칸.md): 항목별로 몇 건, 어느 날, 예시 사건과 같은 시각의 앞 사건(원인 후보)
//   - 한계 등록부(docs/한계-등록부.md): 항목과 계산된 상태 (빈칸이 남아 있으면 열림, 0건이면 해결)
// 두 파일 모두 자동 생성이다. 엔진을 고쳐 빈칸이 줄면 다시 만들어 줄어든 것을 본다. 손으로 고치지 않는다.
// 등록부에 맞는 항목이 없는 빈칸은 "등록 안 됨"으로 따로 보인다 (시험이 0건을 요구한다).

import type { JsonValue } from './events.ts';
import type { Receipt, ReceiptItem } from './receipt.ts';
import { itemText } from './receipt-text.ts';
import type { ReceiptNames } from './receipt-text.ts';

export const GAPS_PATH = 'docs/원인-빈칸.md';
export const LIMITATIONS_PATH = 'docs/한계-등록부.md';
export const LIMITATIONS_DATA = 'data/limitations.json';
export const LIMITATION_KINDS = ['설계 오류', '기능 부재', '원천'] as const;
export type LimitationKind = (typeof LIMITATION_KINDS)[number];

export interface GapTarget {
  readonly type: string;
  readonly src: string;
  /** 사건 data에서 같아야 하는 값 (없으면 유형·출처만 본다) */
  readonly data?: { readonly [key: string]: JsonValue };
}

export interface Limitation {
  readonly id: string;
  readonly kind: LimitationKind;
  readonly title: string;
  /** 영수증의 원인 빈칸과 맞출 대상. 없으면(null) 상태를 계산하지 않고 status를 쓴다 */
  readonly targets: readonly GapTarget[];
  readonly status: string | null;
  readonly finding: string;
  readonly evidence: readonly string[];
  readonly fix: string;
  readonly found: string;
}

export interface Registry {
  readonly kinds: { readonly [kind: string]: string };
  readonly entries: readonly Limitation[];
}

export class RegistryError extends Error {
  override name = 'RegistryError';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTarget(v: unknown, at: string): GapTarget {
  if (!isObj(v) || typeof v['type'] !== 'string' || typeof v['src'] !== 'string') throw new RegistryError(`${at}: 대상은 { type, src, data? }여야 한다`);
  const data = v['data'];
  if (data !== undefined && !isObj(data)) throw new RegistryError(`${at}.data는 객체여야 한다`);
  const out: Record<string, JsonValue> = {};
  for (const [k, x] of Object.entries(data ?? {})) {
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') throw new RegistryError(`${at}.data.${k}는 문자열·숫자·참거짓이어야 한다`);
    out[k] = x;
  }
  return { type: v['type'], src: v['src'], ...(data === undefined ? {} : { data: out }) };
}

/** data/limitations.json을 해석한다. 모양이 틀리거나 번호가 겹치면 던진다. */
export function parseRegistry(raw: unknown): Registry {
  if (!isObj(raw) || raw['format'] !== 'small-happiness-limitations' || raw['version'] !== 1) throw new RegistryError('한계 등록부 형식이 아니다 (small-happiness-limitations v1)');
  if (!isObj(raw['kinds']) || !Array.isArray(raw['entries'])) throw new RegistryError('kinds(객체)와 entries(목록)가 필요하다');
  const kinds: Record<string, string> = {};
  for (const k of LIMITATION_KINDS) {
    const d = raw['kinds'][k];
    if (typeof d !== 'string') throw new RegistryError(`종류 "${k}"의 설명이 없다`);
    kinds[k] = d;
  }
  const seen = new Set<string>();
  const entries = raw['entries'].map((e: unknown, i): Limitation => {
    const at = `entries[${i}]`;
    if (!isObj(e)) throw new RegistryError(`${at}: 객체가 아니다`);
    const id = e['id'], kind = e['kind'];
    if (typeof id !== 'string' || !/^LIM\d{3}$/.test(id)) throw new RegistryError(`${at}: id는 LIM000 꼴이어야 한다`);
    if (seen.has(id)) throw new RegistryError(`${id}: 번호가 겹친다`);
    seen.add(id);
    if (typeof kind !== 'string' || !(LIMITATION_KINDS as readonly string[]).includes(kind)) throw new RegistryError(`${id}: 종류는 ${LIMITATION_KINDS.join(' / ')} 중 하나`);
    for (const f of ['title', 'finding', 'fix', 'found']) if (typeof e[f] !== 'string' || e[f] === '') throw new RegistryError(`${id}: ${f}가 필요하다`);
    if (!Array.isArray(e['evidence']) || !e['evidence'].every((x) => typeof x === 'string')) throw new RegistryError(`${id}: evidence는 문자열 목록`);
    const target = e['target'];
    const also = e['also'];
    if (also !== undefined && !Array.isArray(also)) throw new RegistryError(`${id}: also는 대상 목록`);
    const targets = target === null ? [] : [parseTarget(target, `${id}.target`), ...(also ?? []).map((x: unknown, k: number) => parseTarget(x, `${id}.also[${k}]`))];
    const status = e['status'];
    if (target === null && typeof status !== 'string') throw new RegistryError(`${id}: 대상이 없으면 status를 적는다 (계산할 수 없으므로)`);
    if (target !== null && status !== undefined) throw new RegistryError(`${id}: 대상이 있으면 status는 계산된다 (적지 않는다)`);
    return {
      id,
      kind: kind as LimitationKind,
      title: e['title'] as string,
      targets,
      status: typeof status === 'string' ? status : null,
      finding: e['finding'] as string,
      evidence: [...(e['evidence'] as string[])],
      fix: e['fix'] as string,
      found: e['found'] as string,
    };
  });
  return { kinds, entries };
}

const matches = (t: GapTarget, it: ReceiptItem): boolean =>
  t.type === it.type && t.src === it.src && Object.entries(t.data ?? {}).every(([k, v]) => it.data[k] === v);

export interface GapHit {
  readonly scenario: string;
  readonly day: number;
  readonly item: ReceiptItem;
  /** 같은 날, 같은 시각 또는 그 앞의 바로 앞 사건 (원인 후보로 보인다. 원인이라고 단정하지 않는다) */
  readonly before: ReceiptItem | null;
}

export interface GapReport {
  /** 등록부 번호 → 걸린 빈칸 */
  readonly byEntry: ReadonlyMap<string, readonly GapHit[]>;
  /** 등록부에 맞는 항목이 없는 빈칸 */
  readonly unregistered: readonly GapHit[];
  readonly scenarios: readonly { readonly scenario: string; readonly days: number; readonly events: number; readonly gaps: number }[];
}

/** 영수증 묶음들에서 원인 빈칸을 걸러 등록부 항목에 맞춘다. 항목은 앞에 있는 것이 먼저 맞는다 (자세한 대상을 앞에 둔다). */
export function findGaps(runs: readonly (readonly Receipt[])[], registry: Registry): GapReport {
  const byEntry = new Map<string, GapHit[]>(registry.entries.map((e) => [e.id, []]));
  const unregistered: GapHit[] = [];
  const scenarios = runs.map((receipts) => {
    let gaps = 0, events = 0;
    for (const r of receipts) {
      r.items.forEach((item, k) => {
        events++;
        if (item.cause !== null) return;
        gaps++;
        const hit: GapHit = { scenario: r.run.scenario, day: r.day, item, before: k > 0 ? (r.items[k - 1] ?? null) : null };
        const entry = registry.entries.find((e) => e.targets.some((t) => matches(t, item)));
        if (entry === undefined) unregistered.push(hit);
        else byEntry.get(entry.id)?.push(hit);
      });
    }
    return { scenario: receipts[0]?.run.scenario ?? '', days: receipts.length, events, gaps };
  });
  return { byEntry, unregistered, scenarios };
}

const hhmm = (t: number): string => `${String(Math.floor((t % 1440) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function statusOf(e: Limitation, hits: readonly GapHit[]): string {
  if (e.status !== null) return e.status;
  if (e.kind === '원천') return `원천 (${hits.length}건, 한계 아님)`;
  return hits.length > 0 ? `열림 (${hits.length}건)` : '해결 (0건)';
}

const SAMPLES = 3;

/** docs/원인-빈칸.md */
export function gapsMarkdown(report: GapReport, registry: Registry, names: ReadonlyMap<string, ReceiptNames>): string {
  const out: string[] = [];
  out.push('# 원인 빈칸 (영수증에서 걸러 냄)', '');
  out.push('> `node src/node/cli.ts gaps --write`로 만든다. 손으로 고치지 말 것. `--check`가 최신인지 본다. 근거: `영수증-명세.md` 6장, `한계-등록부.md`', '');
  out.push('영수증에서 원인(`cause`)이 비어 있는 사건만 걸러 낸 목록이다. 엔진을 고쳐 원인이 이어지면 다시 만들어 줄어든 것을 본다.');
  out.push('"앞 사건"은 같은 날 바로 앞에 기록된 사건이다. **원인 후보로 보일 뿐 원인이라고 단정하지 않는다.**', '');
  out.push('| 시나리오 | 날 | 사건 | 원인 빈칸 |', '|---|---|---|---|');
  for (const s of report.scenarios) out.push(`| \`${s.scenario}\` | ${s.days} | ${s.events} | ${s.gaps} |`);
  out.push('');
  const show = (h: GapHit): string => {
    const n = names.get(h.scenario);
    const text = (it: ReceiptItem): string => (n === undefined ? it.type : itemText(it, n, h.day));
    const before = h.before === null ? '—' : `${h.before.seq} ${hhmm(h.before.t)} ${text(h.before)}`;
    return `| ${h.day}일 ${hhmm(h.item.t)} | ${h.item.seq} ${cell(text(h.item))} | ${cell(before)} |`;
  };
  for (const e of registry.entries) {
    const hits = report.byEntry.get(e.id) ?? [];
    if (e.targets.length === 0) continue;
    out.push(`## ${e.id} · ${e.title}`, '', `종류: **${e.kind}** · 상태: ${statusOf(e, hits)} · 대상: ${e.targets.map((t) => `\`${t.type}\`/${t.src}${t.data ? ` ${JSON.stringify(t.data)}` : ''}`).join(', ')}`, '');
    if (hits.length === 0) {
      out.push('빈칸 없음.', '');
      continue;
    }
    const byScenario = new Map<string, GapHit[]>();
    for (const h of hits) byScenario.set(h.scenario, [...(byScenario.get(h.scenario) ?? []), h]);
    for (const [scenario, list] of byScenario) {
      const days = [...new Set(list.map((h) => h.day))];
      out.push(`- \`${scenario}\`: ${list.length}건 (날 ${days.join(', ')}). 처음 ${Math.min(SAMPLES, list.length)}건:`, '', '| 언제 | 사건 | 앞 사건 (원인 후보) |', '|---|---|---|');
      for (const h of list.slice(0, SAMPLES)) out.push(show(h));
      out.push('');
    }
  }
  out.push('## 등록 안 됨', '');
  if (report.unregistered.length === 0) out.push('없음. (새 빈칸이 생기면 여기에 나오고 시험이 실패한다. `data/limitations.json`에 항목을 더한다)', '');
  else {
    out.push('| 언제 | 사건 | 앞 사건 (원인 후보) |', '|---|---|---|');
    for (const h of report.unregistered) out.push(show(h));
    out.push('');
  }
  return out.join('\n');
}

/** docs/한계-등록부.md */
export function limitationsMarkdown(report: GapReport, registry: Registry): string {
  const out: string[] = [];
  out.push('# 한계 등록부', '');
  out.push(`> 원본 \`${LIMITATIONS_DATA}\`에서 \`node src/node/cli.ts gaps --write\`로 만든다. 이 파일은 손으로 고치지 말 것 (항목은 원본에 더한다). 근거: 원 프로젝트 make-bio-database \`limitations.md\`, \`원인-빈칸.md\``, '');
  out.push('엔진이 아직 하지 못하는 것과 그 이유를 모은다. 항목은 원본 JSON에 더하고 고친다. **상태는 계산된다**: 대상이 있는 항목은 영수증에 그 빈칸이 남아 있으면 열림, 0건이면 해결.', '');
  out.push('| 종류 | 뜻 | 항목 |', '|---|---|---|');
  for (const [k, d] of Object.entries(registry.kinds)) out.push(`| ${k} | ${d} | ${registry.entries.filter((e) => e.kind === k).length} |`);
  out.push('', '| ID | 종류 | 한계 | 상태 | 해결 경로 |', '|---|---|---|---|---|');
  for (const e of registry.entries) out.push(`| ${e.id} | ${e.kind} | ${cell(e.title)} | ${statusOf(e, report.byEntry.get(e.id) ?? [])} | ${cell(e.fix)} |`);
  out.push('');
  for (const e of registry.entries) {
    out.push(`## ${e.id} · ${e.title}`, '', `- 종류: ${e.kind}`, `- 상태: ${statusOf(e, report.byEntry.get(e.id) ?? [])}`, `- 발견: ${e.found}`, `- 조사: ${e.finding}`, `- 근거: ${e.evidence.map((x) => `\`${x}\``).join(', ')}`, `- 해결 경로: ${e.fix}`, '');
  }
  return out.join('\n');
}
