/**
 * screens/Formations.tsx — where players get attached
 *
 * Veterancy attaches to the FORMATION, not to individual soldiers and not to
 * the player. This is what players name, grow attached to, and see in the World
 * Atlas (spec/02 §4, spec/06 §2).
 *
 * So the screen leads with the name, then the two independent tracks, then the
 * requirement breakdown — because "why is my next level so expensive" is the
 * question this screen exists to answer, and the honest answer is usually
 * "because your empire got big".
 */

import { useMemo } from 'react';
import { C, VETERANCY_TIERS, cumulativeLevels, empireWeightMultiplier, veterancyStatMultiplier, xpRequiredForLevel } from '@ascendance/shared';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Big, Bar, Empty, Num, Pill } from '../ui/bits.js';
import type { FormationDto } from '../state/api.js';

export function Formations(): JSX.Element {
  const { formations, me } = useStore();
  const weight = me?.empireWeight ?? 0;
  const ewm = useMemo(() => empireWeightMultiplier(weight), [weight]);

  return (
    <div className="page">
      <h1>Formations</h1>
      <p className="lede">
        Experience belongs to the formation. Reinforcing dilutes it by headcount, and a formation destroyed loses
        everything it learned — which is what makes keeping one alive for years mean something.
      </p>

      <div className="card">
        <div className="row wrap">
          <div>
            <div className="faint" style={{ fontSize: 11 }}>EMPIRE WEIGHT</div>
            <div style={{ fontSize: 20, fontWeight: 600 }} className="num">{weight.toFixed(0)}</div>
          </div>
          <div style={{ marginLeft: 24 }}>
            <div className="faint" style={{ fontSize: 11 }}>XP REQUIREMENT MULTIPLIER</div>
            <div style={{ fontSize: 20, fontWeight: 600 }} className="num">&times;{ewm.toFixed(2)}</div>
          </div>
          <span className="spacer" />
          {ewm > 4 && (
            <Pill tone="warn" title="Vassalized holdings are not owned and contribute nothing to weight">
              expansion is costing you veterancy
            </Pill>
          )}
        </div>
        <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
          The sum of admin costs of every holding you own, averaged over 30 days so shedding territory before a war
          does not work. Vassalize rather than annex and your armies keep learning.
        </p>
      </div>

      {formations.length === 0 && <Empty>No formations. Train some at a settlement with a Barracks.</Empty>}

      <div className="grid two">
        {formations.map((f) => <FormationCard key={f.id} f={f} ewm={ewm} />)}
      </div>
    </div>
  );
}

function FormationCard({ f, ewm }: { f: FormationDto; ewm: number }): JSX.Element {
  const { run, busy } = useStore();

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>{f.name}</h3>
        <span className="spacer" />
        <span className="num">{f.count}</span>
      </div>
      <p className="faint" style={{ fontSize: 12, margin: '4px 0 12px' }}>
        {f.def?.name ?? f.unitKey} &middot; {f.def?.role} &middot; {f.def?.grade} &middot; {f.def?.path?.split(' ')[0]}
      </p>

      <Track label="Attack" tier={f.atkTier} level={f.atkLevel} xp={f.atkXp} ewm={ewm}
        onPromote={() => void run(`${f.name} promoted`, () => api.tierUp(f.id, 'atk'))} busy={busy} deeds={f.deeds.length} />
      <Track label="Defence" tier={f.defTier} level={f.defLevel} xp={f.defXp} ewm={ewm}
        onPromote={() => void run(`${f.name} promoted`, () => api.tierUp(f.id, 'def'))} busy={busy} deeds={f.deeds.length} />

      {f.deeds.length > 0 && (
        <p className="faint" style={{ fontSize: 11.5, margin: '10px 0 0' }}>
          {f.deeds.length} qualifying deed{f.deeds.length === 1 ? '' : 's'} on record.
        </p>
      )}
    </div>
  );
}

function Track({ label, tier, level, xp, ewm, onPromote, busy, deeds }: {
  label: string; tier: number; level: number; xp: string; ewm: number;
  onPromote: () => void; busy: boolean; deeds: number;
}): JSX.Element {
  const tierName = VETERANCY_TIERS.find((t) => t.tier === tier)?.name ?? `Tier ${tier}`;
  const required = xpRequiredForLevel(tier, level, ewm);
  const have = BigInt(xp || '0');
  const statMult = veterancyStatMultiplier(cumulativeLevels(tier, level));
  const atCeiling = level >= C.LEVELS_PER_TIER;

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row">
        <span className="faint" style={{ fontSize: 11, letterSpacing: '0.06em' }}>{label.toUpperCase()}</span>
        <span className="spacer" />
        <Pill title={VETERANCY_TIERS.find((t) => t.tier === tier)?.reputation}>{tierName}</Pill>
        <span className="num faint" style={{ fontSize: 12 }}>L{level}</span>
        <span className="num" style={{ fontSize: 12 }} title="All combat benefit comes from levels, at +1% each. Tiers grant nothing.">
          &times;{statMult.toFixed(2)}
        </span>
      </div>

      <div style={{ marginTop: 6 }}>
        <Bar value={Number(have)} max={Number(required)} />
        <div className="row faint" style={{ fontSize: 11.5, marginTop: 4 }}>
          <span><Big value={have} /> / <Big value={required} /> to the next level</span>
          <span className="spacer" />
          {ewm > 1.05 && <span title="Your empire weight multiplies what every level costs">&times;{ewm.toFixed(1)} from empire weight</span>}
        </div>
      </div>

      {atCeiling && (
        <button className="small primary" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={onPromote}
          title="Needs level 1337, the resource cost from the home settlement, and a recorded deed. The cost is NOT scaled by empire weight.">
          Promote to {VETERANCY_TIERS.find((t) => t.tier === tier + 1)?.name ?? 'the next tier'}
          {deeds === 0 && ' — needs a deed'}
        </button>
      )}
    </div>
  );
}

/** A compact roster summary, used by the Codex. */
export function TierLadder(): JSX.Element {
  return (
    <div className="card flush scroll-x">
      <table>
        <thead><tr><th>Tier</th><th>Name</th><th className="num">Cumulative levels</th><th className="num">Stat bonus</th><th className="num">Tier-up cost</th></tr></thead>
        <tbody>
          {VETERANCY_TIERS.map((t) => (
            <tr key={t.tier}>
              <td className="num">{t.tier}</td>
              <td title={t.reputation}>{t.name}</td>
              <td className="num"><Num value={t.cumulativeLevels} /></td>
              <td className="num">&times;{t.totalStatBonus}</td>
              <td className="num"><Big value={t.tierUpCost} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
