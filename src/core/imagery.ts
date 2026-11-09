// ② 공감각 심상과 ⓑ 해석 전 행동 (내면-설계 3장·9장, 작가 2026-11-08):
// "두 가지 이상의 감각이 섞여 생기는 공감각적 심상", "해석 전 행동은 공감각적 심상에 대한 행동들. 따뜻한 단향을 맡고 표정이 풀리거나,
//  차가운 신향을 맡았을 때 몸이 떨리거나 닭살이 돋는 것".
//
// 사전 image: { parts: 서로 다른 감각 둘 이상의 감각질 }. 그 감각질들을 같은 때에 함께 느끼면 생긴다.
//   - 멀리서 느끼는 것끼리 다 갖춰지면 이어지는 심상: 생기고(on) 하나가 그치면 깨진다(off).
//   - 닿거나 먹은 순간의 감각이 하나라도 들어가면 그 순간의 심상: 그때 한 번 (moment).
// 사전 response: { on: [심상] } — 심상이 생기면 몸이 먼저 하는 반응(표정이 풀림, 떨림, 닭살). 요정이 닿지 않는다.
// 무엇에서 왔는지는 여전히 모른다 (해석은 그 위의 일). 난수 없음. 지각 층과 감사가 같은 계산을 쓴다.

import type { Vocab } from './vocab.ts';

export const IMAGE_FORMED = 'image_formed';
export const BODY_RESPONSE = 'body_response';

export interface ImageDef {
  readonly key: string;
  readonly parts: readonly string[];
}

/** 사전의 공감각 심상 (키 순). */
export function imageDefs(vocab: Vocab): ImageDef[] {
  return vocab.keys('image').sort().flatMap((key) => {
    const p = vocab.entry('image', key)?.attrs['parts'];
    return Array.isArray(p) ? [{ key, parts: p.map(String) }] : [];
  });
}

/** 그 심상에 붙은 몸의 반응 (키 순). */
export function responsesTo(vocab: Vocab, image: string): string[] {
  return vocab.keys('response').sort().filter((k) => {
    const on = vocab.entry('response', k)?.attrs['on'];
    return Array.isArray(on) && on.includes(image);
  });
}

/** 멀리서 느끼는 것만으로 다 갖춰졌나. */
export function sustained(img: ImageDef, distance: ReadonlySet<string>): boolean {
  return img.parts.every((p) => distance.has(p));
}

/** 이 순간의 감각이 하나라도 들어가고, 나머지는 멀리서 느끼고 있나. */
export function momentary(img: ImageDef, distance: ReadonlySet<string>, moment: ReadonlySet<string>): boolean {
  return img.parts.some((p) => moment.has(p)) && img.parts.every((p) => moment.has(p) || distance.has(p));
}
