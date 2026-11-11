import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import type { TableRow } from '../../lib/types';
import { Icon } from '../../components/Icon';
import { Dialog, EmptyRow, ErrorText, Field, PageHead, Toggle } from './ui';

interface AreaRow {
  id: string;
  name: string;
}

export function TablesAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const areas = useQuery({
    queryKey: ['admin-areas'],
    queryFn: async () => (await api<{ items: AreaRow[] }>('/areas')).items,
  });
  const tables = useQuery({
    queryKey: ['admin-tables'],
    queryFn: async () => (await api<{ items: TableRow[] }>('/tables')).items,
  });
  const [dialog, setDialog] = useState<'area' | 'table' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = (): Promise<unknown> =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin-areas'] }),
      qc.invalidateQueries({ queryKey: ['admin-tables'] }),
      qc.invalidateQueries({ queryKey: ['floor'] }),
    ]);

  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) =>
      api(`/tables/${v.id}`, { method: 'PATCH', body: { is_active: v.on } }),
    onSuccess: refresh,
    onError: setError,
  });
  const areaName = (id: string | null): string => areas.data?.find((a) => a.id === id)?.name ?? '';

  return (
    <div className="max-w-6xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.tables')} hint={t('admin.tablesPage.hint')}>
        <button className="btn-secondary" onClick={() => setDialog('area')}>
          {t('admin.tablesPage.newArea')}
        </button>
        <button className="btn-primary" onClick={() => setDialog('table')}>
          <Icon name="plus" size={18} />
          {t('admin.tablesPage.newTable')}
        </button>
      </PageHead>
      <ErrorText error={error} />
      {(areas.data ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="micro">{t('admin.tablesPage.areas')}</span>
          {(areas.data ?? []).map((a) => (
            <span key={a.id} className="chip-mute">
              {a.name}
            </span>
          ))}
        </div>
      )}
      <div className="dt">
        <table className="min-w-[32rem]">
          <thead>
            <tr>
              <th>{t('admin.code')}</th>
              <th>{t('admin.tablesPage.area')}</th>
              <th className="num">{t('admin.tablesPage.seats')}</th>
              <th>{t('admin.active')}</th>
            </tr>
          </thead>
          <tbody>
            {(tables.data ?? []).map((tb) => (
              <tr key={tb.id} className={tb.is_active ? '' : 'opacity-55'}>
                <td className="name">{tb.code}</td>
                <td>{areaName(tb.area_id) || <span className="text-slate-400">–</span>}</td>
                <td className="num">{tb.seats}</td>
                <td>
                  <Toggle
                    on={tb.is_active}
                    label={`${t('admin.active')} ${tb.code}`}
                    onChange={(on) => toggle.mutate({ id: tb.id, on })}
                  />
                </td>
              </tr>
            ))}
            {tables.isSuccess && tables.data.length === 0 && (
              <EmptyRow cols={4} icon="tables" text={t('admin.tablesPage.empty')} />
            )}
          </tbody>
        </table>
      </div>
      {dialog === 'area' && (
        <AreaDialog onClose={() => setDialog(null)} onDone={() => void refresh()} />
      )}
      {dialog === 'table' && (
        <TableDialog
          areas={areas.data ?? []}
          onClose={() => setDialog(null)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}

function AreaDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => api('/areas', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog title={t('admin.tablesPage.newArea')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.name')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function TableDialog({
  areas,
  onClose,
  onDone,
}: {
  areas: AreaRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [seats, setSeats] = useState('4');
  const [areaId, setAreaId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () =>
      api('/tables', {
        method: 'POST',
        body: { code: code.trim(), seats: Number(seats) || 4, area_id: areaId || null },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog title={t('admin.tablesPage.newTable')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.code')}>
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('admin.tablesPage.seats')}>
          <input
            className="input"
            inputMode="numeric"
            value={seats}
            onChange={(e) => setSeats(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Field label={t('admin.tablesPage.area')}>
          <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">{t('admin.none')}</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !code.trim()}
            onClick={() => save.mutate()}
          >
            {t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
