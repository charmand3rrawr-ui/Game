/**
 * screens/Simulator.tsx — the battle calculator
 *
 * THE ONE PLACE THE CLIENT MAY COMPUTE AN OUTCOME (spec/06 §5), because it is
 * explicitly a what-if tool and labelled as such.
 *
 * And it is not an approximation of the resolver — it IS the resolver. The
 * import below is the same `resolveBattle` the server runs, from the same
 * package, because the simulation core is pure and has no I/O. That guarantee
 * is the entire reason spec/01 §2 chose one language for the project: the
 * calculator a player uses to plan an attack is literally the code that will
 * decide it.
 */

import { useMemo, useState } from 'react';
import { ROSTER, battleSeed, rngFromSeed } from '@ascendance/shared';
import { resolveBattle, type BattleInput, type CombatUnit } from '@ascendance/engine';
import { useStore } from '../state/store.js';
import { Num, Pill } from '../ui/bits.js';

interface Row { unitKey: string; count: number; tier: number; level: number }

const DEFAULT_ATTACK: Row[] = [
  { unitKey: '1|Militia|Orthodox (Balanced)|Mortal', count: 300, tier: 3, level: 200 },
  { unitKey: '1|Hunter-Archer|Asura (Offense)|Mortal', count: 150, tier: 2, level: 400 },
];
const DEFAULT_DEFEND: Row[] = [
  { unitKey: '1|Spearman|Orthodox (Balanced)|Mortal', count: 250, tier: 2, level: 100 },
  { unitKey: '1|Shield Bearer|Guardian (Defense)|Mortal', count: 120, tier: 3, level: 50 },
];

export function Simulator(): JSX.Element {
  const { formations } = useStore();
  const [attack, setAttack] = useState<Row[]>(DEFAULT_ATTACK);
  const [defend, setDefend] = useState<Row[]>(DEFAULT_DEFEND);
  const [wallGrade, setWallGrade] = useState(4);
  const [envyScopes, setEnvyScopes] = useState(0);
  const [seedTag, setSeedTag] = useState('sim-1');

  const result = useMemo(() => {
    const input: BattleInput = {
      battleId: seedTag,
      settlementName: 'Simulated holding',
      layer: 'province',
      mission: 'attack',
      attacker: side('You', attack),
      defender: side('Them', defend),
      fortification: { wallGrade, flatGarrisonHp: wallGrade * 500, concealment: 0.2 },
      plunderable: {},
      carryCapacity: 0n,
      hiddenCellar: 0n,
      defenderLoyalty: 100,
    };
    input.defender.envyScopes = envyScopes;
    // The same seeding the server uses, so a simulated fight and the real one
    // agree given the same inputs.
    return resolveBattle(input, rngFromSeed(battleSeed('simulator', seedTag)));
  }, [attack, defend, wallGrade, envyScopes, seedTag]);

  const main = result.report.phases.find((p) => p.name === 'main');

  return (
    <div className="page">
      <h1>Simulator</h1>
      <div className="notice">
        <b>This is a what-if tool.</b> It changes nothing in the world. It is also not an approximation: it runs the
        same resolver the server does, from the same package, so a result here is what would happen given these
        inputs and this seed.
      </div>

      <div className="grid two">
        <Force title="Attacking force" rows={attack} onChange={setAttack} />
        <Force title="Defending force" rows={defend} onChange={setDefend} />
      </div>

      <div className="card">
        <div className="row wrap" style={{ gap: 16 }}>
          <label>
            <div className="faint" style={{ fontSize: 11 }}>WALL GRADE</div>
            <input type="range" min={0} max={42} value={wallGrade} onChange={(e) => setWallGrade(Number(e.target.value))} />
            <span className="num"> {wallGrade}</span>
          </label>
          <label>
            <div className="faint" style={{ fontSize: 11 }}>DEFENDER&rsquo;S HEAVEN&rsquo;S ENVY SCOPES</div>
            <input type="range" min={0} max={3} value={envyScopes} onChange={(e) => setEnvyScopes(Number(e.target.value))} />
            <span className="num"> {envyScopes} (&minus;{envyScopes * 10}% defence)</span>
          </label>
          <label>
            <div className="faint" style={{ fontSize: 11 }}>SEED</div>
            <input value={seedTag} onChange={(e) => setSeedTag(e.target.value)}
              style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 9px', width: 120 }} />
          </label>
        </div>
      </div>

      <h2>Result</h2>
      <div className="card">
        <div className="row">
          <strong style={{ fontSize: 16 }}>
            {result.report.outcome === 'attacker' ? 'The attack succeeds' : 'The defence holds'}
          </strong>
          <span className="spacer" />
          {main?.attackerPower.jointCapEngaged && <Pill tone="warn">attacker hit the +40% cap</Pill>}
          {main?.defenderPower.jointCapEngaged && <Pill tone="warn">defender hit the +40% cap</Pill>}
        </div>

        {main && (
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>attack pool</dt><dd><Num value={main.attackerPower.total} /></dd>
            <dt>defence pool</dt><dd><Num value={main.defenderPower.total} /></dd>
            <dt>attacker morale</dt><dd>&times;{main.attackerPower.morale.toFixed(3)}</dd>
            <dt>fortification</dt><dd>&times;{(main.defenderPower.fortification ?? 1).toFixed(3)}</dd>
            {main.defenderPower.heavensEnvy !== undefined && main.defenderPower.heavensEnvy < 1 && (
              <>
                <dt>Heaven&rsquo;s Envy</dt>
                <dd>&times;{main.defenderPower.heavensEnvy.toFixed(2)} on defence only</dd>
              </>
            )}
          </dl>
        )}

        <hr />

        <div className="grid two">
          <div>
            <h3>Attacker survivors</h3>
            {result.report.attacker.formations.map((f) => (
              <div key={f.formationId} className="row" style={{ fontSize: 13 }}>
                <span>{f.name}</span><span className="spacer" />
                <span className="num">{f.after} / {f.before}</span>
              </div>
            ))}
          </div>
          <div>
            <h3>Defender survivors</h3>
            {result.report.defender.formations.map((f) => (
              <div key={f.formationId} className="row" style={{ fontSize: 13 }}>
                <span>{f.name}</span><span className="spacer" />
                <span className="num">{f.after} / {f.before}</span>
              </div>
            ))}
          </div>
        </div>

        {result.report.layerLimits.length > 0 && (
          <p className="faint" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            {result.report.layerLimits.join(' ')}
          </p>
        )}
      </div>

      {formations.length > 0 && (
        <button className="ghost" style={{ width: '100%' }}
          onClick={() => setAttack(formations.slice(0, 4).map((f) => ({
            unitKey: f.unitKey, count: f.count, tier: f.atkTier, level: f.atkLevel,
          })))}>
          Load my actual formations
        </button>
      )}
    </div>
  );
}

function side(name: string, rows: Row[]): BattleInput['attacker'] {
  const units: CombatUnit[] = rows
    .filter((r) => r.count > 0)
    .map((r, i) => ({
      formationId: `${name}-${i}`,
      formationName: ROSTER.find((u) => u.unitKey === r.unitKey)?.name ?? r.unitKey,
      unitKey: r.unitKey,
      count: r.count,
      tier: r.tier,
      levelInTier: r.level,
      equipmentMod: 1,
    }));
  return {
    playerName: name, empireWeight: 30, era: 1, units,
    techTier: 1, doctrineMod: 1, commanderMod: 1, envyScopes: 0,
    munitions: 1e6, statecraft: 0, scoutingQuality: 0.2,
  };
}

function Force({ title, rows, onChange }: { title: string; rows: Row[]; onChange: (r: Row[]) => void }): JSX.Element {
  const era1 = useMemo(() => ROSTER.filter((u) => u.era === 1), []);
  return (
    <div className="card">
      <h3>{title}</h3>
      {rows.map((r, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <select value={r.unitKey} style={{ width: '100%', marginBottom: 4 }}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, unitKey: e.target.value } : x)))}>
            {era1.map((u) => <option key={u.unitKey} value={u.unitKey}>{u.name} ({u.role})</option>)}
          </select>
          <div className="row" style={{ gap: 6 }}>
            <Field label="count" value={r.count} max={100_000}
              onChange={(v) => onChange(rows.map((x, j) => (j === i ? { ...x, count: v } : x)))} />
            <Field label="tier" value={r.tier} max={24}
              onChange={(v) => onChange(rows.map((x, j) => (j === i ? { ...x, tier: v } : x)))} />
            <Field label="level" value={r.level} max={1337}
              onChange={(v) => onChange(rows.map((x, j) => (j === i ? { ...x, level: v } : x)))} />
            <button className="small ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>&minus;</button>
          </div>
        </div>
      ))}
      <button className="small ghost" style={{ width: '100%' }}
        onClick={() => onChange([...rows, { unitKey: era1[0]!.unitKey, count: 100, tier: 1, level: 0 }])}>
        Add a formation
      </button>
    </div>
  );
}

function Field({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <label style={{ flex: 1, minWidth: 0 }}>
      <div className="faint" style={{ fontSize: 10 }}>{label.toUpperCase()}</div>
      <input type="number" min={0} max={max} value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value))))}
        style={{ width: '100%', background: 'var(--bg-sunken)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px', textAlign: 'right' }} />
    </label>
  );
}
