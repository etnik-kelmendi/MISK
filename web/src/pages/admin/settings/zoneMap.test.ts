import { project, separate } from './zoneMap';

const box = { width: 360, height: 260, padding: 40 };
const overlaps = (points: { x: number; y: number }[], radius: number) =>
  points.some((a, i) => points.slice(i + 1).some((b) => Math.hypot(a.x - b.x, a.y - b.y) < 2 * radius));

describe('project', () => {
  it('keeps north up and east right, inside the padding', () => {
    const points = project(
      [
        { lat: 52.6, lng: 13.4 },
        { lat: 52.4, lng: 13.4 },
        { lat: 52.5, lng: 13.6 },
      ],
      box,
    );
    const [north, south, east] = points.map((p) => p.y);
    const [northX, , eastX] = points.map((p) => p.x);
    expect(north).toBeLessThan(south ?? 0);
    expect(eastX).toBeGreaterThan(northX ?? Infinity);
    expect(east).toBeDefined();
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(box.padding - 0.001);
      expect(p.y).toBeLessThanOrEqual(box.height - box.padding + 0.001);
    }
  });

  it('draws nothing for no zones', () => {
    expect(project([], box)).toEqual([]);
  });
});

describe('separate', () => {
  it('pushes a dense cluster apart so no circles overlap, and keeps them in the box', () => {
    // Central Berlin postcodes and one far away, as in the demo data.
    const coords = [
      { lat: 52.5323, lng: 13.3846 },
      { lat: 52.517, lng: 13.3889 },
      { lat: 52.5403, lng: 13.4219 },
      { lat: 52.5308, lng: 13.3519 },
      { lat: 52.5087, lng: 13.3622 },
      { lat: 52.4983, lng: 13.4174 },
      { lat: 52.4797, lng: 13.4353 },
      { lat: 52.4833, lng: 13.4437 },
      { lat: 52.546, lng: 13.374 },
      { lat: 52.418, lng: 13.26 },
    ];
    const radius = 16;
    const before = project(coords, box);
    expect(overlaps(before, radius)).toBe(true);
    const after = separate(before, radius, box);
    expect(overlaps(after, radius)).toBe(false);
    for (const p of after) {
      expect(p.x).toBeGreaterThanOrEqual(radius);
      expect(p.x).toBeLessThanOrEqual(box.width - radius);
      expect(p.y).toBeGreaterThanOrEqual(radius);
      expect(p.y).toBeLessThanOrEqual(box.height - radius);
    }
  });

  it('splits two zones at the same point and leaves far-apart zones where they are', () => {
    const same = separate(
      [
        { x: 100, y: 100 },
        { x: 100, y: 100 },
      ],
      16,
      box,
    );
    expect(overlaps(same, 16)).toBe(false);
    const apart = [
      { x: 60, y: 60 },
      { x: 300, y: 200 },
    ];
    expect(separate(apart, 16, box)).toEqual(apart);
  });
});
