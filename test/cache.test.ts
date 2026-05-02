import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTLCache } from '../src/cache.js';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for an unknown key', () => {
    const cache = new TTLCache<string>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns the stored value within the TTL window', () => {
    const cache = new TTLCache<string>();
    cache.set('key1', 'value1', 60);
    expect(cache.get('key1')).toBe('value1');
  });

  it('returns undefined after the TTL expires', () => {
    const cache = new TTLCache<string>();
    cache.set('key1', 'value1', 60);
    vi.advanceTimersByTime(61_000);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('honours the exact TTL boundary', () => {
    const cache = new TTLCache<string>();
    cache.set('key1', 'value1', 60);
    vi.advanceTimersByTime(59_999);
    expect(cache.get('key1')).toBe('value1');
    vi.advanceTimersByTime(2);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('getStale returns the expired value for stale-cache fallback', () => {
    const cache = new TTLCache<string>();
    cache.set('key1', 'value1', 60);
    vi.advanceTimersByTime(61_000);
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.getStale('key1')).toBe('value1');
  });

  it('getStale returns undefined for a never-set key', () => {
    const cache = new TTLCache<string>();
    expect(cache.getStale('missing')).toBeUndefined();
  });

  it('subsequent set updates the value and resets the expiry', () => {
    const cache = new TTLCache<string>();
    cache.set('key1', 'old', 60);
    vi.advanceTimersByTime(30_000);
    cache.set('key1', 'new', 60);
    expect(cache.get('key1')).toBe('new');
    vi.advanceTimersByTime(40_000);
    expect(cache.get('key1')).toBe('new');
  });

  it('delete removes the entry entirely (no stale survives)', () => {
    const cache = new TTLCache<string>();
    cache.set('key1', 'value1', 60);
    cache.delete('key1');
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.getStale('key1')).toBeUndefined();
  });

  it('clear removes all entries', () => {
    const cache = new TTLCache<string>();
    cache.set('a', 'A', 60);
    cache.set('b', 'B', 60);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('keeps independent TTLs for separate keys', () => {
    const cache = new TTLCache<string>();
    cache.set('short', 'S', 30);
    cache.set('long', 'L', 120);
    vi.advanceTimersByTime(60_000);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('L');
  });
});
