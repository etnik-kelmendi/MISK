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

/** One row of the plans list, with Delete behind a confirmation, like in the editor. */
function PlanRow({ plan, onDeleted }: { plan: Plan; onDeleted: (name: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const removal = useAction();
  const [confirm, setConfirm] = useState(false);
  const name = plan.name ?? t('admin.plans.untitled');
  const live = plan.status === 'published';

  async function remove() {
    const done = await removal.run(() => api.delete(`/admin/plans/${plan.id}`).then(() => true));
    setConfirm(false);
    if (done) onDeleted(plan.name ?? '');
  }

  return (
    <>
      <tr>
        <td>
          <Link to={`/admin/plans/${plan.id}`} className="b">
            {name}
          </Link>
        </td>
        <td>{plan.categoryName ?? '–'}</td>
        <td>{plan.priceCents === null ? '–' : t('admin.plans.perMonth', { price: euro(plan.priceCents) })}</td>
        <td>{t(`admin.plans.frequency.${plan.frequency}`)}</td>
        <td className="center">{plan.subscribers ?? 0}</td>
        <td>
          <span className={`badge ${live ? 'g' : 'grey'}`}>{t(`admin.plans.state.${plan.status}`)}</span>
        </td>
        <td>
          <span className="row gap8 nowrap">
            <Link to={`/admin/plans/${plan.id}`} className="abtn ghost sm" aria-label={t('admin.plans.editLabel', { name })}>
              {t('admin.plans.edit')}
            </Link>
            <button
              type="button"
              className="abtn ghost sm danger-text"
              aria-haspopup="dialog"
              aria-label={t('admin.plans.deleteLabel', { name })}
              disabled={removal.busy || confirm}
              onClick={() => {
                removal.clearError();
                setConfirm(true);
              }}
            >
              {t('admin.plans.delete.short')}
            </button>
          </span>
        </td>
      </tr>
      {(confirm || removal.error) && (
        <tr className="hl">
          <td colSpan={7}>
            {confirm ? (
              <div role="alertdialog" aria-labelledby={`delete-${plan.id}`} aria-describedby={`delete-text-${plan.id}`} className="stack tight">
                <p id={`delete-${plan.id}`} className="b">
                  {t('admin.plans.delete.title', { name })}
                </p>
                <p id={`delete-text-${plan.id}`} className="small">
                  {(plan.subscribers ?? 0) > 0
                    ? t('admin.plans.delete.subscribersText', { count: plan.subscribers })
                    : live
                      ? t('admin.plans.delete.liveText')
                      : t('admin.plans.delete.text')}
                </p>
                <div className="row gap8">
                  <button type="button" className="abtn danger" disabled={removal.busy} onClick={() => void remove()}>
                    {removal.busy ? t('admin.plans.delete.deleting') : t('admin.plans.delete.confirm')}
                  </button>
                  <button type="button" className="abtn ghost" disabled={removal.busy} onClick={() => setConfirm(false)}>
                    {t('admin.plans.delete.keep')}
                  </button>
                </div>
              </div>
            ) : (
              <ErrorText error={removal.error} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function PlansPage() {
  const { t } = useTranslation();
  const api = useApi();
  const location = useLocation();
  // A plan deleted in the editor comes back here with its name; one deleted in the list sets it directly.
  const [deleted, setDeleted] = useState<string | undefined>((location.state as { deleted?: string } | null)?.deleted);
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
                    <th scope="col">{t('admin.plans.subscribers')}</th>
                    <th scope="col">{t('admin.plans.status')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('admin.plans.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((plan) => (
                    <PlanRow
                      key={plan.id}
                      plan={plan}
                      onDeleted={(name) => {
                        setDeleted(name);
                        reload();
                      }}
                    />
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
type PlanField = 'name' | 'category' | 'price' | 'tasks' | 'addonPrice';

/** Every field that can stop publishing, with its input, in the order they appear on the page. */
const FIELD_ORDER: [PlanField | NumberField, string][] = [
  ['name', 'plan-name'],
  ['category', 'plan-category'],
  ['price', 'plan-price'],
  ['visitMinutes', 'plan-visitMinutes'],
  ['minTermMonths', 'plan-minTermMonths'],
  ['tasks', 'plan-new-task'],
  ['addonPrice', 'plan-addon-price'],
  ['skipsPerMonth', 'plan-skipsPerMonth'],
];

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

/** What a number field keeps of what was typed or pasted: digits only, without leading zeros ("03" → "3"). */
export function cleanNumberInput(value: string): string {
  return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

/** The arrow keys' next value: one step up or down, rounded to the step and kept within the limits. */
export function stepNumber(key: NumberField, value: string, direction: 1 | -1): number {
  const { min, max, step } = NUMBER_LIMITS[key];
  const current = /^\d+$/.test(value) ? Number(value) : direction === 1 ? min - step : max + step;
  const next = direction === 1 ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step;
  return Math.min(max, Math.max(min, next));
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
  // What is wrong with each field, for the message under it. Shown after the first try to publish.
  const [tried, setTried] = useState(false);
  const fieldProblems: Record<PlanField, string | null> = {
    name: draft.name.trim() === '' ? t('admin.plans.errors.name') : null,
    category: !category ? t('admin.plans.errors.category') : null,
    price:
      draft.price.trim() === ''
        ? t('admin.plans.errors.priceMissing')
        : priceCents === null || priceCents < 500
          ? t('admin.plans.priceInvalid')
          : null,
    tasks: draft.tasks.length === 0 ? t('admin.plans.errors.tasks') : null,
    addonPrice: addonInvalid ? (draft.addonPrice === '' ? t('admin.plans.addonPriceNeeded') : t('admin.plans.addonPriceInvalid')) : null,
  };
  // A field's message: after a try to publish, or straight away for an amount that was typed wrong.
  const shownProblem = (field: PlanField) => {
    const problem = fieldProblems[field];
    if (!problem) return null;
    if (tried) return problem;
    return (field === 'price' && draft.price.trim() !== '') || (field === 'addonPrice' && draft.addonPrice !== '') ? problem : null;
  };
  const describe = (field: PlanField) => {
    const problem = shownProblem(field);
    return { 'aria-invalid': problem ? true : undefined, 'aria-describedby': problem ? `plan-${field}-error` : undefined } as const;
  };
  const fieldError = (field: PlanField) => {
    const problem = shownProblem(field);
    return (
      problem && (
        <span id={`plan-${field}-error`} className="error-text">
          {problem}
        </span>
      )
    );
  };
  const problemCount = (Object.values(fieldProblems).filter(Boolean).length) + badNumbers.length;

  function addTask() {
    const task = draft.newTask.trim();
    if (!task) {
      setTaskNotice(t('validation.taskEmpty'));
      document.getElementById('plan-new-task')?.focus();
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
      setTried(true);
      // The cursor goes to the first field to fix, in the order the fields appear.
      const first = FIELD_ORDER.find(([field]) =>
        field in fieldProblems ? fieldProblems[field as PlanField] : badNumbers.includes(field as NumberField),
      );
      if (first) document.getElementById(first[1])?.focus();
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
        {/* A text field, not type="number": browsers keep a typed leading zero ("03", or the "0" left of "60")
            in number fields, and React cannot correct it there. Digits only; arrow keys still step. */}
        <input
          id={`plan-${key}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={3}
          required
          value={draft[key]}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `plan-${key}-error` : undefined}
          onChange={(e) => set(key, cleanNumberInput(e.target.value))}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            set(key, String(stepNumber(key, draft[key], e.key === 'ArrowUp' ? 1 : -1)));
          }}
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
              disabled={publish.busy || save.busy}
              aria-describedby={!valid ? 'plan-missing' : undefined}
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
      {!valid &&
        (tried ? (
          <p className="error-text" id="plan-missing" role="alert">
            {t('admin.plans.errors.summary', { count: problemCount })}
          </p>
        ) : (
          <p className="small muted" id="plan-missing">
            {t('admin.plans.missing.intro', { items: missing.join(', ') })}
          </p>
        ))}
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
            <input id="plan-name" required maxLength={80} value={draft.name} {...describe('name')} onChange={(e) => set('name', e.target.value)} />
            {fieldError('name')}
          </div>
          <div className="af">
            <label htmlFor="plan-category">{t('admin.plans.fields.category')}</label>
            <select id="plan-category" value={draft.categoryId} {...describe('category')} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">{t('admin.plans.chooseCategory')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {fieldError('category')}
          </div>
          <div className="af">
            <label htmlFor="plan-price">{t('admin.plans.fields.price')}</label>
            <input
              id="plan-price"
              inputMode="decimal"
              required
              value={draft.price}
              {...describe('price')}
              onChange={(e) => set('price', e.target.value)}
            />
            {fieldError('price') ?? <span className="hint">{t('admin.plans.priceHint')}</span>}
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
                {...describe('tasks')}
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
              <button type="button" className="abtn ghost icon-only" aria-label={t('admin.plans.addTask')} onClick={addTask}>
                <Icon name="plus" />
              </button>
            </div>
            {taskNotice && (
              <span className="error-text" role="status">
                {taskNotice}
              </span>
            )}
            {fieldError('tasks') ?? (draft.tasks.length === 0 && <span className="hint">{t('admin.plans.tasksHint')}</span>)}
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
              {...describe('addonPrice')}
              onChange={(e) => set('addonPrice', e.target.value)}
            />
            {fieldError('addonPrice')}
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
