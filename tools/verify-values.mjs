/**
 * Independent check on the hand-authored face tables in src/dice/values.ts.
 *
 * Real polyhedral dice are numbered so that geometrically opposite faces sum to a
 * constant (max+1, or 9 on a 0-9 d10). Every value must also appear exactly once.
 * If a table entry were misread, one of those two invariants would break.
 */
import fs from 'node:fs';

const faces = JSON.parse(fs.readFileSync('public/dice/faces.json', 'utf8'));
const source = fs.readFileSync('src/dice/values.ts', 'utf8');

function table(die) {
  const match = source.match(new RegExp(`${die}:\\s*\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`no table for ${die}`);
  return match[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
}

let failures = 0;
const fail = (msg) => { console.error(`  FAIL ${msg}`); failures++; };

for (const die of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']) {
  const values = table(die);
  const data = faces[die];
  const slots = die === 'd4' ? data.hull.length : data.faces.length;
  console.log(`${die}: [${values.join(', ')}]`);

  if (values.length !== slots) fail(`${die} table has ${values.length} entries, geometry has ${slots}`);

  const expected = die === 'd10' ? [...Array(10)].map((_, i) => i + 1) : [...Array(slots)].map((_, i) => i + 1);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.join(',') !== expected.join(',')) fail(`${die} values are ${sorted.join(',')}, expected ${expected.join(',')}`);

  // Opposite-slot pairing. A d4 has no opposite vertices, so it is exempt.
  if (die === 'd4') { console.log('  (d4 read from the apex vertex — no opposite pairing)'); continue; }
  const directions = data.faces.map((f) => f.normal);
  // A d10 is numbered 0-9 with opposite faces summing to 9; we store ten as 10.
  const printed = (v) => (die === 'd10' ? v % 10 : v);
  const constant = die === 'd10' ? 9 : slots + 1;
  let ok = true;
  for (let i = 0; i < directions.length; i++) {
    const opposite = directions.findIndex(
      (n) => n[0] * directions[i][0] + n[1] * directions[i][1] + n[2] * directions[i][2] < -0.999,
    );
    if (opposite < 0) { fail(`${die} face ${i} has no opposite face`); ok = false; continue; }
    const sum = printed(values[i]) + printed(values[opposite]);
    if (sum !== constant) {
      fail(`${die} faces ${i}/${opposite} read ${printed(values[i])}+${printed(values[opposite])}=${sum}, expected ${constant}`);
      ok = false;
    }
  }
  if (ok) console.log(`  opposite faces all sum to ${constant}`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall face tables consistent');
process.exit(failures ? 1 : 0);
