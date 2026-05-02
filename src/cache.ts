interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  set(key: string, value: T, ttlSeconds: number): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry.value;
  }

  // Returns the stored value regardless of expiry. Used by the server to fall
  // back to last-known-good data when a fresh fetch fails (Phase 5).
  getStale(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
