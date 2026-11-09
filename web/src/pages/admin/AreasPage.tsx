import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { Zone } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { useSave } from './settings/SaveStatus';

interface ZonesResponse {
  zones: Zone[];
  elsewhere: { postcode: string; waiting: number }[];
}

const MAP_WIDTH = 600;
const MAP_HEIGHT = 340;
const MAP_PADDING = 40;

/**
 * Zones drawn at their centre points, green when live and yellow on the waitlist. A plain drawing rather
 * than map tiles: no outside map service is needed and nothing about customers leaves MISK.
 */
function ZoneMap({ zones }: { zones: Zone[] }) {
  const { t } = useTranslation();
  if (zones.length === 0) {
    return null;
  }
  const lats = zones.map((z) => z.lat);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  // Longitude degrees shrink towards the poles; scale them so the map is not stretched.
  const xs = zones.map((z) => z.lng * Math.cos((midLat * Math.PI) / 180));
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 0.01);
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 0.01);
  const scale = Math.min((MAP_WIDTH - 2 * MAP_PADDING) / spanX, (MAP_HEIGHT - 2 * MAP_PADDING) / spanY);
  const minX = Math.min(...xs);
  const maxLat = Math.max(...lats);
  const offsetX = (MAP_WIDTH - spanX * scale) / 2;
  const offsetY = (MAP_HEIGHT - spanY * scale) / 2;

  return (
    <figure className="zone-map">
      <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label={t('admin.settings.area.mapLabel')}>
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} rx="14" className="map-bg" />
        {zones.map((zone, index) => {
          const x = offsetX + ((xs[index] ?? 0) - minX) * scale;
          const y = offsetY + (maxLat - zone.lat) * scale;
          return (
            <g key={zone.code} className={zone.live ? 'zone live' : 'zone waiting'}>
              <circle cx={x} cy={y} r={zone.live ? 22 : 18} />
              <text x={x} y={y + 4} textAnchor="middle">
                {zone.code}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="row gap8 small">
        <span className="legend live" aria-hidden="true" /> {t('admin.settings.area.legendLive')}
        <span className="legend waiting" aria-hidden="true" /> {t('admin.settings.area.legendWaitlist')}
      </figcaption>
    </figure>
  );
}

function ZoneRow({ zone, onChanged }: { zone: Zone; onChanged: (notice: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const [confirm, setConfirm] = useState(false);

  async function goLive() {
    const result = await track(() => api.post<{ notified: number }>(`/admin/zones/${encodeURIComponent(zone.code)}/go-live`));
    if (result) onChanged(t('admin.settings.area.wentLive', { code: zone.code, count: result.notified }));
  }

  async function pause() {
    const result = await track(() => api.post(`/admin/zones/${encodeURIComponent(zone.code)}/pause`));
    setConfirm(false);
    if (result) onChanged(t('admin.settings.area.paused', { code: zone.code }));
  }

  return (
    <li className={`zone-row ${zone.live ? 'live' : 'waiting'}`}>
      <div className="row between wrap gap8">
        <div>
          <span className="b">
            {zone.code} · {zone.name}
          </span>{' '}
          <span className={`badge ${zone.live ? 'g' : 'a'}`}>
            {zone.live ? t('admin.settings.area.live') : t('admin.settings.area.waitlist')}
          </span>
          <div className="small muted">
            {zone.live
              ? t('admin.settings.area.liveStats', { pros: zone.pros, bookings: zone.bookingsPerWeek })
              : t('admin.settings.area.waitStats', { waiting: zone.waiting, pros: zone.pros })}
          </div>
        </div>
        {zone.live ? (
          !confirm && (
            <button
              type="button"
              className="abtn ghost"
              aria-label={t('admin.settings.area.pauseLabel', { code: zone.code })}
              onClick={() => setConfirm(true)}
            >
              {t('admin.settings.area.pause')}
            </button>
          )
        ) : (
          <button
            type="button"
            className="abtn"
            aria-label={t('admin.settings.area.goLiveLabel', { code: zone.code })}
            onClick={() => void goLive()}
          >
            {t('admin.settings.area.goLive')}
          </button>
        )}
      </div>
      {confirm && (
        <div role="alertdialog" aria-labelledby={`pause-${zone.code}`} className="confirm stack">
          <p id={`pause-${zone.code}`}>{t('admin.settings.area.pauseConfirm', { code: zone.code })}</p>
          <div className="row gap8">
            <button type="button" className="abtn ghost" onClick={() => setConfirm(false)}>
              {t('admin.settings.area.keep')}
            </button>
            <button type="button" className="abtn danger" onClick={() => void pause()}>
              {t('admin.settings.area.pauseYes')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AddZone({ onAdded }: { onAdded: (notice: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [invalid, setInvalid] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const latitude = Number(lat.replace(',', '.'));
    const longitude = Number(lng.replace(',', '.'));
    const ok =
      /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(code.trim()) &&
      name.trim() !== '' &&
      lat.trim() !== '' &&
      lng.trim() !== '' &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180;
    setInvalid(!ok);
    if (!ok) return;
    const result = await track(() =>
      api.put<{ zone: Zone }>(`/admin/zones/${encodeURIComponent(code.trim())}`, { name: name.trim(), lat: latitude, lng: longitude }),
    );
    if (result) {
      setCode('');
      setName('');
      setLat('');
      setLng('');
      onAdded(t('admin.settings.area.added', { code: result.zone.code }));
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} noValidate aria-labelledby="add-zone-heading">
      <h2 id="add-zone-heading">{t('admin.settings.area.add')}</h2>
      <p className="small muted">{t('admin.settings.area.addHint')}</p>
      <div className="row gap8 wrap filters">
        <div className="af">
          <label htmlFor="zone-code">{t('admin.settings.area.code')}</label>
          <input id="zone-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="af grow">
          <label htmlFor="zone-name">{t('admin.settings.area.name')}</label>
          <input id="zone-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="zone-lat">{t('admin.settings.area.lat')}</label>
          <input id="zone-lat" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="zone-lng">{t('admin.settings.area.lng')}</label>
          <input id="zone-lng" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
        </div>
        <button type="submit" className="abtn">
          {t('admin.settings.area.addButton')}
        </button>
      </div>
      {invalid && (
        <p className="error-text" role="alert">
          {t('admin.settings.area.invalid')}
        </p>
      )}
    </form>
  );
}

/** Settings → Service area. */
export function AreasPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<ZonesResponse>('/admin/zones'), [api]);
  const { state, reload } = useResource(load);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (message: string) => {
    setNotice(message);
    reload();
  };

  return (
    <div className="stack">
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      <ResourceState state={state} reload={reload}>
        {({ zones, elsewhere }) => (
          <>
            <section className="panel stack" aria-labelledby="zones-heading">
              <h2 id="zones-heading">{t('admin.settings.area.zones')}</h2>
              <ZoneMap zones={zones} />
              {zones.length === 0 ? (
                <p className="muted">{t('admin.settings.area.none')}</p>
              ) : (
                <ul className="zone-list">
                  {zones.map((zone) => (
                    <ZoneRow key={zone.code} zone={zone} onChanged={changed} />
                  ))}
                </ul>
              )}
            </section>
            {elsewhere.length > 0 && (
              <section className="panel stack" aria-labelledby="elsewhere-heading">
                <h2 id="elsewhere-heading">{t('admin.settings.area.elsewhere')}</h2>
                <ul className="history">
                  {elsewhere.map((row) => (
                    <li key={row.postcode}>{t('admin.settings.area.elsewhereLine', { postcode: row.postcode, count: row.waiting })}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </ResourceState>
      <AddZone onAdded={changed} />
    </div>
  );
}
