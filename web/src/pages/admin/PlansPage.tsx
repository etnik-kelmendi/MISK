import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
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

export function PlansPage() {
  const { t } = useTranslation();
  const api = useApi();
  const location = useLocation();
  const deleted = (location.state as { deleted?: string } | null)?.deleted;
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
      {deleted !== undefined && (
        <p className="info" role="status">
          <Icon name="check" /> {t('admin.plans.deleted', { name: deleted || t('admin.plans.untitled') })}
        </p>
      )}
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
                          {plan.name ?? t('admin.plans.untitled')}
                        </Link>
                      </td>
                      <td>{plan.categoryName ?? '–'}</td>
                      <td>{plan.priceCents === null ? '–' : t('admin.plans.perMonth', { price: euro(plan.priceCents) })}</td>
                      <td>{t(`admin.plans.frequency.${plan.frequency}`)}</td>
                      <td>
                        <span className={`badge ${plan.status === 'published' ? 'g' : 'grey'}`}>
                          {t(`admin.plans.state.${plan.status}`)}
                        </span>
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

type NumberField = 'visitMinutes' | 'skipsPerMonth' | 'minTermMonths';

/** The limits the API accepts for each number, so the editor can explain them before saving. */
export const NUMBER_LIMITS: Record<NumberField, { min: number; max: number; step: number }> = {
  visitMinutes: { min: 15, max: 600, step: 15 },
  skipsPerMonth: { min: 0, max: 8, step: 1 },
  minTermMonths: { min: 0, max: 12, step: 1 },
};

/** A whole number within the field's limits, or null while the field is empty or out of range. */
export function parseNumberField(key: NumberField, value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const number = Number(text);
  const { min, max, step } = NUMBER_LIMITS[key];
  return number >= min && number <= max && number % step === 0 ? number : null;
}

interface Draft {
  name: string;
  categoryId: string;
  price: string;
  frequency: Frequency;
  visitMinutes: string;
  tasks: string[];
  newTask: string;
  addonName: string;
  addonPrice: string;
  seasonal: boolean;
  skipsPerMonth: string;
  minTermMonths: string;
  proSharePct: number;
}

function toDraft(plan: Plan | null): Draft {
  if (!plan) {
    return {
      name: '',
      categoryId: '',
      price: '',
      frequency: 'weekly',
      visitMinutes: '60',
      tasks: [],
      newTask: '',
      addonName: '',
      addonPrice: '',
      seasonal: false,
      skipsPerMonth: '2',
      minTermMonths: '3',
      proSharePct: 70,
    };
  }
  return {
    name: plan.name ?? '',
    categoryId: plan.categoryId ?? '',
    price: plan.priceCents === null ? '' : (plan.priceCents / 100).toFixed(2),
    frequency: plan.frequency,
    visitMinutes: String(plan.visitMinutes),
    tasks: plan.tasks,
    newTask: '',
    addonName: plan.addonName ?? '',
    addonPrice: plan.addonPriceCents === null ? '' : (plan.addonPriceCents / 100).toFixed(2),
    seasonal: plan.seasonal,
    skipsPerMonth: String(plan.skipsPerMonth),
    minTermMonths: String(plan.minTermMonths),
    proSharePct: plan.proSharePct,
  };
}

function inputOf(draft: Draft): PlanInput {
  const addonName = draft.addonName.trim() || null;
  return {
    name: draft.name.trim() || null,
    categoryId: draft.categoryId || null,
    priceCents: parseEuroToCents(draft.price),
    frequency: draft.frequency,
    visitMinutes: parseNumberField('visitMinutes', draft.visitMinutes) ?? Number.NaN,
    tasks: draft.tasks,
    addonName,
    addonPriceCents: addonName ? parseEuroToCents(draft.addonPrice) : null,
    seasonal: draft.seasonal,
    skipsPerMonth: parseNumberField('skipsPerMonth', draft.skipsPerMonth) ?? Number.NaN,
    minTermMonths: parseNumberField('minTermMonths', draft.minTermMonths) ?? Number.NaN,
    proSharePct: draft.proSharePct,
  };
}

function PlanEditor({ plan, categories }: { plan: Plan | null; categories: AdminCategory[] }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const save = useAction();
  const publish = useAction();
  const removal = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan));
  // What was last saved, to tell whether leaving the page would lose changes.
  const [savedInput, setSavedInput] = useState(() => JSON.stringify(inputOf(toDraft(plan))));
  const [current, setCurrent] = useState<Plan | null>(plan);
  const location = useLocation();
  // A brand-new plan reloads under its own address after the first save; the confirmation comes along.
  const [saved, setSaved] = useState(() => Boolean((location.state as { saved?: boolean } | null)?.saved));
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
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
  // What still stops the plan from being published, in the order the fields appear. Drafts save regardless.
  const missing = [
    draft.name.trim() === '' && t('admin.plans.missing.name'),
    !category && t('admin.plans.missing.category'),
    (priceCents === null || priceCents < 500) && t('admin.plans.missing.price'),
    draft.tasks.length === 0 && t('admin.plans.missing.tasks'),
    addonInvalid && t('admin.plans.missing.addonPrice'),
  ].filter((item): item is string => Boolean(item));
  // Numbers the API would refuse: shown at the field, and nothing is saved until they are fixed.
  const badNumbers = (Object.keys(NUMBER_LIMITS) as NumberField[]).filter((key) => parseNumberField(key, draft[key]) === null);
  const valid = missing.length === 0 && badNumbers.length === 0;

  function addTask() {
    const task = draft.newTask.trim();
    if (!task) {
      return;
    }
    if (draft.tasks.some((x) => x.toLowerCase() === task.toLowerCase())) {
      setTaskNotice(t('admin.plans.taskDuplicate', { task }));
      return;
    }
    if (draft.tasks.length >= 12) {
      setTaskNotice(t('admin.plans.taskLimit'));
      return;
    }
    setDraft((d) => ({ ...d, tasks: [...d.tasks, task], newTask: '' }));
    setTaskNotice(null);
    setSaved(false);
  }

  const body = inputOf(draft);
  const dirty = JSON.stringify(body) !== savedInput;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Leaving with unsaved changes asks first: inside the app, and when closing or reloading the tab.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRef.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function saveDraft(event?: FormEvent): Promise<Plan | null> {
    event?.preventDefault();
    if (badNumbers.length > 0) {
      document.getElementById(`plan-${badNumbers[0]}`)?.focus();
      return null;
    }
    const sent = body;
    const result = await save.run(() =>
      current ? api.put<{ plan: Plan }>(`/admin/plans/${current.id}`, sent) : api.post<{ plan: Plan }>('/admin/plans', sent),
    );
    if (!result) {
      return null;
    }
    setCurrent(result.plan);
    setSavedInput(JSON.stringify(sent));
    dirtyRef.current = false;
    setSaved(true);
    if (!current) {
      navigate(`/admin/plans/${result.plan.id}`, { replace: true, state: { saved: true } });
    }
    return result.plan;
  }

  async function deletePlan() {
    if (!current) {
      return;
    }
    const done = await removal.run(() => api.delete(`/admin/plans/${current.id}`).then(() => true));
    if (done) {
      // The plan is gone, so there is nothing left to lose by leaving.
      dirtyRef.current = false;
      void navigate('/admin/plans', { replace: true, state: { deleted: current.name ?? '' } });
    } else {
      setConfirmDelete(false);
    }
  }

  async function setPublished(published: boolean) {
    if (published && !valid) {
      return;
    }
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
  const number = (key: NumberField) => {
    const { min, max, step } = NUMBER_LIMITS[key];
    const invalid = badNumbers.includes(key);
    return (
      <div className="af">
        <label htmlFor={`plan-${key}`}>{t(`admin.plans.fields.${key}`)}</label>
        <input
          id={`plan-${key}`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          required
          value={draft[key]}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `plan-${key}-error` : undefined}
          onChange={(e) => set(key, e.target.value)}
        />
        {invalid ? (
          <span id={`plan-${key}-error`} className="error-text">
            {t(`admin.plans.numberError.${key}`, { min, max, step })}
          </span>
        ) : (
          key === 'visitMinutes' && <span className="hint">{t('admin.plans.visitHint')}</span>
        )}
      </div>
    );
  };

  return (
    // Drafts may be incomplete, so the browser's own required-field check must not block saving.
    <form onSubmit={saveDraft} className="stack" noValidate>
      <div className="row between wrap">
        <div>
          <h1>{live ? t('admin.plans.publishedTitle') : current ? t('admin.plans.editTitle') : t('admin.plans.newTitle')}</h1>
          <p className="small muted">
            <Link to="/admin/plans">{t('admin.plans.title')}</Link> → {draft.name.trim() || t('admin.plans.untitled')}
          </p>
        </div>
        <div className="row gap8">
          {current && (
            <button
              type="button"
              className="abtn ghost big danger-text"
              aria-haspopup="dialog"
              disabled={removal.busy || confirmDelete}
              onClick={() => {
                removal.clearError();
                setConfirmDelete(true);
              }}
            >
              <Icon name="x" /> {t('admin.plans.delete.button')}
            </button>
          )}
          <button type="submit" className="abtn ghost big" disabled={save.busy}>
            {t('admin.plans.saveDraft')}
          </button>
          {live ? (
            <button type="button" className="abtn ghost big" disabled={publish.busy} onClick={() => void setPublished(false)}>
              {t('admin.plans.unpublish')}
            </button>
          ) : (
            <button
              type="button"
              className="abtn big"
              disabled={!valid || publish.busy || save.busy}
              onClick={() => void setPublished(true)}
            >
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
      {!valid && (
        <p className="small muted" id="plan-missing">
          {t('admin.plans.missing.intro', { items: missing.join(', ') })}
        </p>
      )}
      {blocker.state === 'blocked' && (
        <div className="panel leave-warning" role="alertdialog" aria-labelledby="leave-title" aria-describedby="leave-text">
          <p id="leave-title" className="b">
            {t('admin.plans.leave.title')}
          </p>
          <p id="leave-text" className="small">
            {t('admin.plans.leave.text')}
          </p>
          <div className="row gap8">
            <button type="button" className="abtn" onClick={() => blocker.reset()}>
              {t('admin.plans.leave.stay')}
            </button>
            <button type="button" className="abtn ghost" onClick={() => blocker.proceed()}>
              {t('admin.plans.leave.leave')}
            </button>
          </div>
        </div>
      )}
      {confirmDelete && current && (
        <div className="panel leave-warning" role="alertdialog" aria-labelledby="delete-title" aria-describedby="delete-text">
          <p id="delete-title" className="b">
            {t('admin.plans.delete.title', { name: current.name ?? t('admin.plans.untitled') })}
          </p>
          <p id="delete-text" className="small">
            {live ? t('admin.plans.delete.liveText') : t('admin.plans.delete.text')}
          </p>
          <div className="row gap8">
            <button type="button" className="abtn danger" disabled={removal.busy} onClick={() => void deletePlan()}>
              {removal.busy ? t('admin.plans.delete.deleting') : t('admin.plans.delete.confirm')}
            </button>
            <button type="button" className="abtn ghost" disabled={removal.busy} onClick={() => setConfirmDelete(false)}>
              {t('admin.plans.delete.keep')}
            </button>
          </div>
        </div>
      )}
      <ErrorText error={save.error ?? publish.error ?? removal.error} />

      <div className="builder">
        <div className="panel fgrid">
          <div className="af">
            <label htmlFor="plan-name">{t('admin.plans.fields.name')}</label>
            <input id="plan-name" required maxLength={80} value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="af">
            <label htmlFor="plan-category">{t('admin.plans.fields.category')}</label>
            <select id="plan-category" value={draft.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">{t('admin.plans.chooseCategory')}</option>
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
            {draft.price && (priceCents === null || priceCents < 500) && (
              <span className="error-text">{t('admin.plans.priceInvalid')}</span>
            )}
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
          {number('visitMinutes')}
          {number('minTermMonths')}

          <fieldset className="af full">
            <legend>{t('admin.plans.fields.tasks')}</legend>
            <ul className="taskchips">
              {draft.tasks.map((task, index) => (
                <li key={task} className="taskchip">
                  {task}
                  <button
                    type="button"
                    aria-label={t('admin.plans.removeTask', { task })}
                    onClick={() =>
                      set(
                        'tasks',
                        draft.tasks.filter((_, i) => i !== index),
                      )
                    }
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
                placeholder={t('admin.plans.newTaskPlaceholder')}
                maxLength={60}
                value={draft.newTask}
                onChange={(e) => {
                  set('newTask', e.target.value);
                  setTaskNotice(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTask();
                  }
                }}
              />
              <button
                type="button"
                className="abtn ghost icon-only"
                aria-label={t('admin.plans.addTask')}
                onClick={addTask}
                disabled={!draft.newTask.trim()}
              >
                <Icon name="plus" />
              </button>
            </div>
            {taskNotice && (
              <span className="error-text" role="status">
                {taskNotice}
              </span>
            )}
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
            {addonInvalid && (
              <span className="error-text">
                {draft.addonPrice === '' ? t('admin.plans.addonPriceNeeded') : t('admin.plans.addonPriceInvalid')}
              </span>
            )}
          </div>

          <div className="af">
            <span id="plan-seasonal-label">{t('admin.plans.fields.seasonal')}</span>
            <button
              type="button"
              role="switch"
              id="plan-seasonal"
              aria-checked={draft.seasonal}
              aria-labelledby="plan-seasonal-label"
              className={`toggle ${draft.seasonal ? 'on' : ''}`}
              onClick={() => set('seasonal', !draft.seasonal)}
            />
            <span className="hint">{draft.seasonal ? t('admin.plans.seasonOn') : t('admin.plans.seasonOff')}</span>
          </div>
          {number('skipsPerMonth')}

          <div className="af full">
            <label htmlFor="plan-share">{t('admin.plans.fields.proSharePct', { pct: draft.proSharePct })}</label>
            <input
              id="plan-share"
              type="range"
              min={50}
              max={90}
              value={draft.proSharePct}
              onChange={(e) => set('proSharePct', Number(e.target.value))}
            />
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
                  {t(`admin.plans.frequency.${draft.frequency}`)} ·{' '}
                  {t('admin.plans.minutes', { minutes: draft.visitMinutes.trim() || '–' })}
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
              <label className="addon-preview small">
                <input type="checkbox" disabled />
                <span className="grow">{draft.addonName.trim()}</span>
                <b>{t('admin.plans.addonPreviewPrice', { price: euro(addonPriceCents ?? 0) })}</b>
              </label>
            )}
            <span className="cta preview-cta" aria-hidden="true">
              {t('admin.plans.subscribe')}
            </span>
            <p className="tiny muted">
              {draft.seasonal && `${t('admin.plans.seasonShort')} · `}
              {t('admin.plans.rulesShort', { skips: draft.skipsPerMonth.trim() || '–', months: draft.minTermMonths.trim() || '–' })}
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
