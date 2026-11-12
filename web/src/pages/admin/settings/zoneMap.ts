/**
 * Where to draw each zone on the Service area map. Zones are placed at their centre points, then pushed
 * apart just enough that no two circles overlap, so neighbouring postcodes in a dense city stay readable.
 * The map is a sketch of where zones are, not a survey.
 */

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapBox {
  width: number;
  height: number;
  padding: number;
}

const GAP = 3;
const ROUNDS = 120;

/** Projects latitude/longitude into the box, keeping the shape (longitude shrinks towards the poles). */
export function project(coords: { lat: number; lng: number }[], box: MapBox): MapPoint[] {
  if (coords.length === 0) return [];
  const lats = coords.map((c) => c.lat);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const xs = coords.map((c) => c.lng * Math.cos((midLat * Math.PI) / 180));
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 0.01);
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 0.01);
  const scale = Math.min((box.width - 2 * box.padding) / spanX, (box.height - 2 * box.padding) / spanY);
  const minX = Math.min(...xs);
  const maxLat = Math.max(...lats);
  const offsetX = (box.width - spanX * scale) / 2;
  const offsetY = (box.height - spanY * scale) / 2;
  return coords.map((c, i) => ({ x: offsetX + ((xs[i] ?? 0) - minX) * scale, y: offsetY + (maxLat - c.lat) * scale }));
}

/** Moves overlapping circles of `radius` apart, a little at a time, and keeps them inside the box. */
export function separate(points: MapPoint[], radius: number, box: MapBox): MapPoint[] {
  const placed = points.map((p) => ({ ...p }));
  const min = 2 * radius + GAP;
  const clamp = (v: number, size: number) => Math.min(size - radius - 2, Math.max(radius + 2, v));
  for (let round = 0; round < ROUNDS; round += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.01) {
          // Same point: split them sideways, in a direction that depends on the pair so it is stable.
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = (min - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
        moved = true;
      }
    }
    for (const p of placed) {
      p.x = clamp(p.x, box.width);
      p.y = clamp(p.y, box.height);
    }
    if (!moved) break;
  }
  return placed;
}
