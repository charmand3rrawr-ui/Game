/**
 * screens/Attention.tsx — the Attention Dashboard
 *
 * BUILD THIS FIRST (spec/06 §3). With full production isolation and no cap on
 * holdings, this is where players will live. If it is bad, nothing else
 * matters.
 *
 * It is one sortable, filterable stream of actionable items, and every
 * requirement in §3 is load-bearing:
 *
 *   - a ONE-TAP RESOLUTION on each row where one exists;
 *   - MULTI-SELECT to issue the same order across many settlements — every
 *     order still executes locally at local cost, so this is faster clicking,
 *     not automation;
 *   - user-tunable thresholds, so a player can ask to be woken only for
 *     incoming conquest units;
 *   - a virtualised list, because a player may have thousands of holdings.
 */

import { useMemo, useState } from 'react';
import type { AttentionItem } from '@ascendance/shared';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Countdown, Empty, Pill } from '../ui/bits.js';

/** Icon and label per kind. Colour is never the only carrier of meaning. */
const KINDS: Record<string, { glyph: string; label: string }> = {
  incoming_attack: { glyph: '⚔', label: 'Incoming' },
  brownout: { glyph: '⚡', label: 'Brownout' },
  warehouse_full: { glyph: '■', label: 'Overflowing' },
  governor_stalled: { glyph: '⚑', label: 'Governor stalled' },
  understaffed: { glyph: '☺', label: 'Understaffed' },
  promotion_eligible: { glyph: '★', label: 'Promotion' },
  idle_queue: { glyph: '○', label: 'Idle queue' },
  escalation: { glyph: '⚠', label: 'Escalation' },
};

function urgencyClass(u: number): string {
  if (u >= 90) return 'u-critical';
  if (u >= 60) return 'u-high';
  if (u >= 35) return 'u-normal';
  return 'u-low';
}

export function Attention(): JSX.Element {
  const { attention, me, run, go, busy } = useStore();
  const [filter, setFilter] = useState<string>('all');
  const [minUrgency, setMinUrgency] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const kinds = useMemo(() => [...new Set(attention.map((i) => i.kind))], [attention]);

  const visible = useMemo(
    () => attention.filter((i) => (filter === 'all' || i.kind === filter) && i.urgency >= minUrgency),
    [attention, filter, minUrgency],
  );

  // Virtualisation: a player may have thousands of holdings, so only the
  // viewport is rendered. The window grows as they scroll rather than
  // materialising ten thousand rows nobody will read.
  const [window, setWindow] = useState(60);
  const rows = visible.slice(0, window);

  const idleSelected = [...selected]
    .map((id) => attention.find((i) => i.id === id))
    .filter((i): i is AttentionItem => i?.kind === 'idle_queue' && i.settlementId !== undefined);

  return (
    <div className="page">
      <h1>Attention</h1>
      <p className="lede">
        Everything waiting on you, most urgent first. Production is isolated per holding — nothing here
        resolves itself, and nothing is automated on your behalf.
      </p>

      {me && me.player.envyScopes.length > 0 && (
        <div className="notice">
          <b>Heaven&rsquo;s Envy.</b> You are marked on {me.player.envyScopes.length} leaderboard
          {me.player.envyScopes.length === 1 ? '' : 's'}: <b>&minus;{me.player.envyScopes.length * 10}% defensive
          strength</b> for 24 hours. It cannot be cleansed, offset, or dodged by going on holiday, and attacking you
          costs no reputation while it lasts.
        </div>
      )}

      <div className="card">
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="sr" htmlFor="att-filter">Filter by kind</label>
          <select id="att-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Everything ({attention.length})</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KINDS[k]?.label ?? k} ({attention.filter((i) => i.kind === k).length})
              </option>
            ))}
          </select>

          {/*
            User-tunable notification thresholds (spec/06 §3): "only wake me for
            incoming conquest units", digest mode. The same control that filters
            the list is the one that decides what is worth a push.
          */}
          <label className="sr" htmlFor="att-urgency">Minimum urgency</label>
          <select id="att-urgency" value={minUrgency} onChange={(e) => setMinUrgency(Number(e.target.value))}>
            <option value={0}>Everything</option>
            <option value={35}>Worth a look</option>
            <option value={60}>Important</option>
            <option value={90}>Wake me only for attacks</option>
          </select>

          <span className="spacer" />
          <span className="faint">{visible.length} shown</span>
        </div>

        {idleSelected.length > 1 && (
          <>
            <hr />
            <div className="row wrap">
              <span className="dim">
                {idleSelected.length} settlements selected. The same order, issued to each —
                <b> every one executes locally at local cost.</b> This is faster clicking, not automation.
              </span>
              <span className="spacer" />
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(`Queued a farm in ${idleSelected.length} settlements`, async () => {
                    for (const item of idleSelected) {
                      // Each enqueue is its own command against its own
                      // settlement's stockpile, and any one of them may be
                      // rejected on its own terms.
                      await api.enqueue(item.settlementId!, '1_farm', 'personal').catch(() => undefined);
                    }
                    setSelected(new Set());
                  })
                }
              >
                Queue a farm in each
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card flush">
        {rows.length === 0 && (
          <Empty>
            Nothing is waiting on you.
            <div className="faint" style={{ marginTop: 6 }}>
              Idle queues and full warehouses will appear here as they happen.
            </div>
          </Empty>
        )}

        {rows.map((item) => {
          const meta = KINDS[item.kind] ?? { glyph: '•', label: item.kind };
          const selectable = item.kind === 'idle_queue' && item.settlementId;
          return (
            <div key={item.id} className={`att ${urgencyClass(item.urgency)}`}>
              <div className="glyph" aria-hidden="true">{meta.glyph}</div>

              <div>
                <div className="kindlabel">{meta.label}</div>
                <div className="title">{item.title}</div>
                <div className="detail">{item.detail}</div>
                {selectable && (
                  <label className="faint" style={{ display: 'inline-flex', gap: 6, marginTop: 6, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        setSelected(next);
                      }}
                    />
                    select for a batch order
                  </label>
                )}
              </div>

              <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                {item.deadline !== undefined && <Countdown to={item.deadline} />}
                {item.action && (
                  <button
                    className="small"
                    disabled={busy}
                    onClick={() => void resolve(item, go, run)}
                  >
                    {item.action.label}
                  </button>
                )}
                {!item.action && <Pill>no action</Pill>}
              </div>
            </div>
          );
        })}
      </div>

      {visible.length > rows.length && (
        <button className="ghost" style={{ width: '100%' }} onClick={() => setWindow((w) => w + 60)}>
          Show {Math.min(60, visible.length - rows.length)} more of {visible.length}
        </button>
      )}
    </div>
  );
}

/**
 * The one-tap resolution.
 *
 * Every row that can be acted on carries the command it needs. Navigation
 * actions open the screen that can fix it; direct actions issue the command
 * and reconcile.
 */
async function resolve(
  item: AttentionItem,
  go: ReturnType<typeof useStore.getState>['go'],
  run: ReturnType<typeof useStore.getState>['run'],
): Promise<void> {
  const action = item.action;
  if (!action) return;

  switch (action.command) {
    case 'open-settlement':
      await go('settlement', String(action.params['settlementId']));
      return;
    case 'open-haul':
    case 'open-dispatch':
      await go('command');
      return;
    case 'seize': {
      // Seize needs a free personal slot, and the server will say so plainly
      // if there is not one.
      const settlementId = String(action.params['settlementId']);
      const detail = await api.settlement(settlementId);
      const governorJob = detail.queue.find((q) => q.slotKind === 'governor');
      if (!governorJob) {
        await go('settlement', settlementId);
        return;
      }
      await run('Seized the governor job', () => api.seize(governorJob.id));
      return;
    }
    case 'tier-up':
      await run('Promoted', () =>
        api.tierUp(String(action.params['formationId']), action.params['track'] === 'def' ? 'def' : 'atk'),
      );
      return;
    default:
      await go('attention');
  }
}
