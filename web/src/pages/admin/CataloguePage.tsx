import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { AdminCategory, IconName, Service } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { euro, parseEuroToCents } from '../../lib/format';
import { useAction } from '../../lib/useAction';

const ICONS: IconName[] = ['leaf', 'hammer', 'drop', 'bolt', 'sparkle', 'brush', 'wrench', 'sun'];

interface ServiceDraft {
  name: string;
  description: string;
  price: string;
  durationMinutes: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
  active: boolean;
}

const emptyService: ServiceDraft = {
  name: '',
  description: '',
  price: '',
  durationMinutes: 60,
  sizeSmallPct: 100,
  sizeMediumPct: 130,
  sizeLargePct: 170,
  active: true,
};

function ServiceForm({
  categoryId,
  service,
  onSaved,
  onCancel,
}: {
  categoryId: string;
  service: Service | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const [draft, setDraft] = useState<ServiceDraft>(
    service
      ? {
          name: service.name,
          description: service.description,
          price: (service.priceCents / 100).toFixed(2),
          durationMinutes: service.durationMinutes,
          sizeSmallPct: service.sizeSmallPct,
          sizeMediumPct: service.sizeMediumPct,
          sizeLargePct: service.sizeLargePct,
          active: service.active,
        }
      : emptyService,
  );
  const priceCents = parseEuroToCents(draft.price);
  const prefix = service?.id ?? `new-${categoryId}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (priceCents === null) {
      return;
    }
    const body = {
      name: draft.name,
      description: draft.description,
      priceCents,
      durationMinutes: draft.durationMinutes,
      sizeSmallPct: draft.sizeSmallPct,
      sizeMediumPct: draft.sizeMediumPct,
      sizeLargePct: draft.sizeLargePct,
      active: draft.active,
    };
    const saved = await run(() =>
      service ? api.patch(`/admin/services/${service.id}`, body) : api.post('/admin/services', { ...body, categoryId }),
    );
    if (saved) {
      onSaved();
    }
  }

  const number = (key: 'durationMinutes' | 'sizeSmallPct' | 'sizeMediumPct' | 'sizeLargePct', min: number, max: number, step = 1) => (
    <div className="af">
      <label htmlFor={`${prefix}-${key}`}>{t(`admin.catalogue.fields.${key}`)}</label>
      <input
        id={`${prefix}-${key}`}
        type="number"
        min={min}
        max={max}
        step={step}
        required
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
      />
    </div>
  );

  return (
    <form className="fgrid service-form" onSubmit={submit}>
      <div className="af">
        <label htmlFor={`${prefix}-name`}>{t('admin.catalogue.fields.name')}</label>
        <input id={`${prefix}-name`} required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <div className="af">
        <label htmlFor={`${prefix}-price`}>{t('admin.catalogue.fields.price')}</label>
        <input id={`${prefix}-price`} inputMode="decimal" required value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
        {draft.price && priceCents === null && <span className="error-text">{t('job.extraPriceInvalid')}</span>}
      </div>
      <div className="af full">
        <label htmlFor={`${prefix}-description`}>{t('admin.catalogue.fields.description')}</label>
        <input
          id={`${prefix}-description`}
          maxLength={300}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>
      {number('durationMinutes', 15, 600, 15)}
      {number('sizeSmallPct', 50, 500)}
      {number('sizeMediumPct', 50, 500)}
      {number('sizeLargePct', 50, 500)}
      <label className="row gap8 small">
        <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
        {t('admin.catalogue.fields.active')}
      </label>
      <div className="row gap8 full">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="abtn" disabled={busy || priceCents === null}>
          {t('common.save')}
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function CategoryForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [icon, setIcon] = useState<IconName>('leaf');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(() => api.post('/admin/categories', { name, slug, icon }));
    if (saved) {
      setName('');
      setSlug('');
      onSaved();
    }
  }

  return (
    <form className="panel fgrid" onSubmit={submit} aria-labelledby="new-category">
      <h2 id="new-category" className="full">
        {t('admin.catalogue.newCategory')}
      </h2>
      <div className="af">
        <label htmlFor="cat-name">{t('admin.catalogue.fields.name')}</label>
        <input
          id="cat-name"
          required
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSlug(
              e.target.value
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, ''),
            );
          }}
        />
      </div>
      <div className="af">
        <label htmlFor="cat-slug">{t('admin.catalogue.fields.slug')}</label>
        <input id="cat-slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={40} value={slug} onChange={(e) => setSlug(e.target.value)} />
      </div>
      <fieldset className="af full">
        <legend>{t('admin.catalogue.fields.icon')}</legend>
        <div className="row gap8 wrap">
          {ICONS.map((option) => (
            <label key={option} className={`icon-pick ${icon === option ? 'on' : ''}`}>
              <input type="radio" name="icon" className="visually-hidden" checked={icon === option} onChange={() => setIcon(option)} />
              <Icon name={option} label={t(`admin.catalogue.icons.${option}`)} />
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="abtn" disabled={busy}>
        {t('admin.catalogue.addCategory')}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

export function CataloguePage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ categories: AdminCategory[]; services: Service[] }>('/admin/catalogue'), [api]);
  const { state, reload } = useResource(load);
  const [editing, setEditing] = useState<string | null>(null);
  const toggle = useAction();

  return (
    <>
      <h1>{t('admin.catalogue.title')}</h1>
      <p className="muted small">{t('admin.catalogue.intro')}</p>
      <ResourceState state={state} reload={reload}>
        {({ categories, services }) => (
          <div className="stack">
            {categories.map((category) => (
              <section key={category.id} className="panel" aria-labelledby={`cat-${category.id}`}>
                <div className="row between">
                  <h2 id={`cat-${category.id}`} className="row gap8">
                    <Icon name={category.icon} /> {category.name}
                    {!category.active && <span className="badge grey">{t('admin.catalogue.hidden')}</span>}
                  </h2>
                  <button
                    type="button"
                    className="abtn ghost"
                    disabled={toggle.busy}
                    onClick={() => void toggle.run(() => api.patch(`/admin/categories/${category.id}`, { active: !category.active })).then(reload)}
                  >
                    {category.active ? t('admin.catalogue.hide') : t('admin.catalogue.show')}
                  </button>
                </div>
                <ul className="history">
                  {services
                    .filter((s) => s.categoryId === category.id)
                    .map((service) => (
                      <li key={service.id}>
                        {editing === service.id ? (
                          <ServiceForm
                            categoryId={category.id}
                            service={service}
                            onCancel={() => setEditing(null)}
                            onSaved={() => {
                              setEditing(null);
                              reload();
                            }}
                          />
                        ) : (
                          <div className="row between">
                            <span>
                              <span className="b">{service.name}</span>{' '}
                              <span className="small muted">
                                {t('admin.catalogue.serviceLine', { price: euro(service.priceCents), minutes: service.durationMinutes })}
                              </span>
                              {!service.active && <span className="badge grey">{t('admin.catalogue.hidden')}</span>}
                            </span>
                            <button type="button" className="abtn ghost" onClick={() => setEditing(service.id)}>
                              {t('common.edit')}
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
                {editing === `new-${category.id}` ? (
                  <ServiceForm
                    categoryId={category.id}
                    service={null}
                    onCancel={() => setEditing(null)}
                    onSaved={() => {
                      setEditing(null);
                      reload();
                    }}
                  />
                ) : (
                  <button type="button" className="abtn ghost" onClick={() => setEditing(`new-${category.id}`)}>
                    <Icon name="plus" /> {t('admin.catalogue.addService')}
                  </button>
                )}
              </section>
            ))}
            <ErrorText error={toggle.error} />
            <CategoryForm onSaved={reload} />
          </div>
        )}
      </ResourceState>
    </>
  );
}
