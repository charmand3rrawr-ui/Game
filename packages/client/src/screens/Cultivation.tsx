/**
 * screens/Cultivation.tsx — the player's own advancement
 *
 * Two things this screen exists to make felt:
 *
 *   1. A breakthrough is an EVENT, not a purchase. The Qi is spent when you
 *      declare, a window opens, and several trials are visible to everyone
 *      nearby. The screen shows the odds and every term that produced them
 *      before you commit, because a breakthrough lost for reasons nobody can
 *      inspect is how players come to believe the game cheats.
 *
 *   2. This is where Chrono Shards are paid for. Shards cannot touch a
 *      breakthrough at all, and the Temporal Debt from having spent them
 *      elsewhere suppresses Qi income AND lowers these odds. The screen says
 *      so, in those terms, whenever a player carries debt.
 */

import { useEffect, useState } from 'react';
import { C } from '@ascendance/shared';
import { useStore } from '../state/store.js';
import { api, type CultivationDto } from '../state/api.js';
import { Bar, Big, Countdown, Empty, Num, Pill } from '../ui/bits.js';

export function Cultivation(): JSX.Element {
  const { run, busy, me } = useStore();
  const [data, setData] = useState<CultivationDto | null>(null);
  const [showLadder, setShowLadder] = useState(false);

  useEffect(() => {
    let live = true;
    const load = (): void => { void api.cultivation().then((d) => { if (live) setData(d); }); };
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, [busy]);

  if (!data) return <div className="page"><p className="faint">Settling the mind…</p></div>;

  const home = me?.settlements[0];
  const debt = me?.player.temporalDebt ?? 0;
  const nextRealm = data.ladder.find((l) => l.grade === data.grade + 1);

  return (
    <div className="page">
      <h1>Cultivation</h1>
      <p className="lede">
        The only progression money cannot touch. Chrono Shards are barred from breakthroughs outright, and the
        Temporal Debt they leave behind slows your Qi and makes every trial harder.
      </p>

      <div className="card">
        <div className="row wrap">
          <div>
            <div className="faint" style={{ fontSize: 11 }}>REALM</div>
            <div style={{ fontSize: 19, fontWeight: 600 }}>{data.realm}</div>
            <div className="faint" style={{ fontSize: 12 }}>grade {data.grade} of {C.MAX_GRADE}</div>
          </div>
          <span className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <div className="faint" style={{ fontSize: 11 }}>QI</div>
            <div style={{ fontSize: 19, fontWeight: 600 }} className="num"><Big value={data.qi} /></div>
            <div className="faint" style={{ fontSize: 12 }}>
              +<Num value={data.income.perHour} digits={1} />/h
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <Bar value={Number(data.qi)} max={Number(data.nextCost)} tone={data.canAfford ? 'ok' : undefined} />
          <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
            <Big value={data.qi} /> / <Big value={data.nextCost} /> to break into {nextRealm?.realm ?? 'the next realm'}
          </div>
        </div>

        <details style={{ marginTop: 12 }}>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>Where the Qi comes from</summary>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>cultivation buildings</dt><dd><Num value={data.income.buildings} digits={1} />/h</dd>
            <dt>spirit veins</dt><dd><Num value={data.income.spiritVeins} digits={1} />/h</dd>
            <dt>meditation</dt><dd><Num value={data.income.meditation} digits={1} />/h</dd>
          </dl>
          {debt > 0 && (
            <p className="capnote" style={{ marginTop: 8 }}>
              Temporal Debt {debt} is suppressing this income. It decays only through abstention — there is nothing
              you can buy to clear it.
            </p>
          )}
        </details>
      </div>

      {data.tribulation ? (
        <ActiveTribulation t={data.tribulation} odds={data.odds} />
      ) : (
        <div className="card">
          <h3>{nextRealm ? `Break into ${nextRealm.realm}` : 'The final realm'}</h3>
          {nextRealm && (
            <>
              <p className="faint" style={{ fontSize: 12 }}>{nextRealm.trial}</p>
              <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
                {nextRealm.visible && <Pill tone="warn">visible to nearby players</Pill>}
                {nextRealm.crashable && <Pill tone="danger">rivals can crash it</Pill>}
                {!nextRealm.visible && <Pill>private</Pill>}
              </div>

              <Odds odds={data.odds} />

              {data.stunnedUntil && BigInt(data.stunnedUntil) > BigInt(Date.now()) ? (
                <p className="capnote">
                  Cultivation is suspended after a failed trial. It resumes in{' '}
                  <Countdown to={data.stunnedUntil} />.
                </p>
              ) : (
                <button
                  className="primary"
                  style={{ width: '100%', marginTop: 12 }}
                  disabled={busy || !data.canAfford || !home}
                  title={
                    nextRealm.crashable
                      ? 'The Qi is spent the moment you declare, and everyone nearby will see it happen.'
                      : 'The Qi is spent the moment you declare.'
                  }
                  onClick={() => void run(`Breaking into ${nextRealm.realm}`, () => api.breakthrough(home!.id))}
                >
                  {data.canAfford ? `Spend ${Number(data.nextCost).toLocaleString()} Qi and begin` : 'Not enough Qi'}
                </button>
              )}
              <p className="faint" style={{ fontSize: 11.5, marginTop: 8, marginBottom: 0 }}>
                The Qi is spent when you declare, not when you succeed. There is no backing out once the trial
                opens — that exposure is the point.
              </p>
            </>
          )}
        </div>
      )}

      {data.visibleNearby.length > 0 && (
        <>
          <h2>Trials nearby</h2>
          <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
            Someone is breaking through where you can see it. A crashable trial can be interfered with — each
            rival who does lowers their odds, though no crowd can make it impossible.
          </p>
          <div className="card flush">
            {data.visibleNearby.map((t) => (
              <div key={t.id} className="att u-high">
                <div className="glyph" aria-hidden="true">&#9889;</div>
                <div>
                  <div className="kindlabel">{t.trialName}</div>
                  <div className="title">Breaking into grade {t.grade + 1}</div>
                  <div className="detail">
                    {t.interferers.length > 0
                      ? `${t.interferers.length} rival${t.interferers.length === 1 ? '' : 's'} already interfering.`
                      : 'Nobody has interfered yet.'}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                  <Countdown to={t.resolvesAt} />
                  {t.crashable ? (
                    <button
                      className="small danger"
                      disabled={busy}
                      onClick={() => void run('Crashed the tribulation', () => api.interfere(t.id))}
                    >
                      Crash it
                    </button>
                  ) : (
                    <Pill>cannot be crashed</Pill>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>
        <button className="ghost small" onClick={() => setShowLadder(!showLadder)}>
          {showLadder ? 'Hide' : 'Show'} the realm ladder
        </button>
      </h2>
      {showLadder && (
        <div className="card flush scroll-x">
          <table>
            <thead><tr><th>Grade</th><th>Realm</th><th className="num">Qi</th><th>Trial</th></tr></thead>
            <tbody>
              {data.ladder.map((l) => (
                <tr key={l.grade} style={l.grade === data.grade ? { background: 'rgba(217,164,65,0.07)' } : undefined}>
                  <td className="num">{l.grade}</td>
                  <td>
                    {l.realm}
                    {l.grade === data.grade && <> <Pill tone="ok">you</Pill></>}
                  </td>
                  <td className="num"><Big value={l.qiCost} /></td>
                  <td className="faint" style={{ fontSize: 12 }}>
                    {l.trial}
                    {l.crashable && <> <Pill tone="danger">crashable</Pill></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.ladder.length === 0 && <Empty>No realm data.</Empty>}
    </div>
  );
}

function ActiveTribulation({ t, odds }: { t: NonNullable<CultivationDto['tribulation']>; odds: CultivationDto['odds'] }): JSX.Element {
  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{t.trialName}</h3>
        <span className="spacer" />
        <Countdown to={t.resolvesAt} />
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
        Breaking into grade {t.grade + 1}. The Qi is already spent.
      </p>
      <div className="row wrap" style={{ gap: 6 }}>
        {t.visible && <Pill tone="warn">everyone nearby can see this</Pill>}
        {t.interferers.length > 0 && (
          <Pill tone="danger">
            {t.interferers.length} rival{t.interferers.length === 1 ? '' : 's'} interfering
          </Pill>
        )}
      </div>
      <Odds odds={odds} interferers={t.interferers.length} />
    </div>
  );
}

/**
 * The odds, itemised.
 *
 * Same principle as a battle report: if a number decides something that
 * matters, the player gets to see how it was assembled.
 */
function Odds({ odds, interferers }: { odds: CultivationDto['odds']; interferers?: number }): JSX.Element {
  const rows: [string, number, string?][] = [
    ['base', odds.base],
    ['karma', odds.karma, 'Reputation, on a karma-weighted trial'],
    ['temporal debt', odds.debt, 'What buying time costs you here'],
  ];
  if (interferers !== undefined && interferers > 0) rows.push(['interference', odds.interference, 'Rivals who came to crash it']);

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row">
        <span className="faint" style={{ fontSize: 11 }}>CHANCE TO PASS</span>
        <span className="spacer" />
        <span className="num" style={{ fontWeight: 600 }}>{(odds.chance * 100).toFixed(1)}%</span>
      </div>
      <Bar value={odds.chance} max={1} tone={odds.chance > 0.7 ? 'ok' : odds.chance > 0.4 ? 'warn' : 'danger'} />
      <dl className="kv" style={{ marginTop: 8 }}>
        {rows.filter(([, v]) => v !== 0).map(([k, v, why]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt title={why}>{k}</dt>
            <dd>{v > 0 ? '+' : ''}{(v * 100).toFixed(1)}%</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
