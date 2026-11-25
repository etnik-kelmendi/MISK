import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import type { ProProfile } from '../../../api/types';
import { useResource } from '../../../api/useResource';
import { useUser } from '../../../auth/AuthContext';
import { ErrorText } from '../../../components/ErrorText';
import { Avatar, FileButton, IMAGE_TYPES } from '../../../components/Photos';
import { useAction } from '../../../lib/useAction';
import { PersonalPage } from '../../customer/profile/PersonalPage';
import { PRO_PROFILE_PATHS } from './types';

/** The pro's profile photo (D83): customers see it on their booking, in the chat and when they rate the job. */
export function ProPhoto() {
  const { t } = useTranslation();
  const user = useUser();
  const api = useApi();
  const load = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const { state, update } = useResource(load);
  const upload = useAction();
  const remove = useAction();
  if (state.status !== 'ready') return null;
  const { profile } = state.data;
  const changed = (next: ProProfile) => update(() => ({ profile: next }));
  return (
    <section className="card stack" aria-labelledby="photo-heading">
      <h2 id="photo-heading" className="b">
        {t('proPhoto.title')}
      </h2>
      <div className="row gap8">
        <Avatar name={user.firstName ?? ''} photoId={profile.photoId} size="lg" />
        <p className="small muted grow">{profile.photoId ? t('proPhoto.hint') : `${t('proPhoto.none')} ${t('proPhoto.hint')}`}</p>
      </div>
      <div className="row gap8 wrap">
        <FileButton
          label={profile.photoId ? t('proPhoto.change') : t('proPhoto.add')}
          accept={IMAGE_TYPES}
          icon="camera"
          onFile={async (file) => {
            const result = await upload.run(() => api.upload<{ profile: ProProfile }>('/pro/photo', file));
            if (result) changed(result.profile);
          }}
        />
        {profile.photoId && (
          <button
            type="button"
            className="mini-btn danger"
            disabled={remove.busy}
            onClick={() => void remove.run(() => api.delete<{ profile: ProProfile }>('/pro/photo')).then((result) => result && changed(result.profile))}
          >
            {t('proPhoto.remove')}
          </button>
        )}
      </div>
      <ErrorText error={upload.error ?? remove.error} />
    </section>
  );
}

/**
 * Personal information in the pro app (D100): the photo, then the same name, phone number (a new one is confirmed
 * with a code sent by text message, D87), email and language as for customers, with "Save changes".
 */
export function ProPersonalPage() {
  return <PersonalPage back={PRO_PROFILE_PATHS.profile} top={<ProPhoto />} />;
}
