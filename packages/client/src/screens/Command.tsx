/**
 * screens/Command.tsx — the Command Centre
 *
 * All movements and timers in one sortable stream, with one-tap response
 * actions (spec/06 §2). This is where a player answers "what is happening to
 * me right now, and what can I do about it in the next ten minutes".
 *
 * Dispatch lives here too, because the answer to an incoming attack is usually
 * another movement.
 */

import { useMemo, useState } from 'react';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Countdown, Empty, Num, Pill } from '../ui/bits.js';

export function Command(): JSX.Element {
  const { movements, map, me, formations, run, busy, openSettlement } = useStore();

  const mine = useMemo(() => new Set((map?.settlements ?? []).filter((s) => s.mine).map((s) => s.id)), [map]);
  const inbound = useMemo(
    () => (map?.movements ?? []).filter((m) => mine.has(m.targetId) && m.ownerId !== me?.player.id),
    [map, mine, me],
  );

  const nameOf = (id: string): string => map?.settlements.find((s) => s.id === id)?.name ?? 'unknown';

  return (
    <div className="page">
      <h1>Command Centre</h1>
      <p className="lede">
        Every movement and timer in one stream. Times are shown as countdowns against server time — hover any of
        them for the exact local and UTC instant, because coordination happens across time zones.
      </p>

      <h2>Inbound</h2>
      <div className="card flush">
        {inbound.length === 0 && <Empty>Nothing is coming for you.</Empty>}
        {inbound.map((m) => (
          <div key={m.id} className="att u-critical">
            <div className="glyph" aria-hidden="true">&#9876;</div>
            <div>
              <div className="kindlabel">{m.mission}</div>
              <div className="title">Hostile force approaching {nameOf(m.targetId)}</div>
              <div className="detail">From {nameOf(m.originId)}. Reinforce, evacuate the stockpile, or meet it in the field.</div>
            </div>
            <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
              <Countdown to={m.arrivesAt} />
              <button className="small" onClick={() => void openSettlement(m.targetId)}>Open</button>
            </div>
          </div>
        ))}
      </div>

      <h2>Your movements</h2>
      <div className="card flush">
        {movements.length === 0 && <Empty>Nothing in transit.</Empty>}
        {movements.map((m) => (
          <div key={m.id} className="att u-normal">
            <div className="glyph" aria-hidden="true">&#9654;</div>
            <div>
              <div className="kindlabel">{m.mission}</div>
              <div className="title">{nameOf(m.originId)} &rarr; {nameOf(m.targetId)}</div>
              <div className="detail">
                <Num value={m.formations.reduce((n, f) => n + f.count, 0)} /> units. Arrival is an exact timestamp,
                which is what makes multi-wave timing possible.
              </div>
            </div>
            <Countdown to={m.arrivesAt} />
          </div>
        ))}
      </div>

      <h2>Dispatch</h2>
      <Dispatch />

      <p className="faint" style={{ fontSize: 12 }}>
        {formations.length} formation{formations.length === 1 ? '' : 's'} available.
        {busy && ' Working…'}
        {run === undefined && ''}
      </p>
    </div>
  );
}

function Dispatch(): JSX.Element {
  const { map, formations, me, run, busy } = useStore();
  const myHoldings = (map?.settlements ?? []).filter((s) => s.mine);
  const targets = (map?.settlements ?? []).filter((s) => !s.mine);

  const [originId, setOriginId] = useState(myHoldings[0]?.id ?? '');
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [mission, setMission] = useState('attack');
  const [counts, setCounts] = useState<Record<string, number>>({});

  const atOrigin = formations.filter((f) => f.settlementId === originId && f.count > 0);
  const total = atOrigin.reduce((n, f) => n + (counts[f.id] ?? 0), 0);

  if (myHoldings.length === 0) return <Empty>No holdings to dispatch from.</Empty>;

  return (
    <div className="card">
      <div className="grid two">
        <label>
          <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>FROM</div>
          <select value={originId} onChange={(e) => { setOriginId(e.target.value); setCounts({}); }} style={{ width: '100%' }}>
            {myHoldings.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>
          <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>TO</div>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ width: '100%' }}>
            {targets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.ownerId ? '' : ' (unowned)'}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>MISSION</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {['attack', 'raid', 'conquer', 'scout', 'reinforce'].map((m) => (
            <button key={m} className={`small ${mission === m ? 'primary' : 'ghost'}`} onClick={() => setMission(m)}>
              {m}
            </button>
          ))}
        </div>
        {mission === 'conquer' && (
          <p className="faint" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Only conquest-class units can reduce loyalty, and only era-appropriate ground forces can occupy. If none
            survive, the settlement is raided, not taken — the report will say so.
          </p>
        )}
      </div>

      <hr />

      {atOrigin.length === 0 && <p className="faint">No formations here.</p>}
      {atOrigin.map((f) => (
        <div key={f.id} className="row" style={{ marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{f.name}</div>
            <div className="faint" style={{ fontSize: 12 }}>
              {f.def?.name} &middot; {f.def?.role} &middot; {f.count} available &middot; attack tier {f.atkTier}
            </div>
          </div>
          <input
            type="number" min={0} max={f.count} value={counts[f.id] ?? 0}
            onChange={(e) => setCounts({ ...counts, [f.id]: Math.max(0, Math.min(f.count, Number(e.target.value))) })}
            style={{ width: 88, background: 'var(--bg-sunken)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', textAlign: 'right' }}
          />
          <button className="small ghost" onClick={() => setCounts({ ...counts, [f.id]: f.count })}>all</button>
        </div>
      ))}

      <button
        className="primary"
        style={{ width: '100%', marginTop: 10 }}
        disabled={busy || total === 0 || !targetId}
        onClick={() =>
          void run(`Dispatched ${total} units`, async () => {
            const chosen = atOrigin
              .filter((f) => (counts[f.id] ?? 0) > 0)
              .map((f) => ({ formationId: f.id, count: counts[f.id]! }));
            const m = await api.dispatch({ originId, targetId, mission, formations: chosen });
            setCounts({});
            return m;
          })
        }
      >
        {total === 0 ? 'Select forces' : `Send ${total} units`}
      </button>

      <p className="faint" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
        The server computes travel time from the slowest unit and returns an exact arrival timestamp.
        Player: {me?.player.name}.
      </p>
    </div>
  );
}
