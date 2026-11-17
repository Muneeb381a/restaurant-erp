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
