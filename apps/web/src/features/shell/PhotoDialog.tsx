import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../../components/Avatar';
import { api } from '../../lib/api';
import { avatarImage } from '../../lib/image';
import { Dialog, ErrorText } from '../admin/ui';

/**
 * Your own photo: pick one from the gallery or take one with the camera. It is cropped to a square
 * and shrunk to a small JPEG here, so it is quick to send and to show everywhere your name is.
 */
export function PhotoDialog({
  name,
  userId,
  version,
  onClose,
}: {
  name: string;
  userId: string;
  version: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!picked) return;
    const url = URL.createObjectURL(picked);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  const done = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      api('/users/me/avatar', {
        method: 'PUT',
        rawBlob: { content: picked!, contentType: 'image/jpeg' },
      }),
    onSuccess: done,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: () => api('/users/me/avatar', { method: 'DELETE' }),
    onSuccess: done,
    onError: setError,
  });

  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    try {
      setPicked(await avatarImage(file));
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Dialog title={t('shell.changePhoto')} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          {preview ? (
            <img src={preview} alt="" className="size-24 rounded-full object-cover" />
          ) : (
            <Avatar name={name} size={96} userId={userId} version={version} />
          )}
          <div className="space-y-2">
            <p className="font-semibold">{name}</p>
            <button className="btn-secondary" onClick={() => input.current?.click()}>
              {t('shell.choosePhoto')}
            </button>
            <input
              ref={input}
              type="file"
              accept="image/*"
              capture="user"
              className="sr-only"
              aria-label={t('shell.choosePhoto')}
              onChange={(e) => void choose(e.target.files?.[0])}
            />
          </div>
        </div>
        <p className="hint">{t('shell.photoHint')}</p>
        <ErrorText error={error} />
        <div className="flex items-center justify-end gap-2">
          {version != null && !picked && (
            <button
              className="btn-danger-quiet me-auto"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('shell.removePhoto')}
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!picked || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
