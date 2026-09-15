/**
 * screens/BattleReport.tsx — the full phase arithmetic
 *
 * INVARIANT §2.7: EVERY COMBAT OUTCOME IS EXPLAINABLE. All combat maths is
 * SHOWN, not summarised — a player should be able to reconstruct any result by
 * hand from this page (spec/06 §6).
 *
 * That is why the joint cap appears with BOTH its capped and uncapped values.
 * A silent cap produces accusations of cheating; a visible one produces an
 * argument about force composition, which is the game.
 */

import { useEffect, useState } from 'react';
import type { Battle, BattleReport as Report, PowerBreakdown } from '@ascendance/shared';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Big, Empty, Num, Pill } from '../ui/bits.js';

const PHASE_TITLES: Record<string, string> = {
  intel: 'Intel and ambush',
  ranged: 'Ranged and siege exchange',
  main: 'Main engagement',
  breakthrough: 'Breakthrough and pursuit',
  plunder: 'Plunder or occupation',
  munitions: 'Munitions drain',
};

export function BattleReport(): JSX.Element {
  const { battle, settlementId } = useStore();
  const [recent, setRecent] = useState<Battle[]>([]);

  useEffect(() => {
    if (!battle && settlementId) void api.battles(settlementId).then((r) => setRecent(r.battles));
  }, [battle, settlementId]);

  if (!battle) {
    return (
      <div className="page">
        <h1>Battle reports</h1>
        {recent.length === 0
          ? <Empty>No battles yet. Dispatch an attack from the Command Centre.</Empty>
          : <RecentList battles={recent} />}
      </div>
    );
  }

  const r = battle.report;
  return (
    <div className="page">
      <h1>{r.settlementName}</h1>
      <p className="lede">
        {r.outcome === 'attacker' ? 'The attacker prevailed.' : 'The defence held.'}
        {r.captured && ' The settlement changed hands.'}
        {' '}Every multiplier that touched this result is below. Nothing is summarised away.
      </p>

      <div className="grid two">
        <SideCard title="Attacker" side={r.attacker} won={r.outcome === 'attacker'} />
        <SideCard title="Defender" side={r.defender} won={r.outcome !== 'attacker'} />
      </div>

      {r.layerLimits.length > 0 && (
        <div className="notice">
          <b>Layer limits.</b> These are hard preconditions, not modifiers:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {r.layerLimits.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      )}

      <h2>Phases</h2>
      {r.phases.map((p, i) => (
        <section key={i} className="phase">
          <header>
            <span className="n">{i + 1}</span>
            <strong>{PHASE_TITLES[p.name] ?? p.name}</strong>
          </header>
          <div className="body">
            <p style={{ marginBottom: p.attackerPower.base > 0 ? 12 : 0 }}>{p.note}</p>

            {p.attackerPower.base > 0 && (
              <div className="grid two">
                <PowerTable title="Attacker" p={p.attackerPower} />
                <PowerTable title="Defender" p={p.defenderPower} />
              </div>
            )}

            {(Object.keys(p.attackerLosses).length > 0 || Object.keys(p.defenderLosses).length > 0) && (
              <div className="grid two" style={{ marginTop: 12 }}>
                <Losses title="Attacker losses" losses={p.attackerLosses} />
                <Losses title="Defender losses" losses={p.defenderLosses} />
              </div>
            )}
          </div>
        </section>
      ))}

      {r.plunder && Object.keys(r.plunder).length > 0 && (
        <>
          <h2>Plunder</h2>
          <div className="card">
            <div className="row wrap" style={{ gap: 6 }}>
              {Object.entries(r.plunder).map(([k, v]) => (
                <Pill key={k}>{k}: <Big value={v} /></Pill>
              ))}
            </div>
            <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
              Bounded by the attacking force&rsquo;s carrying capacity, and the hidden cellar is never taken — a
              raid is never a wipeout.
            </p>
          </div>
        </>
      )}

      <Attribution report={r} />

      <h2>Reproducibility</h2>
      <div className="card">
        <dl className="kv">
          <dt>seed</dt><dd className="mono">{String(battle.seed)}</dd>
          <dt>battle</dt><dd className="mono">{battle.id}</dd>
        </dl>
        <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
          This battle is replayable from its seed alone. The same inputs and the same seed produce the same result
          on any machine — which is what makes dispute resolution and the World Atlas possible.
        </p>
      </div>
    </div>
  );
}

function SideCard({ title, side, won }: { title: string; side: Report['attacker']; won: boolean }): JSX.Element {
  const lost = side.totalBefore - side.totalAfter;
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="spacer" />
        {won ? <Pill tone="ok">prevailed</Pill> : <Pill tone="danger">broke</Pill>}
      </div>
      <p className="faint" style={{ fontSize: 12, margin: '6px 0 10px' }}>
        {side.playerName} &middot; empire weight <Num value={side.empireWeight} />
      </p>
      <div className="scroll-x">
        <table>
          <thead><tr><th>Formation</th><th className="num">Before</th><th className="num">After</th><th className="num">Lost</th></tr></thead>
          <tbody>
            {side.formations.map((f) => (
              <tr key={f.formationId}>
                <td>
                  {f.name}
                  {f.after === 0 && f.before > 0 && (
                    <> <Pill tone="danger" title="A formation reduced to zero loses all accrued veterancy. Experience is held by the formation, never banked by the player.">destroyed</Pill></>
                  )}
                </td>
                <td className="num">{f.before}</td>
                <td className="num">{f.after}</td>
                <td className="num">{f.before - f.after}</td>
              </tr>
            ))}
            <tr>
              <td><b>Total</b></td>
              <td className="num"><b>{side.totalBefore}</b></td>
              <td className="num"><b>{side.totalAfter}</b></td>
              <td className="num"><b>{lost}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The multiplier stack, itemised.
 *
 * The capped and uncapped values are shown side by side whenever the joint cap
 * engaged, so a player can see exactly how much of their bonus stack was
 * clamped and by how much.
 */
function PowerTable({ title, p }: { title: string; p: PowerBreakdown }): JSX.Element {
  const rows: [string, string, string?][] = [
    ['base', p.base.toFixed(0), 'Raw attack or defence from unit stats and counts'],
    ['tech tier', `×${p.techTier.toFixed(3)}`, 'Research'],
    ['equipment', `×${p.equipment.toFixed(3)}`, 'Weapon, protection and utility slots'],
    ['commander', `×${p.commander.toFixed(3)}`],
    ['veterancy', `×${p.veterancy.toFixed(3)}`, '+1% per cumulative level. Tiers themselves grant nothing.'],
    ['doctrine', `×${p.doctrine.toFixed(3)}`, 'Outside the joint cap by design'],
    ['morale', `×${p.morale.toFixed(3)}`, 'By relative empire size — smaller empires fight harder'],
    ['counter matrix', `×${p.counterMatrix.toFixed(3)}`, 'Weighted against the opposing role mix'],
  ];
  if (p.fortification !== undefined) rows.push(['fortification', `×${p.fortification.toFixed(3)}`, '1 + 0.05 per wall grade']);
  if (p.flatGarrisonHp) rows.push(['garrison HP', `+${p.flatGarrisonHp.toFixed(0)}`, 'Flat, from the walls themselves']);
  if (p.heavensEnvy !== undefined && p.heavensEnvy < 1) {
    rows.push(['Heaven’s Envy', `×${p.heavensEnvy.toFixed(2)}`, 'Defensive only. It never touches attack values.']);
  }

  return (
    <div>
      <h3>{title}</h3>
      <div className="scroll-x">
        <table>
          <tbody>
            {rows.map(([k, v, why]) => (
              <tr key={k}>
                <td title={why}>{k}</td>
                <td className="num">{v}</td>
              </tr>
            ))}
            <tr>
              <td><b>total</b></td>
              <td className="num"><b>{p.total.toFixed(0)}</b></td>
            </tr>
          </tbody>
        </table>
      </div>

      {p.jointCapEngaged && (
        <div className="capnote">
          The joint +40% cap engaged: {p.uncapped.toFixed(0)} was clamped to {p.capped.toFixed(0)}.
          Proficiency, equipment, commanders, cultivation and veterancy all fold into that single clamp.
        </div>
      )}

      {p.byUnit.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>
            Per formation ({p.byUnit.length})
          </summary>
          <div className="scroll-x">
            <table>
              <thead><tr><th>Formation</th><th className="num">Count</th><th className="num">Vet</th><th className="num">Counter</th><th className="num">Share</th></tr></thead>
              <tbody>
                {p.byUnit.map((u, i) => (
                  <tr key={i}>
                    <td>{u.formationName}<div className="faint" style={{ fontSize: 11 }}>{u.role}</div></td>
                    <td className="num">{u.count}</td>
                    <td className="num">&times;{u.veterancyMultiplier.toFixed(2)}</td>
                    <td className="num">&times;{u.counterMultiplier.toFixed(2)}</td>
                    <td className="num">{(u.contributionShare * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function Losses({ title, losses }: { title: string; losses: Record<string, number> }): JSX.Element {
  const entries = Object.entries(losses).filter(([, n]) => n > 0);
  return (
    <div>
      <h3>{title}</h3>
      {entries.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>None.</p> : (
        <div className="row wrap" style={{ gap: 6 }}>
          {entries.map(([k, n]) => <Pill key={k}>{k.split('|')[1] ?? k}: {n}</Pill>)}
        </div>
      )}
    </div>
  );
}

/**
 * The XP attribution table.
 *
 * Every row explains itself: what it killed, how that was valued, what
 * discounted it, and what the next level costs — including how much of that
 * cost is the player's own empire weight.
 */
function Attribution({ report }: { report: Report }): JSX.Element | null {
  if (report.attribution.length === 0) return null;
  return (
    <>
      <h2>Experience attribution</h2>
      <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
        Kills are credited by each formation&rsquo;s share of its side&rsquo;s attack pool, valued by what was
        killed, and discounted by how easy the kill was. The defence track adds absorption XP, because a screen
        that killed nothing may still be the reason the settlement held.
      </p>
      <div className="card flush scroll-x">
        <table>
          <thead>
            <tr>
              <th>Formation</th><th>Track</th><th className="num">Raw value</th>
              <th className="num">Role</th><th className="num">Relative</th>
              <th className="num">Fatigue</th><th className="num">Rep.</th>
              <th className="num">Absorption</th><th className="num">XP</th><th className="num">Needs</th>
            </tr>
          </thead>
          <tbody>
            {report.attribution.map((a, i) => (
              <tr key={i}>
                <td>
                  {a.formationName}
                  {a.zeroReason && (
                    <div className="faint" style={{ fontSize: 11 }} title="Hard zeroes are absolute, not reductions">
                      zero: {a.zeroReason}
                    </div>
                  )}
                </td>
                <td>{a.track === 'atk' ? 'attack' : 'defence'}</td>
                <td className="num">{a.rawValue.toFixed(0)}</td>
                <td className="num">{a.roleFactorAvg.toFixed(2)}</td>
                <td className="num">{a.relativeFactorAvg.toFixed(3)}</td>
                <td className="num">{a.fatigue.toFixed(4)}</td>
                <td className="num">{a.repetition.toFixed(2)}</td>
                <td className="num"><Big value={a.absorptionXp} /></td>
                <td className="num"><b><Big value={a.xpAwarded} /></b></td>
                <td className="num" title={
                  `${a.requirement.base} base` +
                  ` x ${a.requirement.levelFactor.toFixed(3)} level` +
                  ` x ${a.requirement.tierFactor.toFixed(3)} tier` +
                  ` x ${a.requirement.empireWeightMultiplier.toFixed(3)} empire weight`
                }>
                  <Big value={a.requirement.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        Hover a requirement to see its four factors. Empire weight multiplies what a level costs — which is why a
        galactic power can pay for promotions its armies can no longer earn, and a small ally can earn what it
        cannot pay for.
      </p>
    </>
  );
}

function RecentList({ battles }: { battles: Battle[] }): JSX.Element {
  const { openBattle } = useStore();
  return (
    <div className="card flush">
      {battles.map((b) => (
        <div key={b.id} className="att u-normal">
          <div className="glyph" aria-hidden="true">&#9876;</div>
          <div>
            <div className="title">{b.report.settlementName}</div>
            <div className="detail">
              {b.report.outcome === 'attacker' ? 'Attacker prevailed' : 'Defence held'}
              {b.report.captured && ' — settlement changed hands'}
            </div>
          </div>
          <button className="small" onClick={() => void openBattle(b.id)}>Read</button>
        </div>
      ))}
    </div>
  );
}
