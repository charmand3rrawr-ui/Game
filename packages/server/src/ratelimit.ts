/**
 * ratelimit.ts — a token bucket per account
 *
 * spec/05 §5 asks for a budget "generous for normal play and tight enough to
 * make scripted mass-dispatch unattractive", with a burst allowance for
 * movement dispatch "sized to permit legitimate coordinated waves (which are a
 * core skill) while rejecting machine-gun patterns".
 *
 * That last clause is the whole design. Sending twenty armies to land three
 * seconds apart is the game being played well; sending two hundred in a second
 * is a script. The burst is therefore large and the sustained rate is modest.
 *
 * All limits return 429 with Retry-After, never a silent drop.
 */

export type Bucket = 'read' | 'command';

interface State {
  tokens: number;
  lastRefill: number;
}

const LIMITS: Record<Bucket, { burst: number; perSecond: number }> = {
  // Reads are cheap and the attention dashboard is refreshed constantly.
  read: { burst: 120, perSecond: 20 },
  // Commands: a 40-deep burst covers a coordinated multi-wave operation.
  command: { burst: 40, perSecond: 2 },
};

export interface Verdict {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, State>();

  constructor(private readonly now: () => number = Date.now) {}

  check(key: string, bucket: Bucket): Verdict {
    const limit = LIMITS[bucket];
    const id = `${bucket}:${key}`;
    const t = this.now();
    const state = this.buckets.get(id) ?? { tokens: limit.burst, lastRefill: t };

    const elapsed = Math.max(0, t - state.lastRefill);
    state.tokens = Math.min(limit.burst, state.tokens + (elapsed / 1000) * limit.perSecond);
    state.lastRefill = t;

    if (state.tokens < 1) {
      this.buckets.set(id, state);
      return { allowed: false, retryAfterMs: Math.ceil(((1 - state.tokens) / limit.perSecond) * 1000), remaining: 0 };
    }

    state.tokens -= 1;
    this.buckets.set(id, state);
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(state.tokens) };
  }

  reset(): void {
    this.buckets.clear();
  }
}
