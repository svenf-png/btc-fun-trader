import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/update';

describe('isNewer', () => {
  it('detects a different build id', () => {
    expect(isNewer('abc1234', 'def5678')).toBe(true);
  });
  it('ignores the same id, empty or invalid values', () => {
    expect(isNewer('abc1234', 'abc1234')).toBe(false);
    expect(isNewer('abc1234', '')).toBe(false);
    expect(isNewer('abc1234', null)).toBe(false);
    expect(isNewer('abc1234', 42)).toBe(false);
  });
});
