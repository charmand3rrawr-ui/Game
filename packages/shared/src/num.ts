/**
 * num.ts — number handling that has to agree with a spreadsheet
 *
 * WHY THIS FILE EXISTS
 *   The balance workbook is the source of truth, and it rounds with Excel's
 *   ROUND(), which rounds half AWAY FROM ZERO on the decimal value. JavaScript's
 *   Math.round() rounds half UP on the binary double, and the two disagree
 *   exactly where it hurts: Excel's ROUND(3.05, 1) is 3.1, while
 *   Math.round(3.05 * 10) / 10 is 3.0, because the double nearest 3.05 is
 *   slightly below it.
 *
 *   That one-digit difference is the gap between a generated roster that matches
 *   Units_Master and one that does not — which is the M3 acceptance test
 *   (spec/08 M3). So all workbook-facing rounding goes through here.
 */

/**
 * Rounding that has to agree with the workbook, done in EXACT DECIMAL.
 *
 * The published tables are products of short decimals (60 x 1.8 x 0.95). Doing
 * that in binary and rounding the result is not reproducible: 4.06 * 2.5 is
 * 10.149999999999999 and rounds to 10.1, while the workbook publishes 10.2. So
 * the factors are converted to exact integer-and-scale pairs, multiplied
 * exactly, and rounded with integer arithmetic. No float ever touches the
 * boundary decision, which also means the result is identical on every
 * platform — the property invariant §2.2 actually requires.
 *
 * `tie` picks what happens exactly on .5, because the workbook is not uniform:
 * its one-decimal columns round ties up, and its whole-number HP column rounds
 * them down. See generateUnit() in units.ts.
 */
export type TieMode = 'up' | 'down';

export function roundDecimalProduct(factors: readonly number[], dp: number, tie: TieMode = 'up'): number {
  let n = 1n;
  let scale = 0;
  for (const f of factors) {
    const d = exactDecimal(f);
    n *= d.n;
    scale += d.scale;
  }
  const neg = n < 0n;
  if (neg) n = -n;

  let out: bigint;
  if (scale <= dp) {
    out = n * 10n ** BigInt(dp - scale);
  } else {
    const divisor = 10n ** BigInt(scale - dp);
    const q = n / divisor;
    const r = n % divisor;
    const twice = r * 2n;
    out = twice > divisor || (twice === divisor && tie === 'up') ? q + 1n : q;
  }
  const value = Number(out) / Math.pow(10, dp);
  return neg ? -value : value;
}

/**
 * Decompose a float into an exact integer-and-scale pair using its SHORTEST
 * round-trip decimal form — i.e. the decimal a human typed into the cell, not
 * the binary approximation stored for it.
 */
export function exactDecimal(x: number): { n: bigint; scale: number } {
  if (!Number.isFinite(x)) throw new RangeError(`cannot decompose ${x}`);
  let s = String(x);
  // Normalise exponent form (1e-7, 2.5e+21) into plain digits.
  if (s.includes('e') || s.includes('E')) s = expandExponential(s);
  const dot = s.indexOf('.');
  if (dot === -1) return { n: BigInt(s), scale: 0 };
  const scale = s.length - dot - 1;
  return { n: BigInt(s.slice(0, dot) + s.slice(dot + 1)), scale };
}

function expandExponential(s: string): string {
  const [mantissa, exp] = s.split(/[eE]/) as [string, string];
  const e = Number(exp);
  const neg = mantissa.startsWith('-');
  const body = neg ? mantissa.slice(1) : mantissa;
  const dot = body.indexOf('.');
  const digits = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const pointAt = (dot === -1 ? body.length : dot) + e;
  let out: string;
  if (pointAt <= 0) out = `0.${'0'.repeat(-pointAt)}${digits}`;
  else if (pointAt >= digits.length) out = digits + '0'.repeat(pointAt - digits.length);
  else out = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  return (neg ? '-' : '') + out;
}

/**
 * Round a single value to `dp`, half away from zero, in exact decimal.
 * Use this for derived and displayed numbers; use roundDecimalProduct() when
 * reproducing a published table, so the intermediate product stays exact.
 */
export function roundDecimal(x: number, dp: number, tie: TieMode = 'up'): number {
  return roundDecimalProduct([x], dp, tie);
}

/** Clamp to an inclusive range. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Format a bigint for display: locale grouping below 1e6, abbreviated above.
 *
 * spec/06 §6 — numbers are abbreviated at scale (2.3T) with the exact value
 * available on hover. Resource totals in this game legitimately reach 2.3e14.
 */
const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp'] as const;

export function formatBig(v: bigint, locale?: string): string {
  const neg = v < 0n;
  let n = neg ? -v : v;
  if (n < 1_000_000n) return (neg ? '-' : '') + n.toLocaleString(locale);
  let tier = 0;
  while (n >= 1_000_000n && tier < SUFFIXES.length - 1) {
    n /= 1000n;
    tier++;
  }
  // One decimal of the truncated remainder, computed before the final divide.
  const whole = n / 1000n;
  const frac = (n % 1000n) / 100n;
  const suffix = SUFFIXES[tier + 1] ?? SUFFIXES[SUFFIXES.length - 1]!;
  return `${neg ? '-' : ''}${whole.toLocaleString(locale)}.${frac}${suffix}`;
}

/** Exact value with locale grouping — what a long-press or hover reveals. */
export function formatExact(v: bigint, locale?: string): string {
  return v.toLocaleString(locale);
}

/**
 * Big integers cross the API as STRINGS, never JSON numbers (spec/05 §1).
 * Resource amounts and XP exceed the IEEE-754 safe range.
 */
export function bigToJson(v: bigint): string {
  return v.toString();
}

export function bigFromJson(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw new RangeError(`${v} is not a safe integer; big values must cross the API as strings`);
    }
    return BigInt(v);
  }
  return BigInt(v);
}

/** Multiply a bigint by a float multiplier without losing the integer domain. */
export function scaleBig(v: bigint, mult: number): bigint {
  if (!Number.isFinite(mult)) throw new RangeError(`multiplier ${mult} is not finite`);
  // Scale through a 1e9 fixed-point intermediate so large amounts keep precision
  // that Number(v) * mult would silently drop above 2^53.
  const num = BigInt(Math.round(mult * 1e9));
  return (v * num) / 1_000_000_000n;
}

export function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
export function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
