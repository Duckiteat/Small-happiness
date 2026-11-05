#!/usr/bin/env python3
"""격자 경계 상태 정의 — 활성 영역의 내부와 경계(임계점)를 정수 연산으로 뽑는다.

numpy 만 쓴다. 부동소수 합성곱 대신 불리언 연산과 정수 깊이를 써서 결과가 정확히 재현된다.
실행: python3 grid_boundary.py   (끝의 자체 검증이 모두 통과해야 한다)
"""
from __future__ import annotations

from collections import deque

import numpy as np

INF = 10**9  # 경계가 없는 영역(격자 전체)의 깊이


# ── 1. 양자화 ────────────────────────────────────────────────────────────────
def quantize(values, cuts):
    """값 → 구간 번호. cuts 는 오름차순 경계값. 구간 i 는 cuts[i-1] <= v < cuts[i]."""
    return np.searchsorted(np.asarray(cuts), values, side="right")


# ── 2. 영역(활성 셀) ─────────────────────────────────────────────────────────
def region_from_boxes(shape, boxes):
    """boxes: [[(lo, hi), ... 축마다], ...] 닫힌 구간 번호. 합집합 = 범위 조건의 OR-of-AND."""
    m = np.zeros(shape, dtype=bool)
    for box in boxes:
        m[tuple(slice(lo, hi + 1) for lo, hi in box)] = True
    return m


# ── 3. 이웃 연산 (von Neumann: 축 방향 이웃 2N개) ────────────────────────────
def _neighbors(mask, pad):
    """축마다 +1, -1 이동한 사본. 격자 밖은 pad 값으로 채운다."""
    out = []
    for ax in range(mask.ndim):
        for step in (1, -1):
            sh = np.full_like(mask, pad)
            dst = [slice(None)] * mask.ndim
            src = [slice(None)] * mask.ndim
            if step == 1:
                dst[ax], src[ax] = slice(1, None), slice(0, -1)
            else:
                dst[ax], src[ax] = slice(0, -1), slice(1, None)
            sh[tuple(dst)] = mask[tuple(src)]
            out.append(sh)
    return out


def erode(mask, pad=True):
    """모든 이웃이 활성일 때만 남긴다. pad=True: 격자 가장자리는 전이가 아니므로 밖을 활성으로 본다."""
    r = mask.copy()
    for n in _neighbors(mask, pad):
        r &= n
    return r


def dilate(mask):
    """이웃 중 하나라도 활성이면 켠다 (격자 밖은 비활성)."""
    r = mask.copy()
    for n in _neighbors(mask, False):
        r |= n
    return r


def inner_boundary(mask, pad=True):
    """영역 안쪽 테두리: 상태는 유지되지만 한 칸만 더 가면 벗어나는 셀."""
    return mask & ~erode(mask, pad)


def outer_boundary(mask):
    """영역 바깥 테두리: 영역에 처음 인접한 다른 상태의 셀."""
    return dilate(mask) & ~mask


def gradient(mask, pad=True):
    """형태학적 그래디언트 = 팽창 − 침식 (안쪽 테두리 ∪ 바깥 테두리)."""
    return dilate(mask) & ~erode(mask, pad)


def depth_map(mask, pad=True):
    """경계에서의 깊이(맨해튼 거리). 1 = 안쪽 테두리, 2 = 한 칸 안쪽, … 바깥은 0."""
    depth = np.zeros(mask.shape, dtype=np.int64)
    cur = mask.copy()
    d = 0
    while cur.any():
        d += 1
        nxt = erode(cur, pad)
        if np.array_equal(nxt, cur):  # 더는 깎이지 않는다: 경계가 닿지 않는 안쪽
            depth[cur] = INF
            break
        depth[cur & ~nxt] = d
        cur = nxt
    return depth


# ── 4. 판정 ──────────────────────────────────────────────────────────────────
def classify(idx, mask, depth, warn=0):
    """셀 하나를 판정한다. 깊이 표를 한 번만 읽는다.

    'outside'   영역 밖
    'boundary'  임계점 (안쪽 테두리)
    'near_edge' 경계에서 warn 칸 이내 — 예고 구간
    'interior'  안정 내부
    """
    if not mask[idx]:
        return "outside"
    d = depth[idx]
    if d == 1:
        return "boundary"
    if warn and d <= 1 + warn:
        return "near_edge"
    return "interior"


# ── 5. 겹침과 연결 성분 ──────────────────────────────────────────────────────
def label_components(mask):
    """von Neumann 연결 성분 번호 붙이기. (라벨 배열, 개수)"""
    labels = np.zeros(mask.shape, dtype=np.int64)
    n = 0
    for start in zip(*np.nonzero(mask)):
        if labels[start]:
            continue
        n += 1
        q = deque([start])
        labels[start] = n
        while q:
            c = q.popleft()
            for ax in range(mask.ndim):
                for st in (-1, 1):
                    nb = list(c)
                    nb[ax] += st
                    nb = tuple(nb)
                    if 0 <= nb[ax] < mask.shape[ax] and mask[nb] and not labels[nb]:
                        labels[nb] = n
                        q.append(nb)
    return labels, n


# ── 6. 테두리 조건으로 되돌리기 ──────────────────────────────────────────────
def to_boxes(mask):
    """영역을 겹치지 않는 상자들로 나눈다. 상자 하나 = 축마다 [lo, hi] 범위 조건의 곱(AND)."""
    rem = mask.copy()
    boxes = []
    for start in zip(*np.nonzero(mask)):
        if not rem[start]:
            continue
        lo, hi = list(start), list(start)
        for ax in range(mask.ndim):
            while hi[ax] + 1 < mask.shape[ax]:
                layer = [slice(l, h + 1) for l, h in zip(lo, hi)]
                layer[ax] = slice(hi[ax] + 1, hi[ax] + 2)
                if not rem[tuple(layer)].all():
                    break
                hi[ax] += 1
        rem[tuple(slice(l, h + 1) for l, h in zip(lo, hi))] = False
        boxes.append([(int(l), int(h)) for l, h in zip(lo, hi)])
    return boxes


def boundary_representation(mask, pad=True):
    """내부를 지우고 (안쪽 테두리, 내부 성분마다 씨앗 한 점)만 남긴다."""
    b = inner_boundary(mask, pad)
    labels, n = label_components(mask & ~b)
    seeds = [tuple(int(x) for x in np.argwhere(labels == k)[0]) for k in range(1, n + 1)]
    return b, seeds


def reconstruct(boundary, seeds):
    """테두리 + 씨앗에서 영역을 복원한다. 씨앗에서 테두리가 아닌 셀로만 번져 나간다."""
    region = boundary.copy()
    seen = set(seeds)
    q = deque(seeds)
    for s in seeds:
        region[s] = True
    while q:
        c = q.popleft()
        for ax in range(boundary.ndim):
            for st in (-1, 1):
                nb = list(c)
                nb[ax] += st
                nb = tuple(nb)
                if not (0 <= nb[ax] < boundary.shape[ax]) or nb in seen or boundary[nb]:
                    continue
                seen.add(nb)
                region[nb] = True
                q.append(nb)
    return region


# ── 7. 응용: 되먹임 문턱, 이름 없는 겹침 ─────────────────────────────────────
def hysteresis(trajectory, enter, stay):
    """enter 영역에 들어가면 켜지고 stay 영역(⊇ enter)을 벗어나야 꺼진다. 경계에서의 깜박임을 막는다."""
    on, out = False, []
    for cell in trajectory:
        on = bool(stay[cell]) if on else bool(enter[cell])
        out.append(on)
    return out


def unnamed_hotspots(visits, named_masks, threshold, min_size=2):
    """자주 방문했는데 이름이 없는 영역을 상자(범위 조건) 목록으로 돌려준다 — 작가가 이름을 붙일 후보."""
    named = np.zeros(visits.shape, dtype=bool)
    for m in named_masks:
        named |= m
    cand = (visits >= threshold) & ~named
    labels, n = label_components(cand)
    return [to_boxes(labels == k) for k in range(1, n + 1) if (labels == k).sum() >= min_size]


# ── 자체 검증 ────────────────────────────────────────────────────────────────
def _brute_depth(mask, pad):
    """무차별 대입: 활성 셀에서 가장 가까운 비활성 셀까지의 맨해튼 거리."""
    ext = np.pad(mask, 1, constant_values=False) if not pad else mask
    off = 1 if not pad else 0
    inactive = np.argwhere(~ext)
    depth = np.zeros(mask.shape, dtype=np.int64)
    for c in np.argwhere(mask):
        if len(inactive) == 0:
            depth[tuple(c)] = INF
        else:
            depth[tuple(c)] = int(np.abs(inactive - (c + off)).sum(axis=1).min())
    return depth


def _show(mask, depth):
    rows = []
    for i in range(mask.shape[0]):
        row = ""
        for j in range(mask.shape[1]):
            row += "." if not mask[i, j] else ("+" if depth[i, j] == 1 else "#")
        rows.append(row)
    return "\n".join(rows)


def main():
    rng = np.random.default_rng(0)

    # (가) 깊이는 무차별 대입과 같다 — 2D·3D, 가장자리를 전이로 보는 경우와 아닌 경우
    for shape in [(9, 9), (6, 7, 5)]:
        for pad in (True, False):
            for _ in range(20):
                m = rng.random(shape) < 0.7
                assert np.array_equal(depth_map(m, pad), _brute_depth(m, pad)), (shape, pad)
    print("깊이 = 무차별 대입 거리: 통과")

    # (나) 상자 분해는 영역을 정확히 덮고 서로 겹치지 않는다
    for shape in [(9, 9), (6, 7, 5)]:
        for _ in range(20):
            m = rng.random(shape) < 0.6
            boxes = to_boxes(m)
            assert np.array_equal(region_from_boxes(shape, boxes), m)
            vol = sum(int(np.prod([hi - lo + 1 for lo, hi in b])) for b in boxes)
            assert vol == int(m.sum())
    print("상자 분해 = 영역, 겹침 없음: 통과")

    # (다) 테두리 + 씨앗만으로 영역이 복원된다
    for shape in [(9, 9), (6, 7, 5)]:
        for pad in (True, False):
            for _ in range(20):
                m = rng.random(shape) < 0.75
                b, seeds = boundary_representation(m, pad)
                assert np.array_equal(reconstruct(b, seeds), m)
    print("테두리 + 씨앗 → 영역 복원: 통과")

    # (라) 되먹임 문턱은 깜박임을 줄인다
    enter = region_from_boxes((10, 10), [[(6, 9), (0, 4)]])
    stay = dilate(enter)
    path = [(5, 4), (6, 4), (5, 4), (6, 4), (5, 4), (6, 3), (5, 3), (6, 3)]
    plain = [bool(enter[c]) for c in path]
    held = hysteresis(path, enter, stay)
    flips = lambda xs: sum(a != b for a, b in zip(xs, xs[1:]))
    assert flips(held) < flips(plain)
    print(f"되먹임 문턱: 깜박임 {flips(plain)}번 → {flips(held)}번")

    # 예: 긴장(축0) × 여유(축1), 각 10구간. 불안 = 긴장 6~9 & 여유 0~4
    anxious = region_from_boxes((10, 10), [[(6, 9), (0, 4)]])
    depth = depth_map(anxious)
    print("\n불안 영역 (# 내부, + 경계, . 밖) — 행: 긴장 0~9, 열: 여유 0~9")
    print(_show(anxious, depth))
    for p in [(8, 1), (6, 4), (7, 2), (3, 3)]:
        print(p, classify(p, anxious, depth, warn=1))

    # 예: 겹침 = 불안 ∧ 지침(여유 0~3 & 에너지 낮음을 2D로 줄여 긴장 3~7 & 여유 0~3)
    tired = region_from_boxes((10, 10), [[(3, 7), (0, 3)]])
    overlap = anxious & tired
    print("\n겹침(불안 ∧ 지침) 셀 수:", int(overlap.sum()), "상자:", to_boxes(overlap))

    # 예: 이름 없는 겹침 후보
    visits = np.zeros((10, 10), dtype=int)
    visits[6:8, 6:9] = 5   # 자주 간 곳
    visits[1, 1] = 9       # 자주 간 곳 (한 칸)
    print("이름 없는 후보:", unnamed_hotspots(visits, [anxious, tired], threshold=3))

    # 영역 정의를 테두리만으로 줄였을 때의 크기
    b, seeds = boundary_representation(anxious)
    print(f"\n영역 셀 {int(anxious.sum())}개, 테두리 {int(b.sum())}개, 씨앗 {len(seeds)}개")


if __name__ == "__main__":
    main()
