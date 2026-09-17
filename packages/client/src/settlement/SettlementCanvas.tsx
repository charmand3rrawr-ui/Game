/**
 * settlement/SettlementCanvas.tsx — the settlement as a PLACE
 *
 * This is the game's main view. A settlement is not a table of building levels;
 * it is somewhere you look at, recognise, and click on. Everything here follows
 * from three things the spec asks for:
 *
 *   1. ART IS AUTHORED PER TIER (spec/06 §4). Twelve tiers, each with a
 *      silhouette instruction from `Visual_Tiers`. `visual.ts` turns a level
 *      into geometry; this file only draws it. So upgrading a Farm past level
 *      24 visibly rebuilds it, and that is the workbook's decision.
 *
 *   2. TWO OVERLAYS CARRY GAMEPLAY AND MUST STAY LEGIBLE AT A GLANCE.
 *      Damage persists visibly until repaired. Overdriven — shard-accelerated
 *      construction — is deliberately conspicuous, because Heaven's Envy is
 *      meant to be seen. Neither is decoration; both are information a player
 *      acts on.
 *
 *   3. PLOTS ARE SCARCE (spec/04 §1). The scarcity that drives every
 *      settlement decision should be something you SEE — empty plots sitting
 *      there, and none left when there are none left — not a counter.
 *
 * WHY CANVAS AND NOT DOM
 *   Same reason as the map (DECISIONS.md D5): a settlement at galaxy scale can
 *   hold a lot of structures, and the overlays want compositing rather than
 *   stacked elements. It also keeps the build dependency-free enough to deploy
 *   as a static site.
 *
 * ACCESSIBILITY
 *   A canvas is opaque to a screen reader, so the same plots are mirrored into
 *   a visually-hidden button list that is keyboard-navigable and announces the
 *   same facts. Colour is never the only carrier of meaning (spec/06 §6): the
 *   damage and Overdriven states also carry a text label in the detail panel
 *   and a distinct shape on the canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activityState, auraFor, damageState, facesFor, paletteFor, seedOf, shiftHsl,
  silhouetteFor, tierForLevel,
  type BuildingVisual,
} from './visual.js';
import { buildingSpritePath, sprite } from './sprites.js';

export interface Plot {
  /** First cell of the footprint. */
  index: number;
  /**
   * How many plot cells this building occupies — its size class, 1 to 4.
   *
   * A building consumes `sizeClass` plots, not one (`plotsUsed` sums size
   * classes), so drawing every building on a single cell would show a plot
   * budget that disagreed with the server's. Here the footprint is drawn, which
   * makes the scarcity visible in the form the game actually models: a size-4
   * HQ takes four plots away from you and looks like it.
   */
  span: number;
  building?: BuildingVisual & { id: string };
}

interface Props {
  plots: Plot[];
  /** Cells the settlement has. Authoritative, from the server. */
  totalPlots: number;
  /** Cells consumed. Authoritative — never recounted here. */
  usedPlots: number;
  selected: number | null;
  onSelect: (index: number) => void;
  /** Settlement grade, for the cultivation aura band. */
  grade: number;
  maxGrade: number;
  /** Drives the biome ground pass. */
  biome?: string;
}

/**
 * A plot index as an opaque colour, and back again.
 *
 * Encoded across all three channels with the index offset by one, so index 0
 * is not black and cannot be confused with the cleared buffer. Only exact
 * colours are decoded: the pick buffer is drawn with antialiasing off at the
 * edges of flat fills, but a blended edge pixel would decode to a neighbouring
 * index, so anything that does not round-trip is treated as a miss rather than
 * as a wrong answer.
 */
function plotColour(index: number): string {
  const v = index + 1;
  return `rgb(${v & 255} ${(v >> 8) & 255} ${(v >> 16) & 255})`;
}

function plotFromColour(r: number, g: number, b: number): number | null {
  const v = r | (g << 8) | (b << 16);
  return v > 0 ? v - 1 : null;
}

/** Iso tile proportions. Width:height of 2:1 is the classic readable angle. */
const TILE_W = 96;
const TILE_H = 48;

export function SettlementCanvas({
  plots, totalPlots, usedPlots, selected, onSelect, grade, maxGrade, biome = 'temperate',
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const frame = useRef(0);
  const raf = useRef(0);
  /**
   * An offscreen copy of the scene where every plot is a flat, unique colour.
   *
   * WHAT A CLICK HAS TO MEAN: you select the thing you are pointing at. The
   * ground is a diamond, but a building stands UP out of it, so testing the
   * diamond alone meant a tall building's roof — the part you actually look
   * at — selected whatever was behind it, or nothing.
   *
   * Bounding boxes were the obvious next step and were also wrong: a sprite's
   * box includes its transparent corners, so a click in the empty air beside
   * one building was swallowed instead of reaching the building behind it. A
   * measured sweep showed exactly that, selecting the Archery Range when the
   * Elder's Lodge was under the cursor.
   *
   * So the scene is drawn a second time with every building painted as a flat
   * silhouette in a colour encoding its plot index, and a click reads one
   * pixel. It is exact by construction: the clickable region IS the drawn
   * shape, including a sprite's own alpha, and the two cannot drift apart
   * because the same draw code produces both.
   */
  const pickCanvas = useRef<HTMLCanvasElement | null>(null);

  // A square-ish grid, so a village and a city both stay on screen.
  const cols = Math.max(3, Math.ceil(Math.sqrt(Math.max(1, totalPlots))));
  const rows = Math.ceil(Math.max(1, totalPlots) / cols);

  /** Every cell of every footprint -> the plot that owns it. */
  const byCell = useMemo(() => {
    const m = new Map<number, Plot>();
    for (const p of plots) {
      for (let k = 0; k < Math.max(1, p.span); k++) m.set(p.index + k, p);
    }
    return m;
  }, [plots]);

  /** Grid cell -> screen position, before camera. */
  const cellToScreen = useCallback((col: number, row: number) => ({
    x: (col - row) * (TILE_W / 2),
    y: (col + row) * (TILE_H / 2),
  }), []);

  /**
   * Fit the whole settlement in view.
   *
   * There is no camera to drive here deliberately: a settlement is a fixed,
   * comprehensible place, and asking a player to pan around one on a phone to
   * find their own Granary would be a worse screen, not a richer one.
   */
  const layout = useCallback((width: number, height: number) => {
    const spanX = (cols + rows) * (TILE_W / 2);
    const spanY = (cols + rows) * (TILE_H / 2);
    const scale = Math.min((width - 24) / spanX, (height - 80) / (spanY + 120));
    return {
      scale: Math.max(0.35, Math.min(1.25, scale)),
      originX: width / 2,
      originY: height / 2 - (spanY * Math.max(0.35, Math.min(1.25, scale))) / 2 + 24,
    };
  }, [cols, rows]);

  /** Which plot is under a point, for both mouse and touch. */
  const plotAt = useCallback((px: number, py: number, width: number, height: number): number | null => {
    const { scale, originX, originY } = layout(width, height);

    // One pixel out of the pick buffer. Exact, and cheap.
    const pc = pickCanvas.current;
    if (pc) {
      const pctx = pc.getContext('2d', { willReadFrequently: true });
      const d = pctx?.getImageData(Math.round(px), Math.round(py), 1, 1).data;
      if (d && d[3]! > 0) {
        const plot = plotFromColour(d[0]!, d[1]!, d[2]!);
        if (plot !== null) return plot;
      }
    }

    // Fallback for the frame before the first draw lands.
    for (let i = totalPlots - 1; i >= 0; i--) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const p = cellToScreen(col, row);
      const cx = originX + p.x * scale;
      const cy = originY + p.y * scale;
      // Point-in-rhombus: |dx|/w + |dy|/h <= 1, in tile space.
      const dx = Math.abs(px - cx) / ((TILE_W / 2) * scale);
      const dy = Math.abs(py - cy) / ((TILE_H / 2) * scale);
      // Return the PLOT the cell belongs to, so clicking any part of a large
      // building's footprint selects the building.
      if (dx + dy <= 1) return byCell.get(i)?.index ?? i;
    }
    return null;
  }, [byCell, cellToScreen, cols, layout, totalPlots]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const t = frame.current;
    const { scale, originX, originY } = layout(width, height);
    const ground = BIOME[biome] ?? BIOME['temperate']!;

    // Sky and ground wash, so the settlement sits somewhere rather than
    // floating on the page background.
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, ground.far);
    sky.addColorStop(0.55, ground.sky);
    sky.addColorStop(1, ground.far);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // A warm glow behind the settlement, so the scene has a light source
    // rather than an evenly lit backdrop. Cheap, and it is most of what makes
    // a flat canvas feel like somewhere.
    const key = ctx.createRadialGradient(
      width * 0.68, height * 0.28, 0,
      width * 0.68, height * 0.28, Math.max(width, height) * 0.75,
    );
    key.addColorStop(0, 'rgba(255, 214, 150, 0.22)');
    key.addColorStop(1, 'rgba(255, 214, 150, 0)');
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, width, height);

    // Painter's algorithm: back rows first, so buildings in front overlap the
    // ones behind them and the place reads as having depth.
    const order: number[] = [];
    for (let i = 0; i < totalPlots; i++) order.push(i);
    order.sort((a, bb) => {
      const ra = Math.floor(a / cols) + (a % cols);
      const rb = Math.floor(bb / cols) + (bb % cols);
      return ra - rb;
    });

    const cellCentre = (i: number): { x: number; y: number } => {
      const p = cellToScreen(i % cols, Math.floor(i / cols));
      return { x: originX + p.x * scale, y: originY + p.y * scale };
    };

    if (!pickCanvas.current) pickCanvas.current = document.createElement('canvas');
    const pc = pickCanvas.current;
    pc.width = width;
    pc.height = height;
    const pctx = pc.getContext('2d', { willReadFrequently: true });
    pctx?.clearRect(0, 0, width, height);

    // Pass 1: the ground. Every cell, including the ones under a footprint, so
    // a large building is visibly standing on several plots.
    for (const i of order) {
      const c = cellCentre(i);
      const plot = byCell.get(i);
      const owned = plot?.building !== undefined;
      const isSel = plot !== undefined && selected === plot.index;
      const isHover = plot !== undefined && hover === plot.index;
      drawTile(ctx, c.x, c.y, scale, ground, !owned, isSel, isHover && !isSel);
      // Bare ground is clickable too — an empty plot is a decision to make —
      // so the diamond goes into the pick buffer under the buildings.
      if (pctx && plot !== undefined) {
        pctx.fillStyle = plotColour(plot.index);
        pctx.beginPath();
        pctx.moveTo(c.x, c.y - (TILE_H / 2) * scale);
        pctx.lineTo(c.x + (TILE_W / 2) * scale, c.y);
        pctx.lineTo(c.x, c.y + (TILE_H / 2) * scale);
        pctx.lineTo(c.x - (TILE_W / 2) * scale, c.y);
        pctx.closePath();
        pctx.fill();
      } else if (pctx) {
        pctx.fillStyle = plotColour(i);
        pctx.beginPath();
        pctx.moveTo(c.x, c.y - (TILE_H / 2) * scale);
        pctx.lineTo(c.x + (TILE_W / 2) * scale, c.y);
        pctx.lineTo(c.x, c.y + (TILE_H / 2) * scale);
        pctx.lineTo(c.x - (TILE_W / 2) * scale, c.y);
        pctx.closePath();
        pctx.fill();
      }
    }

    // Pass 2: the buildings, back to front, each at the centroid of its
    // footprint so it sits over all the plots it consumes.
    const drawn = [...plots]
      .filter((p) => p.building)
      .sort((a, b2) => depthOf(a, cols) - depthOf(b2, cols));


    for (const plot of drawn) {
      const span = Math.max(1, plot.span);
      let sx = 0;
      let sy = 0;
      for (let k = 0; k < span; k++) {
        const c = cellCentre(plot.index + k);
        sx += c.x;
        sy += c.y;
      }
      drawBuilding(
        ctx, sx / span, sy / span, scale, plot.building!, grade, maxGrade, t,
        selected === plot.index || hover === plot.index, span,
      );
      // The same geometry again, flat, into the pick buffer. Drawn in the same
      // back-to-front order, so a nearer building correctly overwrites one
      // behind it and the topmost colour is what a click reads.
      if (pctx) {
        drawBuilding(
          pctx, sx / span, sy / span, scale, plot.building!, grade, maxGrade, t,
          false, span, plotColour(plot.index),
        );
      }
    }

    // The plot budget, from the server. Scarcity you can see — and a number
    // that cannot disagree with the one on the card below.
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = usedPlots >= totalPlots ? 'rgba(232,124,110,0.95)' : 'rgba(255,255,255,0.62)';
    ctx.textAlign = 'left';
    ctx.fillText(
      usedPlots >= totalPlots ? `${usedPlots} / ${totalPlots} plots — full` : `${usedPlots} / ${totalPlots} plots`,
      12, 20,
    );
  }, [biome, byCell, cellToScreen, cols, grade, hover, layout, maxGrade, plots, selected, totalPlots, usedPlots]);

  /**
   * Animate only what has to move.
   *
   * Working buildings breathe and Overdriven ones shimmer; everything else is
   * static. The loop stops entirely when the tab is hidden, and honours
   * prefers-reduced-motion by drawing one still frame — a shimmering page is
   * exactly what that setting exists to prevent.
   */
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let stopped = false;

    const tick = (): void => {
      if (stopped) return;
      frame.current += 1;
      draw();
      raf.current = requestAnimationFrame(tick);
    };

    if (reduced || document.hidden) {
      draw();
    } else {
      raf.current = requestAnimationFrame(tick);
    }

    const onVisibility = (): void => {
      cancelAnimationFrame(raf.current);
      if (document.hidden || reduced) draw();
      else raf.current = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', draw);
    };
  }, [draw]);

  const pick = (e: React.PointerEvent<HTMLCanvasElement>): number | null => {
    const r = e.currentTarget.getBoundingClientRect();
    return plotAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };

  return (
    <div className="settlement-view">
      <canvas
        ref={canvasRef}
        className="settlement-canvas"
        onPointerMove={(e) => setHover(pick(e))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => { const i = pick(e); if (i !== null) onSelect(i); }}
        // The canvas itself is decorative to assistive tech; the real controls
        // are the buttons below it.
        aria-hidden="true"
      />
      {/*
        One button per PLOT, not per cell: a size-4 building is one thing to
        select, and announcing its four cells separately would be four
        identical rows to tab through.
      */}
      <ul className="sr-plots">
        {Array.from({ length: totalPlots }, (_, i) => {
          const plot = byCell.get(i);
          // Only the first cell of a footprint gets a control.
          if (plot && plot.index !== i) return null;
          const b = plot?.building;
          return (
            <li key={i}>
              <button
                data-plot={i}
                aria-pressed={selected === i}
                onClick={() => onSelect(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {b
                  ? `${b.name}, level ${b.level}, ${tierForLevel(b.level).read}. ` +
                    `${plot!.span} plot${plot!.span === 1 ? '' : 's'}` +
                    `${b.damage > 0 ? `, ${damageState(b.damage)}` : ''}` +
                    `${b.overdriven ? ', Overdriven' : ''}`
                  : `Plot ${i + 1}: empty`}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * Draw one building, for callers outside the settlement grid.
 *
 * The tier reference in the Codex uses this, so what it shows is drawn by the
 * same code as the game rather than an illustration that could drift from it.
 */
/**
 * How tall this level draws at scale 1, spire and floating elements included.
 *
 * Callers that have to fit a building into a fixed box need this: the mass
 * alone is not the extent, because a tier-5 tower adds most of its own height
 * again above the roof and tier 9 puts things above that.
 */
export function visualHeightAt(level: number, key: string): number {
  const sil = silhouetteFor({
    key, name: '', category: 'Extraction', level, damage: 0, staffedPct: 100, era: 1,
  });
  const body = sil.height * TILE_H * 3.0;
  // The tower is drawn from 0.92 of the body height and rises by its own share.
  const tower = sil.tower > 0 ? body * (0.92 + sil.tower) : body;
  // Floats sit above that again.
  const floats = sil.floats > 0 ? body * 1.35 : 0;
  return Math.max(body, tower, floats);
}

export function drawBuildingFor(ctx: CanvasRenderingContext2D, args: {
  x: number; y: number; scale: number;
  building: BuildingVisual & { id: string };
  grade: number; maxGrade: number; frame: number; emphasised: boolean; span: number;
}): void {
  drawBuilding(ctx, args.x, args.y, args.scale, args.building, args.grade, args.maxGrade, args.frame, args.emphasised, args.span);
}

/** Painter's-algorithm depth: further back draws first. */
function depthOf(p: Plot, cols: number): number {
  const i = p.index + Math.max(0, Math.max(1, p.span) - 1);
  return Math.floor(i / cols) + (i % cols);
}

interface Ground { sky: string; far: string; top: string; side: string; empty: string; line: string }

/** "Desert, temperate, tundra, tropical, volcanic, void" — Visual_Overlays. */
const BIOME: Record<string, Ground> = {
  // Saturated, warm-lit ground with a cool sky above it. The old set was near
  // grey and made every building look like it was standing on asphalt; a
  // stylised scene wants the ground to carry colour too, or the buildings are
  // the only thing alive in the frame.
  temperate: { sky: '#2e4a6b', far: '#1b2d44', top: '#6aa84f', side: '#3f6b32', empty: '#4a7a3c', line: '#8fd06a' },
  desert:    { sky: '#5b4a2e', far: '#35291a', top: '#d9b063', side: '#a67c3c', empty: '#c09a52', line: '#f0d28a' },
  tundra:    { sky: '#3a5570', far: '#22354a', top: '#8fb8d6', side: '#5d86a6', empty: '#7aa6c4', line: '#c3e3f7' },
  tropical:  { sky: '#1f5548', far: '#123329', top: '#3fa860', side: '#26743f', empty: '#359451', line: '#6fe08c' },
  volcanic:  { sky: '#5c2a22', far: '#331410', top: '#a04a33', side: '#6f2f20', empty: '#8a3d2a', line: '#ff8a5c' },
  void:      { sky: '#2a2352', far: '#150f30', top: '#4a3f8c', side: '#312a63', empty: '#3d3576', line: '#9b8bff' },
};

/** One iso plot: the ground it stands on, and whether it is free. */
function drawTile(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number,
  g: Ground, empty: boolean, selected: boolean, hovered: boolean,
): void {
  const hw = (TILE_W / 2) * scale;
  const hh = (TILE_H / 2) * scale;

  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
  // A short gradient across the tile so the ground plane reads as lit from the
  // same direction as the buildings, rather than as flat colour.
  const grad = ctx.createLinearGradient(cx, cy - hh, cx, cy + hh);
  grad.addColorStop(0, empty ? g.empty : g.top);
  grad.addColorStop(1, g.side);
  ctx.fillStyle = grad;
  ctx.fill();

  // An empty plot is drawn as a dashed outline — an invitation, and a visible
  // reminder of how few are left.
  ctx.lineWidth = selected ? 2.5 : 1;
  if (empty) {
    ctx.setLineDash([4 * scale, 3 * scale]);
    ctx.strokeStyle = selected ? '#d9a441' : hovered ? g.line : 'rgba(255,255,255,0.18)';
  } else {
    ctx.setLineDash([]);
    ctx.strokeStyle = selected ? '#d9a441' : hovered ? 'rgba(255,255,255,0.45)' : g.line;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * One building, composited from its tier silhouette and its overlays.
 *
 * Order matters: mass, then the tier's own features, then the overlays on top,
 * because damage and Overdriven have to survive being drawn over a busy
 * building and still read at a glance.
 */
/** Returns the screen box the building occupied, so clicks can match it. */
interface DrawnBox { x: number; y: number; w: number; h: number }

function drawBuilding(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number,
  b: BuildingVisual & { id: string }, grade: number, maxGrade: number,
  frame: number, emphasised: boolean, span: number,
  /**
   * When set, the building is drawn as a flat silhouette in this colour
   * instead of its real materials — see `PICK` in the draw loop.
   */
  pick?: string,
): DrawnBox {
  const sil = silhouetteFor(b);
  const pal = pick
    ? { wall: pick, roof: pick, line: pick, glow: pick }
    : paletteFor(b.category, b.era);
  const act = activityState(b);
  const dmg = damageState(b.damage);
  const aura = auraFor(b.category, grade, maxGrade);
  const jitter = seedOf(b.key);

  const hw = (TILE_W / 2) * scale;
  const hh = (TILE_H / 2) * scale;

  /*
   * Size class widens the mass; the tier decides how tall it stands.
   *
   * The floors matter more than they look. Without them a level-1 building on a
   * crowded grid came out about ten pixels square, which reads as a coloured
   * tile rather than a structure — the whole point of drawing the settlement is
   * lost if the first thing a new player builds looks like a marker. A hut is
   * small, but it is unmistakably a hut.
   */
  const footprint = Math.sqrt(Math.max(1, span));
  const w = Math.max(14, sil.width * hw * 1.7 * footprint);
  const h = Math.max(12, sil.height * TILE_H * 3.0 * scale);

  // --- cultivation aura, behind the mass so it haloes rather than veils -----
  // Skipped when picking: a soft halo is not part of what you can click.
  if (aura > 0 && !pick) {
    const r = (w + h) * 0.55;
    const glow = ctx.createRadialGradient(cx, cy - h * 0.4, 0, cx, cy - h * 0.4, r);
    const pulse = 0.12 + 0.05 * Math.sin(frame / 34 + jitter * 6);
    glow.addColorStop(0, `rgba(122,231,196,${(0.10 + aura * 0.24) * (1 + pulse)})`);
    glow.addColorStop(1, 'rgba(122,231,196,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy - h * 0.4, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /*
   * AUTHORED ART TAKES OVER IF IT EXISTS.
   *
   * Drawn per tier, so this asks for the tier the level falls in. A miss costs
   * nothing and returns immediately — the geometry below runs instead, and the
   * frame after the file arrives the building is simply drawn. That is what
   * lets 5,943 sprites land one at a time over months without a flag, a
   * migration, or a broken settlement in between.
   *
   * The overlays are NOT part of the sprite. Damage, Overdriven, idle and the
   * aura are composited afterwards either way, so an authored building carries
   * exactly the same gameplay information as a generated one.
   */
  const art = sprite(buildingSpritePath(b.key, sil.tier));
  if (art) {
    /*
     * A sprite may not grow past its own plots.
     *
     * Authored art arrives at whatever aspect ratio it was drawn at, and
     * scaling it to a fixed multiple of the mass let a tall or wide one spill
     * sideways over its neighbours — which looks like a bug and, worse, put
     * pixels where a different plot's click region is. The footprint is the
     * contract: the width is capped to the plots the building actually
     * occupies, and the height follows from the sprite's own proportions.
     */
    const maxW = (TILE_W / 2) * scale * 2 * Math.sqrt(Math.max(1, span));
    const drawW = Math.min(w * 1.35, maxW);
    const drawH = drawW * (art.naturalHeight / Math.max(1, art.naturalWidth));
    const x = cx - drawW / 2;
    const y = cy + hh * 0.2 - drawH;
    if (pick) {
      /*
       * Paint the sprite's own alpha in the pick colour.
       *
       * `source-atop` clipped to the sprite's box fills only where the sprite
       * actually has pixels, so the click region becomes the artwork's real
       * silhouette rather than its bounding rectangle. That is what stops a
       * transparent corner of one sprite swallowing clicks meant for the
       * building behind it.
       */
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, drawW, drawH);
      ctx.clip();
      ctx.drawImage(art, x, y, drawW, drawH);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = pick;
      ctx.fillRect(x, y, drawW, drawH);
      ctx.restore();
      return { x, y, w: drawW, h: drawH };
    }
    ctx.globalAlpha = sil.solidity;
    ctx.drawImage(art, x, y, drawW, drawH);
    ctx.globalAlpha = 1;
    drawOverlays(ctx, cx, cy, scale, drawW, drawH, b, frame, emphasised, jitter);
    return { x, y, w: drawW, h: drawH };
  }

  // --- tier 0: a cleared site, not a building ------------------------------
  if (sil.tier === 0) {
    if (pick) return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + jitter;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * hw * 0.5, cy + Math.sin(a) * hh * 0.5);
      ctx.lineTo(cx + Math.cos(a) * hw * 0.5, cy + Math.sin(a) * hh * 0.5 - 6 * scale);
      ctx.stroke();
    }
    // A cleared site is only its ground, so its click region is the diamond.
    return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
  }

  ctx.globalAlpha = sil.solidity;

  // --- contact shadow: without it the mass appears to hover over its plot ---
  if (!pick) {
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(cx + w * 0.06, cy + hh * 0.18, w * 0.52, w * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- annexes first, so the main mass overlaps them ------------------------
  for (let i = 0; i < sil.annexes; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const off = (0.55 + Math.floor(i / 2) * 0.32) * w * side;
    const ah = h * (0.34 + ((jitter * 7 + i) % 1) * 0.16);
    box(ctx, cx + off, cy + hh * 0.18, w * 0.34, ah, pal, sil.irregularity, jitter + i);
  }

  // --- the main mass --------------------------------------------------------
  box(ctx, cx, cy, w, h, pal, sil.irregularity, jitter);

  // --- tower or spire, from tier 5 ------------------------------------------
  if (sil.tower > 0) {
    const tw = w * 0.30;
    const th = h * sil.tower;
    box(ctx, cx + w * 0.16, cy - h * 0.92, tw, th, pal, sil.irregularity * 0.4, jitter + 3);
    if (sil.tier >= 7) {
      // A pennant, because a landmark declares who owns it.
      ctx.fillStyle = pal.glow;
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.16 + tw / 2, cy - h * 0.92 - th);
      ctx.lineTo(cx + w * 0.16 + tw / 2 + 9 * scale, cy - h * 0.92 - th + 4 * scale);
      ctx.lineTo(cx + w * 0.16 + tw / 2, cy - h * 0.92 - th + 8 * scale);
      ctx.closePath();
      ctx.fill();
    }
  }

  // --- ornament: window rows, which also carry the activity state -----------
  if (sil.ornament > 0 && !pick) {
    const rowCount = Math.max(1, Math.round(sil.ornament * 4));
    const lit = act === 'working' || act === 'overdriven';
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < 3; c++) {
        const wx = cx - w * 0.28 + c * (w * 0.28);
        const wy = cy - h * 0.25 - r * (h * 0.2);
        // Windows breathe slightly while staffed, so a working settlement is
        // alive without anything moving distractingly.
        const flicker = lit ? 0.55 + 0.25 * Math.sin(frame / 28 + r * 1.7 + c + jitter * 9) : 0.12;
        ctx.fillStyle = lit ? pal.glow : 'rgba(0,0,0,0.45)';
        ctx.globalAlpha = sil.solidity * flicker;
        ctx.fillRect(wx, wy, Math.max(1.5, w * 0.09), Math.max(1.5, h * 0.07));
      }
    }
    ctx.globalAlpha = sil.solidity;
  }

  // --- tier 9+: floating elements ------------------------------------------
  for (let i = 0; i < sil.floats; i++) {
    const a = (i / Math.max(1, sil.floats)) * Math.PI * 2 + frame / 160 + jitter * 6;
    const rx = w * (0.7 + (i % 3) * 0.16);
    const ry = h * 0.22;
    const fx = cx + Math.cos(a) * rx;
    const fy = cy - h * (0.85 + (i % 3) * 0.14) + Math.sin(a) * ry * 0.5;
    ctx.fillStyle = pal.glow;
    ctx.globalAlpha = sil.solidity * 0.75;
    ctx.beginPath();
    // Big enough to read as a detached piece of the building rather than a
    // speck of dust — "impossible cantilevers", not motes.
    ctx.ellipse(fx, fy, Math.max(3, w * 0.20), Math.max(2, h * 0.055), a, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The overlays. Shared with the authored-art path above, so a drawn building
  // carries exactly the same gameplay information as a generated one. Skipped
  // when picking: damage scars and a selection ring are not clickable surface.
  if (!pick) drawOverlays(ctx, cx, cy, scale, w, h, b, frame, emphasised, jitter);

  // The click region covers the mass AND whatever rises out of it — a tower
  // from tier 5, floating elements from tier 9 — because those are the parts a
  // player sees first on a tall building and therefore the parts they aim at.
  const top = sil.tower > 0 ? h * (0.92 + sil.tower) : h;
  const reach = Math.max(top, sil.floats > 0 ? h * 1.35 : 0);
  return { x: cx - w / 2, y: cy + hh * 0.2 - reach, w, h: reach + hh * 0.2 };
}

/**
 * The overlays that carry gameplay, drawn over whatever produced the building.
 *
 * Extracted so the authored-sprite path and the procedural path cannot drift.
 * If a drawn building lost its damage state or its Overdriven shimmer, art
 * landing would quietly remove information the player acts on — and it would
 * do so one building at a time, which is the hardest kind of regression to
 * notice. `spec/06 §4` requires both stay legible at a glance; that is a
 * property of the GAME, not of one renderer branch.
 */
function drawOverlays(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number,
  w: number, h: number, b: BuildingVisual, frame: number, emphasised: boolean, jitter: number,
): void {
  const dmg = damageState(b.damage);
  const act = activityState(b);

  // --- damage: persists visibly until repaired ------------------------------
  if (dmg !== 'pristine') {
    const sev = dmg === 'scarred' ? 1 : dmg === 'breached' ? 2 : 3;
    ctx.strokeStyle = dmg === 'ruined' ? 'rgba(232,90,72,0.95)' : 'rgba(232,124,110,0.8)';
    ctx.lineWidth = Math.max(1, scale * sev);
    for (let i = 0; i < sev * 2; i++) {
      const sx = cx - w / 2 + ((jitter * 13 + i * 5) % 1) * w;
      ctx.beginPath();
      ctx.moveTo(sx, cy);
      ctx.lineTo(sx + (i % 2 ? 5 : -5) * scale, cy - h * (0.3 + (i % 3) * 0.2));
      ctx.stroke();
    }
    if (sev >= 2) {
      // A breach is a hole, not a scratch — the silhouette itself is broken.
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.18, cy);
      ctx.lineTo(cx + w * 0.10, cy - h * 0.42);
      ctx.lineTo(cx + w * 0.26, cy);
      ctx.closePath();
      ctx.fill();
    }
  }

  // --- Overdriven: deliberately conspicuous ---------------------------------
  // Heaven's Envy is MEANT to be seen (spec/06 §4). This is the loudest thing
  // on the canvas by design: a temporal shimmer that no amount of ordinary
  // prosperity produces, so buying speed is public.
  if (act === 'overdriven') {
    const bands = 5;
    for (let i = 0; i < bands; i++) {
      const phase = (frame / 22 + i / bands) % 1;
      const y = cy - h * phase;
      ctx.strokeStyle = `rgba(178,142,255,${0.55 * (1 - phase)})`;
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.6, y);
      ctx.lineTo(cx + w * 0.6, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(178,142,255,0.95)';
    ctx.font = `600 ${Math.max(8, 9 * scale)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('OVERDRIVEN', cx, cy - h - 8 * scale);
  }

  // --- idle: the lights are off ---------------------------------------------
  if (act === 'idle') {
    // A flat wash over the footprint. Drawn as a rectangle rather than a volume
    // so it darkens an authored sprite as readily as a generated one.
    ctx.fillStyle = 'rgba(8,10,14,0.38)';
    ctx.fillRect(cx - w / 2, cy - h, w, h);
  }

  // --- selection ring -------------------------------------------------------
  if (emphasised) {
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy + w * 0.05, w * 0.62, w * 0.30, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * One isometric volume: a top face, a lit side and a shaded side.
 *
 * The first version drew a flat quad with a triangle on top, and at the sizes
 * a crowded settlement actually uses it read as a coloured rectangle — the
 * buildings looked like markers on a board rather than structures standing on
 * ground. A real prism costs three more polygons and is the difference between
 * "this is a place" and "this is a chart".
 *
 * The two side faces carry different shading from one light direction, which is
 * what makes the massing readable: it is how you can tell a tall narrow tower
 * from a wide low hall at a glance, before reading anything.
 *
 * `irregularity` is what makes a tier-1 building look improvised — the corners
 * wander. From tier 2 the workbook says "regular geometry", and they stop.
 */
function box(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number,
  pal: { wall: string; roof: string; line: string; glow: string },
  irregularity: number, seed: number, flat = false,
): void {
  const bw = w / 2;
  const bh = w / 4;                       // iso foreshortening: 2:1
  const wob = (n: number): number => irregularity * ((((seed * 17 + n * 7) % 1) - 0.5) * w * 0.2);

  // Base diamond, then the same diamond lifted by the building's height.
  const bL = { x: cx - bw + wob(1), y: cy + wob(2) };
  const bB = { x: cx + wob(3), y: cy + bh };
  const bR = { x: cx + bw + wob(4), y: cy + wob(5) };
  const tL = { x: bL.x, y: bL.y - h };
  const tT = { x: cx + wob(6), y: cy - bh - h };
  const tB = { x: bB.x, y: bB.y - h };
  const tR = { x: bR.x, y: bR.y - h };

  const f = facesFor(pal.wall);

  const poly = (pts: { x: number; y: number }[], fill: string | CanvasGradient): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  if (flat) {
    // A flat wash (the idle darkening, or the pick buffer) wants one colour
    // and no lighting at all.
    poly([bL, bB, tB, tL], pal.wall);
    poly([bB, bR, tR, tB], pal.wall);
    poly([tL, tT, tR, tB], pal.wall);
    return;
  }

  /*
   * Each face carries a gradient, not a flat fill.
   *
   * A flat fill is what makes stylised geometry read as a diagram: real
   * surfaces fall off toward the ground because less bounced light reaches
   * them. The ramps here are short — a few points of lightness — but they are
   * the difference between a painted volume and a coloured polygon.
   */
  const vertical = (x0: number, y0: number, y1: number, top: string, bottom: string): CanvasGradient => {
    const g = ctx.createLinearGradient(x0, y0, x0, y1);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  };

  // Shadow side, cool and saturated — never a grey version of the wall.
  poly([bL, bB, tB, tL], vertical(cx, tL.y, bB.y, f.shadow, shiftHsl(f.shadow, 6, 4, -8)));
  // Lit side, warm.
  poly([bB, bR, tR, tB], vertical(cx, tR.y, bR.y, f.lit, shiftHsl(f.lit, 8, 2, -12)));
  // Roof, catching the key light.
  poly([tL, tT, tR, tB], vertical(cx, tT.y, tB.y, f.top, shiftHsl(f.top, 4, 0, -7)));

  /*
   * The rim: a bright wrap along the top-lit edges.
   *
   * At sprite size this does more work than any interior detail, because it is
   * what separates a building from whatever is drawn behind it. Drawn only on
   * the two edges facing the key light, so it reads as light rather than as an
   * outline.
   */
  ctx.strokeStyle = f.rim;
  ctx.lineWidth = Math.max(1, w * 0.035);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(tL.x, tL.y);
  ctx.lineTo(tT.x, tT.y);
  ctx.lineTo(tR.x, tR.y);
  ctx.stroke();

  // A darker line only where the form turns away, so the silhouette holds
  // without the whole building looking outlined.
  if (pal.line !== 'transparent') {
    ctx.strokeStyle = f.occlusion;
    ctx.lineWidth = Math.max(0.8, w * 0.016);
    ctx.beginPath();
    ctx.moveTo(bL.x, bL.y);
    ctx.lineTo(bB.x, bB.y);
    ctx.lineTo(bR.x, bR.y);
    ctx.stroke();
  }
}
