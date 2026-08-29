/**
 * Which number is printed where, per die type.
 *
 * These tables were read off the model itself: tools/calibrate.mjs renders every
 * face of every die looking straight down that face's normal and drops a crosshair
 * on the face centre, so the glyph under the crosshair is the value for that slot.
 * `npm run verify` re-checks them against the opposite-faces-sum invariant.
 *
 * Slot ordering matches public/dice/faces.json, which the asset pipeline derives
 * deterministically from the source GLB.
 */
export type DieType = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20';

export const DIE_TYPES: DieType[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];

/**
 * d4 is indexed by hull *vertex*, every other die by face.
 *
 * A d4 carries no numeral at its face centres — it prints three numerals per face,
 * one at each corner — so it is read from the apex that points up, which is the
 * vertex opposite the face it came to rest on. The other dice are read from the
 * face whose normal points up.
 */
export const FACE_VALUES: Record<DieType, number[]> = {
  d4: [1, 4, 3, 2],
  d6: [4, 1, 3, 6, 5, 2],
  d8: [7, 1, 4, 6, 5, 3, 2, 8],
  // The d10 prints 0 for ten. Faces 0 and 7 carry the dotted 9 and 6.
  d10: [9, 5, 3, 7, 1, 8, 2, 6, 4, 10],
  d12: [8, 2, 7, 4, 10, 12, 3, 9, 1, 6, 11, 5],
  // Face 16 carries the maker's crescent logo in place of a "20".
  d20: [14, 11, 16, 19, 2, 5, 10, 7, 4, 18, 3, 17, 6, 9, 12, 15, 20, 8, 13, 1],
};

export const DIE_SIDES: Record<DieType, number> = {
  d4: 4,
  d6: 6,
  d8: 8,
  d10: 10,
  d12: 12,
  d20: 20,
};

/** True when the die is read from an upward-pointing vertex rather than a face. */
export const READS_FROM_VERTEX: Record<DieType, boolean> = {
  d4: true,
  d6: false,
  d8: false,
  d10: false,
  d12: false,
  d20: false,
};
