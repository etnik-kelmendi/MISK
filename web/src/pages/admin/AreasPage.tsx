import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { AdminPostcode } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';

const empty = { code: '', name: '', lat: '', lng: '' };

export function AreasPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ postcodes: AdminPostcode[] }>('/admin/postcodes'), [api]);
  const { state, reload } = useResource(load);
  const save = useAction();
  const [draft, setDraft] = useState(empty);

  async function put(postcode: { code: string; name: string; lat: number; lng: number; active: boolean }) {
    const { code, ...body } = postcode;
    const result = await save.run(() => api.put(`/admin/postcodes/${encodeURIComponent(code)}`, body));
    if (result) {
      reload();
    }
    return result;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await put({ code: draft.code, name: draft.name, lat: Number(draft.lat), lng: Number(draft.lng), active: true });
    if (result) {
      setDraft(empty);
    }
  }

  return (
    <>
      <h2 className="section-title">{t('admin.areas.title')}</h2>
      <p className="muted small">{t('admin.areas.intro')}</p>
      <form className="panel fgrid" onSubmit={submit} aria-labelledby="add-area">
        <h2 id="add-area" className="full">
          {t('admin.areas.add')}
        </h2>
        <div className="af">
          <label htmlFor="area-code">{t('admin.areas.code')}</label>
          <input
            id="area-code"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9 \-]{1,9}"
            maxLength={10}
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
        </div>
        <div className="af">
          <label htmlFor="area-name">{t('admin.areas.name')}</label>
          <input id="area-name" required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="af">
          <label htmlFor="area-lat">{t('admin.areas.lat')}</label>
          <input
            id="area-lat"
            type="number"
            step="any"
            min={-90}
            max={90}
            required
            value={draft.lat}
            onChange={(e) => setDraft({ ...draft, lat: e.target.value })}
          />
        </div>
        <div className="af">
          <label htmlFor="area-lng">{t('admin.areas.lng')}</label>
          <input
            id="area-lng"
            type="number"
            step="any"
            min={-180}
            max={180}
            required
            value={draft.lng}
            onChange={(e) => setDraft({ ...draft, lng: e.target.value })}
          />
        </div>
        <span className="hint full">{t('admin.areas.coordsHint')}</span>
        <button type="submit" className="abtn" disabled={save.busy}>
          {t('admin.areas.save')}
        </button>
        <ErrorText error={save.error} />
      </form>
      <ResourceState state={state} reload={reload}>
        {({ postcodes }) =>
          postcodes.length === 0 ? (
            <p className="panel muted">{t('admin.areas.none')}</p>
          ) : (
            <div className="panel scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.areas.code')}</th>
                    <th scope="col">{t('admin.areas.name')}</th>
                    <th scope="col">{t('admin.areas.centre')}</th>
                    <th scope="col">{t('admin.areas.served')}</th>
                  </tr>
                </thead>
                <tbody>
                  {postcodes.map((p) => (
                    <tr key={p.code}>
                      <td className="b">{p.code}</td>
                      <td>{p.name}</td>
                      <td className="small muted">
                        {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                      </td>
                      <td>
                        <label className="row gap8 small">
                          <input type="checkbox" checked={p.active} disabled={save.busy} onChange={() => void put({ ...p, active: !p.active })} />
                          {p.active ? t('admin.areas.yes') : t('admin.areas.no')}
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceState>
    </>
  );
}
