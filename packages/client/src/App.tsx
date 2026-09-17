/**
 * App.tsx — the shell
 *
 * A bottom tab bar, because the design constraint that shapes everything is
 * that every meaningful action must be completable in a ten-minute mobile
 * session (spec/06 §1). Attention is the home screen and the first tab, since
 * it is where players will actually live.
 */

import { useEffect } from 'react';
import { useStore, runningLocally } from './state/store.js';
import { api } from './state/api.js';
import { drainLocalEvents } from './state/local.js';
import { Attention } from './screens/Attention.js';
import { Settlement } from './screens/Settlement.js';
import { Command } from './screens/Command.js';
import { Formations } from './screens/Formations.js';
import { Research } from './screens/Research.js';
import { Cultivation } from './screens/Cultivation.js';
import { Governors } from './screens/Governors.js';
import { Diplomacy } from './screens/Diplomacy.js';
import { Wilds } from './screens/Wilds.js';
import { Hall } from './screens/Hall.js';
import { BattleReport } from './screens/BattleReport.js';
import { Simulator } from './screens/Simulator.js';
import { Codex } from './screens/Codex.js';
import { MapView } from './map/MapView.js';
import { Big } from './ui/bits.js';

const TABS = [
  { id: 'attention', glyph: '◉', label: 'Attention' },
  { id: 'map', glyph: '▦', label: 'Map' },
  { id: 'settlement', glyph: '⌂', label: 'Holding' },
  { id: 'command', glyph: '⚔', label: 'Command' },
  { id: 'formations', glyph: '⚑', label: 'Forces' },
  { id: 'research', glyph: '⚙', label: 'Research' },
  { id: 'cultivation', glyph: '☯', label: 'Dao' },
  { id: 'governors', glyph: '⚖', label: 'Stewards' },
  { id: 'diplomacy', glyph: '⚯', label: 'Pacts' },
  { id: 'wilds', glyph: '⚑', label: 'Wilds' },
  { id: 'hall', glyph: '☰', label: 'Hall' },
  { id: 'battle', glyph: '⛏', label: 'Reports' },
  { id: 'simulator', glyph: '≈', label: 'Sim' },
  { id: 'codex', glyph: '☷', label: 'Codex' },
] as const;

export function App(): JSX.Element {
  const store = useStore();
  const { ready, screen, me, attention, toasts, boot, go, refresh, dismiss } = store;

  useEffect(() => { void boot(); }, [boot]);

  /**
   * The push loop.
   *
   * Against the gateway, `attack.incoming` arrives over the WebSocket within a
   * second. In the local sandbox there is no socket, so the shell drains the
   * world's outbox on the same cadence and surfaces the same events — the UI
   * code reacting to them is identical either way.
   */
  useEffect(() => {
    if (!ready) return undefined;

    if (runningLocally) {
      const t = setInterval(() => {
        api.tick?.();
        for (const msg of drainLocalEvents()) {
          if (msg.event === 'attack.incoming') {
            store.toast('error', 'Incoming attack', 'A hostile force is on its way. Check the Command Centre.');
          }
          if (msg.event === 'battle.resolved') {
            const data = msg.data as { summary: string };
            store.toast('warn', 'Battle resolved', data.summary);
          }
          if (msg.event === 'tribulation.resolved') {
            const d = msg.data as { passed: boolean; narrative: string };
            store.toast(d.passed ? 'ok' : 'error', d.passed ? 'Breakthrough' : 'The trial overcame you', d.narrative);
          }
          if (msg.event === 'tribulation.opened') {
            const d = msg.data as { playerName: string; trial: string; crashable: boolean };
            store.toast('warn', `${d.playerName} is breaking through`,
              d.crashable ? `A ${d.trial} is open nearby. It can be crashed.` : `A ${d.trial} is under way nearby.`);
          }
        }
        void refresh();
      }, 5000);
      return () => clearInterval(t);
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${window.location.host}/v1/ws`);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ action: 'clock', clientSent: Date.now() }));
    });
    socket.addEventListener('message', (e: MessageEvent<string>) => {
      const env = JSON.parse(e.data) as { event: string; data: unknown };
      if (env.event === 'attack.incoming') {
        store.toast('error', 'Incoming attack', 'A hostile force is on its way. Check the Command Centre.');
      }
      if (env.event === 'battle.resolved') {
        store.toast('warn', 'Battle resolved', (env.data as { summary: string }).summary);
      }
      if (env.event === 'tribulation.opened') {
        const d = env.data as { playerName: string; trial: string; crashable: boolean };
        store.toast('warn', `${d.playerName} is breaking through`,
          d.crashable ? `A ${d.trial} is open nearby. It can be crashed.` : `A ${d.trial} is under way nearby.`);
      }
      if (env.event === 'tribulation.crashed') {
        store.toast('error', 'Your tribulation is being crashed',
          `${(env.data as { interferers: number }).interferers} rival(s) are interfering.`);
      }
      if (env.event === 'tribulation.resolved') {
        const d = env.data as { passed: boolean; narrative: string };
        store.toast(d.passed ? 'ok' : 'error', d.passed ? 'Breakthrough' : 'The trial overcame you', d.narrative);
      }
      if (env.event === 'resource.overflow') {
        store.toast('warn', 'A warehouse is full', 'Production above capacity is being lost.');
      }
      void refresh();
    });
    return () => socket.close();
    // `store` is a stable zustand hook result; only `ready` should re-arm this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, refresh]);

  if (!ready) {
    return (
      <div className="loading">
        <div className="brand">Ascendance</div>
        <div className="faint">Waking the world&hellip;</div>
      </div>
    );
  }

  const incoming = attention.filter((i) => i.kind === 'incoming_attack').length;
  const shards = me?.player.shardBalanceHours ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Ascendance</span>
        {me && (
          <>
            <span className="stat">{me.player.name} &middot; Era <b>{me.player.era}</b></span>
            <span className="stat">Weight <b>{me.empireWeight.toFixed(0)}</b></span>
            <span className="stat">Qi <b><Big value={me.player.qi} /></b></span>
            <span className="stat">Shards <b>{shards.toFixed(0)}h</b></span>
            {me.player.temporalDebt > 0 && <span className="stat">Debt <b>{me.player.temporalDebt}</b></span>}
          </>
        )}
        <span className="spacer" />
        {runningLocally && (
          <span className="pill" title="This page hosts an authoritative world in your browser using the same engine the server runs. Single player, and nothing leaves this tab.">
            sandbox
          </span>
        )}
      </header>

      <main className="main">
        {screen === 'attention' && <Attention />}
        {screen === 'map' && <MapView />}
        {screen === 'settlement' && <Settlement />}
        {screen === 'command' && <Command />}
        {screen === 'formations' && <Formations />}
        {screen === 'research' && <Research />}
        {screen === 'cultivation' && <Cultivation />}
        {screen === 'governors' && <Governors />}
        {screen === 'diplomacy' && <Diplomacy />}
        {screen === 'wilds' && <Wilds />}
        {screen === 'hall' && <Hall />}
        {screen === 'battle' && <BattleReport />}
        {screen === 'simulator' && <Simulator />}
        {screen === 'codex' && <Codex />}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role="status" onClick={() => dismiss(t.id)}>
            <div className="t">{t.title}</div>
            {t.detail && <div className="d">{t.detail}</div>}
          </div>
        ))}
      </div>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-current={screen === t.id}
            onClick={() => {
              if (t.id === 'settlement' && !store.settlementId && me?.settlements[0]) {
                void go('settlement', me.settlements[0].id);
              } else {
                void go(t.id);
              }
            }}
          >
            <span className="glyph" aria-hidden="true">{t.glyph}</span>
            <span>{t.label}</span>
            {t.id === 'attention' && incoming > 0 && <span className="badge">{incoming}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
