import { asPaisa, type Paisa } from '../money';

export interface ModifierDef {
  id: string;
  priceDeltaPaisa: Paisa;
  isActive: boolean;
}

/** A modifier group as attached to an item (e.g. "Spice level": min 1, max 1). */
export interface ModifierGroupDef {
  id: string;
  minSelect: number;
  maxSelect: number;
  modifiers: readonly ModifierDef[];
}

export type ModifierErrorCode =
  | 'MODIFIER_UNKNOWN'
  | 'MODIFIER_INACTIVE'
  | 'MODIFIER_DUPLICATE'
  | 'MODIFIER_GROUP_MIN'
  | 'MODIFIER_GROUP_MAX';

export class ModifierError extends Error {
  constructor(
    readonly code: ModifierErrorCode,
    message: string,
    readonly groupId?: string,
  ) {
    super(message);
  }
}

export interface ModifierSelectionResult {
  /** Sum of price deltas for ONE unit of the item (quantity is applied by line pricing). */
  deltaPerUnitPaisa: Paisa;
  selected: { modifierId: string; groupId: string; priceDeltaPaisa: Paisa }[];
}

/**
 * Validates a customer's modifier choices against the groups attached to the item:
 * every id must belong to an attached group and be active, no repeats, and each group's
 * count must be within [minSelect, maxSelect].
 */
export function validateModifierSelection(
  groups: readonly ModifierGroupDef[],
  selectedIds: readonly string[],
): ModifierSelectionResult {
  const owner = new Map<string, { group: ModifierGroupDef; mod: ModifierDef }>();
  for (const group of groups) for (const mod of group.modifiers) owner.set(mod.id, { group, mod });

  const seen = new Set<string>();
  const perGroup = new Map<string, number>();
  const selected: ModifierSelectionResult['selected'] = [];
  let delta = 0;

  for (const id of selectedIds) {
    const hit = owner.get(id);
    if (!hit)
      throw new ModifierError('MODIFIER_UNKNOWN', `Modifier ${id} is not offered for this item`);
    if (!hit.mod.isActive)
      throw new ModifierError('MODIFIER_INACTIVE', `Modifier ${id} is not available`, hit.group.id);
    if (seen.has(id))
      throw new ModifierError('MODIFIER_DUPLICATE', `Modifier ${id} selected twice`, hit.group.id);
    seen.add(id);
    perGroup.set(hit.group.id, (perGroup.get(hit.group.id) ?? 0) + 1);
    delta += hit.mod.priceDeltaPaisa;
    selected.push({
      modifierId: id,
      groupId: hit.group.id,
      priceDeltaPaisa: hit.mod.priceDeltaPaisa,
    });
  }

  for (const group of groups) {
    const n = perGroup.get(group.id) ?? 0;
    if (n < group.minSelect) {
      throw new ModifierError(
        'MODIFIER_GROUP_MIN',
        `Group ${group.id}: choose at least ${group.minSelect}`,
        group.id,
      );
    }
    if (n > group.maxSelect) {
      throw new ModifierError(
        'MODIFIER_GROUP_MAX',
        `Group ${group.id}: choose at most ${group.maxSelect}`,
        group.id,
      );
    }
  }
  return { deltaPerUnitPaisa: asPaisa(delta), selected };
}
