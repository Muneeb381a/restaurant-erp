import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/Modal';
import { api, ApiError } from '../../lib/api';
import type { Order } from '../../lib/types';

/** Who a takeaway or delivery is for: printed on its token, kitchen ticket and bill (the address on a delivery bill). */
export function CustomerDialog({
  order,
  onClose,
  onSaved,
}: {
  order: Order;
  onClose: () => void;
  onSaved: (o: Order) => void;
}) {
  const { t } = useTranslation();
  const delivery = order.type === 'DELIVERY';
  const [name, setName] = useState(order.customerName ?? '');
  const [phone, setPhone] = useState(order.customerPhone ?? '');
  const [address, setAddress] = useState(order.deliveryAddress ?? '');
  const [channel, setChannel] = useState(order.channel ?? 'POS');
  const [ref, setRef] = useState(order.externalRef ?? '');
  const save = useMutation({
    mutationFn: () =>
      api<Order>(`/orders/${order.id}`, {
        method: 'PATCH',
        ifMatch: order.version,
        body: {
          customerName: name.trim() || null,
          customerPhone: phone.trim() || null,
          channel,
          externalRef: channel === 'POS' ? null : ref.trim() || null,
          ...(delivery ? { deliveryAddress: address.trim() || null } : {}),
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <Modal
      title={t('order.customerTitle')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('admin.save')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="label">{t('order.custName')}</span>
          <input
            className="input"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('order.custPhone')}</span>
          <input
            className="input"
            dir="ltr"
            inputMode="tel"
            maxLength={30}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="label">Order came from</span>
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="POS">Counter</option>
            <option value="PHONE">Phone call</option>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="FOODPANDA">Foodpanda</option>
            <option value="WEB">Website</option>
            <option value="OTHER">Other online</option>
          </select>
        </label>
        {channel !== 'POS' && (
          <label className="block space-y-1">
            <span className="label">Their order number (optional)</span>
            <input
              className="input"
              dir="ltr"
              maxLength={40}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </label>
        )}
        {delivery && (
          <label className="block space-y-1">
            <span className="label">{t('order.custAddress')}</span>
            <textarea
              className="input min-h-20"
              maxLength={300}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
        )}
        <p className="hint">{t(delivery ? 'order.custHintDelivery' : 'order.custHint')}</p>
        {save.error && (
          <p role="alert" className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">
            {save.error instanceof ApiError ? save.error.message : t('common.error')}
          </p>
        )}
      </div>
    </Modal>
  );
}
