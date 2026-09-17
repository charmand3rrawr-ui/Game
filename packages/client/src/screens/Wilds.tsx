/**
 * screens/Wilds.tsx — the barbarians, and why they are as bad as they are
 *
 * THE DESIGN POSITION THIS SCREEN EXISTS TO HOLD
 *   An AI that gets stronger in the dark is indistinguishable from a game that
 *   cheats. Players will not give an escalating opponent the benefit of the
 *   doubt, and they are right not to — "the computer got better because you got
 *   better" is a claim that has to be shown, not asserted.
 *
 *   So this screen publishes everything. The pressure and each of its three
 *   terms, so a player can see that two of them are their own doing. Each
 *   band's tier and exactly what that tier unlocks. Any doomsday engine under
 *   construction, with its deadline and the camp to burn. And the four things
 *   barbarians can do that no player can, in plain words, including the reason
 *   each one is unfair.
 *
 *   Nothing here is a spoiler. A player who reads it learns that taking more
 *   ground makes the wilds worse — which is a strategic decision they should be
 *   allowed to make on purpose, not a trap to discover afterwards.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../state/store.js';
import { api, type ThreatDto } from '../state/api.js';
import { Empty, Pill } from '../ui/bits.js';

/** Colour by how close a band is to the top of the ladder. */
function toneFor(menace: number): string {
  if (menace >= 6) return 'var(--bad)';
  if (menace >= 4) return 'var(--warn)';
  return 'var(--line)';
}

function when(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Number(iso) - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h`;
}

export function Wilds(): JSX.Element {
  const { busy } = useStore();
  const [data, setData] = useState<ThreatDto | null>(null);

  useEffect(() => { void api.threat().then(setData); }, [busy]);

  if (!data) return <div className="page"><p className="faint">Reading what the scouts brought back…</p></div>;

  const worst = data.bands[0];
  const doomsday = data.bands.filter((b) => b.doomsdayReadyAt !== undefined);

  return (
    <div className="page">
      <h1>The Wilds</h1>
      <p className="lede">
        The barbarians do not escalate on a schedule. They escalate in answer to you — two of the three
        things driving them are your own doing, and both are listed below with their arithmetic.
      </p>

      {/* The engine under construction goes first, because it has a deadline. */}
      {doomsday.map((b) => (
        <div key={b.id} className="card" style={{ borderColor: 'var(--bad)' }} data-testid="doomsday-warning">
          <h3 style={{ marginTop: 0 }}>The {b.name} are building something.</h3>
          <p className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
            Far too large to be a siege tower, and they are not hiding the work. It is finished in{' '}
            <b>{when(b.doomsdayReadyAt)}</b>.
          </p>
          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
            Take <b>{b.seatName}</b> before it is done and the engine dies on the slipway. That is the
            whole of the counterplay, and it is why you were told.
          </p>
        </div>
      ))}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          Pressure {Math.round(data.pressure.total)}
          {worst ? <span className="faint" style={{ fontWeight: 400 }}> — worst band at menace {worst.menace}</span> : null}
        </h3>
        <table className="rows">
          <tbody>
            {data.pressure.terms.map((t) => (
              <tr key={t.label}>
                <td>{t.label}</td>
                <td className="faint" style={{ fontSize: 12 }}>{t.detail}</td>
                <td style={{ textAlign: 'right' }}>{Math.round(t.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
          Only the first line is the calendar. The other two are you, and they are the ones that move.
        </p>
      </div>

      <h2>Bands</h2>
      {data.bands.length === 0 ? (
        <Empty>Nothing in the wilds is organised enough to have a name.</Empty>
      ) : (
        data.bands.map((b) => (
          <div key={b.id} className="card" style={{ borderColor: toneFor(b.menace) }}>
            <h3 style={{ marginTop: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
              {b.name}
              <Pill>menace {b.menace}</Pill>
              <Pill>{b.rung.name}</Pill>
            </h3>
            <p className="faint" style={{ fontSize: 12, marginBottom: 6 }}>{b.dossier}</p>
            <p style={{ fontSize: 13, marginBottom: 6 }}>{b.rung.unlocks}</p>
            <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
              Seat: {b.seatName} · {b.holdings} {b.holdings === 1 ? 'holding' : 'holdings'}
              {b.confederacy ? ` · sworn to ${b.confederacy}` : ' · sworn to nobody'}
            </p>
          </div>
        ))
      )}

      <h2>What they can do that you cannot</h2>
      <p className="faint" style={{ fontSize: 12 }}>
        This asymmetry is deliberate, and it is published rather than hidden. You are not meant to match
        the barbarians move for move — you are meant to know exactly which moves you cannot match.
      </p>
      {data.privileges.map((p) => (
        <div key={p.key} className="card">
          <h3 style={{ marginTop: 0 }}>{p.name}</h3>
          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>{p.detail}</p>
        </div>
      ))}
    </div>
  );
}
