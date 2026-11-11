import { useQuery } from '@tanstack/react-query';
import { ALLERGENS, GUEST_TAGS } from '@erp/domain';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { shrinkImage } from '../../lib/image';
import { Field, Toggle } from './ui';

/** What the item dialog edits about a dish for the guest (QR) menu. */
export interface GuestInfo {
  description: string;
  descriptionUr: string;
  hidden: boolean;
  tags: string[];
  allergens: string[];
  /** a newly chosen (already shrunk) photo, to be uploaded on save */
  photo: Blob | null;
  /** remove the existing photo on save */
  removePhoto: boolean;
}

export const emptyGuestInfo = (): GuestInfo => ({
  description: '',
  descriptionUr: '',
  hidden: false,
  tags: [],
  allergens: [],
  photo: null,
  removePhoto: false,
});

/** The fields the API stores as text, in the shape the item create/update calls take. */
export const guestPayload = (g: GuestInfo) => ({
  description: g.description.trim() || null,
  descriptionUr: g.descriptionUr.trim() || null,
  hiddenFromGuests: g.hidden,
  guestTags: g.tags,
  allergens: g.allergens,
});

function toggle(list: string[], code: string): string[] {
  return list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
}

/** A photo that needs the staff sign-in to fetch (staff can see it before the menu is published). */
function SavedPhoto({ itemId }: { itemId: string }) {
  const photo = useQuery({
    queryKey: ['item-image', itemId],
    queryFn: () => api<Blob>(`/items/${itemId}/image`, { responseType: 'blob' }),
    staleTime: 0,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photo.data) return;
    const u = URL.createObjectURL(photo.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo.data]);
  if (!url) return <div className="size-24 animate-pulse rounded-lg bg-slate-200" />;
  return (
    <img src={url} alt="" className="size-24 rounded-lg border border-slate-300 object-cover" />
  );
}

export function GuestInfoFields({
  itemId,
  hasImage,
  value,
  onChange,
}: {
  /** null while creating a new item (nothing saved yet) */
  itemId: string | null;
  hasImage: boolean;
  value: GuestInfo;
  onChange: (next: GuestInfo) => void;
}) {
  const { t } = useTranslation();
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  useEffect(() => {
    if (!value.photo) return setPreview(null);
    const u = URL.createObjectURL(value.photo);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [value.photo]);

  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    setPhotoError(false);
    try {
      onChange({ ...value, photo: await shrinkImage(f), removePhoto: false });
    } catch {
      setPhotoError(true);
    }
  };
  const showSaved = itemId && hasImage && !value.photo && !value.removePhoto;

  return (
    <fieldset className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-3">
      <legend className="px-1 font-semibold">{t('guest.title')}</legend>
      <p className="hint">{t('guest.hint')}</p>

      <div className="flex flex-wrap items-center gap-3">
        <Toggle
          on={value.hidden}
          label={t('guest.hide')}
          onChange={(v) => onChange({ ...value, hidden: v })}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t('guest.hide')}</span>
          <span className="hint">{t('guest.hideHint')}</span>
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('guest.description')}>
          <textarea
            className="input min-h-20 py-2"
            maxLength={300}
            value={value.description}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
          />
        </Field>
        <Field label={t('guest.descriptionUr')}>
          <textarea
            className="input min-h-20 py-2"
            dir="rtl"
            lang="ur"
            maxLength={300}
            value={value.descriptionUr}
            onChange={(e) => onChange({ ...value, descriptionUr: e.target.value })}
          />
        </Field>
      </div>

      <div className="space-y-1">
        <div className="label">{t('guest.tags')}</div>
        <div className="flex flex-wrap gap-2">
          {GUEST_TAGS.map((c) => (
            <button
              key={c}
              type="button"
              className="seg-item border border-slate-400 bg-white"
              aria-pressed={value.tags.includes(c)}
              onClick={() => onChange({ ...value, tags: toggle(value.tags, c) })}
            >
              {t(`guest.tag.${c}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <div className="label">{t('guest.allergens')}</div>
        <div className="flex flex-wrap gap-2">
          {ALLERGENS.map((c) => (
            <button
              key={c}
              type="button"
              className="seg-item border border-slate-400 bg-white"
              aria-pressed={value.allergens.includes(c)}
              onClick={() => onChange({ ...value, allergens: toggle(value.allergens, c) })}
            >
              {t(`guest.allergen.${c}`)}
            </button>
          ))}
        </div>
        <p className="hint">{t('guest.allergenHint')}</p>
      </div>

      <div className="space-y-1">
        <div className="label">{t('guest.photo')}</div>
        <div className="flex flex-wrap items-center gap-3">
          {preview ? (
            <img
              src={preview}
              alt=""
              className="size-24 rounded-lg border border-slate-300 object-cover"
            />
          ) : showSaved ? (
            <SavedPhoto itemId={itemId} />
          ) : (
            <div className="flex size-24 items-center justify-center rounded-lg border border-dashed border-slate-400 text-slate-500">
              <Icon name="box" size={28} />
            </div>
          )}
          <div className="space-y-2">
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label={t('guest.choosePhoto')}
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => file.current?.click()}>
                {preview || showSaved ? t('guest.replacePhoto') : t('guest.choosePhoto')}
              </button>
              {(preview || showSaved) && (
                <button
                  type="button"
                  className="btn-quiet text-rose-700"
                  onClick={() =>
                    onChange({ ...value, photo: null, removePhoto: !!itemId && hasImage })
                  }
                >
                  <Icon name="trash" size={18} />
                  {t('guest.removePhoto')}
                </button>
              )}
            </div>
            <p className="hint">{t('guest.photoHint')}</p>
            {photoError && <p className="text-sm text-rose-700">{t('guest.photoBad')}</p>}
          </div>
        </div>
      </div>
    </fieldset>
  );
}
