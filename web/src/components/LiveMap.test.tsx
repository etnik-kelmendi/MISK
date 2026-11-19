import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_TILE_URL, fitZoom, LiveMap, tilesAround, tileUrlTemplate, worldPixel } from './LiveMap';

const HOME = { lat: 52.5323, lng: 13.3846 };
const PRO = { lat: 52.52, lng: 13.39 };
const LABEL = 'Map: Daniel is about 1.4 km from your home';
const ATTRIBUTION = '© OpenStreetMap contributors';

describe('live map tiles (D83)', () => {
  it('works out slippy-map world pixels', () => {
    expect(worldPixel({ lat: 0, lng: 0 }, 0)).toEqual({ x: 128, y: 128 });
    const berlin = worldPixel(HOME, 15);
    // Tile 17602/10744 at zoom 15 holds Berlin-Mitte.
    expect(Math.floor(berlin.x / 256)).toBe(17602);
    expect(Math.floor(berlin.y / 256)).toBe(10744);
  });

  it('zooms in as far as both points still fit, and further with one point', () => {
    const near = fitZoom([PRO, HOME]);
    const far = fitZoom([{ lat: 52.418, lng: 13.26 }, HOME]);
    expect(near).toBeGreaterThan(far);
    expect(fitZoom([HOME])).toBe(15);
  });

  it('uses OpenStreetMap unless another tile server is configured properly', () => {
    expect(tileUrlTemplate(undefined)).toBe(DEFAULT_TILE_URL);
    expect(tileUrlTemplate('ftp://tiles.example.com/{z}/{x}/{y}.png')).toBe(DEFAULT_TILE_URL);
    expect(tileUrlTemplate('https://tiles.example.com/{z}/{x}.png')).toBe(DEFAULT_TILE_URL);
    expect(tileUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
    const tiles = tilesAround(worldPixel(HOME, 15), 15, DEFAULT_TILE_URL);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles[0]?.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
  });

  it('shows both markers with a description and the attribution, and keeps them in place when tiles fail', () => {
    const { container } = render(
      <LiveMap pro={PRO} home={HOME} label={LABEL} proLabel="Daniel" homeLabel="Your home" proInitial="D" attribution={ATTRIBUTION} />,
    );
    expect(screen.getByRole('img', { name: LABEL })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: ATTRIBUTION })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    const pro = screen.getByTestId('pro-marker');
    const home = screen.getByTestId('home-marker');
    const before = [pro.style.left, pro.style.top, home.style.left, home.style.top];
    // The pro is south of the home.
    expect(before[1]).not.toBe(before[3]);
    const tiles = Array.from(container.querySelectorAll('img.live-tile'));
    expect(tiles.length).toBeGreaterThan(0);
    tiles.forEach((tile) => fireEvent.error(tile));
    expect(container.querySelectorAll('img.live-tile.failed')).toHaveLength(tiles.length);
    expect([pro.style.left, pro.style.top, home.style.left, home.style.top]).toEqual(before);
  });

  it('shows only the home before the position is known', () => {
    render(<LiveMap pro={null} home={HOME} label={LABEL} proLabel="Daniel" homeLabel="Your home" proInitial="D" attribution={ATTRIBUTION} />);
    expect(screen.getByTestId('home-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-marker')).not.toBeInTheDocument();
  });
});
