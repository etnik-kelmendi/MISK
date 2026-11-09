import { useCallback, useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { AdminCatalogue, AdminCategory, Category, CatalogueChange, IconName, Service } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Drawer } from '../../components/Drawer';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro, parseEuroToCents, proShare, sizePrice } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useMarket } from '../../api/MarketContext';
import { CategoryView } from '../customer/CategoryPage';

const ICONS: IconName[] = ['leaf', 'hammer', 'drop', 'bolt', 'sparkle', 'brush', 'wrench', 'sun'];
const SIZES = ['S', 'M', 'L'] as const;
/** The standard size factors (D8): Small ×1.0, Medium ×1.3, Large ×1.7. */
export const SIZE_FACTORS = { S: 1, M: 1.3, L: 1.7 } as const;
const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 1_000_000;

type Changed = () => void;

function useDuration() {
  const { t } = useTranslation();
  return (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return t('admin.catalogue.minutes', { minutes });
    return rest === 0 ? t('admin.catalogue.hours', { hours }) : t('admin.catalogue.hoursMinutes', { hours, minutes: rest });
  };
}

function validPrice(cents: number | null): cents is number {
  return cents !== null && cents >= MIN_PRICE_CENTS && cents <= MAX_PRICE_CENTS;
}

/**
 * The base price, edited in the table. Size prices and earnings follow while typing; the price is saved
 * when the field is left or Enter is pressed, and Escape puts the saved price back.
 */
function PriceInput({
  service,
  onPreview,
  onSaved,
}: {
  service: Service;
  onPreview: (cents: number | null) => void;
  onSaved: (service: Service) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const errorId = useId();
  const saved = (service.priceCents / 100).toFixed(2);
  const [text, setText] = useState(saved);
  const [invalid, setInvalid] = useState(false);

  async function save() {
    const cents = parseEuroToCents(text);
    if (!validPrice(cents)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (cents === service.priceCents) {
      setText(saved);
      onPreview(null);
      return;
    }
    const result = await action.run(() => api.patch<{ service: Service }>(`/admin/services/${service.id}`, { priceCents: cents }));
    onPreview(null);
    if (result) {
      onSaved(result.service);
    } else {
      setText(saved);
    }
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setText(saved);
      setInvalid(false);
      onPreview(null);
    }
  }

  return (
    <span className="stack tight">
      <span className="price-input">
        <span aria-hidden="true">€</span>
        <input
          inputMode="decimal"
          aria-label={t('admin.catalogue.basePriceLabel', { name: service.name })}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          value={text}
          disabled={action.busy}
          onChange={(event) => {
            setText(event.target.value);
            const cents = parseEuroToCents(event.target.value);
            onPreview(validPrice(cents) ? cents : null);
          }}
          onBlur={() => void save()}
          onKeyDown={onKey}
        />
      </span>
      {invalid && (
        <span id={errorId} className="error-text small" role="alert">
          {t('admin.catalogue.priceInvalid')}
        </span>
      )}
      <ErrorText error={action.error} />
    </span>
  );
}

function ServiceRow({ service, proSharePct, onChanged }: { service: Service; proSharePct: number; onChanged: Changed }) {
  const { t } = useTranslation();
  const api = useApi();
  const toggle = useAction();
  const duration = useDuration();
  const [preview, setPreview] = useState<number | null>(null);
  const [notice, setNotice] = useState(false);
  const priced = { ...service, priceCents: preview ?? service.priceCents };
  const hourly = service.pricing === 'hourly';

  return (
    <tr className={service.active ? undefined : 'faded'}>
      <td>
        <span className="b">{service.name}</span> {service.isNew && <span className="badge g">{t('admin.catalogue.new')}</span>}{' '}
        {!service.active && <span className="badge grey">{t('admin.catalogue.hidden')}</span>}
        {service.description && <div className="small muted">{service.description}</div>}
      </td>
      <td>{duration(service.durationMinutes)}</td>
      <td>
        <PriceInput
          // A newly saved price (here or by a colleague) starts the field afresh.
          key={service.priceCents}
          service={service}
          onPreview={setPreview}
          onSaved={() => {
            setNotice(true);
            onChanged();
          }}
        />
        {notice && (
          <span className="small ok" role="status">
            {t('admin.catalogue.priceSaved')}
          </span>
        )}
      </td>
      {hourly ? (
        <td colSpan={3} className="center">
          {t('admin.catalogue.perHour', { price: euro(priced.priceCents) })}
        </td>
      ) : (
        SIZES.map((size) => <td key={size}>{euro(sizePrice(priced, size))}</td>)
      )}
      <td>
        {hourly
          ? t('admin.catalogue.perHour', { price: euro(proShare(priced.priceCents, proSharePct)) })
          : t('admin.catalogue.earnRange', {
              low: euro(proShare(sizePrice(priced, 'S'), proSharePct)),
              high: euro(proShare(sizePrice(priced, 'L'), proSharePct)),
            })}
      </td>
      <td>
        <button
          type="button"
          role="switch"
          aria-checked={service.active}
          aria-label={t('admin.catalogue.visibleLabel', { name: service.name })}
          className={`toggle ${service.active ? 'on' : ''}`}
          disabled={toggle.busy}
          onClick={() =>
            void toggle
              .run(() => api.patch(`/admin/services/${service.id}`, { active: !service.active }))
              .then((result) => result && onChanged())
          }
        />
        <ErrorText error={toggle.error} />
      </td>
    </tr>
  );
}

/** The row that appears under the table after "Add service". */
function AddServiceRow({ categoryId, onDone }: { categoryId: string; onDone: (added: boolean) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [hourly, setHourly] = useState(false);
  const [shown, setShown] = useState(false);
  const cents = parseEuroToCents(price);
  const duration = Number(minutes);
  const problems = {
    name: name.trim() === '' ? t('admin.catalogue.nameRequired') : null,
    price: validPrice(cents) ? null : t('admin.catalogue.priceInvalid'),
    duration: Number.isInteger(duration) && duration >= 15 && duration <= 600 && duration % 15 === 0 ? null : t('admin.catalogue.durationInvalid'),
  };
  const ready = !problems.name && !problems.price && !problems.duration;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (!ready || cents === null) return;
    const result = await action.run(() =>
      api.post('/admin/services', {
        categoryId,
        name: name.trim(),
        description: description.trim(),
        priceCents: cents,
        durationMinutes: duration,
        pricing: hourly ? 'hourly' : 'fixed',
      }),
    );
    if (result) onDone(true);
  }

  const field = (id: string, label: string, problem: string | null, input: ReactNode) => (
    <div className="af">
      <label htmlFor={id}>{label}</label>
      {input}
      {shown && problem && (
        <span id={`${id}-error`} className="error-text small" role="alert">
          {problem}
        </span>
      )}
    </div>
  );

  return (
    <form className="panel add-service" onSubmit={submit} noValidate aria-label={t('admin.catalogue.addService')}>
      <div className="fgrid">
        {field(
          'new-name',
          t('admin.catalogue.serviceName'),
          problems.name,
          <input
            id="new-name"
            maxLength={80}
            value={name}
            aria-invalid={shown && Boolean(problems.name)}
            aria-describedby={shown && problems.name ? 'new-name-error' : undefined}
            onChange={(e) => setName(e.target.value)}
          />,
        )}
        {field(
          'new-price',
          hourly ? t('admin.catalogue.perHour', { price: t('admin.catalogue.price') }) : t('admin.catalogue.price'),
          problems.price,
          <input
            id="new-price"
            inputMode="decimal"
            value={price}
            aria-invalid={shown && Boolean(problems.price)}
            aria-describedby={shown && problems.price ? 'new-price-error' : undefined}
            onChange={(e) => setPrice(e.target.value)}
          />,
        )}
        {field(
          'new-duration',
          t('admin.catalogue.duration'),
          problems.duration,
          <input
            id="new-duration"
            type="number"
            min={15}
            max={600}
            step={15}
            value={minutes}
            aria-invalid={shown && Boolean(problems.duration)}
            aria-describedby={shown && problems.duration ? 'new-duration-error' : undefined}
            onChange={(e) => setMinutes(e.target.value)}
          />,
        )}
        <div className="af">
          <label htmlFor="new-description">{t('admin.catalogue.description')}</label>
          <input id="new-description" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <label className="row gap8 small full">
          <input type="checkbox" checked={hourly} onChange={(e) => setHourly(e.target.checked)} /> {t('admin.catalogue.paidPerHour')}
        </label>
      </div>
      <ErrorText error={action.error} />
      <div className="row gap8">
        <button type="button" className="abtn ghost" onClick={() => onDone(false)}>
          {t('admin.catalogue.cancel')}
        </button>
        <button type="submit" className="abtn" disabled={action.busy || (shown && !ready)}>
          {t('admin.catalogue.add')}
        </button>
      </div>
    </form>
  );
}

function SizeGuide({ services }: { services: Service[] }) {
  const { t } = useTranslation();
  const example = services.find((s) => s.active && s.pricing === 'fixed');
  return (
    <section className="panel stack" aria-labelledby="sizes-heading">
      <h2 id="sizes-heading">{t('admin.catalogue.sizes')}</h2>
      <p className="small muted">{t('admin.catalogue.sizesIntro')}</p>
      <div className="size-guide">
        {SIZES.map((size) => (
          <div key={size} className="size-card">
            <div className="row between">
              <span className="b">{t(`admin.catalogue.size.${size}`)}</span>
              <span className="badge b">{t('admin.catalogue.multiplier', { factor: SIZE_FACTORS[size].toFixed(1) })}</span>
            </div>
            <p className="small">{t(`admin.catalogue.sizeMeaning.${size}`)}</p>
            <p className="small muted">
              {example
                ? t('admin.catalogue.example', {
                    service: example.name,
                    price: euro(Math.round(example.priceCents * SIZE_FACTORS[size])),
                  })
                : t('admin.catalogue.noExample')}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChangeLog({ changes }: { changes: CatalogueChange[] }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  return (
    <section className="panel stack" aria-labelledby="log-heading">
      <h2 id="log-heading">{t('admin.catalogue.log')}</h2>
      {changes.length === 0 ? (
        <p className="small muted">{t('admin.catalogue.noLog')}</p>
      ) : (
        <ul className="history">
          {changes.slice(0, 30).map((c) => (
            <li key={c.id}>
              {t(`admin.catalogue.logAction.${c.action}`, {
                service: c.serviceName ?? c.details.name ?? '',
                from: c.details.from === undefined ? '' : euro(c.details.from),
                to: c.details.to === undefined ? '' : euro(c.details.to),
              })}
              <div className="small muted">{t('admin.catalogue.logBy', { name: c.adminName ?? '–', date: dateTime(c.createdAt, timezone) })}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "See in the app": the trade's screen exactly as the customer app draws it, with only visible services. */
function AppPreview({
  category,
  services,
  appUrl,
  onClose,
}: {
  category: AdminCategory;
  services: Service[];
  appUrl: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const asCustomerSees: Category = {
    id: category.id,
    slug: category.slug,
    name: category.name,
    icon: category.icon,
    approvedPros: category.verifiedPros,
    services: services.filter((s) => s.active),
  };
  return (
    <Drawer title={t('admin.catalogue.previewTitle', { name: category.name })} closeLabel={t('admin.catalogue.close')} onClose={onClose}>
      <p className="small muted">{category.active ? t('admin.catalogue.previewNote') : t('admin.catalogue.previewDraft')}</p>
      {category.active && (
        <a className="abtn ghost" href={`${appUrl}/category/${encodeURIComponent(category.slug)}`} target="_blank" rel="noreferrer">
          {t('admin.catalogue.openInApp')}
        </a>
      )}
      <div className="phone-preview" inert>
        <header className="appbar">
          <h1>{category.name}</h1>
        </header>
        <CategoryView category={asCustomerSees} onContinue={() => undefined} />
      </div>
    </Drawer>
  );
}

function NewTradeForm({ onCreated, onCancel }: { onCreated: (category: AdminCategory) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<IconName>('leaf');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(() => api.post<{ category: AdminCategory }>('/admin/categories', { name: name.trim(), icon }));
    if (result) onCreated(result.category);
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="new-trade-heading">
      <h2 id="new-trade-heading">{t('admin.catalogue.newTradeTitle')}</h2>
      <div className="af">
        <label htmlFor="trade-name">{t('admin.catalogue.tradeName')}</label>
        <input id="trade-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="af">
        <legend>{t('admin.catalogue.icon')}</legend>
        <div className="row gap8 wrap">
          {ICONS.map((option) => (
            <label key={option} className={`icon-pick ${icon === option ? 'on' : ''}`}>
              <input type="radio" name="trade-icon" className="visually-hidden" checked={icon === option} onChange={() => setIcon(option)} />
              <Icon name={option} label={t('admin.catalogue.iconLabel', { icon: t(`admin.catalogue.icons.${option}`) })} />
            </label>
          ))}
        </div>
      </fieldset>
      <p className="small muted">{t('admin.catalogue.draftHint')}</p>
      <ErrorText error={action.error} />
      <div className="row gap8">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('admin.catalogue.cancel')}
        </button>
        <button type="submit" className="abtn" disabled={action.busy || !name.trim()}>
          {t('admin.catalogue.createTrade')}
        </button>
      </div>
    </form>
  );
}

function TradeDetails({ data, category, onChanged }: { data: AdminCatalogue; category: AdminCategory; onChanged: Changed }) {
  const { t } = useTranslation();
  const api = useApi();
  const publish = useAction();
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState(false);
  const services = data.services.filter((s) => s.categoryId === category.id);

  return (
    <div className="stack">
      <section className="panel stack" aria-labelledby="trade-heading">
        <div className="row between wrap gap8">
          <div className="row gap8">
            <span className="ci">
              <Icon name={category.icon} />
            </span>
            <div>
              <h2 id="trade-heading">
                {category.name}{' '}
                {category.active ? (
                  <span className="badge g">{t('admin.catalogue.live')}</span>
                ) : (
                  <span className="badge a">{t('admin.catalogue.draft')}</span>
                )}
              </h2>
              <p className="small muted">
                {t('admin.catalogue.selectedLine', { verified: category.verifiedPros, visible: category.visibleServices })}
              </p>
            </div>
          </div>
          <div className="row gap8 wrap">
            <button type="button" className="abtn ghost" onClick={() => setPreview(true)}>
              <Icon name="phone" /> {t('admin.catalogue.seeInApp')}
            </button>
            <button
              type="button"
              className={category.active ? 'abtn ghost' : 'abtn'}
              disabled={publish.busy}
              onClick={() =>
                void publish
                  .run(() => api.patch(`/admin/categories/${category.id}`, { active: !category.active }))
                  .then((result) => result && onChanged())
              }
            >
              {category.active ? t('admin.catalogue.unpublish') : t('admin.catalogue.publish')}
            </button>
          </div>
        </div>
        {!category.active && <p className="note">{t('admin.catalogue.draftHint')}</p>}
        <ErrorText error={publish.error} />

        {services.length === 0 ? (
          <p className="muted">{t('admin.catalogue.noServices')}</p>
        ) : (
          <div className="scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th scope="col">{t('admin.catalogue.col.service')}</th>
                  <th scope="col">{t('admin.catalogue.col.duration')}</th>
                  <th scope="col">{t('admin.catalogue.col.base')}</th>
                  <th scope="col">{t('admin.catalogue.col.small')}</th>
                  <th scope="col">{t('admin.catalogue.col.medium')}</th>
                  <th scope="col">{t('admin.catalogue.col.large')}</th>
                  <th scope="col">{t('admin.catalogue.col.earns', { pct: data.proSharePct })}</th>
                  <th scope="col">{t('admin.catalogue.col.visible')}</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <ServiceRow key={service.id} service={service} proSharePct={data.proSharePct} onChanged={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adding ? (
          <AddServiceRow
            categoryId={category.id}
            onDone={(added) => {
              setAdding(false);
              if (added) onChanged();
            }}
          />
        ) : (
          <button type="button" className="abtn ghost add-service-btn" onClick={() => setAdding(true)}>
            <Icon name="plus" /> {t('admin.catalogue.addService')}
          </button>
        )}
      </section>

      <SizeGuide services={services} />
      <ChangeLog changes={data.changes.filter((c) => c.categoryId === category.id)} />

      {preview && <AppPreview category={category} services={services} appUrl={data.appUrl} onClose={() => setPreview(false)} />}
    </div>
  );
}

export function CataloguePage() {
  const { t } = useTranslation();
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.get<AdminCatalogue>('/admin/catalogue'), [api]);
  const { state, reload } = useResource(load);
  const select = (id: string) => setParams({ trade: id }, { replace: true });

  return (
    <>
      <div className="row between wrap gap8">
        <h1>{t('admin.catalogue.title')}</h1>
        <button type="button" className="abtn" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {t('admin.catalogue.newTrade')}
        </button>
      </div>
      <ResourceState state={state} reload={reload}>
        {(data) => {
          const selected = data.categories.find((c) => c.id === params.get('trade')) ?? data.categories[0];
          return (
            <div className="catalogue">
              <nav className="panel trade-list" aria-label={t('admin.catalogue.trades')}>
                {data.categories.length === 0 && <p className="small muted">{t('admin.catalogue.noTrades')}</p>}
                {data.categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={`trade ${category.id === selected?.id ? 'on' : ''}`}
                    aria-current={category.id === selected?.id ? 'true' : undefined}
                    onClick={() => select(category.id)}
                  >
                    <Icon name={category.icon} />
                    <span className="grow">
                      <span className="b block">
                        {category.name} {!category.active && <span className="badge a">{t('admin.catalogue.draft')}</span>}
                      </span>
                      <span className="small muted block">
                        {t('admin.catalogue.tradeLine', {
                          visible: category.visibleServices,
                          total: category.totalServices,
                          pros: category.pros,
                        })}
                      </span>
                    </span>
                  </button>
                ))}
              </nav>
              <div className="stack">
                {creating && (
                  <NewTradeForm
                    onCancel={() => setCreating(false)}
                    onCreated={(category) => {
                      setCreating(false);
                      select(category.id);
                      reload();
                    }}
                  />
                )}
                {selected ? (
                  <TradeDetails key={selected.id} data={data} category={selected} onChanged={reload} />
                ) : (
                  <p className="panel muted">{t('admin.catalogue.chooseTrade')}</p>
                )}
              </div>
            </div>
          );
        }}
      </ResourceState>
    </>
  );
}
