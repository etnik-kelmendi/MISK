import { useTranslation } from 'react-i18next';
import { AppHeader } from '../../../shells/Shells';
import { AddressBook } from '../Addresses';

/** Saved addresses (D92): name, address and notes, the default one marked; add, edit, remove, make default. */
export function SavedAddressesPage() {
  const { t } = useTranslation();
  return (
    <>
      <AppHeader title={t('profile.addresses')} back="/profile" />
      <div className="body">
        <AddressBook />
      </div>
    </>
  );
}
