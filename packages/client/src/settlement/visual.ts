/**
 * settlement/visual.ts — turning game state into something to draw
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 *   The renderer is a canvas full of imperative drawing calls, which is the
 *   hardest kind of code to test. Everything that DECIDES what a building looks
 *   like lives here instead: pure functions from game state to geometry and
 *   colour, unit-tested against the workbook. The canvas only executes them.
 *
 * ART IS AUTHORED PER TIER, NOT PER LEVEL (spec/06 §4)
 *   483 buildings x 1,338 levels is 646,000 states, which nobody can draw. The
 *   `Visual_Tiers` sheet defines twelve tiers, each with a level band and —
 *   the load-bearing column — a `silhouette` instruction saying how the shape
 *   changes. This module implements those twelve instructions literally:
 *
 *     0  Flat ground + markers                     8  Sprawling complex; auxiliaries
 *     1  Small, low, irregular                     9  Impossible cantilevers; floating elements
 *     2  Doubles in height; regular geometry      10  Partly non-solid; auroral
 *     3  Spreads horizontally; annexes appear     11  Bespoke per building
 *     4  Vertical emphasis begins
 *     5  Complex massing; a tower or spire
 *     6  Mixed-period silhouette
 *     7  Landmark scale
 *
 *   So a player who upgrades a Farm from level 24 to 25 SEES it become a real
 *   building, and that is the workbook's decision, not mine.
 *
 * WHAT THIS IS NOT
 *   It is not the authored art. Real sprites are a per-building art programme
 *   (each building in the workbook carries its own `art` description and a
 *   "Signature:" element). This composites procedural geometry from the same
 *   data the artists would work to, so the game is playable and legible now and
 *   swapping in an atlas later is a change to the renderer, not to the model.
 *   DECISIONS.md D8.
 */

import { VISUAL_TIERS, type RefVisualTier } from '@ascendance/shared';

/** The eleven building categories, each with its own shape family. */
export type Category =
  | 'HQ/Governance' | 'Extraction' | 'Processing' | 'Logistics' | 'Military'
  | 'Defense' | 'Knowledge' | 'Culture' | 'Cultivation' | 'Trade' | 'Special';

/**
 * The state of one building, as far as drawing is concerned.
 *
 * Deliberately narrow: the renderer should not be able to reach into the full
 * settlement view and start deriving gameplay from it.
 */
export interface BuildingVisual {
  key: string;
  name: string;
  category: string;
  level: number;
  /** 0 pristine .. 100 destroyed. The damage overlay reads this. */
  damage: number;
  /** 0..100. Under-staffed buildings read as idle, which is the point. */
  staffedPct: number;
  era: number;
  /** Shard-accelerated construction. Deliberately conspicuous — see below. */
  overdriven?: boolean;
  /** Unpaid upkeep: output halved, and shedding a level a day after 72h. */
  brownout?: boolean;
}

// ============================================================================
// Tier
// ============================================================================

/** Level bands, smallest first, resolved once from the workbook. */
const TIERS: readonly RefVisualTier[] = [...VISUAL_TIERS].sort((a, b) => a.minLevel - b.minLevel);

/**
 * Which of the twelve authored tiers a level falls in.
 *
 * The importer proves the bands are contiguous from 0 to the level cap, so
 * every level has exactly one tier. The clamp at either end is for safety
 * rather than expectation: a building drawn as nothing would be a bug a player
 * reports as "my mine vanished".
 */
export function tierForLevel(level: number): RefVisualTier {
  if (level <= 0) return TIERS[0]!;
  for (const t of TIERS) if (level >= t.minLevel && level <= t.maxLevel) return t;
  return TIERS[TIERS.length - 1]!;
}

/**
 * How far through its tier a level sits, 0..1.
 *
 * Within a tier the art does not change, but the building may grow slightly, so
 * that levelling up is never completely invisible. The tier change is the
 * moment; this is the slope between moments.
 */
export function tierProgress(level: number): number {
  const t = tierForLevel(level);
  const span = t.maxLevel - t.minLevel;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (level - t.minLevel) / span));
}

// ============================================================================
// Silhouette
// ============================================================================

/**
 * The shape to draw, in plot-relative units.
 *
 * All values are fractions of the plot box, so the renderer can lay out plots
 * at any size and the geometry follows. `body` is the main mass; `annexes` are
 * the outbuildings tier 3 introduces; `tower` is the spire from tier 5;
 * `floats` are the impossible elements of tier 9 and up.
 */
export interface Silhouette {
  tier: number;
  /** Footprint width, 0..1 of the plot. */
  width: number;
  /** Height, 0..1 of the plot. Tier 2 "doubles in height". */
  height: number;
  /** How irregular the outline is. Tier 1 is improvised; tier 2 is regular. */
  irregularity: number;
  /** Outbuildings flanking the body, from tier 3 ("annexes appear"). */
  annexes: number;
  /** A tower or spire, 0..1 of body height. Tier 5 onward. */
  tower: number;
  /** Detached elements that hang in the air. Tier 9 onward. */
  floats: number;
  /** Opacity of the main body. Tier 10 is "partly non-solid". */
  solidity: number;
  /** Ornament density: banners, trim, window rows. */
  ornament: number;
  /** True once the building is a named wonder (tier 11). */
  bespoke: boolean;
}

/** Deterministic per-building jitter, so two Farms are not identical. */
export function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * The twelve silhouette instructions, implemented.
 *
 * Each line below is one row of `Visual_Tiers`. The numbers are chosen so the
 * READ the sheet asks for lands: tier 2 really is about twice tier 1's height,
 * tier 7 really does dominate its plot, and tier 9 is the first one where
 * something leaves the ground.
 */
export function silhouetteFor(b: BuildingVisual): Silhouette {
  const t = tierForLevel(b.level);
  const within = tierProgress(b.level);
  const jitter = seedOf(b.key);
  // Size class drives footprint; a Warehouse should read as bigger than a Well.
  const bulk = 0.82 + jitter * 0.18;

  // Height by tier. The jumps are where the player is meant to notice.
  const heights = [0.06, 0.18, 0.36, 0.40, 0.52, 0.62, 0.66, 0.78, 0.82, 0.88, 0.92, 0.98];
  const widths  = [0.74, 0.46, 0.52, 0.72, 0.66, 0.70, 0.72, 0.84, 0.92, 0.80, 0.78, 0.90];

  const tier = t.tier;
  const base = heights[tier] ?? 0.5;
  const w = widths[tier] ?? 0.6;
  // The NEXT tier's figures, so growth inside a tier reaches toward the next
  // one instead of past it.
  const nextBase = heights[tier + 1] ?? base;
  const nextW = widths[tier + 1] ?? w;

  /**
   * Grow toward the next tier, never beyond it.
   *
   * Scaling a tier's own height by `1 + within` overshoots: a tier-5 building
   * at the top of its band ended up TALLER than a tier-6 one at the bottom, so
   * the upgrade that crossed that boundary made the building visibly shrink —
   * which reads as a downgrade. Interpolating toward the next tier's base
   * keeps height monotonic in level, and the 0.3 keeps the tier change itself
   * the dominant jump rather than a smooth ramp.
   */
  const toward = (from: number, to: number): number => from + (to - from) * within * 0.3;

  return {
    tier,
    width: toward(w, nextW) * bulk,
    height: toward(base, nextBase),
    // Tier 1 is "improvised... visible lashings and patches"; tier 2 brings
    // "regular geometry" and it never goes back.
    irregularity: tier === 0 ? 0.5 : tier === 1 ? 0.85 : Math.max(0, 0.22 - tier * 0.02),
    // "Spreads horizontally; annexes appear" at 3, "sprawling complex;
    // auxiliaries" at 8.
    annexes: tier < 3 ? 0 : tier < 8 ? 1 + (jitter > 0.5 ? 1 : 0) : 3 + Math.round(jitter * 2),
    // "Complex massing; a tower or spire" from 5.
    tower: tier < 5 ? 0 : Math.min(0.85, 0.30 + (tier - 5) * 0.09 + jitter * 0.1),
    // "Impossible cantilevers; floating elements" from 9.
    floats: tier < 9 ? 0 : (tier - 8) * 2 + Math.round(jitter * 2),
    // "Partly non-solid; auroral" at 10.
    solidity: tier < 10 ? 1 : tier === 10 ? 0.72 : 0.84,
    // "First decoration" at 3, "ornament, heraldry" at 5.
    ornament: tier < 3 ? 0 : Math.min(1, (tier - 2) / 6),
    bespoke: tier >= 11,
  };
}

// ============================================================================
// Overlays — two of these carry gameplay and must stay legible (spec/06 §4)
// ============================================================================

export type DamageState = 'pristine' | 'scarred' | 'breached' | 'ruined';
export type ActivityState = 'idle' | 'working' | 'overdriven';

/**
 * Damage, in the four states the workbook names.
 *
 * This overlay PERSISTS VISIBLY UNTIL REPAIRED (spec/06 §4). It is not a
 * transient hit-flash: a settlement you have not repaired should look like one,
 * from across the screen, days later.
 */
export function damageState(damage: number): DamageState {
  if (damage <= 0) return 'pristine';
  if (damage < 34) return 'scarred';
  if (damage < 67) return 'breached';
  return 'ruined';
}

/**
 * Idle / working / Overdriven, in that order of conspicuousness.
 *
 * Overdriven is shard-accelerated construction, and spec/06 §4 asks for it to
 * be deliberately conspicuous BECAUSE Heaven's Envy is meant to be seen. A
 * player who bought their way up the board should be visibly doing so; hiding
 * it would quietly defeat the whole integrity mechanic.
 *
 * Brownout counts as idle: unpaid upkeep means the lights are off, which is
 * exactly the read a player needs before their building starts shedding levels.
 */
export function activityState(b: BuildingVisual): ActivityState {
  if (b.overdriven) return 'overdriven';
  if (b.brownout) return 'idle';
  return b.staffedPct >= 25 ? 'working' : 'idle';
}

// ============================================================================
// Palette — the era retrofit and category axes
// ============================================================================

export interface Palette {
  /** Main mass. */
  wall: string;
  /** Roof and upper surfaces, which is what reads at a glance. */
  roof: string;
  /** Outline. */
  line: string;
  /** Windows, forge glow, screens — the lit parts when working. */
  glow: string;
}

/**
 * Category decides hue, era decides material.
 *
 * "Material and technology pass over the same silhouette: thatch to tile to
 * steel to composite" — `Visual_Overlays`, era retrofit. So the same Farm keeps
 * its shape and its green, and changes what it is made of.
 */
const CATEGORY_HUE: Record<string, number> = {
  'Extraction': 96,      // green: things that come out of the ground
  'Processing': 28,      // amber: forge and kiln heat
  'Logistics': 40,       // ochre: sacks, crates, storage
  'Military': 8,         // red: the only category that kills
  'Defense': 214,        // steel blue: walls
  'Knowledge': 264,      // violet: study
  'Culture': 330,        // rose: people
  'Cultivation': 168,    // jade: Qi
  'Trade': 50,           // gold: coin
  'HQ/Governance': 44,   // the seat, warm and central
  'Special': 286,        // uncanny
};

/** Era I is thatch and timber; Era VII is composite and light. */
/**
 * Bright, saturated, stylised — the look a modern cartoon-realist game uses.
 *
 * The first pass was muted: saturation in the twenties, lightness in the
 * forties. It was defensible as "materials", and on a dark settlement ground
 * it read as a row of grey-brown boxes with nothing to tell them apart at a
 * glance. That is the wrong failure for this screen, because CATEGORY is
 * gameplay — a player scanning a settlement needs to find the Barracks without
 * reading a label.
 *
 * So: saturation high enough that each category's hue is unmistakable, and
 * lightness high enough that the buildings sit forward of the ground rather
 * than sinking into it. Era still changes material, but now across a bright
 * range rather than a drab one — a later era reads as cleaner and more
 * luminous, not merely paler.
 */
const ERA_MATERIAL: { sat: number; light: number; line: number }[] = [
  { sat: 58, light: 58, line: 30 }, // I   timber, thatch
  { sat: 60, light: 60, line: 32 }, // II  fired brick, tile
  { sat: 56, light: 62, line: 34 }, // III dressed stone
  { sat: 58, light: 65, line: 36 }, // IV  iron and glass
  { sat: 62, light: 68, line: 38 }, // V   steel
  { sat: 68, light: 71, line: 40 }, // VI  alloy
  { sat: 74, light: 74, line: 44 }, // VII composite, light
];

export function paletteFor(category: string, era: number): Palette {
  const hue = CATEGORY_HUE[category] ?? 40;
  const m = ERA_MATERIAL[Math.min(ERA_MATERIAL.length, Math.max(1, era)) - 1]!;
  return {
    wall: `hsl(${hue} ${m.sat}% ${m.light}%)`,
    // The roof is darker AND more saturated than the wall. A wide value gap
    // between the two is what makes massing read instantly at sprite size —
    // the earlier 14-point gap left roof and wall reading as one flat shape.
    roof: `hsl(${hue} ${Math.min(100, m.sat + 14)}% ${Math.max(20, m.light - 26)}%)`,
    line: `hsl(${hue} ${m.sat}% ${m.line}%)`,
    // Lit windows and forge glow: warm, and brighter than anything else on the
    // building, so an occupied settlement reads as occupied.
    glow: `hsl(${(hue + 22) % 360} 95% 74%)`,
  };
}

/**
 * Parse an `hsl(h s% l%)` string back to its components.
 *
 * The palette is generated as HSL strings precisely so the lighting model can
 * work in hue space without a colour library.
 */
export function readHsl(css: string): { h: number; s: number; l: number } {
  const m = /hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)/.exec(css);
  if (!m) return { h: 0, s: 0, l: 50 };
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

const clamp01 = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Shift a colour in hue, saturation and lightness at once. */
export function shiftHsl(css: string, dh: number, ds: number, dl: number): string {
  const { h, s, l } = readHsl(css);
  return `hsl(${(h + dh + 360) % 360} ${clamp01(s + ds, 0, 100)}% ${clamp01(l + dl, 3, 97)}%)`;
}

/** The colours one building's faces are painted, under one light. */
export interface Faces {
  /** The roof. Catches the key light most directly. */
  top: string;
  /** The face turned toward the light. */
  lit: string;
  /** The face turned away. Cool and saturated, never grey. */
  shadow: string;
  /** The bright edge where the light wraps the silhouette. */
  rim: string;
  /** Deepest occlusion, at the ground contact. */
  occlusion: string;
}

/**
 * KEY WARM, SHADOW COOL — the thing that makes stylised 3D read as stylised.
 *
 * Shading by lightness alone, which is what this did before, produces a
 * building painted in three tints of one colour. It is correct and it looks
 * like a chart. What a modern stylised game does instead is move the HUE with
 * the light: the lit faces drift warm toward the key, and the shadowed face
 * drifts cool — toward blue — while gaining saturation rather than losing it.
 *
 * That last part is the counter-intuitive one and it is the whole effect.
 * Real shadows are not grey versions of the lit colour; they are bounced
 * ambient light, which outdoors is sky, which is blue and strongly coloured.
 * Desaturating a shadow makes it muddy. Saturating and cooling it makes the
 * form pop and the whole scene look lit rather than merely tinted.
 *
 * The rim is the other half: a narrow band far brighter than anything else,
 * where the light wraps the edge. It separates a building from whatever is
 * behind it, which at sprite size matters more than any interior detail.
 */
export function facesFor(wall: string): Faces {
  return {
    // Roof: closest to the key, so warmest and brightest.
    top: shiftHsl(wall, -8, 6, 14),
    // Lit side: warm, a little brighter.
    lit: shiftHsl(wall, -5, 4, 4),
    // Shadow side: cooled hard toward blue, saturation UP, value down. The
    // hue shift is large on purpose — a subtle one just looks like a mistake.
    shadow: shiftHsl(wall, 26, 16, -28),
    // Rim: the wrap light. Very bright, warm, and nearly white at the top end.
    rim: shiftHsl(wall, -14, -18, 34),
    // Contact occlusion: cool and deep, matching the shadow family.
    occlusion: shiftHsl(wall, 30, 12, -42),
  };
}

/**
 * The cultivation aura band, 0..1.
 *
 * Seven realm bands over 42 grades. Only cultivation and high-grade buildings
 * carry it, so a Spirit Grove in a high-realm settlement looks like one.
 */
export function auraFor(category: string, grade: number, maxGrade: number): number {
  if (category !== 'Cultivation' && grade < maxGrade * 0.5) return 0;
  const band = Math.min(6, Math.floor((grade / Math.max(1, maxGrade)) * 7));
  return band / 6;
}
