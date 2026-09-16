/**
 * settlement/sprites.ts — authored art, when there is any
 *
 * THE POINT OF THIS FILE
 *   Buildings are drawn as procedural geometry composited from the workbook's
 *   twelve visual tiers (DECISIONS.md D8). That is playable, and it is not the
 *   authored art the workbook describes. Real sprites are a per-building art
 *   programme — 483 buildings with their own written appearance and a named
 *   "Signature" element, across twelve tiers each.
 *
 *   So art has to be able to land ONE FILE AT A TIME, over months, without
 *   anything breaking in between. This loader is what makes that true: ask for
 *   a sprite, get one if it has been drawn, get nothing if it has not — and the
 *   renderer falls back to the geometry it already draws. There is no flag to
 *   set and no code to change when a file appears.
 *
 * WHY IT NEVER BLOCKS A FRAME
 *   Decoding an image is asynchronous, and the canvas redraws on an animation
 *   frame. So a miss is not an error and not a wait: it returns undefined
 *   immediately, starts the load in the background, and the next frame picks
 *   the sprite up. A building silently pops from geometry to art one frame
 *   after its file arrives, which is exactly the behaviour wanted.
 *
 * WHY FAILURES ARE REMEMBERED
 *   A 404 for a sprite that has not been drawn is the NORMAL case, not an
 *   error — there are 5,943 of them. Without remembering misses, every frame
 *   would re-request every undrawn sprite, which on a full settlement is a few
 *   hundred requests a second against a server that will keep answering 404.
 */

/** Resolved sprites, ready to draw. */
const loaded = new Map<string, HTMLImageElement>();
/** Paths already known to be absent, so a miss costs nothing after the first. */
const missing = new Set<string>();
/** Paths currently being fetched, so a frame cannot start the same load twice. */
const inFlight = new Set<string>();

/**
 * Where the client serves sprites from.
 *
 * Matches the `path` field in `assets/manifest.jsonl`, so the file an artist
 * is told to produce is the file the renderer asks for — there is no mapping
 * step between the work order and the code, because a mapping step is where
 * the two drift apart.
 */
export function buildingSpritePath(buildingKey: string, tier: number): string {
  return `sprites/buildings/${buildingKey}/t${tier}.png`;
}

export function unitSpritePath(archetypeKey: string): string {
  return `sprites/units/${archetypeKey.replace(/[|\s]+/g, '_').toLowerCase()}.png`;
}

export function researchSpritePath(researchKey: string): string {
  return `sprites/research/${researchKey}.png`;
}

/**
 * A sprite if it is ready, otherwise undefined — never a promise, never a throw.
 *
 * Callers are inside a draw loop. They cannot await, and they must not have to
 * handle an error for the ordinary case of art that does not exist yet.
 */
export function sprite(path: string): HTMLImageElement | undefined {
  const hit = loaded.get(path);
  if (hit) return hit;
  if (missing.has(path) || inFlight.has(path)) return undefined;

  inFlight.add(path);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    inFlight.delete(path);
    // A zero-size decode is a corrupt or placeholder file. Treat it as absent
    // rather than drawing nothing over perfectly good geometry.
    if (img.naturalWidth > 0 && img.naturalHeight > 0) loaded.set(path, img);
    else missing.add(path);
  };
  img.onerror = () => {
    inFlight.delete(path);
    missing.add(path);
  };
  img.src = `${import.meta.env.BASE_URL ?? '/'}${path}`;
  return undefined;
}

/** True once this sprite has been drawn and is in use. For the Codex. */
export function spriteIsLoaded(path: string): boolean {
  return loaded.has(path);
}

/**
 * How much of the art programme is actually in play, as this session has seen it.
 *
 * Only counts paths that have been ASKED for, so it reports what the player has
 * actually looked at rather than the whole manifest — which is the honest
 * number for "is this settlement drawn or generated".
 */
export function spriteCoverage(): { loaded: number; missing: number } {
  return { loaded: loaded.size, missing: missing.size };
}

/** Forget everything. Only for tests — a browser session never needs this. */
export function resetSprites(): void {
  loaded.clear();
  missing.clear();
  inFlight.clear();
}
