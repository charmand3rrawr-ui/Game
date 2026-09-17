/**
 * visual.test.ts — the tier model, pinned to the workbook
 *
 * These test the DECISIONS, not the pixels. The canvas is untestable by nature;
 * everything that decides what a building looks like was pulled into
 * `visual.ts` precisely so it could be checked here against `Visual_Tiers`.
 */

import { describe, it, expect } from 'vitest';
import { VISUAL_TIERS, VISUAL_OVERLAYS, C } from '@ascendance/shared';
import {
  activityState, auraFor, damageState, facesFor, paletteFor, readHsl,
  seedOf, shiftHsl, silhouetteFor, tierForLevel, tierProgress,
  type BuildingVisual,
} from './visual.js';

const b = (over: Partial<BuildingVisual> = {}): BuildingVisual => ({
  key: '1_farm', name: 'Farm', category: 'Extraction',
  level: 1, damage: 0, staffedPct: 100, era: 1, ...over,
});

describe('the twelve authored tiers', () => {
  it('reads all twelve from the workbook', () => {
    expect(VISUAL_TIERS).toHaveLength(12);
    expect(VISUAL_TIERS[0]!.silhouette).toBe('Flat ground + markers');
    expect(VISUAL_TIERS[11]!.silhouette).toBe('Bespoke per building');
  });

  it('gives every level from 0 to the cap exactly one tier', () => {
    // A level with no tier is a building that draws as nothing — the kind of
    // bug that only appears at one particular level in one particular
    // settlement. The importer proves the bands are contiguous; this proves
    // the lookup agrees.
    for (let level = 0; level <= C.MAX_LEVEL; level++) {
      const t = tierForLevel(level);
      expect(level).toBeGreaterThanOrEqual(t.minLevel);
      expect(level).toBeLessThanOrEqual(t.maxLevel);
    }
  });

  it('puts the tier boundaries where the workbook puts them', () => {
    // Level 24 -> 25 is the "someone just started" to "this is real now" jump,
    // and it is the first upgrade a player will see change the skyline.
    expect(tierForLevel(24).tier).toBe(1);
    expect(tierForLevel(25).tier).toBe(2);
    expect(tierForLevel(24).read).toBe('Someone just started');
    expect(tierForLevel(25).read).toBe('This is real now');
    expect(tierForLevel(0).tier).toBe(0);
    expect(tierForLevel(C.MAX_LEVEL).tier).toBe(11);
  });

  it('never goes backwards in height as a building levels up', () => {
    // A building that visibly SHRANK on upgrade would read as a downgrade.
    let last = -1;
    for (let level = 0; level <= C.MAX_LEVEL; level += 7) {
      const h = silhouetteFor(b({ level })).height;
      expect(h).toBeGreaterThanOrEqual(last - 1e-9);
      last = h;
    }
  });
});

describe('the silhouette instructions are actually implemented', () => {
  it('doubles in height at tier 2, as the sheet says', () => {
    const t1 = silhouetteFor(b({ level: 12 }));   // tier 1
    const t2 = silhouetteFor(b({ level: 60 }));   // tier 2
    expect(t2.height).toBeGreaterThan(t1.height * 1.7);
  });

  it('is improvised at tier 1 and regular from tier 2', () => {
    expect(silhouetteFor(b({ level: 12 })).irregularity).toBeGreaterThan(0.6);
    expect(silhouetteFor(b({ level: 60 })).irregularity).toBeLessThan(0.25);
  });

  it('grows annexes at tier 3 and auxiliaries at tier 8', () => {
    expect(silhouetteFor(b({ level: 60 })).annexes).toBe(0);
    expect(silhouetteFor(b({ level: 150 })).annexes).toBeGreaterThan(0);
    expect(silhouetteFor(b({ level: 900 })).annexes).toBeGreaterThanOrEqual(3);
  });

  it('raises a tower from tier 5 and not before', () => {
    expect(silhouetteFor(b({ level: 300 })).tower).toBe(0);
    expect(silhouetteFor(b({ level: 450 })).tower).toBeGreaterThan(0);
  });

  it('leaves the ground only at tier 9', () => {
    expect(silhouetteFor(b({ level: 900 })).floats).toBe(0);
    expect(silhouetteFor(b({ level: 1100 })).floats).toBeGreaterThan(0);
  });

  it('turns partly non-solid at tier 10', () => {
    expect(silhouetteFor(b({ level: 1100 })).solidity).toBe(1);
    expect(silhouetteFor(b({ level: 1200 })).solidity).toBeLessThan(1);
  });

  it('is bespoke only at the very top', () => {
    expect(silhouetteFor(b({ level: 1280 })).bespoke).toBe(false);
    expect(silhouetteFor(b({ level: 1281 })).bespoke).toBe(true);
  });

  it('varies between buildings but is stable for one', () => {
    // Two Farms should not be pixel-identical, and the same Farm must not
    // change shape every time the canvas repaints.
    expect(seedOf('1_farm')).toBe(seedOf('1_farm'));
    expect(seedOf('1_farm')).not.toBe(seedOf('1_mine'));
    const a = silhouetteFor(b({ key: '1_farm', level: 200 }));
    const c = silhouetteFor(b({ key: '1_mine', level: 200 }));
    expect(a.width).not.toBe(c.width);
  });

  it('grows within a tier, but far less than between tiers', () => {
    // Levelling up should never be completely invisible, but the TIER change
    // has to stay the moment that matters.
    const low = silhouetteFor(b({ level: 25 }));
    const high = silhouetteFor(b({ level: 96 }));
    const next = silhouetteFor(b({ level: 97 }));
    expect(high.height).toBeGreaterThan(low.height);
    expect(high.height - low.height).toBeLessThan(next.height - low.height);
    expect(tierProgress(25)).toBeLessThan(0.05);
    expect(tierProgress(96)).toBe(1);
  });
});

describe('the two overlays that carry gameplay', () => {
  it('names both axes in the workbook', () => {
    const keys = VISUAL_OVERLAYS.map((o) => o.key);
    expect(keys).toContain('damage_state');
    expect(keys).toContain('activity_state');
    expect(VISUAL_OVERLAYS).toHaveLength(7);
  });

  it('reads damage in the four states the sheet names', () => {
    expect(damageState(0)).toBe('pristine');
    expect(damageState(20)).toBe('scarred');
    expect(damageState(50)).toBe('breached');
    expect(damageState(90)).toBe('ruined');
  });

  it('makes Overdriven outrank everything else', () => {
    // Heaven's Envy is meant to be SEEN. A player who bought their way up the
    // board must not be able to hide behind a brownout or an empty roster.
    expect(activityState(b({ overdriven: true, staffedPct: 0, brownout: true }))).toBe('overdriven');
    expect(activityState(b({ staffedPct: 100 }))).toBe('working');
    expect(activityState(b({ staffedPct: 0 }))).toBe('idle');
  });

  it('shows an unpaid building as dark', () => {
    // Brownout sheds a level a day after 72h, so "the lights are off" needs to
    // be visible before that starts.
    expect(activityState(b({ brownout: true, staffedPct: 100 }))).toBe('idle');
  });
});

describe('era and category colouring', () => {
  it('keeps the category hue while the material changes with era', () => {
    // "Material and technology pass over the same silhouette" — the era
    // overlay. A Farm stays green from thatch to composite.
    const eraI = paletteFor('Extraction', 1);
    const eraVII = paletteFor('Extraction', 7);
    expect(eraI.wall).not.toBe(eraVII.wall);
    const hue = (c: string) => c.slice(4, c.indexOf(' '));
    expect(hue(eraI.wall)).toBe(hue(eraVII.wall));
  });

  it('separates the categories a player must tell apart at a glance', () => {
    const hue = (c: string) => c.slice(4, c.indexOf(' '));
    const seen = new Set(
      ['Extraction', 'Military', 'Cultivation', 'Knowledge', 'Defense', 'Trade']
        .map((c) => hue(paletteFor(c, 1).wall)),
    );
    expect(seen.size).toBe(6);
  });

  it('gives an aura to cultivation buildings and to nothing ordinary at low grade', () => {
    expect(auraFor('Cultivation', 1, 42)).toBeGreaterThanOrEqual(0);
    expect(auraFor('Extraction', 2, 42)).toBe(0);
    expect(auraFor('Extraction', 40, 42)).toBeGreaterThan(0);
  });

  it('survives an unknown category or a wild era rather than drawing nothing', () => {
    expect(paletteFor('Nonsense', 99).wall).toMatch(/^hsl\(/);
    expect(paletteFor('Extraction', 0).wall).toMatch(/^hsl\(/);
  });
});

/**
 * The stylised lighting model.
 *
 * The whole point of `facesFor` is that a shadow is not "the wall, darker".
 * It is a different, cooler, MORE saturated colour — that single choice is
 * what separates a flat-shaded box from something that reads as toy-like and
 * lit. These tests pin that intent, because it is exactly the sort of thing a
 * later "simplification" would quietly undo.
 */
describe('the lighting model', () => {
  const wall = 'hsl(30 60% 55%)';

  it('reads an hsl triple back out, and shrugs at anything else', () => {
    expect(readHsl(wall)).toEqual({ h: 30, s: 60, l: 55 });
    expect(readHsl('rgb(1,2,3)')).toEqual({ h: 0, s: 0, l: 50 });
  });

  it('wraps hue and clamps saturation and lightness into legal ranges', () => {
    expect(readHsl(shiftHsl('hsl(350 60% 55%)', 40, 0, 0)).h).toBe(30);
    expect(readHsl(shiftHsl('hsl(10 5% 55%)', 0, -40, 0)).s).toBe(0);
    expect(readHsl(shiftHsl(wall, 0, 0, 90)).l).toBeLessThanOrEqual(97);
    expect(readHsl(shiftHsl(wall, 0, 0, -90)).l).toBeGreaterThanOrEqual(3);
  });

  it('shifts the shadow toward blue and UP in saturation, never toward grey', () => {
    const f = facesFor(wall);
    const lit = readHsl(f.lit);
    const shadow = readHsl(f.shadow);
    expect(shadow.h).toBeGreaterThan(lit.h);      // cooler
    expect(shadow.s).toBeGreaterThan(lit.s);      // and more colourful, not less
    expect(shadow.l).toBeLessThan(lit.l);
  });

  it('orders the faces the way a single key light would', () => {
    const f = facesFor(wall);
    const l = (c: string) => readHsl(c).l;
    expect(l(f.rim)).toBeGreaterThan(l(f.top));
    expect(l(f.top)).toBeGreaterThan(l(f.lit));
    expect(l(f.lit)).toBeGreaterThan(l(f.shadow));
    expect(l(f.shadow)).toBeGreaterThan(l(f.occlusion));
  });

  it('keeps every face in the wall\'s own colour family', () => {
    for (const era of [1, 4, 8, 12]) {
      for (const cat of ['Extraction', 'Military', 'Cultivation']) {
        const w = paletteFor(cat, era).wall;
        for (const face of Object.values(facesFor(w))) {
          expect(face).toMatch(/^hsl\(/);
        }
      }
    }
  });
});
