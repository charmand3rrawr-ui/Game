/**
 * ui/bits.tsx — the small shared pieces
 *
 * Two rules from spec/06 §6 live here rather than being repeated everywhere:
 *
 *   - Numbers are locale-grouped and abbreviated at scale (2.3T), with the
 *     exact value available on hover or long-press. Resource totals in this
 *     game legitimately reach 2.3e14, and an unabbreviated one is unreadable.
 *   - Timers render from an ABSOLUTE server timestamp plus the measured clock
 *     offset, and show both server and local time wherever a time appears.
 *     Players coordinate attacks across time zones constantly.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { formatBig, formatExact } from '@ascendance/shared';
import { useStore } from '../state/store.js';

/** A big number, abbreviated, with the exact value one hover away. */
export function Big({ value, className }: { value: string | bigint; className?: string }): JSX.Element {
  const v = typeof value === 'bigint' ? value : BigInt(value || '0');
  return (
    <span className={`num ${className ?? ''}`} title={formatExact(v)}>
      {formatBig(v)}
    </span>
  );
}

export function Num({ value, digits = 0 }: { value: number; digits?: number }): JSX.Element {
  return <span className="num">{value.toLocaleString(undefined, { maximumFractionDigits: digits })}</span>;
}

/**
 * A live countdown to an absolute server timestamp.
 *
 * Never counts down a duration the server handed over: it recomputes from the
 * deadline every second against the measured offset, so a tab that slept or a
 * clock that drifted corrects itself rather than silently lying about when an
 * army lands.
 */
export function Countdown({ to, urgentBelowMs = 3_600_000 }: { to: string | bigint; urgentBelowMs?: number }): JSX.Element {
  const now = useStore((s) => s.now);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const deadline = Number(typeof to === 'bigint' ? to : BigInt(to || '0'));
  const remaining = deadline - now();
  const urgent = remaining > 0 && remaining < urgentBelowMs;

  return (
    <span className={`timer ${urgent ? 'urgent' : ''}`} title={absoluteTimes(deadline)}>
      {remaining <= 0 ? 'now' : humanise(remaining)}
    </span>
  );
}

/** Both server and local time, because coordination happens across zones. */
function absoluteTimes(epochMs: number): string {
  const d = new Date(epochMs);
  return `Local ${d.toLocaleString()}\nUTC   ${d.toISOString().replace('T', ' ').slice(0, 19)}`;
}

export function humanise(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function duration(ms: number): string {
  if (ms < 1000) return '<1s';
  return humanise(ms);
}

export function Pill({ tone, children, title }: { tone?: 'ok' | 'warn' | 'danger' | 'envy'; children: ReactNode; title?: string }): JSX.Element {
  return <span className={`pill ${tone ?? ''}`} title={title}>{children}</span>;
}

export function Bar({ value, max, tone }: { value: number; max: number; tone?: 'ok' | 'warn' | 'danger' }): JSX.Element {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`bar ${tone ?? ''}`} role="img" aria-label={`${Math.round(pct)}%`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}

/**
 * Grades, not raw levels, gate content — unit tiers, doctrine forks, edicts.
 * Showing both at once is how a player reads "level 412 (grade 13)" and knows
 * what it unlocks as well as how big it is (formulas.gradeForLevel).
 */
export function LevelBadge({ level, gradeSize = 32, maxGrade = 42 }: { level: number; gradeSize?: number; maxGrade?: number }): JSX.Element {
  const grade = Math.min(maxGrade, Math.floor(level / gradeSize) + 1);
  const intoGrade = level % gradeSize;
  return (
    <span className="num" title={`Level ${level} — grade ${grade}, ${intoGrade}/${gradeSize} into it`}>
      {level} <span className="faint">G{grade}</span>
    </span>
  );
}
