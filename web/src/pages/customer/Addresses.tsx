import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { Postcode, SavedAddress } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { Sheet } from '../../components/Sheet';
import { Waitlist } from '../../components/Waitlist';
import { isValidPostcode, MAX_POSTCODE_LENGTH, normalizePostcode, tidyPostcodeInput } from '../../lib/checks';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';

/** The API's limits for a saved address (D89). */
export const MAX_ADDRESS_LABEL = 30;
export const MAX_ADDRESS_LENGTH = 200;
export const MAX_ADDRESS_NOTES = 200;

export interface AddressList {
  addresses: SavedAddress[];
  max: number;
}

/** The customer's saved addresses, for Home and the Profile page. */
export function useAddresses() {
  const api = useApi();
  const load = useCallback(() => api.get<AddressList>('/addresses'), [api]);
  return useResource(load);
}

/** "Home · 12 Linden Street" or just the street when the address has no name. */
export function addressTitle(address: SavedAddress): string {
  return address.label ? `${address.label} · ${address.address}` : address.address;
}

/**
 * Adds or edits a saved address: an optional name, the street, a postcode MISK serves and optional notes for
 * the pro (D92). A postcode MISK does not serve yet offers the waiting list (D76) instead of saving.
 */
export function AddressForm({
  editing,
  select = false,
  onSaved,
  onCancel,
}: {
  /** The address being edited; without it a new one is added. */
  editing?: SavedAddress;
  /** Makes a new address the selected one, e.g. when it is added from Home. */
  select?: boolean;
  onSaved: (address: SavedAddress) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const id = useId();
  const loadPostcodes = useCallback(() => api.get<{ postcodes: Postcode[] }>('/postcodes'), [api]);
  const postcodes = useResource(loadPostcodes);
  const [label, setLabel] = useState(editing?.label ?? '');
  const [address, setAddress] = useState(editing?.address ?? '');
  const [postcode, setPostcode] = useState(editing?.postcode ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const save = useAction();
  const served = postcodes.state.status === 'ready' ? postcodes.state.data.postcodes : null;
  const code = normalizePostcode(postcode);
  const wellFormed = isValidPostcode(code);
  const area = wellFormed ? served?.find((p) => p.code === code) : undefined;
  const unserved = wellFormed && served !== null && !area;
  const form = useValidation(
    {
      address: !address.trim() ? t('validation.addressMissing') : address.trim().length < 3 && t('validation.addressShort'),
      postcode: !postcode ? t('validation.postcodeMissing') : !wellFormed ? t('validation.postcodeFormat') : unserved && t('validation.postcodeUnserved'),
    },
    { address: `${id}-address`, postcode: `${id}-postcode` },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const body = { label: label.trim() || null, address: address.trim(), postcode: code, notes: notes.trim() || null };
    const result = await save.run(() =>
      editing
        ? api.patch<{ address: SavedAddress }>(`/addresses/${editing.id}`, body)
        : api.post<{ address: SavedAddress }>('/addresses', select ? { ...body, select: true } : body),
    );
    if (result) onSaved(result.address);
  }

  return (
    <form className="card stack address-form" onSubmit={submit} noValidate aria-label={editing ? t('addresses.editTitle') : t('addresses.addTitle')}>
      <div className="field">
        <label htmlFor={`${id}-label`}>
          {t('addresses.label')} <span className="h-note">{t('rating.optional')}</span>
        </label>
        <input
          id={`${id}-label`}
          maxLength={MAX_ADDRESS_LABEL}
          placeholder={t('addresses.labelPlaceholder')}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-address`}>{t('book.address')}</label>
        <input
          id={`${id}-address`}
          autoComplete="street-address"
          required
          maxLength={MAX_ADDRESS_LENGTH}
          value={address}
          {...form.describe('address')}
          onChange={(event) => setAddress(event.target.value)}
        />
        <FieldError id={`${id}-address`} message={form.message('address')} />
      </div>
      <ResourceState state={postcodes.state} reload={postcodes.reload}>
        {() => (
          <div className="field">
            <label htmlFor={`${id}-postcode`}>{t('book.postcode')}</label>
            <input
              id={`${id}-postcode`}
              autoComplete="postal-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={MAX_POSTCODE_LENGTH + 1}
              value={postcode}
              {...form.describe('postcode')}
              onChange={(event) => setPostcode(tidyPostcodeInput(event.target.value))}
              onBlur={() => setPostcode(code)}
            />
            <FieldError id={`${id}-postcode`} message={form.message('postcode')} />
            {area && <span className="hint">{area.name}</span>}
          </div>
        )}
      </ResourceState>
      {unserved && <Waitlist key={code} postcode={code} />}
      <div className="field">
        <label htmlFor={`${id}-notes`}>
          {t('addresses.notes')} <span className="h-note">{t('rating.optional')}</span>
        </label>
        <textarea
          id={`${id}-notes`}
          rows={2}
          maxLength={MAX_ADDRESS_NOTES}
          placeholder={t('addresses.notesPlaceholder')}
          aria-describedby={`${id}-notes-hint`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <span id={`${id}-notes-hint`} className="hint">
          {t('addresses.notesHint')}
        </span>
      </div>
      <ErrorText error={save.error} />
      <div className="row gap8">
        <button type="button" className="btn btn-ghost grow" disabled={save.busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary grow" disabled={save.busy}>
          {editing ? t('common.save') : t('addresses.save')}
        </button>
      </div>
    </form>
  );
}

/** The address pop-up on Home: pick another saved address, or add one, which becomes the selected one. */
export function AddressSheet({ list, onChanged, onClose }: { list: AddressList; onChanged: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const choose = useAction();
  const [adding, setAdding] = useState(list.addresses.length === 0);
  const full = list.addresses.length >= list.max;

  async function select(address: SavedAddress) {
    if (address.selected) return onClose();
    const result = await choose.run(() => api.post<{ address: SavedAddress }>(`/addresses/${address.id}/select`));
    if (result) {
      onChanged();
      onClose();
    }
  }

  return (
    <Sheet title={t('addresses.title')} closeLabel={t('common.close')} onClose={onClose}>
      {list.addresses.length > 0 && (
        <fieldset className="choices" disabled={choose.busy}>
          <legend className="visually-hidden">{t('addresses.choose')}</legend>
          {list.addresses.map((address) => (
            <label key={address.id} className={`svc address-choice ${address.selected ? 'on' : ''}`}>
              <input
                type="radio"
                name="address"
                className="visually-hidden"
                checked={address.selected}
                onChange={() => void select(address)}
              />
              <span className="radio" aria-hidden="true" />
              <span className="grow">
                <span className="b block">{addressTitle(address)}</span>
                <span className="small muted block">
                  {address.postcode} {address.areaName}
                </span>
                {!address.served && <span className="badge a">{t('addresses.notServed')}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <ErrorText error={choose.error} />
      {adding ? (
        <AddressForm
          select
          onSaved={() => {
            onChanged();
            onClose();
          }}
          onCancel={() => (list.addresses.length === 0 ? onClose() : setAdding(false))}
        />
      ) : full ? (
        <p className="small muted">{t('addresses.full', { count: list.max })}</p>
      ) : (
        <button type="button" className="btn btn-ghost wide" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {t('addresses.add')}
        </button>
      )}
    </Sheet>
  );
}

/** The icon of a saved address: a house for one named Home, a pin for the others. */
function addressIcon(address: SavedAddress): 'home' | 'pin' {
  return address.label?.trim().toLowerCase() === 'home' ? 'home' : 'pin';
}

/**
 * Saved addresses (D92): each with its name, the address and the notes for the pro. The default one is the
 * address Home shows and new bookings start from (the one selected on Home, D89). Add, edit, remove and make
 * another one the default.
 */
export function AddressBook() {
  const { t } = useTranslation();
  const api = useApi();
  const { state, reload } = useAddresses();
  const action = useAction();
  const [editing, setEditing] = useState<SavedAddress | 'new' | null>(null);
  const [removing, setRemoving] = useState<SavedAddress | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  async function run(work: () => Promise<unknown>) {
    const done = await action.run(async () => {
      await work();
      return true;
    });
    if (done) reload();
    return done;
  }

  return (
    <ResourceState state={state} reload={reload}>
      {(list) => (
        <>
          {list.addresses.length === 0 && editing !== 'new' && <p className="card small muted center-text">{t('addresses.none')}</p>}
          {list.addresses.length > 0 && (
            <ul className="stack address-list" aria-label={t('addresses.listLabel')}>
              {list.addresses.map((address) =>
                editing !== 'new' && editing?.id === address.id ? (
                  <li key={address.id}>
                    <AddressForm
                      editing={address}
                      onSaved={() => {
                        setEditing(null);
                        reload();
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </li>
                ) : (
                  <li key={address.id} className="card row address-row">
                    <span className="address-icon" aria-hidden="true">
                      <Icon name={addressIcon(address)} />
                    </span>
                    <span className="grow">
                      <span className="b small block">
                        {address.label ?? address.address}{' '}
                        {address.selected && <span className="badge g">{t('addresses.default')}</span>}
                      </span>
                      <span className="small block">
                        {address.label ? `${address.address}, ` : ''}
                        {address.postcode} {address.areaName}
                      </span>
                      {address.notes && <span className="tiny muted block address-notes">{address.notes}</span>}
                      {!address.served && <span className="badge a">{t('addresses.notServed')}</span>}
                    </span>
                    <span className="row gap4 wrap address-actions">
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label={t('addresses.editLabel', { address: address.address })}
                        disabled={action.busy}
                        onClick={() => setEditing(address)}
                      >
                        {t('addresses.edit')}
                      </button>
                      {!address.selected && (
                        <button
                          type="button"
                          className="mini-btn"
                          aria-label={t('addresses.makeDefaultLabel', { address: address.address })}
                          disabled={action.busy}
                          onClick={() => void run(() => api.post(`/addresses/${address.id}/select`))}
                        >
                          {t('addresses.makeDefault')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="mini-btn danger"
                        aria-label={t('addresses.removeLabel', { address: address.address })}
                        disabled={action.busy}
                        onClick={(event) => {
                          opener.current = event.currentTarget;
                          setRemoving(address);
                        }}
                      >
                        {t('addresses.remove')}
                      </button>
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
          <ErrorText error={action.error} />
          {editing === 'new' ? (
            <AddressForm
              onSaved={() => {
                setEditing(null);
                reload();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : list.addresses.length >= list.max ? (
            <p className="small muted">{t('addresses.full', { count: list.max })}</p>
          ) : (
            <button type="button" className="cta ghost" onClick={() => setEditing('new')}>
              <Icon name="plus" /> {t('addresses.addAddress')}
            </button>
          )}
          <p className="tiny muted">{t('addresses.footer')}</p>
          {removing && (
            <ConfirmDialog
              title={t('addresses.removeTitle')}
              cancelLabel={t('addresses.keep')}
              confirmLabel={t('addresses.remove')}
              busy={action.busy}
              returnFocusTo={opener.current}
              onCancel={() => setRemoving(null)}
              onConfirm={() => void run(() => api.delete(`/addresses/${removing.id}`)).then(() => setRemoving(null))}
            >
              <p>{addressTitle(removing)}</p>
              {removing.selected && list.addresses.length > 1 && <p className="small muted">{t('addresses.removeDefault')}</p>}
            </ConfirmDialog>
          )}
        </>
      )}
    </ResourceState>
  );
}
