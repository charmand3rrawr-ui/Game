/**
 * screens/Settlement.tsx — plots, queues, buildings, stockpile, staffing
 *
 * Every number shown here came from the server. The client does not compute a
 * cost, a completion time, or whether something is allowed — it displays what
 * the server decided and shows the server's reason when something is refused
 * (invariant §2.1, spec/06 §5).
 *
 * The screen is organised around the constraint that actually drives play:
 * PLOTS ARE SCARCE. A settlement can never hold every building, so the plot
 * counter is the first thing on the page, not a footnote.
 */

import { useMemo, useState } from 'react';
import { useStore } from '../state/store.js';
import { api, type AvailableBuilding } from '../state/api.js';
import { C } from '@ascendance/shared';
import { Big, Bar, Countdown, Empty, LevelBadge, Num, Pill, duration } from '../ui/bits.js';
import { Train } from './Train.js';
import { SettlementCanvas, type Plot } from '../settlement/SettlementCanvas.js';
import { activityState, damageState, tierForLevel } from '../settlement/visual.js';

export function Settlement(): JSX.Element {
  const { settlement, me, run, busy, go } = useStore();
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [pane, setPane] = useState<'build' | 'train'>('build');
  const [plot, setPlot] = useState<number | null>(null);

  // EVERY hook runs before any early return. The fogged and empty states below
  // return different trees, and a hook called after one of them would change
  // the hook count between renders — which React rejects outright.
  const available = settlement?.available ?? [];
  const categories = useMemo(() => [...new Set(available.map((a) => a.category))].sort(), [available]);
  /**
   * The settlement laid out as plots.
   *
   * A building's `plotIndex` is where it physically stands, so the canvas can
   * draw the same place every time rather than reshuffling on each poll. A job
   * with shard-hours spent on it is Overdriven, which the canvas is required to
   * make conspicuous — that is a display of a server fact, not a computed one.
   */
  const plots = useMemo<Plot[]>(() => {
    const queue = settlement?.queue ?? [];
    const overdrivenKeys = new Set(
      queue.filter((q) => q.kind === 'building' && q.shardHoursSpent > 0).map((q) => q.targetKey),
    );
    // Footprints are packed in order: a building consumes `sizeClass` cells, so
    // the cells they occupy add up to exactly the server's `plots.used`.
    let cursor = 0;
    return (settlement?.buildings ?? []).map((b) => {
      const span = Math.max(1, b.ref.sizeClass ?? 1);
      const index = cursor;
      cursor += span;
      return {
      index,
      span,
      building: {
        id: b.id,
        key: b.buildingKey,
        name: b.ref.name,
        category: b.ref.category,
        level: b.level,
        damage: b.damage,
        staffedPct: b.staffedPct,
        era: b.ref.era,
        overdriven: overdrivenKeys.has(b.buildingKey),
        brownout: b.brownoutSince !== undefined,
      },
      };
    });
  }, [settlement]);

  const buildable = useMemo(
    () =>
      available
        .filter((a) => category === 'all' || a.category === category)
        .filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => b.currentLevel - a.currentLevel || a.name.localeCompare(b.name))
        .slice(0, 60),
    [available, category, search],
  );

  if (!settlement) return <div className="page"><Empty>Pick a holding from the map.</Empty></div>;

  const s = settlement;
  const mine = s.settlement.ownerId === me?.player.id;

  if (!mine || s.fogged) {
    return (
      <div className="page">
        <h1>{s.settlement.name}</h1>
        <p className="lede">
          Not yours. This is what a scout can see — building levels, stockpiles, queues and garrison stay
          hidden until you look properly.
        </p>
        <div className="card">
          <h3>Visible structures</h3>
          <div className="row wrap" style={{ gap: 6 }}>
            {s.buildings.map((b) => (
              <Pill key={b.id} tone={b.damage > 0 ? 'danger' : undefined}>
                {b.ref.name}
                {b.damage > 0 && ' — damaged'}
              </Pill>
            ))}
          </div>
          <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
            Fogged: {(s.fogged ?? []).join(', ')}
          </p>
        </div>
        <button onClick={() => void go('command')}>Plan an operation against it</button>
      </div>
    );
  }

  const plotsFree = s.plots.total - s.plots.used;
  // The HQ grade sets the settlement's standing, which drives the cultivation
  // aura band on the canvas.
  const gradeOfHq = Math.max(1, Math.ceil(s.hqLevel / 32));

  return (
    <div className="page">
      <h1>{s.settlement.name}</h1>
      <p className="lede">
        {s.settlement.holdingType.replace(/_/g, ' ')} &middot; population <Num value={s.settlement.population} /> &middot;
        loyalty <Num value={s.settlement.loyalty} />
      </p>

      {/*
        THE SETTLEMENT ITSELF.
        Art is authored per tier, so a building visibly rebuilds as it crosses a
        level band, and the two overlays that carry gameplay — damage, and the
        conspicuous Overdriven shimmer — are legible without reading a number.
      */}
      <SettlementCanvas
        plots={plots}
        totalPlots={s.plots.total}
        usedPlots={s.plots.used}
        selected={plot}
        onSelect={setPlot}
        grade={gradeOfHq}
        maxGrade={C.MAX_GRADE}
        biome={s.settlement.layer === 'surface' ? 'temperate' : 'void'}
      />

      <PlotPanel
        plots={plots}
        index={plot}
        onBuildHere={() => { setPane('build'); setPlot(null); }}
        onClose={() => setPlot(null)}
      />

      <div className="grid two">
        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>Plots</h3>
            <span className="spacer" />
            <span className="num">{s.plots.used} / {s.plots.total}</span>
          </div>
          <Bar value={s.plots.used} max={s.plots.total} tone={plotsFree <= 2 ? 'danger' : plotsFree <= 6 ? 'warn' : undefined} />
          <p className="faint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
            {plotsFree} free. A settlement can never hold every building — this scarcity is what forces it to
            specialise. Plots come from the holding type and the HQ grade.
          </p>
        </div>

        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>Staffing</h3>
            <span className="spacer" />
            <span className="num">{Math.round(s.staffing.ratio * 100)}%</span>
          </div>
          <Bar value={s.staffing.supply} max={Math.max(s.staffing.demand, 1)} tone={s.staffing.ratio < 0.5 ? 'danger' : s.staffing.ratio < 0.8 ? 'warn' : 'ok'} />
          <p className="faint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
            <Num value={s.staffing.supply} /> workers for <Num value={s.staffing.demand} /> posts. Output scales
            linearly with staffing — understaffing is the normal state of a growing settlement, not an error.
          </p>
        </div>
      </div>

      <h2>Stockpile</h2>
      <div className="card flush scroll-x">
        <table>
          <thead>
            <tr><th>Resource</th><th className="num">Held</th><th className="num">Capacity</th><th>Fill</th></tr>
          </thead>
          <tbody>
            {s.stockpiles.map((sp) => {
              const amount = BigInt(sp.amount);
              const capacity = BigInt(sp.capacity);
              const full = capacity > 0n && amount >= capacity;
              return (
                <tr key={sp.resourceKey}>
                  <td>
                    {sp.resourceKey}
                    {full && <> <Pill tone="danger" title="Production above capacity is discarded, not carried">losing output</Pill></>}
                  </td>
                  <td className="num"><Big value={sp.amount} /></td>
                  <td className="num"><Big value={sp.capacity} /></td>
                  <td style={{ width: 120 }}>
                    <Bar value={Number(amount)} max={Number(capacity)} tone={full ? 'danger' : undefined} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Queues</h2>
      <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
        Personal slots come from the HQ. Governor slots run in parallel at double time — that one number is the
        entire governor system, and a free personal slot is what lets you seize a job back.
      </p>
      <div className="card flush">
        {s.queue.length === 0 && <Empty>Nothing building. Idle slots are unspent time.</Empty>}
        {s.queue.map((q) => (
          <div key={q.id} className="att u-normal">
            <div className="glyph" aria-hidden="true">{q.slotKind === 'governor' ? '⚑' : '▸'}</div>
            <div>
              <div className="kindlabel">{q.kind} &middot; {q.slotKind} &middot; {q.timeMultiplier}&times; time</div>
              <div className="title">
                {q.kind === 'training'
                  ? `${q.quantity ?? 1} \u00d7 ${q.targetKey.split('|')[1] ?? q.targetKey}`
                  : s.available.find((a) => a.key === q.targetKey)?.name ?? q.targetKey.replace(/_/g, ' ')}
                {q.kind !== 'training' && q.targetLevel !== undefined && <> &rarr; level {q.targetLevel}</>}
              </div>
              <div className="detail">
                {q.shardHoursSpent > 0
                  ? `${q.shardHoursSpent.toFixed(1)} shard-hours applied. Overdriven construction is deliberately conspicuous.`
                  : 'Running on real time.'}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
              <Countdown to={q.finishesAt} />
              <div className="row" style={{ gap: 4 }}>
                {q.slotKind === 'governor' && (
                  <button
                    className="small"
                    disabled={busy}
                    title="Keeps elapsed progress and recomputes the remainder at 1x. Needs a free personal slot."
                    onClick={() => void run('Seized', () => api.seize(q.id))}
                  >
                    Seize
                  </button>
                )}
                <button
                  className="small"
                  disabled={busy}
                  title="Compress remaining time, up to your earned ceiling. Never past it."
                  onClick={() => void run('Shards applied', () => api.spendShards(q.id, 8))}
                >
                  Shards
                </button>
                <button
                  className="small danger"
                  disabled={busy}
                  title="Refunds 80% of resources"
                  onClick={() => void run('Cancelled', () => api.cancel(q.id))}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2>Production</h2>
      <div className="card flush scroll-x">
        <table>
          <thead>
            <tr><th>Building</th><th>Yields</th><th className="num">Per hour</th><th className="num">Staffed</th><th className="num">Adjacency</th></tr>
          </thead>
          <tbody>
            {s.production.length === 0 && (
              <tr><td colSpan={5} className="faint">Nothing is producing.</td></tr>
            )}
            {s.production.map((p, i) => (
              <tr key={i}>
                <td>
                  {p.buildingName}
                  {p.brownout && <> <Pill tone="danger" title="Upkeep unpaid: output halved, and after 72h it sheds a level a day">brownout</Pill></>}
                </td>
                <td className="dim">{p.resourceKey}</td>
                <td className="num"><Num value={p.ratePerHour} digits={1} /></td>
                <td className="num">{p.staffedPct}%</td>
                <td className="num">{p.adjacencyBonus > 0 ? `+${Math.round(p.adjacencyBonus * 100)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Make something</h2>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {/* data-pane is a stable hook for the browser smoke test: "Build" and
            "Train" also appear on the action buttons below, and a test that
            picks by label alone silently clicks the wrong one. */}
        <button data-pane="build" className={`small ${pane === 'build' ? 'primary' : 'ghost'}`} onClick={() => setPane('build')}>Build</button>
        <button data-pane="train" className={`small ${pane === 'train' ? 'primary' : 'ghost'}`} onClick={() => setPane('train')}>Train</button>
      </div>

      {pane === 'train' && <Train settlementId={s.settlement.id} />}

      {pane === 'build' && (
      <>
      <div className="card">
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="sr" htmlFor="cat">Category</label>
          <select id="cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input placeholder="Search buildings" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 140, background: 'var(--bg-sunken)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }} />
        </div>
      </div>

      <div className="grid two">
        {buildable.map((b) => (
          <BuildCard key={b.key} b={b} plotsFree={plotsFree} hqLevel={s.hqLevel} settlementId={s.settlement.id} />
        ))}
      </div>
      </>
      )}
    </div>
  );
}

function BuildCard({ b, plotsFree, hqLevel, settlementId }: {
  b: AvailableBuilding; plotsFree: number; hqLevel: number; settlementId: string;
}): JSX.Element {
  const { run, busy } = useStore();
  const isNew = b.currentLevel === 0;
  const blockedByPlots = isNew && plotsFree < b.sizeClass;
  const blockedByHq = b.category !== 'HQ/Governance' && b.currentLevel + 1 > hqLevel;

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>{b.name}</h3>
        <span className="spacer" />
        <LevelBadge level={b.currentLevel} />
      </div>
      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        <Pill>{b.category}</Pill>
        <Pill title="Plots this building occupies">{b.sizeClass} plot{b.sizeClass === 1 ? '' : 's'}</Pill>
        <Pill>Era {b.era}</Pill>
      </div>

      <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>{b.purpose ?? b.functionText}</p>
      {b.mechanic && <p className="faint" style={{ fontSize: 12, fontStyle: 'italic' }}>{b.mechanic}</p>}

      <dl className="kv" style={{ marginTop: 10 }}>
        {Object.entries(b.cost).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd><Big value={v} /></dd>
          </div>
        ))}
        <dt>time</dt>
        <dd>{duration(Number(b.timeMs))}</dd>
      </dl>

      <button
        data-action="build"
        className="primary"
        style={{ width: '100%', marginTop: 10 }}
        disabled={busy || blockedByPlots || blockedByHq}
        onClick={() => void run(`Queued ${b.name}`, () => api.enqueue(settlementId, b.key, 'personal'))}
      >
        {blockedByPlots
          ? `Needs ${b.sizeClass} plots — ${plotsFree} free`
          : blockedByHq
            ? `Blocked by the HQ at level ${hqLevel}`
            : isNew ? 'Build' : `Raise to ${b.currentLevel + 1}`}
      </button>
      <button
        className="ghost small"
        style={{ width: '100%', marginTop: 6 }}
        disabled={busy || blockedByPlots || blockedByHq}
        title="Runs in the governor's own parallel queue at double time"
        onClick={() => void run(`Governor queued ${b.name}`, () => api.enqueue(settlementId, b.key, 'governor'))}
      >
        Have a governor do it (2&times; time)
      </button>
    </div>
  );
}

/**
 * What you selected on the canvas.
 *
 * The canvas answers "what is this place like"; this answers "what is this
 * building, exactly". Both matter: spec/06 §6 requires the maths be shown, not
 * summarised, so clicking a building gives you its real numbers and the plain
 * sentence the workbook attaches to its tier.
 */
function PlotPanel({ plots, index, onBuildHere, onClose }: {
  plots: Plot[];
  index: number | null;
  onBuildHere: () => void;
  onClose: () => void;
}): JSX.Element | null {
  if (index === null) return null;
  const plot = plots.find((p) => p.index === index);
  const b = plot?.building;

  if (!b) {
    return (
      <div className="card plot-panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>Plot {index + 1} — empty</h3>
          <span className="spacer" />
          <button className="ghost small" onClick={onClose}>Close</button>
        </div>
        <p className="faint" style={{ fontSize: 12 }}>
          Ground, cleared and waiting. Plots do not come back once spent, so what goes here is the decision
          that shapes this settlement.
        </p>
        <button className="primary" style={{ width: '100%' }} onClick={onBuildHere}>Choose a building</button>
      </div>
    );
  }

  const tier = tierForLevel(b.level);
  const dmg = damageState(b.damage);
  const act = activityState(b);

  return (
    <div className="card plot-panel">
      <div className="row">
        <h3 style={{ margin: 0 }}>{b.name}</h3>
        <span className="spacer" />
        <LevelBadge level={b.level} />
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>

      {/* The workbook's own sentence for this tier: what a player is meant to
          conclude from the silhouette alone. */}
      <p className="faint" style={{ fontSize: 12.5, marginTop: 6, fontStyle: 'italic' }}>
        &ldquo;{tier.read}&rdquo;
      </p>
      <p className="faint" style={{ fontSize: 11.5, marginTop: -4 }}>
        Visual tier {tier.tier} of 11 &middot; {tier.silhouette.toLowerCase()} &middot; levels {tier.minLevel}&ndash;{tier.maxLevel}
      </p>

      <div className="row wrap" style={{ gap: 6 }}>
        <Pill>{b.category}</Pill>
        {act === 'overdriven' && <Pill tone="envy">Overdriven — everyone can see this</Pill>}
        {act === 'idle' && !b.brownout && <Pill tone="warn">idle — understaffed</Pill>}
        {b.brownout && <Pill tone="danger">Brownout — upkeep unpaid</Pill>}
        {dmg !== 'pristine' && <Pill tone="danger">{dmg}</Pill>}
        {act === 'working' && <Pill tone="ok">working</Pill>}
      </div>

      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>staffed</dt><dd>{b.staffedPct}%</dd>
        {b.damage > 0 && <><dt>damage</dt><dd>{b.damage}% — persists until repaired</dd></>}
        <dt>next tier at</dt>
        <dd>{tier.tier >= 11 ? 'this is the top tier' : `level ${tier.maxLevel + 1}`}</dd>
      </dl>
    </div>
  );
}
