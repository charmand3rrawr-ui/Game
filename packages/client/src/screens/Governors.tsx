/**
 * screens/Governors.tsx — delegation, and what it costs you
 *
 * The entire governor system is one number: anything a governor initiates
 * takes twice as long (spec/04 §6). No efficiency loss, no output tax. So this
 * screen has one job beyond appointing them — make the two things a player
 * will otherwise learn the hard way visible up front:
 *
 *   1. THE 2x IS THE PRICE. It is stated on the appointment, on every governor
 *      card, and beside every job a governor started. Seize takes a job back at
 *      1x and keeps the elapsed progress, and it costs a PERSONAL queue slot —
 *      that scarcity is the only thing stopping a player governing everything
 *      and instantly seizing it all back.
 *
 *   2. GOVERNORS HAVE NO JUDGEMENT. A build order that meets a shortfall stalls
 *      rather than skipping ahead. That is not a bug to be smoothed over, it is
 *      the design, so each of the six spec sheets carries its own published
 *      failure mode from the workbook, right where you edit it.
 *
 * Spec editing is a real UI, not a JSON box (spec/06 §2).
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store.js';
import {
  api, ApiError,
  type GovernorDto, type GovernorSpecsDto, type GovernorsDto, type OptionsDto,
} from '../state/api.js';
import { Empty, Pill } from '../ui/bits.js';

const POSTURES: { key: GovernorSpecsDto['defencePosture']; label: string; what: string }[] = [
  { key: 'garrison', label: 'Garrison', what: 'Everything stays home. No bonus, no penalty.' },
  { key: 'mobile', label: 'Sally', what: 'Meets attackers in the field. Trades defence for the chance to break a siege early.' },
  { key: 'fortify', label: 'Fortify', what: 'Turtles behind the walls. Stronger defensively; will not pursue.' },
];

function blank(): GovernorSpecsDto {
  return {
    buildOrder: [],
    trainingStandingOrder: [],
    researchMandate: [],
    resourcePolicy: { keepDays: 3 },
    defencePosture: 'garrison',
    escalationRules: { alertOnIncoming: true, alertBelowLoyalty: 40 },
  };
}

export function Governors(): JSX.Element {
  const { run, busy, me } = useStore();
  const [data, setData] = useState<GovernorsDto | null>(null);
  const [editing, setEditing] = useState<GovernorDto | null>(null);
  const [appointing, setAppointing] = useState(false);
  const [audit, setAudit] = useState<{ id: string; findings: string[]; subverted: boolean } | null>(null);

  const load = (): void => { void api.governors().then(setData); };
  useEffect(() => { load(); }, [busy]);

  if (!data) return <div className="page"><p className="faint">Reading the appointment rolls…</p></div>;

  const ungoverned = data.settlements.filter((s) => !s.governorId);

  return (
    <div className="page">
      <h1>Stewards</h1>
      <p className="lede">
        There is no cap on holdings and no administrative overload penalty. The only limit on how wide you
        play is your own attention — and a governor buys that back at exactly one price.
      </p>

      <div className="card" style={{ borderColor: 'var(--warn)' }}>
        <h3 style={{ marginTop: 0 }}>Anything a governor initiates takes twice as long.</h3>
        <p className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
          That is the whole mechanic. No output tax, no efficiency loss, no upkeep — the job simply takes 2×
          the time it would have taken you. You can <b>Seize</b> any governor job in progress: the elapsed
          progress is kept and the remainder recalculates at 1×. Seizing needs a free <b>personal</b> queue
          slot, and that scarcity is the only thing stopping you from governing everything and taking it all
          back the moment it starts.
        </p>
      </div>

      <h2>Your commander</h2>
      <div className="card">
        <div className="row">
          <div>
            <div className="faint" style={{ fontSize: 11 }}>COMMANDER LEVEL</div>
            <div style={{ fontSize: 22, fontWeight: 600 }} className="num">{data.commanderLevel}</div>
          </div>
          <span className="spacer" />
          <p className="faint" style={{ fontSize: 11.5, margin: 0, maxWidth: 260, textAlign: 'right' }}>
            The most experienced formation you have. A commander is someone who has led troops, so delegation
            is earned by fighting — and the server reads the level, never the client.
          </p>
        </div>
        {data.commanderLevel === 0 && (
          <p className="capnote" style={{ marginTop: 10 }}>
            Every formation you have is still green, so there is nobody to appoint. Veterancy is earned in
            battle, and a formation that has fought a dozen real engagements is enough for a Bailiff.
          </p>
        )}
        <div className="scroll-x" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Tier</th><th>Area</th><th className="num">Needs</th><th /></tr></thead>
            <tbody>
              {data.tiers.map((t) => {
                const ok = data.commanderLevel >= t.commanderLevel;
                return (
                  <tr key={t.key} style={ok ? undefined : { opacity: 0.55 }}>
                    <td>{t.name}</td>
                    <td className="faint" style={{ fontSize: 12 }}>{t.area} — {t.covers}</td>
                    <td className="num">{t.commanderLevel}</td>
                    <td>{ok ? <Pill tone="ok">available</Pill> : <Pill>needs level {t.commanderLevel}</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Appointed</h2>
      {data.governors.length === 0 ? (
        <Empty>
          Nobody governs for you. Everything you build, you started yourself — which is the fastest way to
          play, right up until it is the only way you can play.
        </Empty>
      ) : (
        <div className="card flush">
          {data.governors.map((g) => {
            const tier = data.tiers.find((t) => t.key === g.tier);
            return (
              <div key={g.id} className="att">
                <div className="glyph" aria-hidden="true">&#9878;</div>
                <div>
                  <div className="kindlabel">{tier?.name ?? g.tier}</div>
                  <div className="title">{g.areaNames.join(', ')}</div>
                  <div className="detail">
                    {g.specs.buildOrder.length} build steps · {g.specs.trainingStandingOrder.length} standing
                    orders · {g.specs.researchMandate.length} mandated disciplines ·{' '}
                    {POSTURES.find((p) => p.key === g.specs.defencePosture)?.label.toLowerCase()}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                  <button className="small" onClick={() => { setAppointing(false); setEditing(g); }}>Specs</button>
                  <button
                    className="small ghost"
                    disabled={busy}
                    onClick={() => { void api.auditGovernor(g.id).then((a) => setAudit({ id: g.id, ...a })); }}
                    title="A subverted governor follows corrupted specs silently. An audit is the only thing that reveals it."
                  >
                    Audit
                  </button>
                  <button
                    className="small danger"
                    disabled={busy}
                    onClick={() => void run('Governor dismissed', () => api.dismissGovernor(g.id))}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {audit && (
        <div className="card" style={{ borderColor: audit.subverted ? 'var(--danger)' : undefined }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>Audit</h3>
            <span className="spacer" />
            <button className="ghost small" onClick={() => setAudit(null)}>Close</button>
          </div>
          {audit.subverted && <Pill tone="danger">this governor has been turned</Pill>}
          <ul style={{ fontSize: 12.5, marginBottom: 0, paddingLeft: 18 }}>
            {audit.findings.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      {!editing && !appointing && (
        <button
          className="primary"
          style={{ width: '100%', marginTop: 12 }}
          disabled={ungoverned.length === 0}
          onClick={() => setAppointing(true)}
        >
          {ungoverned.length === 0 ? 'Every holding already has a governor' : 'Appoint a governor'}
        </button>
      )}

      {(editing || appointing) && (
        <SpecEditor
          data={data}
          governor={editing}
          settlementsAvailable={editing ? data.settlements : ungoverned}
          defaultSettlementId={me?.settlements[0]?.id}
          onClose={() => { setEditing(null); setAppointing(false); }}
          onSaved={() => { setEditing(null); setAppointing(false); load(); }}
        />
      )}
    </div>
  );
}

/**
 * The six sheets.
 *
 * Every section carries the workbook's own text for what that sheet controls
 * and — the part that matters — what it does when written badly. A player who
 * reads "stalls on the first unaffordable entry and builds nothing further"
 * while writing the build order is a player who will not file that stall as a
 * bug later.
 */
function SpecEditor({
  data, governor, settlementsAvailable, defaultSettlementId, onClose, onSaved,
}: {
  data: GovernorsDto;
  governor: GovernorDto | null;
  settlementsAvailable: GovernorsDto['settlements'];
  defaultSettlementId?: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { run, busy } = useStore();
  const [specs, setSpecs] = useState<GovernorSpecsDto>(governor ? structuredClone(governor.specs) : blank());
  const [tier, setTier] = useState<string>(governor?.tier ?? 'bailiff');
  const [chosen, setChosen] = useState<string[]>(governor ? [...governor.areaRef.settlementIds] : []);
  const [options, setOptions] = useState<OptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Options are read from a settlement inside the area, so the pickers offer
  // what can actually be built there rather than the whole catalogue.
  const sampleId = chosen[0] ?? settlementsAvailable[0]?.id ?? defaultSettlementId;
  useEffect(() => {
    if (!sampleId) return;
    void api.options(sampleId).then(setOptions).catch(() => setOptions(null));
  }, [sampleId]);

  /**
   * Names, indexed once per catalogue rather than searched per row.
   *
   * Every row of the build order, the standing orders and the research mandate
   * needs to turn a key into a display name. Scanning the settlement's whole
   * catalogue for each of them re-ran that search on every render — so a long
   * build order paid for the entire catalogue, several times over, on every
   * keystroke in a level field. These Maps rebuild only when the catalogue
   * itself changes.
   */
  const names = useMemo(() => ({
    buildings: new Map((options?.buildings ?? []).map((b) => [b.key, b.name])),
    training: new Map((options?.training ?? []).map((t) => [t.unitKey, t.name])),
    research: new Map((options?.research ?? []).map((r) => [r.key, r.name])),
  }), [options]);

  /** Six sheets, but looked up once per section and per render all the same. */
  const sheets = useMemo(() => new Map(data.sheets.map((x) => [x.key, x])), [data.sheets]);
  const sheet = (key: string): GovernorsDto['sheets'][number] | undefined => sheets.get(key);

  const tierRef = data.tiers.find((t) => t.key === tier);
  const tierLocked = tierRef !== undefined && data.commanderLevel < tierRef.commanderLevel;

  const save = (): void => {
    setError(null);
    const attempt = governor
      ? (): Promise<unknown> => api.updateGovernorSpecs(governor.id, specs)
      : (): Promise<unknown> => api.appointGovernor({
          commanderId: crypto.randomUUID(),
          tier,
          layer: 'surface',
          settlementIds: chosen,
          specs,
        });
    void run(governor ? 'Specs updated' : 'Governor appointed', async () => {
      try {
        const out = await attempt();
        onSaved();
        return out;
      } catch (e) {
        setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
        throw e;
      }
    });
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{governor ? 'Spec sheets' : 'Appoint a governor'}</h3>
        <span className="spacer" />
        <button className="ghost small" onClick={onClose}>Cancel</button>
      </div>

      {!governor && (
        <>
          <Section title="Tier" note={tierRef?.notes}>
            <div className="row wrap" style={{ gap: 6 }}>
              {data.tiers.map((t) => {
                const locked = data.commanderLevel < t.commanderLevel;
                return (
                  <button
                    key={t.key}
                    className={`small ${tier === t.key ? 'primary' : 'ghost'}`}
                    disabled={locked}
                    title={locked ? `Needs a commander of level ${t.commanderLevel}; your best is ${data.commanderLevel}.` : t.covers}
                    onClick={() => setTier(t.key)}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Area of authority" note="A governor governs an AREA, not a list you curate. Everything you hold inside it comes under them — including holdings you found later.">
            {settlementsAvailable.length === 0 ? (
              <Empty>Nothing left to govern.</Empty>
            ) : settlementsAvailable.map((s) => (
              <label key={s.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
                <input
                  type="checkbox"
                  checked={chosen.includes(s.id)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </Section>
        </>
      )}

      {/* ---------------------------------------------------------- 1. build */}
      <Section title="Build Order" note={sheet('buildOrder')?.defines} failure={sheet('buildOrder')?.failure}>
        {specs.buildOrder.length === 0 && <p className="faint" style={{ fontSize: 12 }}>Nothing ordered. The governor will build nothing.</p>}
        {specs.buildOrder.map((entry, i) => (
          <div key={i} className="row" style={{ gap: 6, padding: '3px 0' }}>
            <span className="faint num" style={{ fontSize: 11, width: 18 }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 13 }}>
              {names.buildings.get(entry.buildingKey) ?? entry.buildingKey}
            </span>
            <label className="faint" style={{ fontSize: 11 }}>
              to{' '}
              <input
                type="number"
                min={1}
                max={1337}
                value={entry.toLevel}
                style={{ width: 62 }}
                onChange={(e) => {
                  const next = [...specs.buildOrder];
                  next[i] = { ...entry, toLevel: Math.max(1, Number(e.target.value) || 1) };
                  setSpecs({ ...specs, buildOrder: next });
                }}
              />
            </label>
            <button
              className="small ghost"
              disabled={i === 0}
              title="Order is everything: a governor never reorders and never improvises."
              onClick={() => {
                const next = [...specs.buildOrder];
                const prev = next[i - 1]!;
                next[i - 1] = entry; next[i] = prev;
                setSpecs({ ...specs, buildOrder: next });
              }}
            >
              &#8593;
            </button>
            <button
              className="small danger"
              onClick={() => setSpecs({ ...specs, buildOrder: specs.buildOrder.filter((_, j) => j !== i) })}
            >
              &#215;
            </button>
          </div>
        ))}
        <select
          value=""
          style={{ width: '100%', marginTop: 6 }}
          onChange={(e) => {
            if (!e.target.value) return;
            const b = options?.buildings.find((x) => x.key === e.target.value);
            setSpecs({
              ...specs,
              buildOrder: [...specs.buildOrder, { buildingKey: e.target.value, toLevel: (b?.currentLevel ?? 0) + 1 }],
            });
          }}
        >
          <option value="">Add a building…</option>
          {(options?.buildings ?? []).map((b) => (
            <option key={b.key} value={b.key}>{b.name} (now {b.currentLevel})</option>
          ))}
        </select>
      </Section>

      {/* ------------------------------------------------------- 2. training */}
      <Section title="Training Standing Order" note={sheet('trainingStandingOrder')?.defines} failure={sheet('trainingStandingOrder')?.failure}>
        {specs.trainingStandingOrder.map((entry, i) => (
          <div key={i} className="row" style={{ gap: 6, padding: '3px 0' }}>
            <span style={{ flex: 1, fontSize: 13 }}>
              {names.training.get(entry.unitKey) ?? entry.unitKey}
            </span>
            <label className="faint" style={{ fontSize: 11 }}>
              keep{' '}
              <input
                type="number"
                min={0}
                value={entry.maintainCount}
                style={{ width: 72 }}
                onChange={(e) => {
                  const next = [...specs.trainingStandingOrder];
                  next[i] = { ...entry, maintainCount: Math.max(0, Number(e.target.value) || 0) };
                  setSpecs({ ...specs, trainingStandingOrder: next });
                }}
              />
            </label>
            <button
              className="small danger"
              onClick={() => setSpecs({ ...specs, trainingStandingOrder: specs.trainingStandingOrder.filter((_, j) => j !== i) })}
            >
              &#215;
            </button>
          </div>
        ))}
        <select
          value=""
          style={{ width: '100%', marginTop: 6 }}
          onChange={(e) => {
            if (!e.target.value) return;
            setSpecs({ ...specs, trainingStandingOrder: [...specs.trainingStandingOrder, { unitKey: e.target.value, maintainCount: 100 }] });
          }}
        >
          <option value="">Add a unit to maintain…</option>
          {(options?.training ?? []).filter((t) => t.allowed).map((t) => (
            <option key={t.unitKey} value={t.unitKey}>{t.name} — {t.role}</option>
          ))}
        </select>
      </Section>

      {/* ------------------------------------------------------- 3. research */}
      <Section title="Research Mandate" note={sheet('researchMandate')?.defines} failure={sheet('researchMandate')?.failure}>
        <div className="row wrap" style={{ gap: 6 }}>
          {specs.researchMandate.map((key) => (
            <button
              key={key}
              className="small"
              onClick={() => setSpecs({ ...specs, researchMandate: specs.researchMandate.filter((k) => k !== key) })}
            >
              {names.research.get(key) ?? key} &#215;
            </button>
          ))}
        </div>
        <select
          value=""
          style={{ width: '100%', marginTop: 6 }}
          onChange={(e) => {
            if (!e.target.value || specs.researchMandate.includes(e.target.value)) return;
            setSpecs({ ...specs, researchMandate: [...specs.researchMandate, e.target.value] });
          }}
        >
          <option value="">Mandate a discipline…</option>
          {(options?.research ?? []).map((r) => (
            <option key={r.key} value={r.key}>{r.name} (level {r.level})</option>
          ))}
        </select>
        <p className="capnote" style={{ marginTop: 8 }}>
          Two governors mandated onto the same discipline is a conflict, and the appointment will be refused
          rather than silently picking one.
        </p>
      </Section>

      {/* ------------------------------------------------------ 4. resources */}
      <Section title="Resource Policy" note={sheet('resourcePolicy')?.defines} failure={sheet('resourcePolicy')?.failure}>
        <label className="row" style={{ gap: 8 }}>
          <span style={{ fontSize: 13 }}>Keep this many days of stock before hauling</span>
          <span className="spacer" />
          <input
            type="number"
            min={0}
            value={specs.resourcePolicy.keepDays}
            style={{ width: 72 }}
            onChange={(e) => setSpecs({ ...specs, resourcePolicy: { ...specs.resourcePolicy, keepDays: Math.max(0, Number(e.target.value) || 0) } })}
          />
        </label>
        <label className="row" style={{ gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 13 }}>Haul the surplus to</span>
          <span className="spacer" />
          <select
            value={specs.resourcePolicy.haulSurplusTo ?? ''}
            onChange={(e) => setSpecs({
              ...specs,
              resourcePolicy: { ...specs.resourcePolicy, haulSurplusTo: e.target.value || undefined },
            })}
          >
            <option value="">nowhere</option>
            {data.settlements.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <p className="capnote" style={{ marginTop: 8 }}>
          A haul is a convoy on the map like any other. It can be intercepted, and it is never a private pipe
          between your own holdings.
        </p>
      </Section>

      {/* -------------------------------------------------------- 5. defence */}
      <Section title="Defence Posture" note={sheet('defencePosture')?.defines} failure={sheet('defencePosture')?.failure}>
        <div className="row wrap" style={{ gap: 6 }}>
          {POSTURES.map((p) => (
            <button
              key={p.key}
              className={`small ${specs.defencePosture === p.key ? 'primary' : 'ghost'}`}
              title={p.what}
              onClick={() => setSpecs({ ...specs, defencePosture: p.key })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 6, marginBottom: 0 }}>
          {POSTURES.find((p) => p.key === specs.defencePosture)?.what}
        </p>
      </Section>

      {/* ----------------------------------------------------- 6. escalation */}
      <Section title="Escalation Rules" note={sheet('escalationRules')?.defines} failure={sheet('escalationRules')?.failure}>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={specs.escalationRules.alertOnIncoming}
            onChange={(e) => setSpecs({ ...specs, escalationRules: { ...specs.escalationRules, alertOnIncoming: e.target.checked } })}
          />
          <span style={{ fontSize: 13 }}>Stop and alert me when a force is inbound</span>
        </label>
        <label className="row" style={{ gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 13 }}>Alert below loyalty</span>
          <span className="spacer" />
          <input
            type="number"
            min={0}
            max={100}
            value={specs.escalationRules.alertBelowLoyalty}
            style={{ width: 72 }}
            onChange={(e) => setSpecs({
              ...specs,
              escalationRules: { ...specs.escalationRules, alertBelowLoyalty: Math.min(100, Math.max(0, Number(e.target.value) || 0)) },
            })}
          />
        </label>
        <p className="capnote" style={{ marginTop: 8 }}>
          An escalation stops the governor and puts the reason on your Attention dashboard. Set it too high
          and it stops for everything; set it to zero and you find out from the battle report.
        </p>
      </Section>

      {error && <p className="capnote" style={{ borderColor: 'var(--danger)' }}>{error}</p>}

      <button
        className="primary"
        style={{ width: '100%', marginTop: 10 }}
        disabled={busy || tierLocked || (!governor && chosen.length === 0)}
        onClick={save}
      >
        {governor
          ? 'Save — takes effect on the next job it starts'
          : chosen.length === 0 ? 'Choose at least one holding' : `Appoint over ${chosen.length} holding${chosen.length === 1 ? '' : 's'}`}
      </button>
      {governor && (
        <p className="faint" style={{ fontSize: 11.5, marginTop: 6, marginBottom: 0 }}>
          A job already running keeps the finishing time it was given. Nothing recomputes it downward except
          a Seize or a Chrono Shard spend, so editing a sheet never re-costs work already under way.
        </p>
      )}
    </div>
  );
}

function Section({ title, note, failure, children }: {
  title: string; note?: string; failure?: string; children: React.ReactNode;
}): JSX.Element {
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
      <div className="kindlabel">{title}</div>
      {note && <p className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>{note}</p>}
      {children}
      {failure && (
        <p className="capnote" style={{ marginTop: 8 }}>
          <b>Written badly:</b> {failure}
        </p>
      )}
    </div>
  );
}
