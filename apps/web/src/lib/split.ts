import { allocateProRata, asPaisa } from '@erp/domain';

/**
 * Splits a bill equally between `people` who each pay their share. The shares always add up to the
 * bill exactly: any odd paisa go to the last person (one paisa at most per person).
 */
export function splitEqually(totalPaisa: number, people: number): number[] {
  if (!Number.isInteger(people) || people < 1 || people > 20)
    throw new RangeError('people must be a whole number from 1 to 20');
  return allocateProRata(asPaisa(totalPaisa), Array<number>(people).fill(1)).map(Number);
}

/** Who pays for a dish: one person (0-based) or everybody equally. */
export type Owner = number | 'ALL';

/**
 * Splits a bill between people by what each one ate. `netPaisa[k]` is what dish line k costs and
 * `owners[k]` says who pays for it. Service charge, tax and any discount are shared in proportion to
 * what each person ordered, and the shares ALWAYS add up to the bill exactly (odd paisa on the last person).
 * A dish shared by everybody counts equally for each person; the weights stay whole numbers by scaling
 * a personal dish by the number of people.
 */
export function splitByDishes(
  totalPaisa: number,
  netPaisa: readonly number[],
  owners: readonly Owner[],
  people: number,
): number[] {
  if (!Number.isInteger(people) || people < 2 || people > 20)
    throw new RangeError('people must be a whole number from 2 to 20');
  if (netPaisa.length !== owners.length) throw new RangeError('every dish needs exactly one owner');
  const weights = Array<number>(people).fill(0);
  netPaisa.forEach((net, k) => {
    const owner = owners[k]!;
    if (!Number.isInteger(net) || net < 0) throw new RangeError('a dish cannot cost less than 0');
    if (owner === 'ALL') for (let p = 0; p < people; p++) weights[p]! += net;
    else if (Number.isInteger(owner) && owner >= 0 && owner < people)
      weights[owner]! += net * people;
    else throw new RangeError('that person is not in the group');
  });
  if (weights.every((w) => w === 0)) throw new RangeError('nothing to split');
  return allocateProRata(asPaisa(totalPaisa), weights).map(Number);
}
