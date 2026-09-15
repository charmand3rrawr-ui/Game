/**
 * screens/Codex.tsx — in-world documents, written diegetically (spec/06 §2)
 *
 * It also carries the honesty page: which balance revision is running, and
 * which constants are still assumptions awaiting the balance owner. spec/07 §1
 * asks a running server to report exactly which balance revision produced a
 * result; there is no reason to hide that from players.
 */

import { useEffect, useState } from 'react';
import { C, HOLDINGS, BUILDINGS, ROSTER, CONSTANT_META } from '@ascendance/shared';
import { useStore, runningLocally } from '../state/store.js';
import { Big, Num, Pill } from '../ui/bits.js';
import { TierLadder } from './Formations.js';

export function Codex(): JSX.Element {
  const { meta } = useStore();
  const [tab, setTab] = useState<'rules' | 'holdings' | 'veterancy' | 'balance'>('rules');

  useEffect(() => { document.title = 'Ascendance — Codex'; }, []);

  return (
    <div className="page">
      <h1>Codex</h1>
      <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
        {(['rules', 'holdings', 'veterancy', 'balance'] as const).map((t) => (
          <button key={t} className={`small ${tab === t ? 'primary' : 'ghost'}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === 'rules' && <Rules />}
      {tab === 'holdings' && <Holdings />}
      {tab === 'veterancy' && <><h2>The veterancy ladder</h2><TierLadder /></>}
      {tab === 'balance' && <Balance meta={meta} />}
    </div>
  );
}

function Rules(): JSX.Element {
  return (
    <>
      <div className="card">
        <h3>Production is isolated</h3>
        <p>
          Resources exist in the settlement that produced them. There is no empire treasury and no instant
          transfer. Moving anything creates a convoy that is visible on the map and can be intercepted.
        </p>
        <p style={{ marginBottom: 0 }}>
          The single exception is your own progression — research, proficiency, cultivation, dynasty traditions.
          Those are global, because without them a wide empire would be unplayable.
        </p>
      </div>

      <div className="card">
        <h3>Nothing you build becomes obsolete</h3>
        <p style={{ marginBottom: 0 }}>
          Buildings from earlier eras never stop working. When you advance an era they gain Heritage status: full
          output, plus Culture equal to {(C.HERITAGE_CULTURE_PCT * 100).toFixed(0)}% of their level.
        </p>
      </div>

      <div className="card">
        <h3>A settlement can never hold everything</h3>
        <p>
          Plots are finite, buildings occupy one to four of them, and no building may exceed its HQ&rsquo;s level.
          Beyond that, a settlement may hold at most {C.SPEC_CAP_G30} buildings above grade {C.SPEC_CAP_G30_GRADE}
          {' '}and {C.SPEC_CAP_G20} above grade {C.SPEC_CAP_G20_GRADE}.
        </p>
        <p style={{ marginBottom: 0 }}>
          These are hard limits, not penalties. The game rejects the order rather than quietly taxing you for it.
        </p>
      </div>

      <div className="card">
        <h3>Governors cost time, never efficiency</h3>
        <p>
          There is no cap on how many holdings you may own and no administrative overload penalty. The only limit
          on the size of an empire is your own attention.
        </p>
        <p style={{ marginBottom: 0 }}>
          A governor is the relief valve, and the entire system is one number: <b>anything a governor initiates
          takes {C.GOVERNOR_TIME_MULT}&times; as long</b>. No output tax, no efficiency loss. You can seize a
          governor&rsquo;s job at any time — you keep the elapsed progress and the remainder recalculates at full
          speed — but seizing needs a free personal slot, and personal slots are scarce.
        </p>
      </div>

      <div className="card">
        <h3>Veterancy belongs to the formation</h3>
        <p>
          Not to soldiers, and not to you. Tiers grant no stats at all: every point of combat benefit comes from
          levels, at +1% each, accumulating to {C.MAX_VET_TIER * C.LEVELS_PER_TIER * C.VET_PER_LEVEL + 1}&times;
          across the whole ladder.
        </p>
        <p style={{ marginBottom: 0 }}>
          Reinforcing dilutes veterancy by headcount, and a formation reduced to zero loses everything it learned.
          A veteran formation is a thing you keep alive, not a resource you spend.
        </p>
      </div>

      <div className="card">
        <h3>Every bonus folds into one cap</h3>
        <p style={{ marginBottom: 0 }}>
          Proficiency, equipment, commanders, cultivation and veterancy all fold into a single clamp of
          +{(C.JOINT_BONUS_CAP * 100).toFixed(0)}% on any stat. When it engages, the battle report shows both the
          capped and uncapped numbers, so you can see it happen rather than wonder.
        </p>
      </div>

      <div className="card">
        <h3>Money never buys power</h3>
        <p>
          Chrono Shards compress the time left on a queue item, up to an <b>earned ceiling</b> of
          {' '}{C.SHARD_BASE} + {C.SHARD_PER_RANK} per Construction rank + {C.SHARD_PER_ERA} per era. Beyond that
          ceiling, shards are simply unspendable. A vault of them and rank-0 Construction compresses at
          {' '}{C.SHARD_BASE + C.SHARD_PER_ERA}&times;, like everybody else.
        </p>
        <p>
          They can never be applied to a settlement with hostile movement inbound, to training during a declared
          war, to Ascension or epoch projects, to megastructures, to cultivation breakthroughs, or to fortification
          repair under siege. The moments this game is actually about stay on real time.
        </p>
        <p style={{ marginBottom: 0 }}>
          Spending accrues Temporal Debt across {C.TEMPORAL_DEBT_TIERS} tiers, which raises tribulation difficulty
          and suppresses Qi regeneration, and decays only through abstention. Your 30-day purchase total is public
          on your profile.
        </p>
      </div>

      <div className="card">
        <h3>Heaven&rsquo;s Envy</h3>
        <p style={{ marginBottom: 0 }}>
          Three leaderboards rank shard-hours <i>purchased</i> in a rolling 24 hours: the universe, your quadrant,
          and your alliance. Each top-ten placement costs {(C.ENVY_PER_SCOPE * 100).toFixed(0)}% defensive strength
          for 24 hours, stacking to {(C.ENVY_PER_SCOPE * C.ENVY_MAX_SCOPES * 100).toFixed(0)}%. It touches defence
          and fortifications, never attack. It cannot be cleansed, offset, or dodged by going on holiday, and
          attacking someone who is marked costs no reputation while the mark lasts.
        </p>
      </div>
    </>
  );
}

function Holdings(): JSX.Element {
  return (
    <>
      <p className="lede">
        Every holding is fully independent: its own plots, its own stockpile, its own queues. Admin cost is what it
        adds to your Empire Weight, and Empire Weight is what makes veterancy expensive.
      </p>
      <div className="card flush scroll-x">
        <table>
          <thead>
            <tr><th>Holding</th><th>Era</th><th>Layer</th><th className="num">Plots</th><th className="num">Max</th><th className="num">Admin</th></tr>
          </thead>
          <tbody>
            {HOLDINGS.map((h) => (
              <tr key={h.key}>
                <td title={h.notes}>{h.name}<div className="faint" style={{ fontSize: 11 }}>{h.produces}</div></td>
                <td>{h.era}</td>
                <td className="dim">{h.layer}</td>
                <td className="num">{h.plotsAtFounding}</td>
                <td className="num">{h.maxPlots}</td>
                <td className="num">{h.adminCost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Balance({ meta }: { meta?: { balanceRevision: string; assumedConstants: string[] } }): JSX.Element {
  return (
    <>
      <p className="lede">
        Every number in this game comes from one workbook, imported at build time. Nothing is hardcoded in game
        logic. This page says exactly which revision is running and which numbers are still assumptions.
      </p>

      <div className="card">
        <dl className="kv">
          <dt>balance revision</dt>
          <dd className="mono">{meta?.balanceRevision.slice(0, 32) ?? '—'}&hellip;</dd>
          <dt>buildings</dt><dd><Num value={BUILDINGS.length} /></dd>
          <dt>units</dt><dd><Num value={ROSTER.length} /> generated from {ROSTER.length / 18} parameter rows</dd>
          <dt>holding types</dt><dd><Num value={HOLDINGS.length} /></dd>
          <dt>mode</dt>
          <dd>{runningLocally ? 'local sandbox world in this browser' : 'connected to a server'}</dd>
        </dl>
      </div>

      <h2>Calibration anchors</h2>
      <div className="card">
        <p className="faint" style={{ fontSize: 12 }}>
          Six fixed points the whole economy was tuned around. The build fails if any of them moves.
        </p>
        <dl className="kv">
          <dt>full 0&rarr;1337 climb</dt><dd><Big value={String(Math.round(C.FULL_CLIMB_HOURS))} /> hours = 500 years</dd>
          <dt>Mythic Path Avatar</dt><dd>4,383 hours = 6 months</dd>
          <dt>veterancy ladder</dt><dd>&times;{(C.MAX_VET_TIER * C.LEVELS_PER_TIER * C.VET_PER_LEVEL + 1).toFixed(2)}</dd>
          <dt>joint bonus cap</dt><dd>+{(C.JOINT_BONUS_CAP * 100).toFixed(0)}%</dd>
          <dt>strongest counter</dt><dd>&times;{C.COUNTER_MAX}</dd>
          <dt>empire weight cap</dt><dd>&times;<Num value={C.EW_CAP} /></dd>
        </dl>
      </div>

      {meta && meta.assumedConstants.length > 0 && (
        <>
          <h2>Open assumptions</h2>
          <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
            {meta.assumedConstants.length} constants the specification requires but neither the workbook nor the
            spec pins down. They are marked rather than quietly invented, and each carries its reasoning.
          </p>
          <div className="card flush scroll-x">
            <table>
              <thead><tr><th>Constant</th><th className="num">Assumed</th><th>Reasoning</th></tr></thead>
              <tbody>
                {meta.assumedConstants.map((name) => {
                  const m = CONSTANT_META[name];
                  return (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td className="num">{Array.isArray(m?.value) ? m?.value.join(', ') : String(m?.value)}</td>
                      <td className="faint" style={{ fontSize: 12 }}>{m?.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="row wrap" style={{ gap: 6, marginTop: 14 }}>
        <Pill>{BUILDINGS.filter((b) => b.era === 1).length} Era I buildings fully specified</Pill>
        <Pill tone="warn">Eras II&ndash;VII await per-building detail</Pill>
      </div>
    </>
  );
}
