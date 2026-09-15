/**
 * map/MapView.tsx — the map
 *
 * spec/06 §4 specifies PixiJS, for the right reason: a DOM or SVG map will not
 * survive galaxy scale. This is a Canvas 2D renderer that implements the
 * properties §4 actually asks for — viewport culling, level-of-detail cluster
 * markers beyond a zoom threshold, delta patching rather than snapshots, and
 * the two overlays that carry gameplay information. The renderer is isolated
 * here so swapping in PixiJS is a contained change (DECISIONS.md D5).
 *
 * TWO OVERLAYS MUST STAY LEGIBLE AT A GLANCE (spec/06 §4):
 *   - damage state persists visibly until repaired;
 *   - Overdriven activity — shard-accelerated construction — is deliberately
 *     conspicuous, because Heaven's Envy is meant to be seen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store.js';
import { Empty, Pill } from '../ui/bits.js';
import type { MapResponse } from '../state/api.js';

interface Camera { x: number; y: number; zoom: number }

/** Beyond this many world units per pixel, settlements become clusters. */
const LOD_CLUSTER_BELOW_ZOOM = 1.1;

export function MapView(): JSX.Element {
  const { map, me, movements, openSettlement, now } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 2.4 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const settlements = map?.settlements ?? [];

  /** Inbound hostile movements, so the map can show what is coming. */
  const threatened = useMemo(() => {
    const mine = new Set(settlements.filter((s) => s.mine).map((s) => s.id));
    return new Set(
      (map?.movements ?? [])
        .filter((m) => mine.has(m.targetId) && m.ownerId !== me?.player.id)
        .map((m) => m.targetId),
    );
  }, [map, settlements, me]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = Math.max(320, Math.round(width * 0.62));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const toScreen = (wx: number, wy: number): [number, number] => [
      cx + (wx - camera.x) * camera.zoom,
      cy + (wy - camera.y) * camera.zoom,
    ];

    // Ground.
    ctx.fillStyle = '#0b0e12';
    ctx.fillRect(0, 0, width, height);

    // Grid, spaced so it stays a reference rather than a texture at any zoom.
    const step = camera.zoom > 4 ? 10 : camera.zoom > 1.5 ? 25 : 100;
    ctx.strokeStyle = 'rgba(51,65,90,0.25)';
    ctx.lineWidth = 1;
    const startX = Math.floor((camera.x - cx / camera.zoom) / step) * step;
    const endX = camera.x + cx / camera.zoom;
    for (let wx = startX; wx <= endX; wx += step) {
      const [sx] = toScreen(wx, 0);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, height); ctx.stroke();
    }
    const startY = Math.floor((camera.y - cy / camera.zoom) / step) * step;
    const endY = camera.y + cy / camera.zoom;
    for (let wy = startY; wy <= endY; wy += step) {
      const [, sy] = toScreen(0, wy);
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(width, sy); ctx.stroke();
    }

    // VIEWPORT CULLING: only what is on screen is considered at all. With
    // thousands of holdings this is the difference between a map and a
    // slideshow.
    const margin = 60;
    const visible = settlements.filter((s) => {
      const [sx, sy] = toScreen(s.coordX, s.coordY);
      return sx > -margin && sx < width + margin && sy > -margin && sy < height + margin;
    });

    // LEVEL OF DETAIL: beyond the zoom threshold, settlements render as
    // aggregate cluster markers rather than individual sprites (spec/06 §4).
    if (camera.zoom < LOD_CLUSTER_BELOW_ZOOM) {
      const cells = new Map<string, { x: number; y: number; n: number; mine: number }>();
      const cell = 60;
      for (const s of visible) {
        const key = `${Math.round(s.coordX / cell)}:${Math.round(s.coordY / cell)}`;
        const c = cells.get(key) ?? { x: 0, y: 0, n: 0, mine: 0 };
        c.x += s.coordX; c.y += s.coordY; c.n++; if (s.mine) c.mine++;
        cells.set(key, c);
      }
      for (const c of cells.values()) {
        const [sx, sy] = toScreen(c.x / c.n, c.y / c.n);
        const r = 7 + Math.min(14, Math.log2(c.n + 1) * 5);
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = c.mine > 0 ? 'rgba(217,164,65,0.22)' : 'rgba(111,155,209,0.16)';
        ctx.fill();
        ctx.strokeStyle = c.mine > 0 ? '#d9a441' : '#6f9bd1';
        ctx.stroke();
        ctx.fillStyle = '#e6edf3';
        ctx.font = '600 11px ui-sans-serif, system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(c.n), sx, sy);
      }
    } else {
      // Movement lines first, so markers sit on top of them.
      for (const m of map?.movements ?? []) {
        const from = settlements.find((s) => s.id === m.originId);
        const to = settlements.find((s) => s.id === m.targetId);
        if (!from || !to) continue;
        const [fx, fy] = toScreen(from.coordX, from.coordY);
        const [tx, ty] = toScreen(to.coordX, to.coordY);
        const hostile = m.ownerId !== me?.player.id;
        // Progress along the line is computed from absolute timestamps, never
        // from a duration the client counted down itself.
        const total = Number(BigInt(m.arrivesAt) - BigInt(m.departsAt)) || 1;
        const done = Math.max(0, Math.min(1, (now() - Number(BigInt(m.departsAt))) / total));
        ctx.strokeStyle = hostile ? 'rgba(224,86,86,0.55)' : 'rgba(90,192,138,0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.setLineDash([]);
        const px = fx + (tx - fx) * done;
        const py = fy + (ty - fy) * done;
        ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = hostile ? '#e05656' : '#5ac08a';
        ctx.fill();
      }

      for (const s of visible) {
        const [sx, sy] = toScreen(s.coordX, s.coordY);
        const size = s.holdingType.includes('outpost') ? 4 : 6;
        const ruin = s.integrity < 60;

        // Damage state persists VISIBLY until repaired.
        if (threatened.has(s.id)) {
          ctx.beginPath(); ctx.arc(sx, sy, size + 8, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(224,86,86,0.7)'; ctx.lineWidth = 2; ctx.stroke();
        }

        ctx.beginPath();
        ctx.rect(sx - size, sy - size, size * 2, size * 2);
        ctx.fillStyle = s.mine ? '#d9a441' : s.ownerId ? '#6f9bd1' : '#3d4756';
        ctx.fill();
        // Shape as well as colour: ownership never depends on hue alone.
        if (s.mine) {
          ctx.strokeStyle = '#fff3d6'; ctx.lineWidth = 1.5; ctx.stroke();
        }
        if (ruin) {
          ctx.strokeStyle = '#e05656'; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx - size, sy - size); ctx.lineTo(sx + size, sy + size);
          ctx.moveTo(sx + size, sy - size); ctx.lineTo(sx - size, sy + size);
          ctx.stroke();
        }

        if (camera.zoom > 2) {
          ctx.fillStyle = hover === s.id ? '#e6edf3' : '#93a1b1';
          ctx.font = `${hover === s.id ? '600 ' : ''}11px ui-sans-serif, system-ui`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(s.name, sx, sy + size + 4);
        }
      }
    }
  }, [camera, settlements, map, me, hover, threatened, now]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const onResize = (): void => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = Math.max(320, Math.round(rect.width * 0.62)) / 2;
    const wx = (mx - cx) / camera.zoom + camera.x;
    const wy = (my - cy) / camera.zoom + camera.y;
    let best: { id: string; d: number } | null = null;
    for (const s of settlements) {
      const d = Math.hypot(s.coordX - wx, s.coordY - wy);
      if (d < 12 / camera.zoom + 6 && (!best || d < best.d)) best = { id: s.id, d };
    }
    return best?.id ?? null;
  };

  return (
    <div className="page">
      <h1>Map</h1>
      <p className="lede">
        Drag to pan, scroll to zoom. Below a zoom threshold, holdings aggregate into cluster markers — this map is
        built to survive galaxy scale, so it never renders what you cannot see.
      </p>

      {settlements.length === 0 ? (
        <Empty>No holdings in view.</Empty>
      ) : (
        <>
          <div className="mapwrap">
            <canvas
              ref={canvasRef}
              onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y }; }}
              onMouseUp={() => { drag.current = null; }}
              onMouseLeave={() => { drag.current = null; setHover(null); }}
              onMouseMove={(e) => {
                if (drag.current) {
                  setCamera((c) => ({
                    ...c,
                    x: drag.current!.cx - (e.clientX - drag.current!.x) / c.zoom,
                    y: drag.current!.cy - (e.clientY - drag.current!.y) / c.zoom,
                  }));
                } else {
                  setHover(pick(e));
                }
              }}
              onClick={(e) => { const id = pick(e); if (id) void openSettlement(id); }}
              onWheel={(e) => {
                setCamera((c) => ({ ...c, zoom: Math.max(0.35, Math.min(9, c.zoom * (e.deltaY > 0 ? 0.88 : 1.14))) }));
              }}
            />
            <div className="maphud">
              <span>zoom {camera.zoom.toFixed(2)}&times;</span>
              <span>&middot;</span>
              <span>{settlements.length} holdings</span>
              {camera.zoom < LOD_CLUSTER_BELOW_ZOOM && <><span>&middot;</span><span>clustered</span></>}
            </div>
          </div>

          {/* Colour is never the only carrier of meaning (spec/06 §6). */}
          <div className="maplegend">
            <span><i className="swatch" style={{ background: '#d9a441' }} /> yours (outlined)</span>
            <span><i className="swatch" style={{ background: '#6f9bd1' }} /> another player</span>
            <span><i className="swatch" style={{ background: '#3d4756' }} /> unowned</span>
            <span><i className="swatch" style={{ background: 'transparent', border: '2px solid #e05656', borderRadius: '50%' }} /> under threat</span>
            <span>&times; ruined</span>
          </div>

          {hover && <HoverCard id={hover} map={map!} threatened={threatened.has(hover)} />}

          {movements.length > 0 && (
            <>
              <h2>Your movements</h2>
              <div className="row wrap" style={{ gap: 6 }}>
                {movements.map((m) => (
                  <Pill key={m.id}>{m.mission} &rarr; {settlements.find((s) => s.id === m.targetId)?.name ?? 'unknown'}</Pill>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function HoverCard({ id, map, threatened }: { id: string; map: MapResponse; threatened: boolean }): JSX.Element | null {
  const s = map.settlements.find((x) => x.id === id);
  if (!s) return null;
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row wrap">
        <h3 style={{ margin: 0 }}>{s.name}</h3>
        <span className="spacer" />
        {s.mine && <Pill tone="ok">yours</Pill>}
        {!s.mine && s.ownerId && <Pill>another player</Pill>}
        {!s.ownerId && <Pill>unowned</Pill>}
        {threatened && <Pill tone="danger">hostile inbound</Pill>}
      </div>
      <p className="faint" style={{ margin: '8px 0 0', fontSize: 12 }}>
        {s.holdingType.replace(/_/g, ' ')} &middot; {s.layer} &middot; integrity {s.integrity}
        {' '}&middot; click to open
      </p>
    </div>
  );
}
