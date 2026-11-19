import { useState } from 'react';

/**
 * A small map drawn from raster tiles, with no map library (D83): the pro's position and the customer's home
 * as markers. Tiles come from OpenStreetMap unless VITE_MAP_TILE_URL names another server. The markers are
 * placed by the same arithmetic as the tiles, so they stay right when a tile fails to load.
 */

export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE = 256;
/** Tiles are decoration: the map's label says where the pro and the home are. */
const DECORATIVE = '';
const MIN_ZOOM = 3;
const MAX_ZOOM = 17;
/** Zoom when only one point is known: a few streets around it. */
const SINGLE_POINT_ZOOM = 15;
/** The map is drawn for a box this size around its centre; the page shows what fits. */
export const MAP_WIDTH = 480;
export const MAP_HEIGHT = 200;
/** The narrowest map a phone shows: the markers must fit in it. */
const FIT_WIDTH = 320;
/** Room kept free around the markers, in pixels. */
const PADDING = 44;

export interface LatLng {
  lat: number;
  lng: number;
}

/** The tile URL template: VITE_MAP_TILE_URL when it is an http(s) URL with {z}, {x} and {y}, else OpenStreetMap. */
export function tileUrlTemplate(configured: string | undefined = import.meta.env.VITE_MAP_TILE_URL): string {
  const value = configured?.trim();
  if (value && /^https?:\/\//.test(value) && ['{z}', '{x}', '{y}'].every((part) => value.includes(part))) {
    return value;
  }
  return DEFAULT_TILE_URL;
}

/** A point in "world pixels" at a zoom level: the slippy-map tile coordinates times 256. */
export function worldPixel(point: LatLng, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  // Web Mercator stops at about ±85°.
  const lat = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** The closest zoom at which all points fit in the box with some room around them. */
export function fitZoom(points: LatLng[], width = FIT_WIDTH, height = MAP_HEIGHT): number {
  if (points.length < 2) return SINGLE_POINT_ZOOM;
  for (let zoom = MAX_ZOOM; zoom > MIN_ZOOM; zoom -= 1) {
    const pixels = points.map((p) => worldPixel(p, zoom));
    const xs = pixels.map((p) => p.x);
    const ys = pixels.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) <= width - 2 * PADDING && Math.max(...ys) - Math.min(...ys) <= height - 2 * PADDING) {
      return zoom;
    }
  }
  return MIN_ZOOM;
}

export interface Tile {
  key: string;
  url: string;
  /** Offset of the tile's top-left corner from the map's centre, in pixels. */
  left: number;
  top: number;
}

/** The tiles that cover the box around a centre (in world pixels) at a zoom level. */
export function tilesAround(center: { x: number; y: number }, zoom: number, template: string): Tile[] {
  const count = 2 ** zoom;
  const fromX = Math.floor((center.x - MAP_WIDTH / 2) / TILE);
  const toX = Math.floor((center.x + MAP_WIDTH / 2) / TILE);
  const fromY = Math.max(0, Math.floor((center.y - MAP_HEIGHT / 2) / TILE));
  const toY = Math.min(count - 1, Math.floor((center.y + MAP_HEIGHT / 2) / TILE));
  const tiles: Tile[] = [];
  for (let ty = fromY; ty <= toY; ty += 1) {
    for (let tx = fromX; tx <= toX; tx += 1) {
      // The world repeats east and west.
      const wrapped = ((tx % count) + count) % count;
      tiles.push({
        key: `${zoom}/${tx}/${ty}`,
        url: template.replace('{z}', String(zoom)).replace('{x}', String(wrapped)).replace('{y}', String(ty)),
        left: tx * TILE - center.x,
        top: ty * TILE - center.y,
      });
    }
  }
  return tiles;
}

export function LiveMap({
  pro,
  home,
  label,
  proLabel,
  homeLabel,
  proInitial,
  attribution,
}: {
  pro: LatLng | null;
  home: LatLng;
  /** Describes the map for screen readers, e.g. where the pro is. */
  label: string;
  proLabel: string;
  homeLabel: string;
  proInitial: string;
  attribution: string;
}) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const points = pro ? [pro, home] : [home];
  const zoom = fitZoom(points);
  const pixels = points.map((p) => worldPixel(p, zoom));
  const center = {
    x: pixels.reduce((sum, p) => sum + p.x, 0) / pixels.length,
    y: pixels.reduce((sum, p) => sum + p.y, 0) / pixels.length,
  };
  const tiles = tilesAround(center, zoom, tileUrlTemplate());
  const homePixel = worldPixel(home, zoom);
  const proPixel = pro ? worldPixel(pro, zoom) : null;
  const at = (p: { x: number; y: number }) => ({ left: `calc(50% + ${p.x - center.x}px)`, top: `calc(50% + ${p.y - center.y}px)` });

  return (
    <figure className="map live-map">
      <div className="live-map-tiles" role="img" aria-label={label} data-zoom={zoom}>
        {tiles.map((tile) => (
          <img
            key={tile.key}
            className={`live-tile ${failed.has(tile.key) ? 'failed' : ''}`}
            src={tile.url}
            alt={DECORATIVE}
            width={TILE}
            height={TILE}
            draggable={false}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            style={{ left: `calc(50% + ${tile.left}px)`, top: `calc(50% + ${tile.top}px)` }}
            onError={() => setFailed((current) => new Set(current).add(tile.key))}
          />
        ))}
        <span className="live-marker home" style={at(homePixel)} title={homeLabel} data-testid="home-marker" />
        {proPixel && (
          <span className="live-marker pro" style={at(proPixel)} title={proLabel} data-testid="pro-marker">
            {proInitial}
          </span>
        )}
      </div>
      <figcaption className="live-map-attribution">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          {attribution}
        </a>
      </figcaption>
    </figure>
  );
}
