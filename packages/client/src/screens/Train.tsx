/**
 * screens/Train.tsx — the training panel
 *
 * Units spawn HERE and must physically travel to be anywhere else (spec/04 §4),
 * so this lives inside the Settlement screen rather than being an empire-wide
 * muster page. That placement is the mechanic.
 *
 * Every gate and every cost is the server's. Where a unit is refused, the
 * server's own reason is shown on the card — a player should learn that Elite
 * units need a military discipline at grade 12, not that the button is grey.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store.js';
import { api, type OptionsDto } from '../state/api.js';
import { Big, Empty, Pill, duration } from '../ui/bits.js';

export function Train({ settlementId }: { settlementId: string }): JSX.Element {
  const { run, busy } = useStore();
  const [options, setOptions] = useState<OptionsDto | null>(null);
  const [role, setRole] = useState('all');
  const [quantity, setQuantity] = useState(25);
  const [showLocked, setShowLocked] = useState(false);

  useEffect(() => {
    let live = true;
    void api.options(settlementId).then((o) => { if (live) setOptions(o); });
    return () => { live = false; };
  }, [settlementId, busy]);

  const roles = useMemo(
    () => [...new Set((options?.training ?? []).map((t) => t.role))].sort(),
    [options],
  );

  const units = useMemo(() => {
    const all = options?.training ?? [];
    return all
      .filter((t) => role === 'all' || t.role === role)
      .filter((t) => showLocked || t.allowed)
      // Buildable first, then by role, so the list opens on what can be done.
      .sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name))
      .slice(0, 40);
  }, [options, role, showLocked]);

  if (!options) return <p className="faint">Reading what this settlement can train…</p>;

  const anyAllowed = options.training.some((t) => t.allowed);

  return (
    <>
      <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
        Units are built here and stay here until you move them. Training draws on its own slots, granted by
        military buildings — a settlement never has to choose between growing and defending itself.
      </p>

      {!anyAllowed && (
        <Empty>
          Nothing can be trained here.
          <div className="faint" style={{ marginTop: 6 }}>This settlement has no military building.</div>
        </Empty>
      )}

      {anyAllowed && (
        <>
          <div className="card">
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="sr" htmlFor="train-role">Filter by role</label>
              <select id="train-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="all">All roles</option>
                {roles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="faint" style={{ fontSize: 11 }}>BATCH</span>
                <input
                  type="number" min={1} max={5000} value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Math.min(5000, Number(e.target.value))))}
                  style={{ width: 84, background: 'var(--bg-sunken)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', textAlign: 'right' }}
                />
              </label>

              <span className="spacer" />
              <label className="faint" style={{ display: 'inline-flex', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={showLocked} onChange={(e) => setShowLocked(e.target.checked)} />
                show what I cannot train yet
              </label>
            </div>
          </div>

          <div className="grid two">
            {units.map((u) => (
              <div key={u.unitKey} className="card">
                <div className="row">
                  <h3 style={{ margin: 0 }}>{u.name}</h3>
                  <span className="spacer" />
                  {!u.allowed && <Pill tone="warn">locked</Pill>}
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  <Pill>{u.role}</Pill>
                  <Pill>{u.grade}</Pill>
                </div>

                {!u.allowed && (
                  // The server's own words. A player should learn the rule,
                  // not just meet a grey button.
                  <p className="faint" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>{u.reason}</p>
                )}

                {u.allowed && (
                  <>
                    <dl className="kv" style={{ marginTop: 10 }}>
                      {Object.entries(u.cost).map(([k, v]) => (
                        <div key={k} style={{ display: 'contents' }}>
                          <dt>{k} each</dt>
                          <dd><Big value={v} /></dd>
                        </div>
                      ))}
                      <dt>time each</dt>
                      <dd>{duration(Number(u.timeMs))}</dd>
                      <dt>batch of {quantity}</dt>
                      <dd>{duration(Number(u.timeMs) * quantity)}</dd>
                    </dl>

                    <button
                      data-action="train"
                      className="primary"
                      style={{ width: '100%', marginTop: 10 }}
                      disabled={busy}
                      onClick={() => void run(`Training ${quantity} ${u.name}`, () => api.train(settlementId, u.unitKey, quantity, 'personal'))}
                    >
                      Train {quantity}
                    </button>
                    <button
                      className="ghost small"
                      style={{ width: '100%', marginTop: 6 }}
                      disabled={busy}
                      title="A governor trains at double time, per unit — a large batch becomes a serious commitment"
                      onClick={() => void run(`Governor training ${quantity} ${u.name}`, () => api.train(settlementId, u.unitKey, quantity, 'governor'))}
                    >
                      Have a governor do it (2&times; time)
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
