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
  activityState, auraFor, damageState, paletteFor, seedOf, silhouetteFor, tierForLevel,
  type BuildingVisual,
} from './visual.js';

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
    // Walk back to front so the topmost drawn tile wins a tie.
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
    sky.addColorStop(0, ground.sky);
    sky.addColorStop(1, ground.far);
    ctx.fillStyle = sky;
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

    // Pass 1: the ground. Every cell, including the ones under a footprint, so
    // a large building is visibly standing on several plots.
    for (const i of order) {
      const c = cellCentre(i);
      const plot = byCell.get(i);
      const owned = plot?.building !== undefined;
      const isSel = plot !== undefined && selected === plot.index;
      const isHover = plot !== undefined && hover === plot.index;
      drawTile(ctx, c.x, c.y, scale, ground, !owned, isSel, isHover && !isSel);
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
  temperate: { sky: '#1b2230', far: '#141a25', top: '#3f5136', side: '#2c3a26', empty: '#26302a', line: '#55684a' },
  desert:    { sky: '#2a2519', far: '#1d1a12', top: '#6b5a36', side: '#4e4227', empty: '#3a3120', line: '#8a7346' },
  tundra:    { sky: '#1d2430', far: '#161c26', top: '#4e5a66', side: '#39434d', empty: '#2e3640', line: '#6b7a88' },
  tropical:  { sky: '#16241d', far: '#101a15', top: '#2f5a3a', side: '#22422b', empty: '#1e3325', line: '#467a52' },
  volcanic:  { sky: '#2a1a18', far: '#1c1110', top: '#4a2f2a', side: '#37211e', empty: '#2b1c19', line: '#7a4438' },
  void:      { sky: '#15131f', far: '#0d0c14', top: '#2c2740', side: '#201c30', empty: '#1a1726', line: '#4a4170' },
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
  ctx.fillStyle = empty ? g.empty : g.top;
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
function drawBuilding(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number,
  b: BuildingVisual & { id: string }, grade: number, maxGrade: number,
  frame: number, emphasised: boolean, span: number,
): void {
  const sil = silhouetteFor(b);
  const pal = paletteFor(b.category, b.era);
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
  if (aura > 0) {
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

  // --- tier 0: a cleared site, not a building ------------------------------
  if (sil.tier === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + jitter;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * hw * 0.5, cy + Math.sin(a) * hh * 0.5);
      ctx.lineTo(cx + Math.cos(a) * hw * 0.5, cy + Math.sin(a) * hh * 0.5 - 6 * scale);
      ctx.stroke();
    }
    return;
  }

  ctx.globalAlpha = sil.solidity;

  // --- contact shadow: without it the mass appears to hover over its plot ---
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(cx + w * 0.06, cy + hh * 0.18, w * 0.52, w * 0.20, 0, 0, Math.PI * 2);
  ctx.fill();

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
  if (sil.ornament > 0) {
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

  // ==========================================================================
  // The two overlays that carry gameplay. Drawn LAST so nothing hides them.
  // ==========================================================================

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
    // A flat wash over the same volume — `flat` skips the face shading and the
    // outlines, so this darkens the building rather than redrawing it.
    box(ctx, cx, cy, w, h, { wall: 'rgba(8,10,14,0.38)', roof: 'rgba(8,10,14,0.38)', line: 'transparent', glow: '' }, 0, jitter, true);
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

  const poly = (pts: { x: number; y: number }[], fill: string): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (pal.line !== 'transparent' && !flat) {
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  };

  // Left face in shadow, right face lit — one consistent light direction, so
  // the whole settlement reads as one scene.
  poly([bL, bB, tB, tL], flat ? pal.wall : shade(pal.wall, -18));
  poly([bB, bR, tR, tB], flat ? pal.wall : shade(pal.wall, 6));
  poly([tL, tT, tR, tB], flat ? pal.wall : pal.roof);
}

/**
 * Nudge an `hsl(h s% l%)` colour lighter or darker.
 *
 * The palette is generated as HSL strings precisely so the renderer can do
 * this without a colour library: face shading is a lightness delta on the same
 * hue, which keeps a building one material rather than three.
 */
function shade(hsl: string, delta: number): string {
  const m = /hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)/.exec(hsl);
  if (!m) return hsl;
  const l = Math.max(4, Math.min(96, Number(m[3]) + delta));
  return `hsl(${m[1]} ${m[2]}% ${l}%)`;
}
