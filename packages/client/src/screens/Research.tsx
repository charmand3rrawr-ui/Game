/**
 * screens/Research.tsx — the one global progression
 *
 * Research is player-level (spec/04 §3), so it gets its own screen rather than
 * living inside a settlement — but it is still PAID from a settlement's
 * stockpile and occupies that settlement's queue slot, so starting a level
 * always asks which holding is footing the bill. That question is the mechanic:
 * a global benefit with a local cost.
 *
 * The screen leads with grades rather than levels, because grades are what gate
 * content — fork choices, unit-grade gates, edicts — while levels only make you
 * incrementally better.
 */

import { useEffect, useMemo, useState } from 'react';
import { C, gradeForLevel } from '@ascendance/shared';
import { useStore } from '../state/store.js';
import { api, type OptionsDto, type ResearchDto } from '../state/api.js';
import { Bar, Big, Countdown, Empty, Num, Pill, duration } from '../ui/bits.js';

const BRANCH_GLYPH: Record<string, string> = {
  Economy: '⚖',
  Military: '⚔',
  Statecraft: '⚖',
};

export function Research(): JSX.Element {
  const { me, run, busy } = useStore();
  const [data, setData] = useState<ResearchDto | null>(null);
  const [options, setOptions] = useState<Record<string, OptionsDto>>({});
  const [hostId, setHostId] = useState('');

  const holdings = me?.settlements ?? [];

  useEffect(() => {
    if (!hostId && holdings[0]) setHostId(holdings[0].id);
  }, [holdings, hostId]);

  useEffect(() => {
    let live = true;
    void api.research().then((r) => { if (live) setData(r); });
    return () => { live = false; };
  }, [busy]);

  useEffect(() => {
    if (!hostId) return undefined;
    let live = true;
    void api.options(hostId).then((o) => { if (live) setOptions((prev) => ({ ...prev, [hostId]: o })); });
    return () => { live = false; };
  }, [hostId, busy]);

  const hostOptions = hostId ? options[hostId] : undefined;
  const byKey = useMemo(
    () => new Map((hostOptions?.research ?? []).map((r) => [r.key, r])),
    [hostOptions],
  );
  const inProgress = useMemo(
    () => new Map((data?.inProgress ?? []).map((p) => [p.researchKey, p])),
    [data],
  );

  if (!data) return <div className="page"><p className="faint">Reading the archives…</p></div>;

  const era = me?.player.era ?? 1;
  const available = data.disciplines.filter((d) => d.era <= era);
  const locked = data.disciplines.filter((d) => d.era > era);

  return (
    <div className="page">
      <h1>Research</h1>
      <p className="lede">
        The single thing in this game that is not isolated to one holding. A level raised anywhere applies
        everywhere — but it is paid for out of one settlement&rsquo;s stockpile, and it occupies that
        settlement&rsquo;s build slot while it runs.
      </p>

      <div className="card">
        <div className="row wrap" style={{ gap: 20 }}>
          <Effect label="OUTPUT" value={data.effects.output} />
          <Effect label="UNIT EFFECTIVENESS" value={data.effects.unitEffectiveness} />
          <Effect label="GOVERNANCE" value={data.effects.governance} />
        </div>
        <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Unit effectiveness folds into the same +{(C.JOINT_BONUS_CAP * 100).toFixed(0)}% joint cap as equipment,
          commanders, cultivation and veterancy. Research does not get to sit outside it for having taken a long
          time.
        </p>
      </div>

      <div className="card">
        <label>
          <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>PAID BY, AND QUEUED IN</div>
          <select value={hostId} onChange={(e) => setHostId(e.target.value)} style={{ width: '100%' }}>
            {holdings.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </label>
        <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Needs a Knowledge building there, and a free build slot. The level it produces is yours everywhere.
        </p>
      </div>

      <h2>Era {era}</h2>
      <div className="grid two">
        {available.map((d) => (
          <Discipline
            key={d.key}
            d={d}
            option={byKey.get(d.key)}
            running={inProgress.get(d.key)}
            onStart={() => void run(`Researching ${d.name}`, () => api.startResearch(hostId, d.key, 'personal'))}
            busy={busy || !hostId}
          />
        ))}
      </div>

      {locked.length > 0 && (
        <>
          <h2>Ahead of you</h2>
          <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
            An era&rsquo;s disciplines need every discipline of the era before it at grade{' '}
            {C.RESEARCH_ERA_PREREQ_GRADE}. There is no skipping a generation.
          </p>
          <div className="card flush scroll-x">
            <table>
              <thead><tr><th>Discipline</th><th>Era</th><th>Branch</th><th>Effect</th></tr></thead>
              <tbody>
                {locked.map((d) => (
                  <tr key={d.key}>
                    <td className="dim">{d.name}</td>
                    <td className="num">{d.era}</td>
                    <td className="dim">{d.branch}</td>
                    <td className="faint" style={{ fontSize: 12 }}>{d.perLevel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {available.length === 0 && <Empty>No disciplines available yet.</Empty>}
    </div>
  );
}

function Effect({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div>
      <div className="faint" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }} className="num">
        &times;{value.toFixed(3)}
      </div>
    </div>
  );
}

function Discipline({ d, option, running, onStart, busy }: {
  d: ResearchDto['disciplines'][number];
  option?: OptionsDto['research'][number];
  running?: { finishesAt: string };
  onStart: () => void;
  busy: boolean;
}): JSX.Element {
  const grade = gradeForLevel(d.level);
  const intoGrade = d.level % C.LEVELS_PER_GRADE;
  const nextGradeAt = grade * C.LEVELS_PER_GRADE;

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>
          <span aria-hidden="true" style={{ opacity: 0.6, marginRight: 6 }}>{BRANCH_GLYPH[d.branch] ?? '⚙'}</span>
          {d.name}
        </h3>
        <span className="spacer" />
        <span className="num" title={`Level ${d.level} of ${C.MAX_LEVEL}`}>
          {d.level} <span className="faint">G{grade}</span>
        </span>
      </div>

      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        <Pill>{d.branch}</Pill>
        <Pill title="Grades gate content; levels only make you better">
          grade {grade} of {C.MAX_GRADE}
        </Pill>
      </div>

      <div style={{ marginTop: 10 }}>
        <Bar value={intoGrade} max={C.LEVELS_PER_GRADE} />
        <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
          {intoGrade} / {C.LEVELS_PER_GRADE} into grade {grade} &middot; next breakthrough at level {nextGradeAt}
        </div>
      </div>

      <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>
        {d.perLevel} &mdash; currently <Num value={d.level * d.perLevelPct * 100} digits={1} />% total.
      </p>

      {running && (
        <div className="row" style={{ marginTop: 10 }}>
          <Pill tone="ok">in progress</Pill>
          <span className="spacer" />
          <Countdown to={running.finishesAt} />
        </div>
      )}

      {!running && option && (
        <>
          {option.allowed ? (
            <>
              <dl className="kv" style={{ marginTop: 10 }}>
                {Object.entries(option.cost).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd><Big value={v} /></dd>
                  </div>
                ))}
                <dt>time</dt>
                <dd>{duration(Number(option.timeMs))}</dd>
              </dl>
              <button className="primary" style={{ width: '100%', marginTop: 10 }} disabled={busy} onClick={onStart}>
                Raise to level {d.level + 1}
              </button>
            </>
          ) : (
            // The prerequisite, in the server's own words. "Bring the others
            // along" is a rule worth teaching, not hiding behind a grey button.
            <p className="faint" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>{option.reason}</p>
          )}
        </>
      )}
    </div>
  );
}
