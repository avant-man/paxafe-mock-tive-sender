/**
 * Token bucket per key: `perMinute` capacity, refilled continuously. In memory, so the
 * limit is per instance, which is enough for one free-tier instance.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly ratePerMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {
    this.ratePerMs = perMinute / 60_000;
  }

  /** Takes one token. Returns the seconds to wait when the bucket is empty. */
  take(key: string): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, updatedAt: t };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (t - bucket.updatedAt) * this.ratePerMs);
    bucket.updatedAt = t;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerMs / 1000)) };
  }
}
