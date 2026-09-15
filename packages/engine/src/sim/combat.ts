/**
 * sim/combat.ts — the six-phase battle resolver
 *
 * A PURE FUNCTION. Same inputs, same seed, same result, always — on every
 * machine. `resolveBattle` reads no clock, touches no I/O, and draws every
 * random number from the generator it is handed (spec/03 §5).
 *
 * This is the same code the client's Simulator runs, which is the whole reason
 * the project is in one language (spec/01 §2): the calculator a player uses to
 * plan an attack is literally the resolver that will decide it.
 *
 * INVARIANT §2.7 — EVERY COMBAT OUTCOME IS EXPLAINABLE.
 *   Every phase writes its full arithmetic into the report: every multiplier,
 *   uncapped and capped, per unit type, with contribution shares. A player must
 *   be able to reconstruct any result by hand. If a number cannot be shown with
 *   its derivation, it should not exist.
 *
 * LAYER LIMITS ARE HARD RULES, NOT MODIFIERS (spec/03 §5).
 *   Orbital bombardment softens a planet but cannot capture it. Blockades
 *   starve but cannot conquer. Only era-appropriate ground forces occupy a
 *   settlement. These are enforced as preconditions, and the reason is recorded
 *   in the report so the player understands why their fleet took the walls down
 *   and then left.
 */

import {
  C,
  applyJointCap,
  counterMultiplier,
  cumulativeLevels,
  fortificationMultiplier,
  heavensEnvyDebuff,
  morale,
  unitDef,
  veterancyStatMultiplier,
  type BattlePhase,
  type BattleReport,
  type PowerBreakdown,
  type Rng,
  type SideSummary,
  type UnitPowerRow,
} from '@ascendance/shared';

// ============================================================================
// Inputs
// ============================================================================

export interface CombatUnit {
  formationId: string;
  formationName: string;
  unitKey: string;
  count: number;
  /** Veterancy on the track this unit is fighting on (attack or defence). */
  tier: number;
  levelInTier: number;
  /** Combined equipment bonus across the three slots, as a multiplier. */
  equipmentMod: number;
}

export interface SideInput {
  playerId?: string;
  playerName: string;
  /** Rolling 30-day admin-cost average. Feeds morale, not damage. */
  empireWeight: number;
  era: number;
  units: CombatUnit[];
  /** Research tier bonus for the era. */
  techTier: number;
  /** Doctrine is deliberately OUTSIDE the joint cap (spec/03 §5). */
  doctrineMod: number;
  commanderMod: number;
  /** Heaven's Envy scopes currently marked: 0..3. Defence only. */
  envyScopes: number;
  /** Era IV+ only. Sustained combat drains this on both sides. */
  munitions: number;
  statecraft: number;
  scoutingQuality: number;
}

export interface FortificationInput {
  wallGrade: number;
  flatGarrisonHp: number;
  /** Concealment from terrain, 0..1. Raises the defender's ambush chance. */
  concealment: number;
}

export interface BattleInput {
  battleId: string;
  settlementName: string;
  /** The layer the engagement happens on. Decides what may capture. */
  layer: string;
  mission: string;
  attacker: SideInput;
  defender: SideInput;
  fortification: FortificationInput;
  /** Stockpiles present, for the plunder phase. */
  plunderable: Record<string, bigint>;
  /** Total carrying capacity of the attacking force. */
  carryCapacity: bigint;
  /** Hidden-cellar protection: this much of each resource cannot be looted. */
  hiddenCellar: bigint;
  defenderLoyalty: number;
}

export interface BattleResult {
  report: BattleReport;
  /** formationId -> survivors, for both sides. */
  survivors: Record<string, number>;
  /** Formations reduced to zero. They lose ALL accrued veterancy XP. */
  destroyed: string[];
  /** Per-phase losses by unit key, for XP attribution. */
  attackerLossesByPhase: Record<string, number>[];
  defenderLossesByPhase: Record<string, number>[];
  /**
   * Each formation's share of its side's attack pool, per phase.
   *
   * The resolver already computes these pools to decide the battle, so
   * attribution costs arithmetic rather than a second simulation (spec/03 §7).
   * Kills are credited by THESE numbers, which is what makes experience
   * proportional to what a formation actually did rather than to who happened
   * to be present.
   */
  attackerSharesByPhase: Record<string, number>[];
  defenderSharesByPhase: Record<string, number>[];
  /** Damage each side delivered and absorbed, for the defence track's
   *  absorption component — without which screens could never advance. */
  damageDelivered: { attacker: number; defender: number };
  damageAbsorbed: Record<string, number>;
  plunder: Record<string, bigint>;
  loyaltyDamage: number;
  captured: boolean;
}

// ============================================================================
// Which roles can do what
// ============================================================================

/** Only these can take and hold ground. Enforced as a precondition. */
const OCCUPYING_ROLES = new Set(['Line Infantry', 'Shock Infantry', 'Elite Shock', 'Conquest', 'Anti-Infantry']);
/** Roles that shoot before contact: the ranged and siege exchange. */
const RANGED_ROLES = new Set([
  'Ranged', 'Siege', 'Artillery', 'Air Strike', 'Alpha Strike', 'Ultimate Siege',
  'Capital', 'Line Warship', 'Carrier', 'Static Defense', 'Anti-Armor',
]);
/** Roles whose job is to absorb rather than to kill. */
const SCREEN_ROLES = new Set(['Screen', 'Naval Escort', 'Anti-Air', 'Support']);
/** Layers where ground forces can be present at all. */
const GROUND_LAYERS = new Set(['province', 'continent', 'planet']);

export function isOccupier(role: string): boolean {
  return OCCUPYING_ROLES.has(role);
}

// ============================================================================
// Power computation
// ============================================================================

interface Pooled {
  breakdown: PowerBreakdown;
  /** Live unit counts, mutated as casualties land. */
  counts: Map<string, number>;
}

/**
 * Compute one side's effective attack or defence pool.
 *
 * THE JOINT CAP IS APPLIED ONCE, AT THE END (Bible §5.3). Proficiency,
 * equipment, commanders, cultivation and veterancy all fold into a single +40%
 * clamp. Five individually reasonable systems multiply into an unreasonable one
 * otherwise — which is exactly how these games usually break.
 *
 * Doctrine sits outside the clamp by design, so doctrine choice stays a real
 * decision rather than being swallowed by a cap everyone is already at.
 */
function computePower(
  side: SideInput,
  opposing: SideInput,
  opts: {
    stat: 'atk' | 'def';
    counts: Map<string, number>;
    roleFilter?: (role: string) => boolean;
    fortification?: FortificationInput;
    ambushMod: number;
  },
): Pooled {
  const rows: UnitPowerRow[] = [];
  let base = 0;
  let vetWeighted = 0;
  let equipWeighted = 0;
  let counterWeighted = 0;

  // The opposing force's role mix, so the counter matrix can be applied as a
  // weighted average rather than per-pair — the resolver settles pools, not
  // individual duels.
  const opposingMix = roleMix(opposing);

  for (const u of side.units) {
    const count = opts.counts.get(u.formationId) ?? 0;
    if (count <= 0) continue;
    const def = unitDef(u.unitKey);
    if (opts.roleFilter && !opts.roleFilter(def.role)) continue;

    const perUnit = opts.stat === 'atk' ? def.atk : def.def;
    const vet = veterancyStatMultiplier(cumulativeLevels(u.tier, u.levelInTier));
    let counter = 0;
    for (const [role, share] of opposingMix) {
      counter += share * (opts.stat === 'atk' ? counterMultiplier(def.role, role) : counterMultiplier(role, def.role));
    }
    if (opposingMix.size === 0) counter = 1;
    // Defending, the counter matrix works AGAINST you: a role your attacker
    // counters defends worse, so the multiplier is inverted.
    const counterApplied = opts.stat === 'atk' ? counter : 1 / Math.max(counter, 1e-9);

    const contribution = perUnit * count;
    base += contribution;
    vetWeighted += contribution * vet;
    equipWeighted += contribution * u.equipmentMod;
    counterWeighted += contribution * counterApplied;

    rows.push({
      formationId: u.formationId,
      formationName: u.formationName,
      unitKey: u.unitKey,
      unitName: def.name,
      role: def.role,
      count,
      perUnit,
      veterancyMultiplier: vet,
      counterMultiplier: counterApplied,
      contribution,
      contributionShare: 0, // filled below, once the total is known
    });
  }

  const vetAvg = base > 0 ? vetWeighted / base : 1;
  const equipAvg = base > 0 ? equipWeighted / base : 1;
  const counterAvg = base > 0 ? counterWeighted / base : 1;
  const mor = morale(side.empireWeight, opposing.empireWeight);

  // Everything inside the joint cap.
  const capped = applyJointCap(1, side.techTier * equipAvg * side.commanderMod * vetAvg * opts.ambushMod);

  // Everything outside it: doctrine, morale, the counter matrix, fortification,
  // and the Heaven's Envy defensive debuff.
  let outside = side.doctrineMod * mor * counterAvg;
  let fortMult: number | undefined;
  let envy: number | undefined;
  if (opts.stat === 'def') {
    // Heaven's Envy applies to the defence pool AND to fortification
    // multipliers, and deliberately never to attack values — which makes a
    // marked player a glass cannon rather than simply weaker (spec/04 §11).
    envy = heavensEnvyDebuff(side.envyScopes);
    outside *= envy;
    if (opts.fortification) {
      fortMult = fortificationMultiplier(opts.fortification.wallGrade) * envy;
      outside *= fortMult;
    }
  }

  const total = base * capped.value * outside + (opts.stat === 'def' ? (opts.fortification?.flatGarrisonHp ?? 0) : 0);

  for (const r of rows) r.contributionShare = base > 0 ? r.contribution / base : 0;

  return {
    counts: opts.counts,
    breakdown: {
      byUnit: rows,
      base,
      techTier: side.techTier,
      equipment: equipAvg,
      doctrine: side.doctrineMod,
      commander: side.commanderMod,
      veterancy: vetAvg,
      morale: mor,
      counterMatrix: counterAvg,
      fortification: fortMult,
      flatGarrisonHp: opts.stat === 'def' ? opts.fortification?.flatGarrisonHp : undefined,
      heavensEnvy: envy,
      uncapped: base * capped.uncapped * outside,
      capped: base * capped.value * outside,
      jointCapEngaged: capped.capped,
      total,
    },
  };
}

function roleMix(side: SideInput): Map<string, number> {
  const byRole = new Map<string, number>();
  let total = 0;
  for (const u of side.units) {
    const def = unitDef(u.unitKey);
    byRole.set(def.role, (byRole.get(def.role) ?? 0) + u.count);
    total += u.count;
  }
  if (total === 0) return byRole;
  for (const [role, n] of byRole) byRole.set(role, n / total);
  return byRole;
}

// ============================================================================
// The resolver
// ============================================================================

export function resolveBattle(input: BattleInput, rng: Rng): BattleResult {
  const attackerCounts = new Map(input.attacker.units.map((u) => [u.formationId, u.count]));
  const defenderCounts = new Map(input.defender.units.map((u) => [u.formationId, u.count]));
  const startAttacker = new Map(attackerCounts);
  const startDefender = new Map(defenderCounts);

  const phases: BattlePhase[] = [];
  const attackerLossesByPhase: Record<string, number>[] = [];
  const defenderLossesByPhase: Record<string, number>[] = [];
  const attackerSharesByPhase: Record<string, number>[] = [];
  const defenderSharesByPhase: Record<string, number>[] = [];
  const sharesOf = (b: PowerBreakdown): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of b.byUnit) out[r.formationId] = (out[r.formationId] ?? 0) + r.contributionShare;
    return out;
  };
  const damageAbsorbed: Record<string, number> = {};
  const layerLimits: string[] = [];
  let damageByAttacker = 0;
  let damageByDefender = 0;
  let wallGrade = input.fortification.wallGrade;
  let attackerMunitions = input.attacker.munitions;
  let defenderMunitions = input.defender.munitions;

  // ---------------------------------------------------------------- PHASE 1
  // Intel and ambush. Scouting quality against terrain concealment.
  //
  // Drawn ONCE, before anything else, so the draw count never depends on force
  // composition — a draw count that varied would desynchronise a replay.
  const ambushRoll = rng();
  const ambushChance = Math.max(
    0,
    Math.min(C.AMBUSH_MAX_CHANCE, input.fortification.concealment * C.AMBUSH_PER_CONCEALMENT - input.attacker.scoutingQuality * C.AMBUSH_PER_SCOUTING),
  );
  const ambushed = ambushRoll < ambushChance;
  const attackerAmbushMod = ambushed ? 1 - C.AMBUSH_PENALTY : 1;
  const defenderAmbushMod = ambushed ? 1 + C.AMBUSH_BONUS : 1;

  phases.push({
    name: 'intel',
    note: ambushed
      ? `Defender ambush succeeded (${(ambushChance * 100).toFixed(1)}% chance, rolled ${(ambushRoll * 100).toFixed(1)}). Attacker fights at ${((1 - C.AMBUSH_PENALTY) * 100).toFixed(0)}%.`
      : `No ambush (${(ambushChance * 100).toFixed(1)}% chance, rolled ${(ambushRoll * 100).toFixed(1)}).`,
    attackerPower: emptyBreakdown(),
    defenderPower: emptyBreakdown(),
    attackerLosses: {},
    defenderLosses: {},
  });
  attackerLossesByPhase.push({});
  defenderLossesByPhase.push({});
  attackerSharesByPhase.push({});
  defenderSharesByPhase.push({});

  // ---------------------------------------------------------------- PHASE 2
  // Ranged and siege exchange. Artillery, bombardment, alpha strike.
  // Fortification damage is applied HERE — which is what makes a siege train
  // worth hauling and a wall worth raising.
  {
    const ap = computePower(input.attacker, input.defender, {
      stat: 'atk', counts: attackerCounts, roleFilter: (r) => RANGED_ROLES.has(r), ambushMod: attackerAmbushMod,
    });
    const dp = computePower(input.defender, input.attacker, {
      stat: 'def', counts: defenderCounts, fortification: input.fortification, ambushMod: defenderAmbushMod,
    });

    const defenderRanged = computePower(input.defender, input.attacker, {
      stat: 'atk', counts: defenderCounts, roleFilter: (r) => RANGED_ROLES.has(r), ambushMod: defenderAmbushMod,
    });
    const attackerDamage = ap.breakdown.total * C.RANGED_PHASE_WEIGHT;
    const defenderDamage = defenderRanged.breakdown.total * C.RANGED_PHASE_WEIGHT;
    attackerSharesByPhase.push(sharesOf(ap.breakdown));
    defenderSharesByPhase.push(sharesOf(defenderRanged.breakdown));

    damageByAttacker += attackerDamage;
    damageByDefender += defenderDamage;

    const dLoss = applyCasualties(input.defender, defenderCounts, attackerDamage, dp.breakdown.total, damageAbsorbed);
    const aLoss = applyCasualties(input.attacker, attackerCounts, defenderDamage, ap.breakdown.total, damageAbsorbed);

    // Walls take damage in proportion to the siege weight brought against them.
    const siegeShare = ap.breakdown.byUnit.filter((r) => r.role.includes('Siege')).reduce((s, r) => s + r.contributionShare, 0);
    const wallDamage = Math.floor(siegeShare * C.WALL_GRADES_PER_SIEGE_SHARE * (1 + rng() * 0.5));
    wallGrade = Math.max(0, wallGrade - wallDamage);

    phases.push({
      name: 'ranged',
      note: `Ranged and siege exchange. ${wallDamage > 0 ? `Walls reduced by ${wallDamage} grade(s) to ${wallGrade}.` : 'Walls held.'}`,
      attackerPower: ap.breakdown,
      defenderPower: dp.breakdown,
      attackerLosses: aLoss,
      defenderLosses: dLoss,
    });
    attackerLossesByPhase.push(aLoss);
    defenderLossesByPhase.push(dLoss);
  }

  // ---------------------------------------------------------------- PHASE 3
  // The main engagement — the core exchange.
  const mainAttack = computePower(input.attacker, input.defender, {
    stat: 'atk', counts: attackerCounts, ambushMod: attackerAmbushMod,
  });
  const mainDefence = computePower(input.defender, input.attacker, {
    stat: 'def',
    counts: defenderCounts,
    fortification: { ...input.fortification, wallGrade },
    ambushMod: defenderAmbushMod,
  });
  const defenderCounter = computePower(input.defender, input.attacker, {
    stat: 'atk', counts: defenderCounts, ambushMod: defenderAmbushMod,
  });

  {
    damageByAttacker += mainAttack.breakdown.total;
    damageByDefender += defenderCounter.breakdown.total;

    const dLoss = applyCasualties(input.defender, defenderCounts, mainAttack.breakdown.total, mainDefence.breakdown.total, damageAbsorbed);
    const aLoss = applyCasualties(input.attacker, attackerCounts, defenderCounter.breakdown.total, mainAttack.breakdown.total, damageAbsorbed);

    phases.push({
      name: 'main',
      note: `Main engagement: ${fmt(mainAttack.breakdown.total)} attack against ${fmt(mainDefence.breakdown.total)} defence.` +
        (mainAttack.breakdown.jointCapEngaged ? ' Attacker bonus stack hit the +40% joint cap.' : '') +
        (mainDefence.breakdown.jointCapEngaged ? ' Defender bonus stack hit the +40% joint cap.' : ''),
      attackerPower: mainAttack.breakdown,
      defenderPower: mainDefence.breakdown,
      attackerLosses: aLoss,
      defenderLosses: dLoss,
    });
    attackerLossesByPhase.push(aLoss);
    defenderLossesByPhase.push(dLoss);
    attackerSharesByPhase.push(sharesOf(mainAttack.breakdown));
    defenderSharesByPhase.push(sharesOf(defenderCounter.breakdown));
  }

  const attackerWon = mainAttack.breakdown.total > mainDefence.breakdown.total;

  // ---------------------------------------------------------------- PHASE 4
  // Breakthrough and pursuit. Casualty amplification on the LOSING side.
  //
  // This is what makes a decisive defeat decisive: a routed army does not
  // retreat in good order, and that is what turns a won battle into a won war.
  {
    const ratio = mainAttack.breakdown.total / Math.max(mainDefence.breakdown.total, 1e-9);
    const rout = Math.min(C.PURSUIT_MAX, Math.abs(Math.log(ratio)) * C.PURSUIT_PER_LOG_RATIO);
    const loserSide = attackerWon ? input.defender : input.attacker;
    const loserCounts = attackerWon ? defenderCounts : attackerCounts;
    const extra = fractionalCasualties(loserSide, loserCounts, rout);

    phases.push({
      name: 'breakthrough',
      note: attackerWon
        ? `Defence broke; pursuit destroyed a further ${(rout * 100).toFixed(1)}% of the garrison.`
        : `Assault broke; the withdrawal cost a further ${(rout * 100).toFixed(1)}% of the attacking force.`,
      attackerPower: emptyBreakdown(),
      defenderPower: emptyBreakdown(),
      attackerLosses: attackerWon ? {} : extra,
      defenderLosses: attackerWon ? extra : {},
    });
    attackerLossesByPhase.push(attackerWon ? {} : extra);
    defenderLossesByPhase.push(attackerWon ? extra : {});
    // Pursuit kills are credited on the same shares as the main engagement:
    // the formations that broke the line are the ones that ran it down.
    attackerSharesByPhase.push(sharesOf(mainAttack.breakdown));
    defenderSharesByPhase.push(sharesOf(defenderCounter.breakdown));
  }

  // ---------------------------------------------------------------- PHASE 5
  // Plunder or occupation.
  //
  // LAYER LIMITS ARE PRECONDITIONS, NOT MODIFIERS. A fleet in orbit can flatten
  // a planet's walls and take nothing.
  const plunder: Record<string, bigint> = {};
  let captured = false;
  let loyaltyDamage = 0;

  if (attackerWon) {
    const survivingOccupiers = input.attacker.units.filter(
      (u) => (attackerCounts.get(u.formationId) ?? 0) > 0 && isOccupier(unitDef(u.unitKey).role),
    );
    const canOccupy = GROUND_LAYERS.has(input.layer) && survivingOccupiers.length > 0;

    if (!GROUND_LAYERS.has(input.layer)) {
      layerLimits.push(`Orbital and void forces cannot occupy a ${input.layer} holding. Bombardment softens; only ground forces take ground.`);
    } else if (survivingOccupiers.length === 0) {
      layerLimits.push('No surviving occupation-capable units. The settlement was raided, not taken.');
    }

    // Plunder is bounded by carrying capacity, and the hidden cellar is never
    // taken — which is what stops a raid from being a wipeout and gives a
    // beaten player something to rebuild on.
    let remaining = input.carryCapacity;
    for (const [key, amount] of Object.entries(input.plunderable)) {
      const lootable = amount > input.hiddenCellar ? amount - input.hiddenCellar : 0n;
      const taken = lootable < remaining ? lootable : remaining;
      if (taken > 0n) {
        plunder[key] = taken;
        remaining -= taken;
      }
      if (remaining <= 0n) break;
    }

    if (canOccupy && (input.mission === 'conquer' || input.mission === 'attack')) {
      const conquestShare = survivingOccupiers
        .filter((u) => unitDef(u.unitKey).role === 'Conquest')
        .reduce((s, u) => s + (attackerCounts.get(u.formationId) ?? 0), 0);
      if (conquestShare > 0) {
        const span = C.CONQUEST_LOYALTY_MAX - C.CONQUEST_LOYALTY_MIN;
        const contest = clampNum(1 + (input.attacker.statecraft - input.defender.statecraft) * C.STATECRAFT_PER_POINT, 0.5, 1.5);
        loyaltyDamage = Math.round((C.CONQUEST_LOYALTY_MIN + rng() * span) * contest);
        captured = input.defenderLoyalty - loyaltyDamage <= 0;
      } else {
        layerLimits.push('No conquest-class units present. Loyalty was untouched; the settlement cannot flip.');
      }
    }
  }

  phases.push({
    name: 'plunder',
    note: attackerWon
      ? `${Object.keys(plunder).length > 0 ? `Plundered ${Object.keys(plunder).join(', ')}.` : 'Nothing lootable within carrying capacity.'}` +
        (captured ? ' Loyalty reached zero — the settlement flips.' : loyaltyDamage > 0 ? ` Loyalty reduced by ${loyaltyDamage}.` : '')
      : 'The assault failed; nothing was taken.',
    attackerPower: emptyBreakdown(),
    defenderPower: emptyBreakdown(),
    attackerLosses: {},
    defenderLosses: {},
  });
  attackerLossesByPhase.push({});
  defenderLossesByPhase.push({});
  attackerSharesByPhase.push({});
  defenderSharesByPhase.push({});

  // ---------------------------------------------------------------- PHASE 6
  // Munitions drain — Era IV+ only.
  //
  // This is what makes industrial depth decisive in long wars: an army that
  // wins every engagement and runs out of shells has still lost.
  if (input.attacker.era >= 4 || input.defender.era >= 4) {
    const drainA = Math.min(attackerMunitions, damageByAttacker * C.MUNITIONS_PER_DAMAGE);
    const drainD = Math.min(defenderMunitions, damageByDefender * C.MUNITIONS_PER_DAMAGE);
    attackerMunitions -= drainA;
    defenderMunitions -= drainD;
    phases.push({
      name: 'munitions',
      note: `Munitions drawn down: attacker ${fmt(drainA)} (${fmt(attackerMunitions)} left), defender ${fmt(drainD)} (${fmt(defenderMunitions)} left).` +
        (attackerMunitions <= 0 ? ' The attacking force is out of ammunition and cannot sustain another assault.' : ''),
      attackerPower: emptyBreakdown(),
      defenderPower: emptyBreakdown(),
      attackerLosses: {},
      defenderLosses: {},
    });
    attackerLossesByPhase.push({});
    defenderLossesByPhase.push({});
  }

  // ------------------------------------------------------------------ report
  const survivors: Record<string, number> = {};
  const destroyed: string[] = [];
  for (const [id, n] of [...attackerCounts, ...defenderCounts]) {
    survivors[id] = n;
    // A formation reduced to zero is destroyed and loses ALL accrued veterancy
    // XP. Experience is held by the formation, never banked by the player
    // (spec/03 §6) — which is what makes losing one hurt.
    if (n <= 0) destroyed.push(id);
  }

  const report: BattleReport = {
    outcome: attackerWon ? 'attacker' : 'defender',
    settlementName: input.settlementName,
    phases,
    attacker: summarise(input.attacker, startAttacker, attackerCounts),
    defender: summarise(input.defender, startDefender, defenderCounts),
    plunder: Object.fromEntries(Object.entries(plunder).map(([k, v]) => [k, v.toString()])),
    loyaltyDamage,
    captured,
    layerLimits,
    attribution: [], // filled asynchronously by the XP pass (spec/03 §7)
  };

  return {
    report,
    survivors,
    destroyed,
    attackerLossesByPhase,
    defenderLossesByPhase,
    attackerSharesByPhase,
    defenderSharesByPhase,
    damageDelivered: { attacker: damageByAttacker, defender: damageByDefender },
    damageAbsorbed,
    plunder,
    loyaltyDamage,
    captured,
  };
}

// ============================================================================
// Casualties
// ============================================================================

/**
 * Apply damage to a side, distributing casualties by CONTRIBUTION SHARE.
 *
 * Casualties land in proportion to how much each formation was doing, so a
 * reserve held back really is safer than a formation in the line — which is
 * what makes force composition and commitment a decision rather than a sum.
 *
 * Screens absorb disproportionately, and the amount they soak is recorded for
 * the absorption-XP pass: a Guardian shield wall may kill nothing across an
 * entire siege and still be the reason the settlement held.
 */
function applyCasualties(
  side: SideInput,
  counts: Map<string, number>,
  incomingDamage: number,
  opposingPool: number,
  damageAbsorbed: Record<string, number>,
): Record<string, number> {
  const losses: Record<string, number> = {};
  if (incomingDamage <= 0) return losses;

  // Total hit points present decides how far the damage goes.
  let totalHp = 0;
  const hpByFormation = new Map<string, number>();
  for (const u of side.units) {
    const n = counts.get(u.formationId) ?? 0;
    if (n <= 0) continue;
    const def = unitDef(u.unitKey);
    const vet = veterancyStatMultiplier(cumulativeLevels(u.tier, u.levelInTier));
    const hp = def.hp * n * vet;
    hpByFormation.set(u.formationId, hp);
    totalHp += hp;
  }
  if (totalHp <= 0) return losses;

  const lethality = Math.min(1, incomingDamage / Math.max(totalHp, 1e-9));

  for (const u of side.units) {
    const n = counts.get(u.formationId) ?? 0;
    if (n <= 0) continue;
    const def = unitDef(u.unitKey);
    // Screens take more than their share; that is what they are for.
    const exposure = SCREEN_ROLES.has(def.role) ? C.SCREEN_EXPOSURE : 1;
    const share = (hpByFormation.get(u.formationId) ?? 0) / totalHp;
    const absorbed = incomingDamage * share * exposure;
    damageAbsorbed[u.formationId] = (damageAbsorbed[u.formationId] ?? 0) + absorbed;

    const killed = Math.min(n, Math.round(n * lethality * exposure));
    if (killed > 0) {
      counts.set(u.formationId, n - killed);
      losses[u.unitKey] = (losses[u.unitKey] ?? 0) + killed;
    }
  }

  // Casualties can never exceed the counts present — a property test asserts it.
  return losses;
}

/** Flat proportional losses, used by the pursuit phase. */
function fractionalCasualties(side: SideInput, counts: Map<string, number>, fraction: number): Record<string, number> {
  const losses: Record<string, number> = {};
  if (fraction <= 0) return losses;
  for (const u of side.units) {
    const n = counts.get(u.formationId) ?? 0;
    if (n <= 0) continue;
    const killed = Math.min(n, Math.round(n * fraction));
    if (killed > 0) {
      counts.set(u.formationId, n - killed);
      losses[u.unitKey] = (losses[u.unitKey] ?? 0) + killed;
    }
  }
  return losses;
}

function summarise(side: SideInput, before: Map<string, number>, after: Map<string, number>): SideSummary {
  let totalBefore = 0;
  let totalAfter = 0;
  const formations = side.units.map((u) => {
    const b = before.get(u.formationId) ?? 0;
    const a = after.get(u.formationId) ?? 0;
    totalBefore += b;
    totalAfter += a;
    return { formationId: u.formationId, name: u.formationName, unitKey: u.unitKey, before: b, after: a };
  });
  return {
    playerId: side.playerId,
    playerName: side.playerName,
    empireWeight: side.empireWeight,
    formations,
    totalBefore,
    totalAfter,
  };
}

function emptyBreakdown(): PowerBreakdown {
  return {
    byUnit: [], base: 0, techTier: 1, equipment: 1, doctrine: 1, commander: 1,
    veterancy: 1, morale: 1, counterMatrix: 1, uncapped: 0, capped: 0,
    jointCapEngaged: false, total: 0,
  };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function clampNum(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
