import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { BookingListItem, Category, JobSize, Plan, Postcode, SavedAddress, Service } from '../../api/types';
import { useResource } from '../../api/useResource';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { IMAGE_TYPES, MAX_FILE_BYTES } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { Waitlist } from '../../components/Waitlist';
import { euro, packagePrice, PACKAGE_DISCOUNT_PCT } from '../../lib/format';
import { planSizePrice } from '../../lib/plans';
import { isValidPostcode, MAX_POSTCODE_LENGTH, normalizePostcode, tidyPostcodeInput } from '../../lib/checks';
import { useValidation } from '../../lib/useValidation';

export const SIZES: JobSize[] = ['S', 'M', 'L'];
/** Photos a customer can send with a booking, as the API allows. */
export const MAX_BOOKING_PHOTOS = 3;

export interface Details {
  address: string;
  postcode: string;
  size: JobSize;
  notes: string;
  /** Sent to the booking right after it is made (D69). */
  photos: File[];
}

export const EMPTY_DETAILS: Details = { address: '', postcode: '', size: 'M', notes: '', photos: [] };

/** Garden trades measure in square metres; other trades in how big the job is. */
export function sizeGroup(category: Category): 'garden' | 'job' {
  return category.icon === 'leaf' || category.icon === 'sun' ? 'garden' : 'job';
}

/** Small previews of the chosen photos, released again when they go. */
function PhotoPreviews({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useTranslation();
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);
  return (
    <>
      {files.map((file, index) => (
        <span key={`${file.name}-${index}`} className="ph ph-preview">
          <img src={urls[index]} alt={file.name} />
          <button type="button" className="ph-remove" aria-label={t('problem.removePhoto', { name: file.name })} onClick={() => onRemove(index)}>
            <Icon name="x" />
          </button>
        </span>
      ))}
    </>
  );
}

/** "Need this regularly?": the trade's first plan, when it has one. */
function MakeItAPlan({ category }: { category: Category }) {
  const { t } = useTranslation();
  const api = useApi();
  const [plan, setPlan] = useState<Plan | null>(null);
  useEffect(() => {
    let live = true;
    api.get<{ plans: Plan[] }>('/plans').then(
      (result) => live && setPlan(result.plans.find((p) => p.categoryId === category.id) ?? null),
      // A hint only: without it the page still books, so a failure is logged and the card left out.
      (error: unknown) => console.warn('Could not load the plans for the plan hint', error),
    );
    return () => {
      live = false;
    };
  }, [api, category.id]);
  if (!plan) return null;
  return (
    <Link to={`/plans/${plan.id}`} className="card row plan-hint">
      <span className="plan-hint-icon" aria-hidden="true">
        <Icon name="repeat" />
      </span>
      <span className="grow">
        <span className="b small block">{t('details.planTitle')}</span>
        <span className="tiny muted">{t('details.planText', { name: plan.name, price: euro(planSizePrice(plan.priceCents ?? 0, 'S')) })}</span>
      </span>
      <Icon name="chevR" />
    </Link>
  );
}

/**
 * Job details (D69): where, how big, photos and notes, with the fixed price. Starts from the selected address
 * on Home (D89), or else the customer's last booking.
 */
export function JobDetailsStep({
  category,
  services,
  details,
  onChange,
  onPrefill,
  onNext,
}: {
  category: Category;
  services: Service[];
  details: Details;
  onChange: (details: Details) => void;
  /** The last booking's address, for fields the customer has not filled in yet. */
  onPrefill: (address: string, postcode: string) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const loadPostcodes = useCallback(() => api.get<{ postcodes: Postcode[] }>('/postcodes'), [api]);
  const postcodes = useResource(loadPostcodes);
  const [tooBig, setTooBig] = useState(false);
  const group = sizeGroup(category);
  const price = packagePrice(services, details.size);
  // The size changes the price of fixed-price services only; hourly ones cost their rate times their length.
  const sized = services.some((service) => service.pricing !== 'hourly');
  const [single] = services;
  const servedList = postcodes.state.status === 'ready' ? postcodes.state.data.postcodes : null;
  // Postcodes from any country (D84), compared the way the API stores them: upper-case with single spaces.
  const code = normalizePostcode(details.postcode);
  const wellFormed = isValidPostcode(code);
  const servedArea = wellFormed ? servedList?.find((p) => p.code === code) : undefined;
  // Only known once the list of served postcodes has loaded.
  const unserved = wellFormed && servedList !== null && !servedArea;
  const form = useValidation(
    {
      address: !details.address.trim() ? t('validation.addressMissing') : details.address.trim().length < 3 && t('validation.addressShort'),
      postcode: !details.postcode
        ? t('validation.postcodeMissing')
        : !wellFormed
          ? t('validation.postcodeFormat')
          : unserved && t('validation.postcodeUnserved'),
    },
    { address: 'address', postcode: 'postcode' },
  );

  // An empty form starts from the address selected on Home (D89), else the last booking's address.
  const { address, postcode } = details;
  useEffect(() => {
    if (address || postcode) return;
    let live = true;
    async function lastAddress(): Promise<{ address: string; postcode: string } | null> {
      const saved = await api.get<{ addresses: SavedAddress[] }>('/addresses');
      const selected = saved.addresses.find((a) => a.selected && a.served);
      if (selected) return selected;
      const result = await api.get<{ bookings: BookingListItem[] }>('/bookings');
      const last = [...result.bookings].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).find((b) => b.address && b.postcode);
      return last?.address && last.postcode ? { address: last.address, postcode: last.postcode } : null;
    }
    lastAddress().then(
      (found) => {
        if (live && found) onPrefill(found.address, found.postcode);
      },
      // Filling the address is a convenience; the customer can still type it.
      (error: unknown) => console.warn('Could not load the last address', error),
    );
    return () => {
      live = false;
    };
    // Only when the step opens empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    // Files over 8 MB are left out here, so nobody waits for an upload the API would refuse.
    setTooBig(picked.some((file) => file.size > MAX_FILE_BYTES));
    const fitting = picked.filter((file) => file.size <= MAX_FILE_BYTES);
    onChange({ ...details, photos: [...details.photos, ...fitting].slice(0, MAX_BOOKING_PHOTOS) });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    // A space typed at the end is dropped before the postcode is used for times and the booking.
    if (details.postcode !== code) onChange({ ...details, postcode: code });
    onNext();
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="body">
        {services.length > 1 && (
          <p className="small muted row gap6">
            <Icon name="tag" /> {t('details.package', { count: services.length, pct: PACKAGE_DISCOUNT_PCT })}
          </p>
        )}
        <div className="field">
          <label htmlFor="address">{t('book.address')}</label>
          <input
            id="address"
            autoComplete="street-address"
            required
            minLength={3}
            maxLength={200}
            value={details.address}
            {...form.describe('address')}
            onChange={(event) => onChange({ ...details, address: event.target.value })}
          />
          <FieldError id="address" message={form.message('address')} />
        </div>
        <ResourceState state={postcodes.state} reload={postcodes.reload}>
          {() => (
            <div className="field">
              <label htmlFor="postcode">{t('book.postcode')}</label>
              <input
                id="postcode"
                autoComplete="postal-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={MAX_POSTCODE_LENGTH + 1}
                required
                value={details.postcode}
                {...form.describe('postcode')}
                onChange={(event) => onChange({ ...details, postcode: tidyPostcodeInput(event.target.value) })}
                onBlur={() => code !== details.postcode && onChange({ ...details, postcode: code })}
              />
              <FieldError id="postcode" message={form.message('postcode')} />
              {servedArea && <span className="hint">{servedArea.name}</span>}
            </div>
          )}
        </ResourceState>
        {unserved && <Waitlist key={code} postcode={code} />}

        {!sized && single && services.length === 1 ? (
          <p className="info">
            <Icon name="clock" />
            <span>{t('book.hourly', { rate: euro(single.priceCents), hours: single.durationMinutes / 60 })}</span>
          </p>
        ) : (
          <>
            <fieldset className="sizes">
              <legend className="h-sm">{t(`book.sizeTitle.${group}`)}</legend>
              {SIZES.map((size) => (
                <label key={size} className={`size ${details.size === size ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name="size"
                    className="visually-hidden"
                    checked={details.size === size}
                    onChange={() => onChange({ ...details, size })}
                  />
                  <span className="n">{t(`details.sizeName.${group}.${size}`)}</span>
                  <span className="d">{t(`book.sizeHint.${group}.${size}`)}</span>
                  <span className="b small brand-text">{euro(packagePrice(services, size).jobCents)}</span>
                </label>
              ))}
            </fieldset>
            <p className="info amber">
              <Icon name="bell" />
              <span>
                <b>{t('details.unsureTitle')}</b> {t('details.unsureText')}
              </span>
            </p>
          </>
        )}

        <fieldset>
          <legend className="h-sm">
            {t('details.photos')} <span className="h-note">{t('rating.optional')}</span>
          </legend>
          <div className="photos">
            <PhotoPreviews files={details.photos} onRemove={(index) => onChange({ ...details, photos: details.photos.filter((_, i) => i !== index) })} />
          </div>
          {details.photos.length < MAX_BOOKING_PHOTOS && (
            <div className="photo-buttons">
              <span className="file-button">
                <input id="job-photo-camera" type="file" accept="image/*" capture="environment" className="visually-hidden" onChange={choose} />
                <label htmlFor="job-photo-camera" className="btn btn-ghost">
                  <Icon name="camera" /> {t('details.takePhoto')}
                </label>
              </span>
              <span className="file-button">
                <input id="job-photos" type="file" accept={IMAGE_TYPES} multiple className="visually-hidden" onChange={choose} />
                <label htmlFor="job-photos" className="btn btn-ghost">
                  <Icon name="upload" /> {t('details.choosePhotos')}
                </label>
              </span>
            </div>
          )}
          {tooBig && (
            <span className="error-text" role="alert">
              {t('errors.file_too_large')}
            </span>
          )}
        </fieldset>

        <div className="field">
          <label htmlFor="notes" className="h-sm">
            {t('book.notes')}
          </label>
          <textarea
            id="notes"
            rows={3}
            maxLength={1000}
            placeholder={t('book.notesPlaceholder')}
            value={details.notes}
            onChange={(event) => onChange({ ...details, notes: event.target.value })}
          />
        </div>
        <p className="info">
          <Icon name="tag" />
          <span>{t(sized ? 'details.fixedPrice' : 'details.fixedPriceHourly', { price: euro(price.jobCents) })}</span>
        </p>
        <MakeItAPlan category={category} />
      </div>
      <div className="cta-bar">
        <button className="cta" type="submit">
          {t('book.continuePrice', { price: euro(price.jobCents) })}
        </button>
      </div>
    </form>
  );
}
