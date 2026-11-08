// 사건의 근거 참조 `via` (docs/영수증-명세.md 7장 · 결정-기록 "사건의 근거 via")
//
// 사건은 두 가지 이유를 갖는다. 직전의 어떤 사건이 일으켰나(`cause`, 사건 번호 하나)와,
// 어떤 규칙·행동·법칙·감각이 만들었나(`data.via`, 정의 안의 자리 하나).
// 단계는 규칙 참조와 대상만 갖는다 (원 프로젝트 make-bio-database의 단계 = 규칙 적용 기록).
// 근거가 여럿인 조건은 via의 정의에 있고, 어느 값이 거기 맞았는지는 기록에서 다시 계산한다.
//
// 모양: `정의 번호/종류/키`
//   rule      정의의 규칙 (생성된 번짐 규칙 포함)         PLC000002/rule/odor_thicken
//   offer     정의가 내놓는 행동                          PLC000002/offer/inspect
//   progress  그 정의의 인스턴스에 걸린 진행 법칙(특징)    OBJ000003/progress/decay
//   sense     인물 정의의 감각                            CHR000001/sense/smell
// 어느 사건 유형이 어떤 종류의 via를 가져야 하는지는 사전 event_type의 `via_kinds`에 있다.

import type { JsonValue } from './events.ts';

export const VIA_KINDS = ['rule', 'offer', 'progress', 'sense'] as const;
export type ViaKind = (typeof VIA_KINDS)[number];

export interface Via {
  readonly owner: string;
  readonly kind: ViaKind;
  readonly key: string;
}

const VIA_RE = /^([A-Z]{3}\d{6})\/(rule|offer|progress|sense)\/([a-z][a-z0-9_]*)$/;

export function formatVia(owner: string, kind: ViaKind, key: string): string {
  return `${owner}/${kind}/${key}`;
}

/** 근거 참조를 읽는다. 모양이 아니면 null. */
export function parseVia(text: string): Via | null {
  const m = VIA_RE.exec(text);
  return m === null ? null : { owner: m[1] as string, kind: m[2] as ViaKind, key: m[3] as string };
}

/** 사전 event_type의 via_kinds를 읽는다. 없으면 이 유형은 via를 갖지 않는다. */
export function viaKindsOf(attrs: { readonly [key: string]: JsonValue }): readonly ViaKind[] | undefined {
  const raw = attrs['via_kinds'];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((k): k is ViaKind => typeof k === 'string' && (VIA_KINDS as readonly string[]).includes(k));
}

/**
 * 사건 data가 via 규칙을 지키는가. 지키면 null, 어기면 이유.
 * kinds가 있으면 via가 필수이고 그 종류 중 하나여야 한다. 없으면 via를 가지면 안 된다.
 */
export function viaProblem(kinds: readonly ViaKind[] | undefined, data: { readonly [key: string]: JsonValue }): string | null {
  const via = data['via'];
  if (kinds === undefined) return via === undefined ? null : 'via는 이 사건 유형에 쓰지 않는다 (사전 event_type에 via_kinds가 없다)';
  if (typeof via !== 'string') return `via가 필요하다 (${kinds.join(' / ')})`;
  const p = parseVia(via);
  if (p === null) return `via 모양이 아니다: ${via} (정의 번호/종류/키)`;
  if (!kinds.includes(p.kind)) return `via 종류 ${p.kind}는 이 사건 유형에 맞지 않는다 (${kinds.join(' / ')})`;
  return null;
}

/** 사전에서 사건 유형별 via 종류를 찾는 함수 (영수증 검증에 넘긴다). */
export function viaKindsLookup(vocab: { entry(category: string, key: string): { readonly attrs: { readonly [key: string]: JsonValue } } | undefined }): (type: string) => readonly ViaKind[] | undefined {
  return (type) => viaKindsOf(vocab.entry('event_type', type)?.attrs ?? {});
}

/** 기록에 붙일 data 검사: 사전 event_type의 via_kinds대로 via를 요구한다. */
export function viaCheck(vocab: { entry(category: string, key: string): { readonly attrs: { readonly [key: string]: JsonValue } } | undefined }): (type: string, data: { readonly [key: string]: JsonValue }) => string | null {
  return (type, data) => viaProblem(viaKindsOf(vocab.entry('event_type', type)?.attrs ?? {}), data);
}
