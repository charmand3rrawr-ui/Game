/**
 * screens/Diplomacy.tsx — alliances and treaties
 *
 * Treaties carry mechanical consequences, not just text (spec/04 §7). A signed
 * NAP hard-blocks an attack ON THE SERVER — `dispatch` refuses it — not merely
 * in this UI, so a client that skipped the check would get the same refusal.
 *
 * Three things this screen is careful about, because each one is a place a
 * player could otherwise be misled:
 *
 *   1. A PROPOSAL BINDS NOBODY. Only signature does. An unsigned NAP blocks no
 *      attack in either direction — otherwise anyone could freeze your armies
 *      by spamming offers at you. Proposed and signed are shown differently.
 *
 *   2. BETRAYAL IS ALWAYS ALLOWED AND ALWAYS PRICED. Reputation never blocks an
 *      action. The break button is never disabled; it states the cost instead.
 *
 *   3. THE NOTICE PERIOD IS REAL. Leaving a NAP takes 48 hours of public
 *      notice, during which the pact still binds you. The screen says when the
 *      exit actually lands rather than implying it is immediate.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store.js';
import { api, type AllianceDto, type TreatyDto } from '../state/api.js';
import { Countdown, Empty, Pill, duration } from '../ui/bits.js';

const KINDS: { key: string; label: string; teeth: string }[] = [
  { key: 'nap', label: 'Non-aggression', teeth: 'Hard-blocks attacks between you on the server. Leaving takes 48h of public notice.' },
  { key: 'defensive', label: 'Defensive pact', teeth: 'A call to arms is expected when either of you is attacked.' },
  { key: 'trade', label: 'Trade', teeth: 'Convoys between you pass without tariff.' },
  { key: 'tribute', label: 'Tribute', teeth: 'A recurring payment, on stated terms.' },
  { key: 'border', label: 'Border', teeth: 'An agreed line. Crossing it is a breach, not a surprise.' },
  { key: 'armistice', label: 'Armistice', teeth: 'Stops a running war on both sides.' },
  { key: 'war', label: 'War', teeth: 'Declared openly. Nothing is blocked; everything is on the record.' },
];

/**
 * KINDS indexed by key.
 *
 * Every treaty row asks for its kind's label and its teeth, and the list is a
 * module constant that never changes — so the lookup is built once here rather
 * than scanned afresh for each of the two or three reads every row makes.
 */
const KIND_BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

export function Diplomacy(): JSX.Element {
  const { run, busy, me } = useStore();
  const [data, setData] = useState<AllianceDto | null>(null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [kind, setKind] = useState('nap');

  useEffect(() => { void api.alliance().then(setData); }, [busy]);

  // Counterparty names, indexed once. Every treaty row resolves a player id to
  // a name, so scanning the neighbour list per row made naming the board cost
  // rows x neighbours on each render.
  //
  // This sits ABOVE the loading return deliberately: a hook after an early
  // return changes the hook count between renders, which React rejects
  // outright — the screen would go blank the moment the data arrived.
  const knownById = useMemo(
    () => new Map((data?.known ?? []).map((k) => [k.id, k])),
    [data?.known],
  );

  if (!data) return <div className="page"><p className="faint">Reading the standing accords…</p></div>;

  const now = data.serverTime;
  const signed = data.treaties.filter((t) => t.signedAt !== '0' && !t.brokenAt);
  const incoming = data.treaties.filter((t) => t.signedAt === '0' && t.partyB === data.me);
  const outgoing = data.treaties.filter((t) => t.signedAt === '0' && t.partyA === data.me);
  const broken = data.treaties.filter((t) => t.brokenAt);
  const nameOf = (id: string): string =>
    id === data.me ? (me?.player.name ?? 'you') : (knownById.get(id)?.name ?? 'an unknown power');

  return (
    <div className="page">
      <h1>Pacts</h1>
      <p className="lede">
        Treaties here have teeth. A signed non-aggression pact does not ask your armies to behave — the server
        refuses the order. Breaking one is always allowed, and always costs.
      </p>

      {/* ------------------------------------------------------- alliance */}
      <h2>Alliance</h2>
      {data.alliance ? (
        <div className="card">
          <div className="row">
            <div>
              <div className="faint" style={{ fontSize: 11 }}>[{data.alliance.tag}]</div>
              <div style={{ fontSize: 19, fontWeight: 600 }}>{data.alliance.name}</div>
            </div>
            <span className="spacer" />
            <div style={{ textAlign: 'right' }}>
              <div className="faint" style={{ fontSize: 11 }}>MEMBERS</div>
              <div className="num" style={{ fontSize: 19, fontWeight: 600 }}>
                {data.members.length}<span className="faint" style={{ fontSize: 12 }}> / {data.maxMembers}</span>
              </div>
            </div>
          </div>
          <dl className="kv" style={{ marginTop: 10 }}>
            {data.members.map((m) => (
              <div key={m.playerId} style={{ display: 'contents' }}>
                <dt>{nameOf(m.playerId)}</dt>
                <dd>{m.role}</dd>
              </div>
            ))}
          </dl>
          <p className="capnote" style={{ marginTop: 8 }}>
            An alliance holds at most {data.maxMembers}. One that could absorb a server would not be an
            alliance, it would be the server.
          </p>
        </div>
      ) : (
        <div className="card">
          <p className="faint" style={{ fontSize: 12, marginTop: 0 }}>
            You stand alone. Founding an alliance makes you its leader.
          </p>
          <div className="row wrap" style={{ gap: 6 }}>
            <input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: 2, minWidth: 140 }}
            />
            <input
              placeholder="TAG"
              value={tag}
              maxLength={6}
              onChange={(e) => setTag(e.target.value.toUpperCase())}
              style={{ flex: 1, minWidth: 72 }}
            />
          </div>
          <button
            className="primary"
            style={{ width: '100%', marginTop: 8 }}
            disabled={busy || name.trim().length < 3 || tag.trim().length < 2}
            onClick={() => void run('Alliance founded', () => api.createAlliance(name.trim(), tag.trim()))}
          >
            Found it
          </button>
        </div>
      )}

      {/* -------------------------------------------------------- treaties */}
      <h2>In force</h2>
      {signed.length === 0 ? (
        <Empty>Nothing binds you, and nothing protects you.</Empty>
      ) : (
        <div className="card flush">
          {signed.map((t) => (
            <TreatyRow key={t.id} t={t} data={data} nameOf={nameOf} now={now} />
          ))}
        </div>
      )}

      {incoming.length > 0 && (
        <>
          <h2>Offered to you</h2>
          <div className="card flush">
            {incoming.map((t) => (
              <div key={t.id} className="att u-high">
                <div className="glyph" aria-hidden="true">&#9998;</div>
                <div>
                  <div className="kindlabel">{KIND_BY_KEY.get(t.kind)?.label ?? t.kind}</div>
                  <div className="title">From {nameOf(t.partyA)}</div>
                  <div className="detail">{KIND_BY_KEY.get(t.kind)?.teeth}</div>
                </div>
                <button
                  className="small primary"
                  disabled={busy}
                  onClick={() => void run('Treaty signed', () => api.acceptTreaty(t.id))}
                >
                  Sign
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {outgoing.length > 0 && (
        <>
          <h2>Awaiting signature</h2>
          <div className="card flush">
            {outgoing.map((t) => (
              <div key={t.id} className="att">
                <div className="glyph" aria-hidden="true">&#8987;</div>
                <div>
                  <div className="kindlabel">{KIND_BY_KEY.get(t.kind)?.label ?? t.kind}</div>
                  <div className="title">To {nameOf(t.partyB)}</div>
                  <div className="detail">
                    Binds nobody until they sign. Until then it blocks no attack, in either direction.
                  </div>
                </div>
                <Pill>unsigned</Pill>
              </div>
            ))}
          </div>
        </>
      )}

      {/* --------------------------------------------------------- propose */}
      <h2>Propose</h2>
      <div className="card">
        {data.known.length === 0 ? (
          <Empty>You have no neighbours to treat with.</Empty>
        ) : (
          <>
            <select value={counterparty} onChange={(e) => setCounterparty(e.target.value)} style={{ width: '100%' }}>
              <option value="">Choose a counterparty…</option>
              {data.known.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} — {k.holdings} holding{k.holdings === 1 ? '' : 's'}, reputation {k.reputation}
                </option>
              ))}
            </select>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: '100%', marginTop: 6 }}>
              {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <p className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              {KIND_BY_KEY.get(kind)?.teeth}
            </p>
            <button
              className="primary"
              style={{ width: '100%' }}
              disabled={busy || !counterparty}
              onClick={() => void run('Proposal sent', () => api.proposeTreaty({ counterpartyId: counterparty, kind, terms: {} }))}
            >
              Send the proposal
            </button>
          </>
        )}
      </div>

      {broken.length > 0 && (
        <>
          <h2>Broken</h2>
          <div className="card flush">
            {broken.map((t) => (
              <div key={t.id} className="att">
                <div className="glyph" aria-hidden="true">&#9888;</div>
                <div>
                  <div className="kindlabel">{KIND_BY_KEY.get(t.kind)?.label ?? t.kind}</div>
                  <div className="title">
                    {nameOf(t.partyA === data.me ? t.partyB : t.partyA)}
                  </div>
                  <div className="detail">
                    {BigInt(t.brokenAt!) > BigInt(now)
                      ? 'Notice given. It still binds until the exit lands.'
                      : 'Ended.'}
                  </div>
                </div>
                {BigInt(t.brokenAt!) > BigInt(now)
                  ? <Countdown to={t.brokenAt!} />
                  : <Pill tone="danger">over</Pill>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TreatyRow({ t, data, nameOf, now }: {
  t: TreatyDto; data: AllianceDto; nameOf: (id: string) => string; now: number;
}): JSX.Element {
  const { run, busy } = useStore();
  const [confirming, setConfirming] = useState(false);
  const isNap = t.kind === 'nap';
  const cost = isNap ? data.napBreakReputation : data.treatyBreakReputation;
  const notice = isNap ? Number(data.napNoticeMs) : 0;

  return (
    <div className="att">
      <div className="glyph" aria-hidden="true">&#9878;</div>
      <div>
        <div className="kindlabel">{KIND_BY_KEY.get(t.kind)?.label ?? t.kind}</div>
        <div className="title">With {nameOf(t.partyA === data.me ? t.partyB : t.partyA)}</div>
        <div className="detail">
          {KIND_BY_KEY.get(t.kind)?.teeth}
          {t.expiresAt && BigInt(t.expiresAt) > BigInt(now) && <> Lapses in <Countdown to={t.expiresAt} />.</>}
        </div>
        {confirming && (
          <p className="capnote" style={{ marginTop: 8 }}>
            Breaking this costs <b>{cost} reputation</b>
            {notice > 0 && <> and takes <b>{duration(notice)}</b> of public notice, during which it still binds you</>}
            . Reputation never blocks an action — betrayal is always allowed, and always priced.
          </p>
        )}
      </div>
      <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
        {confirming ? (
          <>
            <button
              className="small danger"
              disabled={busy}
              onClick={() => { setConfirming(false); void run('Notice given', () => api.breakTreaty(t.id)); }}
            >
              Break it
            </button>
            <button className="small ghost" onClick={() => setConfirming(false)}>Keep it</button>
          </>
        ) : (
          <>
            <Pill tone="ok">signed</Pill>
            <button className="small ghost" onClick={() => setConfirming(true)}>Break…</button>
          </>
        )}
      </div>
    </div>
  );
}
