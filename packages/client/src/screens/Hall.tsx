/**
 * screens/Hall.tsx — the text layer around the game
 *
 * The game itself is the map and the settlement: graphical, interactive, and
 * where the decisions are made. This is everything that SURROUNDS it, and the
 * reason a persistent world still has players in it a year later — a ranking
 * worth climbing, an inbox where a war gets negotiated before it is declared,
 * a board where the server argues about it, and a plain answer to the
 * questions this game is going to raise.
 *
 * It is deliberately text. A leaderboard is a table, a message is prose, and
 * dressing either of them up would make them slower to read without making
 * them say more.
 *
 * Four sections rather than four tabs: the tab bar is already at its limit on
 * a phone, and these belong together — they are all "the world, other than
 * what I am building right now".
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store.js';
import {
  api, ApiError,
  type BoardRowDto, type InboxDto, type LeaderboardsDto, type MessageDto,
  type PostDto, type ThreadDto,
} from '../state/api.js';
import { Empty, Num, Pill } from '../ui/bits.js';

type Section = 'rankings' | 'messages' | 'forum' | 'help';

export function Hall(): JSX.Element {
  const [section, setSection] = useState<Section>('rankings');
  const [unread, setUnread] = useState(0);

  // The unread count is wanted on the section button whichever section is
  // open, so it is fetched here rather than inside Messages.
  useEffect(() => {
    let live = true;
    const load = (): void => { void api.messages('in').then((d) => { if (live) setUnread(d.counts.unread); }).catch(() => undefined); };
    load();
    const t = setInterval(load, 15_000);
    return () => { live = false; clearInterval(t); };
  }, [section]);

  return (
    <div className="page">
      <h1>The Hall</h1>
      <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
        {(['rankings', 'messages', 'forum', 'help'] as const).map((s) => (
          <button
            key={s}
            className={`small ${section === s ? 'primary' : 'ghost'}`}
            onClick={() => setSection(s)}
          >
            {s}
            {s === 'messages' && unread > 0 && <> <span className="badge inline">{unread}</span></>}
          </button>
        ))}
      </div>

      {section === 'rankings' && <Rankings />}
      {section === 'messages' && <Messages />}
      {section === 'forum' && <Forum />}
      {section === 'help' && <Help />}
    </div>
  );
}

// ============================================================================
// Rankings
// ============================================================================

/**
 * Six boards, each derived from live state on every read.
 *
 * Every board carries a sentence saying what its number MEANS. A ranking
 * nobody understands is a ranking players invent explanations for, and in this
 * game the explanations matter: empire weight looks like a penalty until you
 * read that it raises XP requirements rather than reducing output.
 */
function Rankings(): JSX.Element {
  const [board, setBoard] = useState<string | undefined>(undefined);
  const [data, setData] = useState<LeaderboardsDto | null>(null);

  useEffect(() => {
    let live = true;
    void api.leaderboards(board).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [board]);

  if (!data) return <p className="faint">Reading the rolls…</p>;
  const meta = data.boards.find((b) => b.key === data.active)!;

  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {data.boards.map((b) => (
          <button
            key={b.key}
            className={`small ${b.key === data.active ? 'primary' : 'ghost'}`}
            onClick={() => setBoard(b.key)}
          >
            {b.title}
          </button>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{meta.title}</h3>
        <p className="faint" style={{ fontSize: 12.5, marginBottom: 6 }}>{meta.what}</p>
        <p className="capnote" style={{ marginBottom: 0 }}>{meta.note}</p>
      </div>

      {data.rows.length === 0 ? (
        <Empty>Nobody has anything to show on this board yet.</Empty>
      ) : (
        <div className="card flush scroll-x">
          <table>
            <thead>
              <tr><th className="num">#</th><th>Player</th><th className="num">{meta.title}</th><th /></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => <BoardRow key={r.playerId} row={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BoardRow({ row }: { row: BoardRowDto }): JSX.Element {
  return (
    <tr style={row.isYou ? { background: 'rgba(217,164,65,0.09)' } : undefined}>
      <td className="num">{row.rank}</td>
      <td>
        {row.allianceTag && <span className="faint">[{row.allianceTag}] </span>}
        {row.name}
        {row.isYou && <> <Pill tone="ok">you</Pill></>}
        {/* Heaven's Envy is public and cannot be cleansed — so it shows here. */}
        {row.envyScopes.length > 0 && <> <Pill tone="envy">marked</Pill></>}
      </td>
      <td className="num"><Num value={row.value} /></td>
      <td className="faint" style={{ fontSize: 11.5 }}>{row.detail}</td>
    </tr>
  );
}

// ============================================================================
// Messages
// ============================================================================

function Messages(): JSX.Element {
  const { run, busy } = useStore();
  const [box, setBox] = useState<'in' | 'out' | 'archive'>('in');
  const [data, setData] = useState<InboxDto | null>(null);
  const [open, setOpen] = useState<MessageDto | null>(null);
  const [composing, setComposing] = useState(false);

  const load = (): void => { void api.messages(box).then(setData); };
  useEffect(load, [box, busy]);

  if (!data) return <p className="faint">Opening the post…</p>;

  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {(['in', 'out', 'archive'] as const).map((b) => (
          <button key={b} className={`small ${box === b ? 'primary' : 'ghost'}`} onClick={() => { setBox(b); setOpen(null); }}>
            {b === 'in' ? 'inbox' : b === 'out' ? 'sent' : 'archive'}
            {b === 'in' && data.counts.unread > 0 && ` (${data.counts.unread})`}
          </button>
        ))}
        <span className="spacer" />
        <button className="small" onClick={() => { setComposing(true); setOpen(null); }}>Write</button>
      </div>

      {composing && (
        <Compose
          correspondents={data.correspondents}
          onClose={() => setComposing(false)}
          onSent={() => { setComposing(false); load(); }}
        />
      )}

      {open && (
        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>{open.subject}</h3>
            <span className="spacer" />
            <button className="ghost small" onClick={() => setOpen(null)}>Close</button>
          </div>
          <p className="faint" style={{ fontSize: 11.5 }}>
            {box === 'out' ? `to ${open.toName}` : `from ${open.fromName}`}
          </p>
          {/* Player-written text: rendered as plain text, never as markup. */}
          <p style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{open.body}</p>
          {box === 'in' && (
            <div className="row wrap" style={{ gap: 6 }}>
              <button
                className="small"
                disabled={busy}
                onClick={() => void run('Replying', async () => {
                  setOpen(null);
                  setComposing(true);
                })}
              >
                Reply
              </button>
              <button
                className="small ghost"
                disabled={busy}
                onClick={() => void run('Archived', () => api.archiveMessage(open.id)).then(() => { setOpen(null); load(); })}
              >
                Archive
              </button>
            </div>
          )}
        </div>
      )}

      {data.messages.length === 0 ? (
        <Empty>
          {box === 'in' ? 'Nothing waiting. Quiet is not always good news.' : box === 'out' ? 'You have written to nobody.' : 'Nothing filed away.'}
        </Empty>
      ) : (
        <div className="card flush">
          {data.messages.map((m) => (
            <div
              key={m.id}
              className={`att ${m.readAt === undefined && box === 'in' ? 'u-high' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => { setOpen(m); if (box === 'in' && !m.readAt) void api.readMessage(m.id).then(load); }}
              onKeyDown={(e) => { if (e.key === 'Enter') setOpen(m); }}
            >
              <div className="glyph" aria-hidden="true">{m.readAt === undefined && box === 'in' ? '✉' : '✓'}</div>
              <div>
                <div className="kindlabel">{box === 'out' ? `to ${m.toName}` : m.fromName}</div>
                <div className="title">{m.subject}</div>
                <div className="detail">{m.body.slice(0, 90)}{m.body.length > 90 ? '…' : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Compose({ correspondents, onClose, onSent }: {
  correspondents: InboxDto['correspondents'];
  onClose: () => void;
  onSent: () => void;
}): JSX.Element {
  const { run, busy } = useStore();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>Write</h3>
        <span className="spacer" />
        <button className="ghost small" onClick={onClose}>Cancel</button>
      </div>
      <select value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%', marginBottom: 6 }}>
        <option value="">Choose a recipient…</option>
        {correspondents.map((c) => (
          <option key={c.id} value={c.id}>{c.name} — {c.holdings} holding{c.holdings === 1 ? '' : 's'}</option>
        ))}
      </select>
      <input
        placeholder="Subject"
        value={subject}
        maxLength={120}
        onChange={(e) => setSubject(e.target.value)}
        style={{ width: '100%', marginBottom: 6 }}
      />
      <textarea
        placeholder="Being at war with someone is not a reason to stop talking to them."
        value={body}
        rows={6}
        maxLength={8000}
        onChange={(e) => setBody(e.target.value)}
        style={{ width: '100%', marginBottom: 6 }}
      />
      {error && <p className="capnote" style={{ borderColor: 'var(--danger)' }}>{error}</p>}
      <button
        className="primary"
        style={{ width: '100%' }}
        disabled={busy || !to || subject.trim().length === 0 || body.trim().length === 0}
        onClick={() => {
          setError(null);
          void run('Message sent', async () => {
            try {
              const m = await api.sendMessage({ toId: to, subject, body });
              onSent();
              return m;
            } catch (e) {
              setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
              throw e;
            }
          });
        }}
      >
        Send
      </button>
    </div>
  );
}

// ============================================================================
// Forum
// ============================================================================

function Forum(): JSX.Element {
  const { run, busy, me } = useStore();
  const [scope, setScope] = useState<'world' | 'alliance'>('world');
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ thread: ThreadDto; posts: PostDto[] } | null>(null);
  const [starting, setStarting] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');

  const loadList = (): void => { void api.threads(scope).then((d) => setThreads(d.threads)).catch(() => setThreads([])); };
  useEffect(loadList, [scope, busy]);
  useEffect(() => {
    if (!openId) { setThread(null); return; }
    void api.thread(openId).then(setThread).catch(() => setThread(null));
  }, [openId, busy]);

  if (openId && thread) {
    return (
      <>
        <button className="ghost small" onClick={() => setOpenId(null)}>&larr; back to the board</button>
        <h2 style={{ marginTop: 10 }}>{thread.thread.title}</h2>
        <p className="faint" style={{ fontSize: 11.5, marginTop: -6 }}>
          {thread.thread.postCount} post{thread.thread.postCount === 1 ? '' : 's'} &middot; opened by {thread.thread.authorName}
        </p>
        <div className="card flush">
          {thread.posts.map((p) => (
            <article key={p.id} className="post">
              <div className="row">
                <b style={{ fontSize: 12.5 }}>{p.authorName}</b>
                {p.authorId === me?.player.id && <> <Pill tone="ok">you</Pill></>}
              </div>
              {/* Player-written text, rendered as plain text. */}
              <p style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, margin: '6px 0 0' }}>{p.body}</p>
            </article>
          ))}
        </div>
        {thread.thread.lockedAt ? (
          <p className="capnote">This thread is locked. Its history stays readable.</p>
        ) : (
          <div className="card">
            <textarea
              placeholder="Reply"
              rows={4}
              value={reply}
              maxLength={8000}
              onChange={(e) => setReply(e.target.value)}
              style={{ width: '100%', marginBottom: 6 }}
            />
            <button
              className="primary"
              style={{ width: '100%' }}
              disabled={busy || reply.trim().length === 0}
              onClick={() => void run('Posted', () => api.reply(openId, reply)).then(() => setReply(''))}
            >
              Post
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {(['world', 'alliance'] as const).map((s) => (
          <button key={s} className={`small ${scope === s ? 'primary' : 'ghost'}`} onClick={() => setScope(s)}>
            {s === 'world' ? 'the world' : 'my alliance'}
          </button>
        ))}
        <span className="spacer" />
        <button className="small" onClick={() => setStarting(!starting)}>New thread</button>
      </div>

      {scope === 'alliance' && !me?.player.allianceId && (
        <p className="capnote">
          The alliance board is private to its members, and that is enforced on the server — not by hiding the
          tab. Found or join an alliance in Pacts to see it.
        </p>
      )}

      {starting && (
        <div className="card">
          <input
            placeholder="Title"
            value={title}
            maxLength={140}
            onChange={(e) => setTitle(e.target.value)}
            style={{ width: '100%', marginBottom: 6 }}
          />
          <textarea
            placeholder="Opening post"
            rows={5}
            value={body}
            maxLength={8000}
            onChange={(e) => setBody(e.target.value)}
            style={{ width: '100%', marginBottom: 6 }}
          />
          <button
            className="primary"
            style={{ width: '100%' }}
            disabled={busy || title.trim().length < 3 || body.trim().length === 0}
            onClick={() => void run('Thread opened', () => api.openThread({ scope, title, body }))
              .then(() => { setStarting(false); setTitle(''); setBody(''); loadList(); })}
          >
            Open it
          </button>
        </div>
      )}

      {threads.length === 0 ? (
        <Empty>Nothing on this board yet.</Empty>
      ) : (
        <div className="card flush">
          {threads.map((t) => (
            <div
              key={t.id}
              className="att"
              role="button"
              tabIndex={0}
              onClick={() => setOpenId(t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(t.id); }}
            >
              <div className="glyph" aria-hidden="true">&#9776;</div>
              <div>
                <div className="kindlabel">{t.authorName}</div>
                <div className="title">{t.title}</div>
                <div className="detail">{t.postCount} post{t.postCount === 1 ? '' : 's'}</div>
              </div>
              {t.lockedAt && <Pill>locked</Pill>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ============================================================================
// Help
// ============================================================================

/**
 * The questions this game actually raises.
 *
 * Not a feature list. Every entry here is something a player will otherwise
 * conclude is a bug — a governor that stalls, a breakthrough a rival crashed,
 * an XP award of zero — and each answer says plainly that it is working as
 * designed and why the design is that way.
 */
const FAQ: { q: string; a: string }[] = [
  {
    q: 'My governor stopped building. Is it broken?',
    a:
      'No, and this is the most common thing mistaken for one. Governors have no judgement. A build order ' +
      'that reaches an entry you cannot afford STALLS there — it will not skip to something cheaper. The ' +
      'stall appears on your Attention dashboard with the reason. Reorder the spec, or seize the job back.',
  },
  {
    q: 'Why does everything a governor does take twice as long?',
    a:
      'That is the entire governor system — one number, no output tax and no upkeep. You are paying time for ' +
      'attention. You can Seize any governor job in progress: the elapsed progress is kept and the remainder ' +
      'recalculates at normal speed. Seizing needs a free personal queue slot, and that scarcity is the only ' +
      'thing stopping you governing everything and taking it all back instantly.',
  },
  {
    q: 'Someone crashed my breakthrough. Is that allowed?',
    a:
      'Yes, if the trial was a crashable one. Several tribulations are visible to every player nearby and can ' +
      'be interfered with. The Dao screen tells you whether the next one is crashable BEFORE you commit, and ' +
      'it shows every term that produced your odds. No crowd can make a trial impossible — interference has a ' +
      'floor.',
  },
  {
    q: 'The Qi was taken and I still failed. Is that a bug?',
    a:
      'No. The Qi is spent when you DECLARE the breakthrough, not when you succeed. That exposure is the ' +
      'point: a breakthrough is an event other players can see and act on, not a purchase.',
  },
  {
    q: 'My army killed hundreds and earned no XP.',
    a:
      'Check what it killed. A victim far beneath the killer is beneath notice and earns exactly zero, not a ' +
      'reduced amount — it is a hard zero, so farming defenceless targets cannot be made to work by doing it ' +
      'more. The battle report shows the full attribution table, including the zeroes and the reason for each.',
  },
  {
    q: 'What is empire weight actually doing to me?',
    a:
      'It raises the XP your formations need, up to roughly 9.9 million times at the very top. It does not ' +
      'reduce your output and there is no cap on holdings. It is a 30-day rolling average, so shedding ' +
      'territory before a war costs you a month rather than an afternoon. Going wide is allowed — it just ' +
      'means your veterans stop being cheap.',
  },
  {
    q: 'Can I buy my way to the top with Chrono Shards?',
    a:
      'Only partly, and never quietly. Shards compress construction time toward a ceiling you have already ' +
      'earned, never past it. They are barred from breakthroughs outright. Spending them leaves Temporal ' +
      'Debt, which suppresses Qi income and makes every trial harder. Your 30-day purchase total is public on ' +
      'your profile and on the Chrono Shards board, and the top of that list is marked by Heaven’s Envy ' +
      'daily — a marked player can be attacked with no reputation penalty until it lapses.',
  },
  {
    q: 'I signed a non-aggression pact and cannot attack. Is the button broken?',
    a:
      'The pact is working. A signed NAP hard-blocks the attack on the SERVER, not just in this interface. ' +
      'You can break it at any time — betrayal is always allowed and always priced — but leaving a NAP takes ' +
      '48 hours of public notice, during which it still binds you, and it costs reputation.',
  },
  {
    q: 'Someone offered me a pact. Am I protected now?',
    a:
      'Not until you sign it. An unsigned proposal binds nobody in either direction. If it did, anyone could ' +
      'freeze your armies simply by sending you offers.',
  },
  {
    q: 'Why can I not fit every building in one settlement?',
    a:
      'By design. Plots are scarce and they do not come back once spent, so every settlement has to ' +
      'specialise. That is what stops the game becoming one perfect city surrounded by nothing, and it is why ' +
      'trade and convoys exist.',
  },
  {
    q: 'My buildings changed shape when I upgraded them.',
    a:
      'They are meant to. Art is authored in twelve tiers rather than per level, so a building keeps its ' +
      'shape inside a tier and visibly rebuilds when it crosses into the next one. The Codex shows all twelve, ' +
      'drawn by the same renderer the game uses.',
  },
  {
    q: 'What does the shimmer on a building mean?',
    a:
      'That building is Overdriven — its construction is being accelerated with Chrono Shards. It is the ' +
      'loudest thing on the screen deliberately, because buying speed is allowed and is never private.',
  },
  {
    q: 'Is any of this actually decided on my device?',
    a:
      'No. The server decides every outcome, cost and completion time; this interface requests and displays. ' +
      'The only exception is the Simulator, which is explicitly a what-if tool and labelled as one — and it ' +
      'runs the same resolver the server does, so its arithmetic agrees.',
  },
];

function Help(): JSX.Element {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FAQ;
    return FAQ.filter((f) => f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q));
  }, [query]);

  return (
    <>
      <p className="lede">
        Most of these are things that look like bugs and are not. Where the answer is &ldquo;working as
        designed&rdquo;, it also says why the design is that way.
      </p>
      <input
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: '100%', marginBottom: 10 }}
      />
      {shown.length === 0 && <Empty>Nothing matches that.</Empty>}
      <div className="card flush">
        {shown.map((f) => (
          <details key={f.q} className="faq">
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}
