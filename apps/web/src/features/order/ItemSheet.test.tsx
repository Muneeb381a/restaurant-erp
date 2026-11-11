import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../../lib/types';
import { ItemSheet } from './ItemSheet';

const base: MenuItem = {
  id: 'item1',
  code: null,
  name: 'Spicy Boti',
  nameUr: 'مسالہ بوٹی',
  kind: 'STANDARD',
  categoryId: null,
  station: null,
  available: true,
  searchTerms: null,
  variants: [{ id: 'v1', name: 'Regular', nameUr: null, isDefault: true, pricePaisa: 80000 }],
  modifierGroups: [],
  deal: null,
};

const render_ = (item: MenuItem) => {
  const onAdd = vi.fn();
  render(
    <ItemSheet item={item} busy={false} error={null} onClose={() => undefined} onAdd={onAdd} />,
  );
  return onAdd;
};
const addButton = () => screen.getByRole('button', { name: /^Add/ });

describe('ItemSheet', () => {
  it('adds a standard item with a quantity (price shown for orientation only)', async () => {
    const onAdd = render_(base);
    expect(addButton()).toHaveTextContent('Rs 800');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'plus' }));
    await user.click(screen.getByRole('button', { name: 'plus' }));
    expect(addButton()).toHaveTextContent('Rs 2,400');
    await user.click(addButton());
    expect(onAdd).toHaveBeenCalledWith({
      itemId: 'item1',
      variantId: 'v1',
      qty: 3,
      modifierIds: [],
    });
  });

  it('requires a choice in a required modifier group and sends the selected ids', async () => {
    const item: MenuItem = {
      ...base,
      modifierGroups: [
        {
          id: 'g1',
          code: 'SPICE',
          name: 'Spice',
          nameUr: null,
          minSelect: 1,
          maxSelect: 1,
          modifiers: [
            { id: 'm1', name: 'Mild', nameUr: null, priceDeltaPaisa: 0 },
            { id: 'm2', name: 'Extra hot', nameUr: null, priceDeltaPaisa: 5000 },
          ],
        },
      ],
    };
    const onAdd = render_(item);
    expect(addButton()).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Extra hot/ }));
    expect(addButton()).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Mild/ })); // max 1: replaces
    await user.click(addButton());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ modifierIds: ['m1'] }));
  });

  it('lets the user switch between variants (Half / Full)', async () => {
    const item: MenuItem = {
      ...base,
      variants: [
        { id: 'half', name: 'Half', nameUr: null, isDefault: true, pricePaisa: 110000 },
        { id: 'full', name: 'Full', nameUr: null, isDefault: false, pricePaisa: 210000 },
      ],
    };
    const onAdd = render_(item);
    await userEvent.setup().click(screen.getByRole('button', { name: /Full/ }));
    await userEvent.setup().click(addButton());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ variantId: 'full' }));
  });

  it('needs a weight for weighed items and sends grams (no quantity)', async () => {
    const item: MenuItem = {
      ...base,
      kind: 'WEIGHT',
      variants: [{ id: 'kg', name: 'Per kg', nameUr: null, isDefault: true, pricePaisa: 480000 }],
    };
    const onAdd = render_(item);
    expect(addButton()).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /750/ }));
    await user.click(addButton());
    const body = onAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ itemId: 'item1', variantId: 'kg', weightG: 750 });
    expect(body).not.toHaveProperty('qty');
  });

  it('deal: pre-fills fixed/default components, needs the open choice completed, and sends the picks', async () => {
    const item: MenuItem = {
      ...base,
      kind: 'DEAL',
      deal: {
        slots: [
          {
            id: 's-naan',
            name: 'Naan',
            qty: 4,
            options: [
              {
                id: 'o-naan',
                variantId: 'vn',
                itemName: 'Naan',
                itemNameUr: null,
                variantName: 'Regular',
                priceDeltaPaisa: 0,
                isDefault: false,
                available: true,
              },
            ],
          },
          {
            id: 's-drink',
            name: 'Drinks',
            qty: 2,
            options: [
              {
                id: 'o-cola',
                variantId: 'vc',
                itemName: 'Cola',
                itemNameUr: null,
                variantName: 'Regular',
                priceDeltaPaisa: 0,
                isDefault: false,
                available: true,
              },
              {
                id: 'o-sprite',
                variantId: 'vs',
                itemName: 'Sprite',
                itemNameUr: null,
                variantName: 'Regular',
                priceDeltaPaisa: 0,
                isDefault: false,
                available: false,
              },
            ],
          },
        ],
      },
    };
    const onAdd = render_(item);
    expect(addButton()).toBeDisabled(); // drinks not chosen yet
    const user = userEvent.setup();
    const plus = screen.getAllByRole('button', { name: 'plus' });
    // naan (fixed 4) is pre-filled; sold-out Sprite cannot be added; two colas fill the slot
    expect(plus[2]).toBeDisabled();
    await user.click(plus[1]!);
    await user.click(plus[1]!);
    await user.click(plus[1]!); // third click is ignored: slot is full
    expect(addButton()).toBeEnabled();
    await user.click(addButton());
    const picks = (onAdd.mock.calls[0]![0] as { dealPicks: unknown[] }).dealPicks;
    expect(picks).toEqual([
      { slotId: 's-naan', optionId: 'o-naan', count: 4 },
      { slotId: 's-drink', optionId: 'o-cola', count: 2 },
    ]);
  });
});
