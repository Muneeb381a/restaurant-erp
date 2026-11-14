import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { platformApi, type Provisioned } from '../../lib/platform-api';
import { whatsappLink } from '../../lib/whatsapp';
import { CopyField } from './parts';

/** The same rules as the server (apps/api/src/control/slug.ts): the server stays the judge. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const suggest = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

/** What the new restaurant's owner needs, as one block: where to go, who to be, the one-time password. */
export function Credentials({
  name,
  slug,
  username,
  password,
}: {
  name: string;
  slug: string;
  username: string;
  password: string;
}) {
  const { t } = useTranslation();
  // opens the restaurant's sign-in already on the password form (the password itself is never in the link)
  const url = `${window.location.origin}/r/${slug}?login=password&user=${encodeURIComponent(username)}`;
  const message = t('platform.shareText', { name, url, code: slug, username, password });
  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900">
        {t('platform.shownOnce')}
      </p>
      <CopyField label={t('platform.address')} value={url} />
      <CopyField label={t('platform.code')} value={slug} />
      <CopyField label={t('platform.ownerLogin')} value={username} />
      <CopyField label={t('platform.tempPassword')} value={password} secret />
      <a
        className="btn-secondary w-full"
        href={whatsappLink(null, message)}
        target="_blank"
        rel="noreferrer"
      >
        {t('platform.shareWhatsapp')}
      </a>
      <p className="hint">{t('platform.shareHint')}</p>
    </div>
  );
}

export function NewTenantDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [ownerUsername, setOwnerUsername] = useState('owner');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [made, setMade] = useState<Provisioned | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      platformApi<Provisioned>('/tenants', {
        method: 'POST',
        body: {
          name: name.trim(),
          slug,
          ownerName: ownerName.trim(),
          ownerUsername: ownerUsername.trim() || undefined,
          contactPhone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      }),
    onSuccess: (out) => setMade(out),
    onError: (e) =>
      setError(
        e instanceof ApiError && e.code === 'TENANT_SLUG_TAKEN'
          ? t('platform.slugTaken')
          : e instanceof ApiError && e.code === 'PROVISIONING_FAILED'
            ? t('platform.provisionFailed', { reason: e.message })
            : e instanceof ApiError
              ? e.message
              : t('common.error'),
      ),
  });

  if (made)
    return (
      <Modal
        title={t('platform.created', { name: made.tenant.name })}
        size="md"
        dismissible={false}
        onClose={() => undefined}
        footer={
          <>
            <label className="me-auto flex items-center gap-2 text-sm">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              {t('platform.iSaved')}
            </label>
            <button className="btn-primary" disabled={!saved} onClick={onDone}>
              {t('common.close')}
            </button>
          </>
        }
      >
        <Credentials
          name={made.tenant.name}
          slug={made.tenant.slug}
          username={made.owner.username}
          password={made.owner.temporaryPassword}
        />
      </Modal>
    );

  const slugOk = SLUG.test(slug) && !slug.includes('--');
  const valid = name.trim().length >= 2 && slugOk && ownerName.trim().length >= 2;
  return (
    <Modal
      title={t('platform.new')}
      size="md"
      dismissible={!create.isPending}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={create.isPending}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!valid || create.isPending}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            {create.isPending ? t('platform.creating') : t('platform.create')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block space-y-1">
          <span className="label">{t('platform.restaurantName')}</span>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(suggest(e.target.value));
            }}
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('platform.code')}</span>
          <input
            className="input"
            dir="ltr"
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
          <span className="hint block" dir="ltr">
            {window.location.origin}/r/{slug || '…'}
          </span>
          {slug && !slugOk && (
            <span className="text-sm text-rose-700">{t('platform.slugRule')}</span>
          )}
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="label">{t('platform.ownerName')}</span>
            <input
              className="input"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="label">{t('platform.ownerUsername')}</span>
            <input
              className="input"
              dir="ltr"
              value={ownerUsername}
              onChange={(e) => setOwnerUsername(e.target.value.toLowerCase())}
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="label">{t('platform.phone')}</span>
          <input
            className="input"
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('platform.notes')}</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <p className="hint">{t('platform.createHint')}</p>
        {create.isPending && (
          <p role="status" className="rounded-lg bg-sky-50 p-3 text-sm text-sky-900">
            {t('platform.creatingHint')}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
