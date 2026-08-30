import type { DieType } from './values';

/** How a pool's individual results collapse into the one number that is flashed. */
export type ResultMode = 'sum' | 'highest' | 'lowest';

export const RESULT_MODES: { id: ResultMode; label: string; description: string }[] = [
  { id: 'sum', label: 'Sum', description: 'Add every die together' },
  { id: 'highest', label: 'Highest', description: 'Keep the highest die, as with advantage' },
  { id: 'lowest', label: 'Lowest', description: 'Keep the lowest die, as with disadvantage' },
];

export interface Roll {
  type: DieType;
  value: number;
}

export interface Outcome {
  mode: ResultMode;
  /** The number to show. */
  value: number;
  /** Index of the die the result came from, or -1 when every die contributed. */
  keptIndex: number;
  /**
   * Every die that produced the winning value — more than one when they tie.
   * Empty under sum, where no die is singled out.
   */
  keptIndices: number[];
  critical: boolean;
  fumble: boolean;
}

const isNatural = (roll: Roll | undefined, value: number) => roll?.type === 'd20' && roll.value === value;

/**
 * Collapses a pool to its headline number.
 *
 * Highest and lowest compare raw face values, so they stay meaningful for a mixed
 * pool even though the mechanic they exist for — advantage and disadvantage — is
 * normally rolled on two of a kind. Ties keep the first die, which only matters
 * for which chip is marked, never for the number.
 */
export function resolveRoll(rolls: Roll[], mode: ResultMode): Outcome {
  if (rolls.length === 0) {
    return { mode, value: 0, keptIndex: -1, keptIndices: [], critical: false, fumble: false };
  }

  if (mode === 'sum') {
    const value = rolls.reduce((total, roll) => total + roll.value, 0);
    // A total is just a total; only a lone d20 reads as a natural roll.
    const lone = rolls.length === 1 ? rolls[0] : undefined;
    return {
      mode,
      value,
      keptIndex: -1,
      keptIndices: [],
      critical: isNatural(lone, 20),
      fumble: isNatural(lone, 1),
    };
  }

  let keptIndex = 0;
  for (let i = 1; i < rolls.length; i++) {
    const better = mode === 'highest' ? rolls[i].value > rolls[keptIndex].value : rolls[i].value < rolls[keptIndex].value;
    if (better) keptIndex = i;
  }

  const kept = rolls[keptIndex];
  return {
    mode,
    value: kept.value,
    keptIndex,
    // On a tie every die showing that value is equally the winner.
    keptIndices: rolls.flatMap((roll, i) => (roll.value === kept.value ? [i] : [])),
    critical: isNatural(kept, 20),
    fumble: isNatural(kept, 1),
  };
}
