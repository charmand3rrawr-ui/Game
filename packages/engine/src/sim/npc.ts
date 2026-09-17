/**
 * sim/npc.ts — what a barbarian band decides to do, and why
 *
 * THE SHAPE OF THIS MODULE
 *   `decide()` is a pure function from a snapshot of what one band can see to a
 *   single intent. It never reads the clock, never touches the store, never
 *   calls Math.random, and never mutates anything. The World assembles the
 *   snapshot, calls this, and carries out the intent — the same load / decide /
 *   persist shape as every other system here (spec/03 §1).
 *
 *   That purity is not tidiness. It is what makes an AI compatible with
 *   invariant §2.2: a world replays identically, which means the barbarians
 *   must reach the same decisions in the same order from the same state. An AI
 *   with memory between calls, or one that consulted a wall clock, could not.
 *
 * WHY EVERY INTENT CARRIES A REASON
 *   The reason string is written into the event log and shown to players on the
 *   band's dossier. An AI that is merely hostile is indistinguishable from a
 *   broken one; an AI that says "your mill is the richest thing within four
 *   days' march and it is guarded by ninety spearmen" is an opponent. It is
 *   also how a balance problem gets diagnosed — a thousand log lines saying
 *   "nothing within reach is worth the march" is a bug report.
 *
 * THE LADDER
 *   Menace 0..7, from `shared/npc.ts`. Each rung adds a behaviour and keeps
 *   everything below it, so a horde that conquers cities still raids farms.
 *   `decide` checks them from the top down and returns the first that applies,
 *   which is what makes a band prefer the most escalated thing it is capable
 *   of without ever forgetting how to do the simple things.
 *
 * SPEC: the specification models NPCs as scenery (spec/02 §3, spec/03 §7), so
 * everything here is new design. Every number it uses is an `assumed` constant
 * and says so in `assumptions.md`.
 */

import {
  C,
  distance,
  menaceFor,
  pressureForMenace,
  unitDef,
  unitPowerValue,
  type Millis,
  type NpcBand,
  type NpcDoctrine,
  type Uuid,
} from '@ascendance/shared';

// ---------------------------------------------------------------- snapshots

/** One settlement a band is weighing up. */
export interface TargetSnapshot {
  settlementId: Uuid;
  name: string;
  /** Undefined for a ruin or an unclaimed camp — free ground, no battle. */
  ownerId?: Uuid;
  ownerIsNpc: boolean;
  /** True when this is one of the deciding band's own holdings. */
  isSelf: boolean;
  coordX: number;
  coordY: number;
  /** Summed unit power value of everything garrisoning it. */
  garrison: number;
  /** Total lootable stockpile, as a number — precision beyond this is noise. */
  loot: number;
  wallGrade: number;
}

/** A band the deciding band could ally with. */
export interface NeighbourSnapshot {
  bandId: Uuid;
  playerId: Uuid;
  name: string;
  menace: number;
  seatX: number;
  seatY: number;
  confederacyId?: Uuid;
}

/** One formation the band could commit. */
export interface MusterSlice {
  formationId: Uuid;
  unitKey: string;
  count: number;
}

export interface BandSnapshot {
  band: NpcBand;
  /** Where the band musters from. */
  seatX: number;
  seatY: number;
  /** How many settlements the band currently holds. */
  holdings: number;
  /** Everything at the seat and available to march. */
  muster: MusterSlice[];
  targets: TargetSnapshot[];
  neighbours: NeighbourSnapshot[];
  /** Current world pressure, from `shared/npc.ts`. */
  pressure: number;
  now: Millis;
}

// ------------------------------------------------------------------ intents

export type BandIntent =
  /** Nothing to do at this pressure. Wake when the world has got this bad. */
  | { kind: 'sleep'; untilPressure: number; reason: string }
  /** Awake and capable, but nothing is worth doing this turn. */
  | { kind: 'wait'; reason: string }
  /** March to loot. Survivors come home; the ground stays where it is. */
  | { kind: 'raid'; targetId: Uuid; commit: MusterSlice[]; reason: string }
  /** March to keep. */
  | { kind: 'conquer'; targetId: Uuid; commit: MusterSlice[]; reason: string }
  /** Join or found a confederation with a neighbouring band. */
  | { kind: 'confederate'; withBandId: Uuid; reason: string }
  /**
   * A joint strike landing in one instant, from wherever the members are.
   *
   * Carries its own mission because the warpath opens a rung BEFORE conquest
   * does: at menace 5 confederates rob a player together, and only at 6 do
   * they come to keep the place. Reusing `canTake` for both would have meant
   * the warpath quietly did nothing for a whole rung of the ladder.
   */
  | {
      kind: 'warpath';
      targetId: Uuid;
      withBandIds: Uuid[];
      commit: MusterSlice[];
      mission: 'raid' | 'conquer';
      reason: string;
    }
  /** Start building the engine. Public from this moment. */
  | { kind: 'doomsday'; targetId: Uuid; reason: string };

// ------------------------------------------------------------------ scoring

/**
 * What one formation is worth in a fight, in the same units the combat
 * resolver uses. Upkeep already encodes era, archetype and grade, which is why
 * it is the base of unit power everywhere in this engine.
 */
export function sliceStrength(slice: MusterSlice): number {
  const def = unitDef(slice.unitKey);
  return unitPowerValue(def.upkeep, 0) * slice.count;
}

export function musterStrength(muster: readonly MusterSlice[]): number {
  return muster.reduce((n, s) => n + sliceStrength(s), 0);
}

/**
 * How a band weighs one target.
 *
 * Value over risk, biased by doctrine and by memory:
 *
 *   value   loot on the floor, plus the worth of the ground if it means to keep it
 *   risk    garrison power and walls, plus the cost of marching there
 *   grudge  who has hurt this band before
 *
 * The distance term is division, not subtraction, so a rich target across the
 * map never beats a decent one next door. Barbarians are opportunists; a band
 * that crossed a continent for marginally better loot would read as a scripted
 * antagonist rather than a neighbour with bad intentions.
 */
export function scoreTarget(
  snap: BandSnapshot,
  target: TargetSnapshot,
  intent: 'raid' | 'conquer',
  riskShare = 1,
): number {
  const dist = Math.max(1, distance(snap.seatX, snap.seatY, target.coordX, target.coordY));
  const doctrine = snap.band.doctrine;

  // What is in it. A raider counts loot; a warlord counts ground.
  const groundWorth = intent === 'conquer' ? GROUND_WORTH[doctrine] : 0;
  const value = target.loot * LOOT_APPETITE[doctrine] + groundWorth;

  // What it costs. Walls matter more to a band that means to take the place:
  // a raid can be called off at the gate, an assault cannot.
  //
  // `riskShare` is how many bands are carrying that cost between them. It is
  // what lets a confederacy weigh a fortress against the undefended farm next
  // door and correctly pick the fortress: four bands each face a quarter of the
  // garrison, so a target that is madness alone becomes the best thing on the
  // map the moment there is somebody to bring.
  const wallWeight = intent === 'conquer' ? WALL_WEIGHT_ASSAULT : WALL_WEIGHT_RAID;
  const risk = 1 + (target.garrison + target.wallGrade * wallWeight) / Math.max(1, riskShare);

  // Memory. A zealot's grudges weigh double — it is the whole of its character.
  const grudge = snap.band.grudges[target.ownerId ?? ''] ?? 0;
  const grudgeMult = 1 + grudge * C.NPC_GRUDGE_WEIGHT * (doctrine === 'zealot' ? 2 : 1);

  return ((value / risk) * grudgeMult) / Math.sqrt(dist);
}

/** Loot is worth more to some bands than others. */
const LOOT_APPETITE: Readonly<Record<NpcDoctrine, number>> = Object.freeze({
  raider: 1.4,
  slaver: 1.1,
  zealot: 0.7,
  warlord: 0.8,
});

/** And ground is worth more to others. Expressed in the same units as loot. */
const GROUND_WORTH: Readonly<Record<NpcDoctrine, number>> = Object.freeze({
  raider: 4_000,
  slaver: 8_000,
  zealot: 10_000,
  warlord: 30_000,
});

const WALL_WEIGHT_RAID = 40;
const WALL_WEIGHT_ASSAULT = 160;

/**
 * Will this band actually win?
 *
 * Bands are opportunists, not martyrs. A band that marched into a garrison
 * three times its size every turn would be a free XP fountain, which is worse
 * for the game than a band that never attacks at all: it would teach players
 * that barbarians are a resource rather than a threat.
 */
function winnable(committed: number, target: TargetSnapshot, intent: 'raid' | 'conquer'): boolean {
  const need = intent === 'conquer' ? ASSAULT_MARGIN : RAID_MARGIN;
  const defence = target.garrison + target.wallGrade * C.GARRISON_HP_PER_WALL_GRADE * 0.01;
  return committed >= defence * need;
}

/** A raid only has to survive contact. */
const RAID_MARGIN = 1.1;
/** Taking a place needs a real margin, because the survivors have to hold it. */
const ASSAULT_MARGIN = 1.8;

// ------------------------------------------------------------------- muster

/**
 * How much the band sends.
 *
 * Never everything: a band that emptied its seat would be free ground for the
 * first player who noticed, and losing the seat kills the band. The remainder
 * is its garrison, and keeping one is the same discipline a good player shows.
 *
 * Slices are taken whole where possible and in stable order, so the same
 * snapshot always produces the same column of march (invariant §2.2).
 */
export function commitForce(muster: readonly MusterSlice[], fraction: number): MusterSlice[] {
  const total = musterStrength(muster);
  if (total <= 0) return [];
  const budget = total * fraction;

  const out: MusterSlice[] = [];
  let spent = 0;
  for (const slice of muster) {
    if (spent >= budget) break;
    const per = sliceStrength({ ...slice, count: 1 });
    if (per <= 0) continue;
    const affordable = Math.floor((budget - spent) / per);
    const take = Math.min(slice.count, Math.max(1, affordable));
    if (take <= 0) continue;
    out.push({ ...slice, count: take });
    spent += per * take;
  }
  return out;
}

// ------------------------------------------------------------------ deciding

/**
 * Is this band losing badly enough to reach for the engine?
 *
 * "Last resort" is a STATE, not a timer. A band that is winning never builds
 * one however old the world is, and a band that has been driven back to its
 * seat builds one the moment it can. That is the difference between a weapon
 * that arrives because you beat the barbarians and a weapon that arrives
 * because the calendar said so — only the first one is a consequence.
 */
export function isLosing(snap: BandSnapshot): boolean {
  if (snap.band.peakHoldings <= 0) return false;
  const lost = 1 - snap.holdings / snap.band.peakHoldings;
  return lost >= C.NPC_DOOMSDAY_LOSS_RATIO;
}

/**
 * One band, one turn, one decision.
 *
 * Checked from the top of the ladder down, so a band always does the most
 * escalated thing it is capable of this turn. Returning a single intent rather
 * than a plan is deliberate: a band that queued three moves would be acting on
 * a world that has since changed, and the cheapest way to keep an AI honest is
 * to make it look again every time.
 */
export function decide(snap: BandSnapshot): BandIntent {
  const menace = menaceFor(snap.pressure, snap.band.doctrine);

  // --- asleep ------------------------------------------------------------
  // Below the first rung there is nothing to do, so the band costs nothing
  // until the world is worse (invariant §2.3).
  if (menace < 1) {
    return {
      kind: 'sleep',
      untilPressure: pressureForMenace(1, snap.band.doctrine),
      reason: 'the world is not yet worth waking for',
    };
  }

  const reachable = snap.targets.filter((t) => !t.isSelf);
  const committed = commitForce(snap.muster, C.NPC_MUSTER_FRACTION);
  const strength = musterStrength(committed);

  // --- 7: the last resort ------------------------------------------------
  // Eligibility is menace AND defeat AND never having built one before. All
  // three, because any two of them alone produce a weapon that shows up in
  // every world on a schedule.
  if (
    menace >= C.NPC_DOOMSDAY_MENACE &&
    snap.band.doomsdayUsedAt === undefined &&
    snap.band.doomsdayStartedAt === undefined &&
    isLosing(snap)
  ) {
    // It goes at whoever took the most from this band, because that is what a
    // last resort is for. Falling back to the best ordinary target keeps a
    // band that lost its holdings to a rival band from having no answer.
    const avenged = bestByGrudge(snap, reachable);
    const target = avenged ?? best(snap, reachable, 'conquer')?.target;
    if (target) {
      return {
        kind: 'doomsday',
        targetId: target.settlementId,
        reason:
          `driven back to ${snap.holdings} of ${snap.band.peakHoldings} holdings; ` +
          `the engine is begun and ${target.name} is where it goes`,
      };
    }
  }

  // --- 4: confederation --------------------------------------------------
  // Before fighting, because a band that spends one turn finding an ally and
  // then fights for the rest of the world's life is strictly better at this
  // than one that never gets round to it.
  if (menace >= C.NPC_CONFEDERATE_MENACE && snap.band.confederacyId === undefined) {
    const ally = bestAlly(snap);
    if (ally) {
      return {
        kind: 'confederate',
        withBandId: ally.bandId,
        reason: `${ally.name} keeps the country to our ${bearing(snap, ally)}; better beside us than across from us`,
      };
    }
  }

  // --- 3, 5 and 6: taking ground, alone or together ----------------------
  //
  // Menace 3 opens other bands' camps; menace 6 opens players' settlements.
  // The gap between them is deliberate and it is long: barbarian consolidation
  // is the warning that the second one is coming.
  //
  // The warpath is weighed against the solo assault rather than checked before
  // it. Checking it first made a confederacy pile onto the hardest thing on the
  // map while ignoring undefended ground next door; checking it second meant it
  // effectively never fired, because there is almost always something soft
  // somewhere. Scoring both and taking the better one produces both behaviours
  // from one rule, and it is the rule a competent player would use.
  const solo =
    menace >= 3 && committed.length > 0
      ? best(snap, reachable.filter((t) => canTake(menace, t) && winnable(strength, t, 'conquer')), 'conquer')
      : undefined;

  let joint: { target: TargetSnapshot; score: number } | undefined;
  let partners: NeighbourSnapshot[] = [];
  if (menace >= C.NPC_WARPATH_MENACE && snap.band.confederacyId !== undefined && committed.length > 0) {
    partners = snap.neighbours.filter((n) => n.confederacyId === snap.band.confederacyId);
    if (partners.length > 0) {
      // Anything this band could not manage by itself. Not filtered by what it
      // is allowed to CAPTURE: at this rung the confederacy can still only rob
      // a player, and robbing one together is the point of the rung.
      //
      // Beyond this band alone, but not beyond the confederacy. Both halves
      // matter: without the first the joint strike is a formality that wastes
      // everyone's armies on a farm, and without the second it is a mass
      // suicide that hands the defender four bands' worth of experience.
      const together = strength * (partners.length + 1);
      const wanted = reachable.filter(
        (t) => t.ownerId !== undefined && !winnable(strength, t, 'raid') && winnable(together, t, 'raid'),
      );
      joint = best(snap, wanted, 'conquer', partners.length + 1);
    }
  }

  if (joint && (!solo || joint.score > solo.score)) {
    const mission = canTake(menace, joint.target) ? 'conquer' : 'raid';
    return {
      kind: 'warpath',
      targetId: joint.target.settlementId,
      withBandIds: partners.map((p) => p.bandId),
      commit: committed,
      mission,
      reason:
        `${joint.target.name} is beyond us alone; ${partners.length} confederate ` +
        `${partners.length === 1 ? 'band marches' : 'bands march'} with us and we arrive together ` +
        `${mission === 'conquer' ? 'to keep it' : 'to empty it'}`,
    };
  }

  if (solo) {
    return {
      kind: 'conquer',
      targetId: solo.target.settlementId,
      commit: committed,
      reason: whyTake(snap, solo.target),
    };
  }

  // --- 1: raiding --------------------------------------------------------
  if (committed.length > 0) {
    const raidable = reachable.filter((t) => t.ownerId !== undefined && winnable(strength, t, 'raid'));
    // At menace 2 a band prefers to hunt other bands — that is what "farming"
    // means here, and it is why barbarian numbers grow before players are ever
    // attacked in earnest.
    const preferred = menace === 2 ? raidable.filter((t) => t.ownerIsNpc) : raidable;
    const pick = best(snap, preferred.length > 0 ? preferred : raidable, 'raid');
    if (pick) {
      return {
        kind: 'raid',
        targetId: pick.target.settlementId,
        commit: committed,
        reason:
          `${pick.target.name} holds about ${Math.round(pick.target.loot).toLocaleString('en')} in stores ` +
          `behind ${pick.target.garrison <= 0 ? 'no garrison at all' : 'a garrison we can break'}`,
      };
    }
  }

  return {
    kind: 'wait',
    reason:
      committed.length === 0
        ? 'the band has nothing left to march with'
        : 'nothing within reach is worth the march',
  };
}

/** Which settlements this menace tier is allowed to CAPTURE. */
function canTake(menace: number, t: TargetSnapshot): boolean {
  if (t.ownerId === undefined) return true; // unclaimed ground is free
  return t.ownerIsNpc ? menace >= 3 : menace >= 6;
}

function best(
  snap: BandSnapshot,
  targets: readonly TargetSnapshot[],
  intent: 'raid' | 'conquer',
  riskShare = 1,
): { target: TargetSnapshot; score: number } | undefined {
  let bestPick: { target: TargetSnapshot; score: number } | undefined;
  for (const target of targets) {
    const score = scoreTarget(snap, target, intent, riskShare);
    // Strictly greater, and targets arrive in a stable order, so ties resolve
    // the same way on every replay.
    if (!bestPick || score > bestPick.score) bestPick = { target, score };
  }
  return bestPick;
}

/** The holding of whoever this band hates most, if it can see one. */
function bestByGrudge(snap: BandSnapshot, targets: readonly TargetSnapshot[]): TargetSnapshot | undefined {
  let pick: TargetSnapshot | undefined;
  let worst = 0;
  for (const t of targets) {
    const grudge = snap.band.grudges[t.ownerId ?? ''] ?? 0;
    if (grudge > worst) {
      worst = grudge;
      pick = t;
    }
  }
  return pick;
}

/**
 * Who to confederate with.
 *
 * Nearest eligible neighbour wins. Barbarian politics are geographic: bands
 * ally with the people they would otherwise be fighting over the same valley,
 * which is also why the first confederation in a world usually forms in the
 * most crowded corner of it.
 */
function bestAlly(snap: BandSnapshot): NeighbourSnapshot | undefined {
  let pick: NeighbourSnapshot | undefined;
  let nearest = Infinity;
  for (const n of snap.neighbours) {
    if (n.menace < C.NPC_CONFEDERATE_MENACE) continue;
    const d = distance(snap.seatX, snap.seatY, n.seatX, n.seatY);
    if (d > C.NPC_CONFEDERATE_RADIUS) continue;
    if (d < nearest) {
      nearest = d;
      pick = n;
    }
  }
  return pick;
}

function bearing(snap: BandSnapshot, n: NeighbourSnapshot): string {
  const dx = n.seatX - snap.seatX;
  const dy = n.seatY - snap.seatY;
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
}

function whyTake(snap: BandSnapshot, t: TargetSnapshot): string {
  if (t.ownerId === undefined) return `${t.name} stands empty and we will have it`;
  if (t.ownerIsNpc) return `${t.name} is held by lesser men and we are done sharing this country`;
  const grudge = snap.band.grudges[t.ownerId] ?? 0;
  return grudge > 0
    ? `${t.name} belongs to the ones who burned us ${grudge} ${grudge === 1 ? 'time' : 'times'}`
    : `${t.name} is worth keeping, not merely emptying`;
}

// ------------------------------------------------------------------ cadence

/**
 * How long until this band decides again.
 *
 * Shortens with menace, so escalation is felt as tempo before it is felt as
 * size — a world at menace 6 is not just attacked by bigger armies, it is
 * attacked more often. Floored well above a second so that a long
 * `advanceTo` over months of game time cannot produce an unbounded number of
 * turns.
 */
export function turnInterval(menace: number): Millis {
  const tier = Math.max(1, Math.min(C.NPC_MAX_MENACE, Math.floor(menace)));
  const ms = C.NPC_TURN_BASE_MS * Math.pow(C.NPC_TURN_PER_MENACE, tier - 1);
  return BigInt(Math.max(3_600_000, Math.round(ms)));
}

/**
 * When to look again while asleep.
 *
 * Pressure rises with time at a known rate, and with player success at a rate
 * nobody can predict. So the band sleeps for as long as TIME ALONE would take
 * to reach its threshold, and wakes early only in the sense that player growth
 * will have made the threshold arrive sooner — at which point it finds itself
 * over the line and acts.
 *
 * This is the whole reason dormant bands cost nothing: one timed event each,
 * computed in closed form, with no scan of anything (invariant §2.3).
 */
export function sleepFor(current: number, target: number): Millis {
  const shortfall = Math.max(0, target - current);
  const days = shortfall / Math.max(1e-6, C.NPC_PRESSURE_PER_DAY);
  // Capped at a season so a band in a very quiet world still checks in
  // occasionally, and floored at an hour so a near-threshold band cannot spin.
  const ms = Math.min(90 * 24 * 3_600_000, Math.max(3_600_000, days * 24 * 3_600_000));
  return BigInt(Math.round(ms));
}

/** A band's dossier line, for the log and for the player-facing screen. */
export function describeBand(band: NpcBand, menace: number): string {
  const holds = band.peakHoldings > 0 ? `${band.peakHoldings} camps at its height` : 'no ground to speak of';
  return `${band.name}, a ${band.doctrine} band at menace ${menace}, ${holds}`;
}
