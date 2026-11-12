import { useCallback, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { Zone } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { useSave } from './settings/SaveStatus';
import { parseCoordinate, splitPair, zoneProblems, type ZoneField, type ZoneInput, type ZoneProblem } from './settings/zoneForm';

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

function AddZone({ zones, onAdded }: { zones: Zone[]; onAdded: (notice: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const [values, setValues] = useState<ZoneInput>({ code: '', name: '', lat: '', lng: '' });
  const [shown, setShown] = useState(false);
  const problems = zoneProblems(values, zones);
  const problemOf = (field: ZoneField) => problems.find((p) => p.field === field);

  const message = (problem: ZoneProblem) =>
    problem.key === 'tooFar'
      ? t('admin.settings.area.errors.tooFar', { km: problem.km, code: problem.nearest })
      : t(`admin.settings.area.errors.${problem.key}`);

  const set = (field: ZoneField, value: string) => setValues((current) => ({ ...current, [field]: value }));

  // A map copies "52.5200, 13.4050" as one text; pasted into either field it fills both.
  function pasteCoordinates(event: ClipboardEvent<HTMLInputElement>) {
    const pair = splitPair(event.clipboardData.getData('text'));
    if (!pair) return;
    event.preventDefault();
    setValues((current) => ({ ...current, ...pair }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    const first = problems[0];
    if (first) {
      // The cursor goes to the first field to fix (D42).
      document.getElementById(`zone-${first.field}`)?.focus();
      return;
    }
    const lat = parseCoordinate(values.lat);
    const lng = parseCoordinate(values.lng);
    if (lat === null || lng === null) return;
    const code = values.code.trim();
    const result = await track(() => api.put<{ zone: Zone }>(`/admin/zones/${encodeURIComponent(code)}`, { name: values.name.trim(), lat, lng }));
    if (result) {
      setValues({ code: '', name: '', lat: '', lng: '' });
      setShown(false);
      onAdded(t('admin.settings.area.added', { code: result.zone.code }));
    }
  }

  const field = (id: ZoneField, input: (invalid: boolean, describedBy: string | undefined) => ReactNode, grow = false) => {
    const problem = shown ? problemOf(id) : undefined;
    return (
      <div className={grow ? 'af grow' : 'af'}>
        <label htmlFor={`zone-${id}`}>{t(`admin.settings.area.${id}`)}</label>
        {input(Boolean(problem), problem ? `zone-${id}-error` : undefined)}
        {problem && (
          <span id={`zone-${id}-error`} className="error-text small" role="alert">
            {message(problem)}
          </span>
        )}
      </div>
    );
  };

  const coordinate = (id: 'lat' | 'lng', placeholder: string) =>
    field(id, (invalid, describedBy) => (
      <input
        id={`zone-${id}`}
        inputMode="decimal"
        autoComplete="off"
        maxLength={20}
        placeholder={placeholder}
        value={values[id]}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onPaste={pasteCoordinates}
        onChange={(e) => set(id, e.target.value)}
      />
    ));

  return (
    <form className="panel stack" onSubmit={submit} noValidate aria-labelledby="add-zone-heading">
      <h2 id="add-zone-heading">{t('admin.settings.area.add')}</h2>
      <p className="small muted">{t('admin.settings.area.addHint')}</p>
      <div className="row gap8 wrap filters zone-form">
        {field('code', (invalid, describedBy) => (
          <input
            id="zone-code"
            maxLength={10}
            value={values.code}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => set('code', e.target.value)}
          />
        ))}
        {field(
          'name',
          (invalid, describedBy) => (
            <input
              id="zone-name"
              maxLength={80}
              value={values.name}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => set('name', e.target.value)}
            />
          ),
          true,
        )}
        {coordinate('lat', '52.5200')}
        {coordinate('lng', '13.4050')}
        <button type="submit" className="abtn">
          {t('admin.settings.area.addButton')}
        </button>
      </div>
      <p className="small muted">{t('admin.settings.area.coordsHint')}</p>
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
      <AddZone zones={state.status === 'ready' ? state.data.zones : []} onAdded={changed} />
    </div>
  );
}
