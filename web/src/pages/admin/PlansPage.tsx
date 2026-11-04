import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { AdminCategory, Frequency, Plan, PlanInput } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { euro, parseEuroToCents } from '../../lib/format';
import { useAction } from '../../lib/useAction';

export const FREQUENCIES: Frequency[] = ['every_2_weeks', 'weekly', 'twice_weekly', 'three_times_weekly'];
/** Average visits a month, as the API counts them. */
export const VISITS_PER_MONTH: Record<Frequency, number> = {
  every_2_weeks: 2.2,
  weekly: 4.3,
  twice_weekly: 8.7,
  three_times_weekly: 13,
};
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
type Month = (typeof MONTHS)[number];

export function PlansPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ plans: Plan[] }>('/admin/plans'), [api]);
  const { state, reload } = useResource(load);

  return (
    <>
      <div className="row between wrap">
        <h1>{t('admin.plans.title')}</h1>
        <Link to="/admin/plans/new" className="abtn">
          <Icon name="plus" /> {t('admin.plans.new')}
        </Link>
      </div>
      <p className="muted small">{t('admin.plans.intro')}</p>
      <ResourceState state={state} reload={reload}>
        {({ plans }) =>
          plans.length === 0 ? (
            <p className="panel muted">{t('admin.plans.none')}</p>
          ) : (
            <div className="panel scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.plans.fields.name')}</th>
                    <th scope="col">{t('admin.plans.fields.category')}</th>
                    <th scope="col">{t('admin.plans.fields.price')}</th>
                    <th scope="col">{t('admin.plans.fields.frequency')}</th>
                    <th scope="col">{t('admin.plans.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((plan) => (
                    <tr key={plan.id}>
                      <td>
                        <Link to={`/admin/plans/${plan.id}`} className="b">
                          {plan.name}
                        </Link>
                      </td>
                      <td>{plan.categoryName}</td>
                      <td>{t('admin.plans.perMonth', { price: euro(plan.priceCents) })}</td>
                      <td>{t(`admin.plans.frequency.${plan.frequency}`)}</td>
                      <td>
                        <span className={`badge ${plan.status === 'published' ? 'g' : 'grey'}`}>{t(`admin.plans.state.${plan.status}`)}</span>
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

interface Draft {
  name: string;
  categoryId: string;
  price: string;
  frequency: Frequency;
  visitMinutes: number;
  tasks: string[];
  newTask: string;
  addonName: string;
  addonPrice: string;
  seasonal: boolean;
  seasonFrom: Month;
  seasonTo: Month;
  skipsPerMonth: number;
  minTermMonths: number;
  proSharePct: number;
}

function toDraft(plan: Plan | null, categories: AdminCategory[]): Draft {
  if (!plan) {
    return {
      name: '',
      categoryId: categories[0]?.id ?? '',
      price: '',
      frequency: 'weekly',
      visitMinutes: 60,
      tasks: [],
      newTask: '',
      addonName: '',
      addonPrice: '',
      seasonal: false,
      seasonFrom: 4,
      seasonTo: 10,
      skipsPerMonth: 2,
      minTermMonths: 3,
      proSharePct: 70,
    };
  }
  return {
    name: plan.name,
    categoryId: plan.categoryId,
    price: (plan.priceCents / 100).toFixed(2),
    frequency: plan.frequency,
    visitMinutes: plan.visitMinutes,
    tasks: plan.tasks,
    newTask: '',
    addonName: plan.addonName ?? '',
    addonPrice: plan.addonPriceCents === null ? '' : (plan.addonPriceCents / 100).toFixed(2),
    seasonal: plan.seasonal,
    seasonFrom: (plan.seasonFrom ?? 4) as Month,
    seasonTo: (plan.seasonTo ?? 10) as Month,
    skipsPerMonth: plan.skipsPerMonth,
    minTermMonths: plan.minTermMonths,
    proSharePct: plan.proSharePct,
  };
}

function PlanEditor({ plan, categories }: { plan: Plan | null; categories: AdminCategory[] }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const save = useAction();
  const publish = useAction();
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan, categories));
  const [current, setCurrent] = useState<Plan | null>(plan);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const priceCents = parseEuroToCents(draft.price);
  const addonPriceCents = draft.addonName.trim() ? parseEuroToCents(draft.addonPrice) : null;
  const addonInvalid = draft.addonName.trim() !== '' && addonPriceCents === null;
  const visits = VISITS_PER_MONTH[draft.frequency];
  const proCents = priceCents === null ? 0 : Math.floor((priceCents * draft.proSharePct) / 100);
  const category = categories.find((c) => c.id === draft.categoryId);
  const valid = draft.name.trim() !== '' && priceCents !== null && priceCents >= 500 && draft.tasks.length > 0 && !addonInvalid && Boolean(category);

  function addTask() {
    const task = draft.newTask.trim();
    if (task && !draft.tasks.some((x) => x.toLowerCase() === task.toLowerCase()) && draft.tasks.length < 12) {
      setDraft((d) => ({ ...d, tasks: [...d.tasks, task], newTask: '' }));
      setSaved(false);
    }
  }

  function input(): PlanInput | null {
    if (!valid || priceCents === null) {
      return null;
    }
    return {
      name: draft.name.trim(),
      categoryId: draft.categoryId,
      priceCents,
      frequency: draft.frequency,
      visitMinutes: draft.visitMinutes,
      tasks: draft.tasks,
      addonName: draft.addonName.trim() || null,
      addonPriceCents,
      seasonal: draft.seasonal,
      seasonFrom: draft.seasonal ? draft.seasonFrom : null,
      seasonTo: draft.seasonal ? draft.seasonTo : null,
      skipsPerMonth: draft.skipsPerMonth,
      minTermMonths: draft.minTermMonths,
      proSharePct: draft.proSharePct,
    };
  }

  async function saveDraft(event?: FormEvent): Promise<Plan | null> {
    event?.preventDefault();
    const body = input();
    if (!body) {
      return null;
    }
    const result = await save.run(() =>
      current ? api.put<{ plan: Plan }>(`/admin/plans/${current.id}`, body) : api.post<{ plan: Plan }>('/admin/plans', body),
    );
    if (!result) {
      return null;
    }
    setCurrent(result.plan);
    setSaved(true);
    if (!current) {
      navigate(`/admin/plans/${result.plan.id}`, { replace: true });
    }
    return result.plan;
  }

  async function setPublished(published: boolean) {
    const savedPlan = published ? await saveDraft() : current;
    if (!savedPlan) {
      return;
    }
    const result = await publish.run(() => api.post<{ plan: Plan }>(`/admin/plans/${savedPlan.id}/status`, { published }));
    if (result) {
      setCurrent(result.plan);
    }
  }

  const live = current?.status === 'published';
  const number = (key: 'visitMinutes' | 'skipsPerMonth' | 'minTermMonths', min: number, max: number, step = 1) => (
    <div className="af">
      <label htmlFor={`plan-${key}`}>{t(`admin.plans.fields.${key}`)}</label>
      <input
        id={`plan-${key}`}
        type="number"
        min={min}
        max={max}
        step={step}
        required
        value={draft[key]}
        onChange={(e) => set(key, Number(e.target.value))}
      />
      {key === 'visitMinutes' && <span className="hint">{t('admin.plans.visitHint')}</span>}
    </div>
  );

  return (
    <form onSubmit={saveDraft} className="stack">
      <div className="row between wrap">
        <div>
          <h1>{live ? t('admin.plans.publishedTitle') : current ? t('admin.plans.editTitle') : t('admin.plans.newTitle')}</h1>
          <p className="small muted">
            <Link to="/admin/plans">{t('admin.plans.title')}</Link> → {draft.name.trim() || t('admin.plans.untitled')}
          </p>
        </div>
        <div className="row gap8">
          <button type="submit" className="abtn ghost big" disabled={!valid || save.busy}>
            {t('admin.plans.saveDraft')}
          </button>
          {live ? (
            <button type="button" className="abtn ghost big" disabled={publish.busy} onClick={() => void setPublished(false)}>
              {t('admin.plans.unpublish')}
            </button>
          ) : (
            <button type="button" className="abtn big" disabled={!valid || publish.busy || save.busy} onClick={() => void setPublished(true)}>
              {t('admin.plans.publish')}
            </button>
          )}
        </div>
      </div>
      {saved && !live && (
        <p className="small brand-text" role="status">
          {t('admin.plans.saved')}
        </p>
      )}
      <ErrorText error={save.error ?? publish.error} />

      <div className="builder">
        <div className="panel fgrid">
          <div className="af">
            <label htmlFor="plan-name">{t('admin.plans.fields.name')}</label>
            <input id="plan-name" required maxLength={80} value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="af">
            <label htmlFor="plan-category">{t('admin.plans.fields.category')}</label>
            <select id="plan-category" value={draft.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="af">
            <label htmlFor="plan-price">{t('admin.plans.fields.price')}</label>
            <input id="plan-price" inputMode="decimal" required value={draft.price} onChange={(e) => set('price', e.target.value)} />
            <span className="hint">{t('admin.plans.priceHint')}</span>
            {draft.price && (priceCents === null || priceCents < 500) && <span className="error-text">{t('admin.plans.priceInvalid')}</span>}
          </div>
          <div className="af">
            <label htmlFor="plan-frequency">{t('admin.plans.fields.frequency')}</label>
            <select id="plan-frequency" value={draft.frequency} onChange={(e) => set('frequency', e.target.value as Frequency)}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`admin.plans.frequency.${f}`)}
                </option>
              ))}
            </select>
            <span className="hint">{t('admin.plans.visitsHint', { visits })}</span>
          </div>
          {number('visitMinutes', 15, 600, 15)}
          {number('minTermMonths', 0, 12)}

          <fieldset className="af full">
            <legend>{t('admin.plans.fields.tasks')}</legend>
            <ul className="taskchips">
              {draft.tasks.map((task, index) => (
                <li key={task} className="taskchip">
                  {task}
                  <button
                    type="button"
                    aria-label={t('admin.plans.removeTask', { task })}
                    onClick={() => set('tasks', draft.tasks.filter((_, i) => i !== index))}
                  >
                    <Icon name="x" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="row gap8">
              <label htmlFor="plan-new-task" className="visually-hidden">
                {t('admin.plans.newTask')}
              </label>
              <input
                id="plan-new-task"
                placeholder={t('admin.plans.newTask')}
                maxLength={60}
                value={draft.newTask}
                onChange={(e) => set('newTask', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTask();
                  }
                }}
              />
              <button type="button" className="abtn ghost" onClick={addTask} disabled={!draft.newTask.trim()}>
                <Icon name="plus" /> {t('admin.plans.addTask')}
              </button>
            </div>
            {draft.tasks.length === 0 && <span className="hint">{t('admin.plans.tasksHint')}</span>}
          </fieldset>

          <div className="af">
            <label htmlFor="plan-addon">{t('admin.plans.fields.addonName')}</label>
            <input id="plan-addon" maxLength={80} value={draft.addonName} onChange={(e) => set('addonName', e.target.value)} />
            <span className="hint">{t('admin.plans.addonHint')}</span>
          </div>
          <div className="af">
            <label htmlFor="plan-addon-price">{t('admin.plans.fields.addonPrice')}</label>
            <input
              id="plan-addon-price"
              inputMode="decimal"
              disabled={!draft.addonName.trim()}
              value={draft.addonPrice}
              onChange={(e) => set('addonPrice', e.target.value)}
            />
            {addonInvalid && draft.addonPrice !== '' && <span className="error-text">{t('admin.plans.priceInvalid')}</span>}
          </div>

          <div className="af">
            <label className="row gap8" htmlFor="plan-seasonal">
              <input id="plan-seasonal" type="checkbox" checked={draft.seasonal} onChange={(e) => set('seasonal', e.target.checked)} />
              {t('admin.plans.fields.seasonal')}
            </label>
            <span className="hint">
              {draft.seasonal
                ? t('admin.plans.seasonOn', { from: t(`month.${draft.seasonFrom}`), to: t(`month.${draft.seasonTo}`) })
                : t('admin.plans.seasonOff')}
            </span>
            {draft.seasonal && (
              <div className="row gap8">
                {(['seasonFrom', 'seasonTo'] as const).map((key) => (
                  <span key={key} className="af grow">
                    <label htmlFor={`plan-${key}`}>{t(`admin.plans.fields.${key}`)}</label>
                    <select id={`plan-${key}`} value={draft[key]} onChange={(e) => set(key, Number(e.target.value) as Month)}>
                      {MONTHS.map((m) => (
                        <option key={m} value={m}>
                          {t(`month.${m}`)}
                        </option>
                      ))}
                    </select>
                  </span>
                ))}
              </div>
            )}
          </div>
          {number('skipsPerMonth', 0, 8)}

          <div className="af full">
            <label htmlFor="plan-share">{t('admin.plans.fields.proSharePct', { pct: draft.proSharePct })}</label>
            <input id="plan-share" type="range" min={50} max={90} value={draft.proSharePct} onChange={(e) => set('proSharePct', Number(e.target.value))} />
            <div className="split" aria-hidden="true">
              <div style={{ width: `${draft.proSharePct}%` }} />
              <div style={{ width: `${100 - draft.proSharePct}%` }} />
            </div>
            <p className="row between small">
              <span>{t('admin.plans.proEarns', { amount: euro(proCents) })}</span>
              <span>{t('admin.plans.miskKeeps', { amount: euro(priceCents === null ? 0 : priceCents - proCents) })}</span>
            </p>
          </div>
        </div>

        <aside className="preview" aria-labelledby="preview-title">
          <p id="preview-title" className="pv-l">
            {t('admin.plans.preview')}
          </p>
          <div className="card stack">
            <div className="row">
              {category && (
                <span className="ci">
                  <Icon name={category.icon} />
                </span>
              )}
              <div>
                <p className="b">{draft.name.trim() || t('admin.plans.untitled')}</p>
                <p className="small muted">
                  {t(`admin.plans.frequency.${draft.frequency}`)} · {t('admin.plans.minutes', { minutes: draft.visitMinutes })}
                </p>
              </div>
            </div>
            <p className="pv-price">
              {euro(priceCents ?? 0)}
              <span className="small muted">{t('admin.plans.perMonthSuffix')}</span>
            </p>
            <p className="small muted">{t('admin.plans.perVisit', { price: euro(Math.round((priceCents ?? 0) / visits)) })}</p>
            <ul className="stack tight">
              {draft.tasks.map((task) => (
                <li key={task} className="row small gap4">
                  <Icon name="check" className="brand-text" /> {task}
                </li>
              ))}
            </ul>
            {draft.addonName.trim() && (
              <p className="addon-preview small">
                <span>{draft.addonName.trim()}</span>
                <b>+{euro(addonPriceCents ?? 0)}</b>
              </p>
            )}
            <p className="tiny muted">
              {draft.seasonal && `${t('admin.plans.seasonShort', { from: t(`month.${draft.seasonFrom}`), to: t(`month.${draft.seasonTo}`) })} · `}
              {t('admin.plans.rulesShort', { skips: draft.skipsPerMonth, months: draft.minTermMonths })}
            </p>
          </div>
          <p className="small muted">
            {live ? (
              <>
                <span className="badge g">
                  <Icon name="check" /> {t('admin.plans.state.published')}
                </span>{' '}
                {t('admin.plans.liveNote')}
              </>
            ) : (
              t('admin.plans.draftNote')
            )}
          </p>
        </aside>
      </div>
    </form>
  );
}

export function PlanEditorPage() {
  const { id } = useParams();
  const api = useApi();
  const load = useCallback(async () => {
    const [{ categories }, planResult] = await Promise.all([
      api.get<{ categories: AdminCategory[] }>('/admin/catalogue'),
      id ? api.get<{ plan: Plan }>(`/admin/plans/${encodeURIComponent(id)}`) : Promise.resolve({ plan: null }),
    ]);
    return { categories: categories.filter((c) => c.active || c.id === planResult.plan?.categoryId), plan: planResult.plan };
  }, [api, id]);
  const { state, reload } = useResource(load);
  return (
    <ResourceState state={state} reload={reload}>
      {({ categories, plan }) => <PlanEditor key={plan?.id ?? 'new'} plan={plan} categories={categories} />}
    </ResourceState>
  );
}
