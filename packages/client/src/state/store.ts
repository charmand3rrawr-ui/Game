/**
 * state/store.ts — client state
 *
 * SERVER STATE IS THE TRUTH (spec/06 §5). This store caches what the server
 * said and nothing else. Where an optimistic hint appears, it is reconciled
 * against the next server response and visibly corrected if it differs.
 *
 * Timers are never stored as durations. Every deadline is kept as the absolute
 * server timestamp the server sent, and rendered through a measured clock
 * offset — players coordinate attacks across time zones constantly, and a
 * client that quietly trusts its own clock will get someone's army killed
 * (spec/06 §5).
 */

import { create } from 'zustand';
import type { AttentionItem, Battle } from '@ascendance/shared';
import {
  api, runningLocally, ApiError,
  type FormationDto, type MapResponse, type MeResponse, type Meta, type MovementDto, type SettlementDetail,
} from './api.js';

export type Screen = 'attention' | 'map' | 'settlement' | 'command' | 'formations' | 'battle' | 'simulator' | 'codex';

export interface Toast {
  id: number;
  tone: 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
}

interface State {
  ready: boolean;
  screen: Screen;
  meta?: Meta;
  me?: MeResponse;
  attention: AttentionItem[];
  settlementId?: string;
  settlement?: SettlementDetail;
  map?: MapResponse;
  formations: FormationDto[];
  movements: MovementDto[];
  battleId?: string;
  battle?: Battle;
  /** serverTime - clientTime, measured at load and re-measured periodically. */
  clockOffsetMs: number;
  toasts: Toast[];
  busy: boolean;

  boot(): Promise<void>;
  go(screen: Screen, arg?: string): Promise<void>;
  refresh(): Promise<void>;
  openSettlement(id: string): Promise<void>;
  openBattle(id: string): Promise<void>;
  run(label: string, fn: () => Promise<unknown>): Promise<boolean>;
  toast(tone: Toast['tone'], title: string, detail?: string): void;
  dismiss(id: number): void;
  /** Server time as this client currently believes it to be. */
  now(): number;
}

let toastSeq = 1;

export const useStore = create<State>((set, get) => ({
  ready: false,
  screen: 'attention',
  attention: [],
  formations: [],
  movements: [],
  clockOffsetMs: 0,
  toasts: [],
  busy: false,

  async boot() {
    const sentAt = Date.now();
    const meta = await api.meta();
    // One round trip gives a usable offset: assume symmetric latency and take
    // the midpoint. Re-measured on every refresh, so it tightens over time.
    const midpoint = sentAt + (Date.now() - sentAt) / 2;
    set({ meta, clockOffsetMs: meta.serverTime - midpoint });
    await get().refresh();
    set({ ready: true });
  },

  async refresh() {
    api.tick?.();
    const [me, attention, map, formations, movements] = await Promise.all([
      api.me(), api.attention(), api.map(), api.formations(), api.movements(),
    ]);
    set({
      me,
      attention: attention.items,
      map,
      formations: formations.formations,
      movements: movements.movements,
      clockOffsetMs: attention.serverTime - Date.now(),
    });
    const id = get().settlementId;
    if (id) set({ settlement: await api.settlement(id) });
  },

  async go(screen, arg) {
    if (screen === 'settlement' && arg) return get().openSettlement(arg);
    if (screen === 'battle' && arg) return get().openBattle(arg);
    set({ screen });
    return undefined;
  },

  async openSettlement(id) {
    set({ screen: 'settlement', settlementId: id });
    set({ settlement: await api.settlement(id) });
  },

  async openBattle(id) {
    set({ screen: 'battle', battleId: id });
    set({ battle: await api.battle(id) });
  },

  /**
   * Run a command, then reconcile.
   *
   * A rejection is SHOWN, with the server's own reason. That is the whole point
   * of RFC 9457 problem details: the player learns they are three plots short,
   * not that something went wrong.
   */
  async run(label, fn) {
    set({ busy: true });
    try {
      await fn();
      await get().refresh();
      get().toast('ok', label);
      return true;
    } catch (e) {
      if (e instanceof ApiError) {
        get().toast('error', e.problem.title, explain(e));
      } else {
        get().toast('error', 'Failed', e instanceof Error ? e.message : String(e));
      }
      // Reconcile even on failure: the optimistic view must be corrected.
      await get().refresh().catch(() => undefined);
      return false;
    } finally {
      set({ busy: false });
    }
  },

  toast(tone, title, detail) {
    const t: Toast = { id: toastSeq++, tone, title, detail };
    set({ toasts: [...get().toasts, t] });
    setTimeout(() => get().dismiss(t.id), tone === 'error' ? 8000 : 4000);
  },

  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  now() {
    return Date.now() + get().clockOffsetMs;
  },
}));

/**
 * Turn a problem into something a player can act on.
 *
 * The server sends structured `meta` precisely so the client can be specific
 * rather than apologetic.
 */
function explain(e: ApiError): string {
  const m = e.problem.meta ?? {};
  switch (e.code) {
    case 'insufficient-plots':
      return `Needs ${m['needed']} plots; ${m['free']} free of ${m['total']}. Something has to go, or the HQ has to rise.`;
    case 'insufficient-resources': {
      const short = (m['short'] ?? {}) as Record<string, string>;
      return `Short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}.`;
    }
    case 'hq-level-cap':
      return `The HQ is level ${m['hqLevel']}; nothing may pass it. Raise the HQ first.`;
    case 'specialization-cap':
      return `A settlement may hold at most ${m['limit']} buildings above grade ${m['grade']}. This is a hard limit, not a penalty.`;
    case 'no-free-personal-slot':
      return `All ${m['available']} personal slots are busy. Seize needs one free — that scarcity is the only brake on governing everything.`;
    case 'no-free-queue-slot':
      return `All ${m['available']} ${m['slotKind']} slots are busy.`;
    case 'nap-blocks-attack':
      return 'A non-aggression pact blocks this. Break it first — 48 hours of public notice, and it will cost you.';
    case 'shard-prohibited-target':
      return `Shards cannot be applied here: ${m['reason']}. The moments the game is about stay on real time.`;
    case 'shard-ceiling-reached':
      return `You are at your earned compression ceiling of ${m['ceiling']}x. More shards cannot buy more speed.`;
    case 'tier-up-requirements':
      return e.problem.detail ?? 'Promotion needs level 1337, the resource cost, and a recorded deed.';
    default:
      return e.problem.detail ?? '';
  }
}

export { runningLocally };
