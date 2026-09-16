/**
 * settlement/TierStrip.tsx — what a building looks like as it grows
 *
 * Twelve authored tiers is a real mechanic, not a cosmetic one: a player
 * deciding whether to push a Granary from 96 to 97 is buying a visible
 * rebuild, and they should be able to see what they are buying. So this is a
 * player-facing reference, drawn by the SAME code that draws the settlement —
 * not an illustration of it.
 *
 * It doubles as the honest way to check the silhouette rules. If tier 5 does
 * not visibly grow a tower here, it does not in the game either.
 */

import { useEffect, useRef } from 'react';
import { VISUAL_TIERS } from '@ascendance/shared';
import { drawBuildingFor, visualHeightAt } from './SettlementCanvas.js';

export function TierStrip({ category = 'Extraction', era = 1, buildingKey = '1_granary' }: {
  category?: string;
  era?: number;
  buildingKey?: string;
}): JSX.Element {
  return (
    <div className="card flush">
      <div className="tier-strip">
        {[...VISUAL_TIERS].sort((a, b) => a.tier - b.tier).map((t) => (
          <figure key={t.tier} className="tier-cell">
            <TierSwatch
              level={t.tier === 0 ? 0 : t.minLevel}
              category={category}
              era={era}
              buildingKey={buildingKey}
            />
            <figcaption>
              <b>Tier {t.tier}</b>
              <span className="faint"> · {t.minLevel === t.maxLevel ? `level ${t.minLevel}` : `${t.minLevel}–${t.maxLevel}`}</span>
              <div className="tier-read">&ldquo;{t.read}&rdquo;</div>
              <div className="faint tier-sil">{t.silhouette}</div>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function TierSwatch({ level, category, era, buildingKey }: {
  level: number; category: string; era: number; buildingKey: string;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /*
     * Fit the swatch to its own tier.
     *
     * A fixed scale clipped the top off every tier from 8 up — exactly the
     * tiers whose whole point is that they tower — so the reference showed
     * least where it mattered most. `visualHeightAt` reports how tall this
     * tier draws, including its spire and floating elements, and the scale is
     * solved backwards from the cell.
     */
    const need = visualHeightAt(level, buildingKey);
    const fit = (h * 0.82) / Math.max(1, need);

    drawBuildingFor(ctx, {
      x: w / 2, y: h * 0.90, scale: Math.min(0.62, fit),
      building: {
        id: `swatch-${level}`, key: buildingKey, name: 'Sample',
        category, level, damage: 0, staffedPct: 100, era,
      },
      grade: 1, maxGrade: 42, frame: 0, emphasised: false, span: 1,
    });
  }, [buildingKey, category, era, level]);

  return <canvas ref={ref} className="tier-swatch" aria-hidden="true" />;
}
