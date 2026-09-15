/**
 * serialize.ts — the wire format
 *
 * ONE RULE: big integers cross the API as STRINGS, never JSON numbers
 * (spec/05 §1). Resource amounts reach 2.3e14 and XP requirements 1.88e12, both
 * beyond the IEEE-754 safe range. A silently truncated stockpile is the worst
 * kind of bug — plausible, and wrong.
 *
 * JSON.stringify throws on a bigint rather than truncating it, which is a
 * genuine kindness: it means forgetting to serialize one is a loud failure
 * rather than a quiet corruption. This module makes doing it right the easy
 * path.
 */

/** Recursively convert every bigint to a decimal string. */
export function wire<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(wire);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), wire(v)]));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = wire(v);
    }
    return out;
  }
  return value;
}

/**
 * A stable JSON encoding, used where two encodings must be comparable —
 * cache keys, the replay hash, and the ETag on map tiles.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(wire(value)));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}
