import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import type { TableRow } from '../../lib/types';
import { Icon } from '../../components/Icon';
import { ConfirmDelete, Dialog, EmptyRow, ErrorText, Field, PageHead, Toggle } from './ui';

interface AreaRow {
  id: string;
  name: string;
}

type Editing =
  | { kind: 'area'; row: AreaRow | null }
  | { kind: 'table'; row: TableRow | null }
  | { kind: 'delete-area'; row: AreaRow }
  | { kind: 'delete-table'; row: TableRow };

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
  const [editing, setEditing] = useState<Editing | null>(null);
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
  const close = (): void => setEditing(null);

  return (
    <div className="max-w-6xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.tables')} hint={t('admin.tablesPage.hint')}>
        <button className="btn-secondary" onClick={() => setEditing({ kind: 'area', row: null })}>
          {t('admin.tablesPage.newArea')}
        </button>
        <button className="btn-primary" onClick={() => setEditing({ kind: 'table', row: null })}>
          <Icon name="plus" size={18} />
          {t('admin.tablesPage.newTable')}
        </button>
      </PageHead>
      <ErrorText error={error} />
      {(areas.data ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="micro">{t('admin.tablesPage.areas')}</span>
          {(areas.data ?? []).map((a) => (
            <button
              key={a.id}
              type="button"
              className="chip-mute hover:bg-slate-200"
              title={t('admin.tablesPage.editArea')}
              aria-label={`${t('admin.tablesPage.editArea')}: ${a.name}`}
              onClick={() => setEditing({ kind: 'area', row: a })}
            >
              {a.name}
              <Icon name="more" size={14} />
            </button>
          ))}
        </div>
      )}
      <div className="dt">
        <table className="min-w-[36rem]">
          <thead>
            <tr>
              <th>{t('admin.code')}</th>
              <th>{t('admin.tablesPage.area')}</th>
              <th className="num">{t('admin.tablesPage.seats')}</th>
              <th>{t('admin.active')}</th>
              <th />
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
                <td className="whitespace-nowrap text-end">
                  <button
                    className="btn-secondary me-1"
                    aria-label={`${t('admin.edit')} ${tb.code}`}
                    onClick={() => setEditing({ kind: 'table', row: tb })}
                  >
                    {t('admin.edit')}
                  </button>
                  <button
                    className="btn-danger-quiet"
                    aria-label={`${t('admin.delete')} ${tb.code}`}
                    onClick={() => setEditing({ kind: 'delete-table', row: tb })}
                  >
                    {t('admin.delete')}
                  </button>
                </td>
              </tr>
            ))}
            {tables.isSuccess && tables.data.length === 0 && (
              <EmptyRow cols={5} icon="tables" text={t('admin.tablesPage.empty')} />
            )}
          </tbody>
        </table>
      </div>
      {editing?.kind === 'area' && (
        <AreaDialog
          area={editing.row}
          onClose={close}
          onDone={() => void refresh()}
          onDelete={
            editing.row ? () => setEditing({ kind: 'delete-area', row: editing.row! }) : undefined
          }
        />
      )}
      {editing?.kind === 'table' && (
        <TableDialog
          table={editing.row}
          areas={areas.data ?? []}
          onClose={close}
          onDone={() => void refresh()}
        />
      )}
      {editing?.kind === 'delete-table' && (
        <ConfirmDelete
          name={editing.row.code}
          run={() => api(`/tables/${editing.row.id}`, { method: 'DELETE' })}
          onDone={() => void refresh()}
          onClose={close}
        />
      )}
      {editing?.kind === 'delete-area' && (
        <ConfirmDelete
          name={editing.row.name}
          run={() => api(`/areas/${editing.row.id}`, { method: 'DELETE' })}
          onDone={() => void refresh()}
          onClose={close}
        />
      )}
    </div>
  );
}

function AreaDialog({
  area,
  onClose,
  onDone,
  onDelete,
}: {
  area: AreaRow | null;
  onClose: () => void;
  onDone: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(area?.name ?? '');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () =>
      area
        ? api(`/areas/${area.id}`, { method: 'PATCH', body: { name: name.trim() } })
        : api('/areas', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog
      title={area ? t('admin.tablesPage.editArea') : t('admin.tablesPage.newArea')}
      onClose={onClose}
    >
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
        <div className="flex items-center justify-end gap-2">
          {onDelete && (
            <button className="btn-danger-quiet me-auto" onClick={onDelete}>
              {t('admin.delete')}
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {area ? t('admin.save') : t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function TableDialog({
  table,
  areas,
  onClose,
  onDone,
}: {
  table: TableRow | null;
  areas: AreaRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(table?.code ?? '');
  const [seats, setSeats] = useState(String(table?.seats ?? 4));
  const [areaId, setAreaId] = useState(table?.area_id ?? '');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { code: code.trim(), seats: Number(seats) || 4, area_id: areaId || null };
      return table
        ? api(`/tables/${table.id}`, { method: 'PATCH', body })
        : api('/tables', { method: 'POST', body });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog
      title={table ? t('admin.tablesPage.editTable') : t('admin.tablesPage.newTable')}
      onClose={onClose}
    >
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
            {table ? t('admin.save') : t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
