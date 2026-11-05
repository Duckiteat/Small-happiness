// 실제 시계 (docs/기반층-명세.md 3-2). 코어는 현재 시각을 직접 읽지 않으므로 이 어댑터만 읽는다.

import type { Clock } from '../core/clock.ts';

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}
