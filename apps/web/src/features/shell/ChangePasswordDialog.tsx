import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { ApiError, api } from '../../lib/api';

/**
 * A signed-in user replaces their own password. `forced` is the first sign-in with a temporary
 * password: the dialog cannot be closed until it is changed (the server also refuses everything else).
 */
export function ChangePasswordDialog({
  forced,
  onClose,
}: {
  forced: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = again.length > 0 && again !== next;
  const valid = current.length > 0 && next.length >= 8 && again === next && next !== current;

  const save = useMutation({
    mutationFn: () =>
      api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast(t('shell.passwordChanged'));
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'INVALID_CREDENTIALS')
        setError(t('shell.currentWrong'));
      else if (e instanceof ApiError && e.code === 'ACCOUNT_LOCKED')
        setError(
          t('login.locked', {
            minutes: Math.max(1, Math.ceil(Number(e.body.retryAfterSeconds ?? 600) / 60)),
          }),
        );
      else setError(e instanceof ApiError ? e.message : t('common.error'));
    },
  });

  return (
    <Modal
      title={t('shell.changePassword')}
      size="sm"
      dismissible={!forced}
      onClose={onClose}
      footer={
        <>
          {!forced && (
            <button className="btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
          )}
          <button
            className="btn-primary"
            disabled={!valid || save.isPending}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {t('shell.changePassword')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {forced && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900">
            {t('shell.mustChange')}
          </p>
        )}
        <label className="block space-y-1">
          <span className="label">{t('shell.currentPassword')}</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('shell.newPassword')}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          {tooShort && <span className="text-sm text-rose-700">{t('shell.passwordShort')}</span>}
        </label>
        <label className="block space-y-1">
          <span className="label">{t('shell.repeatPassword')}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
          {mismatch && <span className="text-sm text-rose-700">{t('shell.passwordMismatch')}</span>}
        </label>
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
