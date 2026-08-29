import type { DiceSet } from '../assets';
import { DIE_TYPES, type DieType } from '../dice/values';
import { RESULT_MODES, type Outcome, type ResultMode, type Roll } from '../dice/outcome';
import type { DragState } from '../input/throw-input';

export interface HudCallbacks {
  onPoolChange(pool: DieType[]): void;
  onRoll(): void;
  onSetChange(setId: string): void;
  onSoundToggle(enabled: boolean): void;
  onModeChange(mode: ResultMode): void;
}

const MAX_POOL = 12;

export class Hud {
  private pool: DieType[] = ['d20'];
  private readonly callbacks: HudCallbacks;

  private readonly poolRow = document.getElementById('pool') as HTMLElement;
  private readonly picker = document.getElementById('die-picker') as HTMLElement;
  private readonly swatches = document.getElementById('swatches') as HTMLElement;
  private readonly rollButton = document.getElementById('roll') as HTMLButtonElement;
  private readonly clearButton = document.getElementById('clear') as HTMLButtonElement;
  private readonly soundButton = document.getElementById('sound-toggle') as HTMLButtonElement;
  private readonly controls = document.getElementById('controls') as HTMLElement;
  private readonly reveal = document.getElementById('reveal') as HTMLElement;
  private readonly revealTotal = document.getElementById('reveal-total') as HTMLElement;
  private readonly revealCaption = document.getElementById('reveal-caption') as HTMLElement;
  private readonly revealBreakdown = document.getElementById('reveal-breakdown') as HTMLElement;
  private readonly hint = document.getElementById('hint') as HTMLElement;
  private readonly loader = document.getElementById('loader') as HTMLElement;

  private readonly pickerButtons = new Map<DieType, { button: HTMLButtonElement; badge: HTMLElement }>();
  private readonly modes = document.getElementById('modes') as HTMLElement;
  private mode: ResultMode = 'sum';

  private aim: SVGSVGElement | null = null;
  private aimLine: SVGLineElement | null = null;
  private aimHead: SVGPolygonElement | null = null;
  private hasRolled = false;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.buildPicker();
    this.buildModes();
    this.buildAim();
    this.renderPool();

    this.rollButton.addEventListener('click', () => this.callbacks.onRoll());
    this.clearButton.addEventListener('click', () => this.setPool([]));
    this.soundButton.addEventListener('click', () => {
      const enabled = this.soundButton.getAttribute('aria-pressed') !== 'true';
      this.soundButton.setAttribute('aria-pressed', String(enabled));
      this.callbacks.onSoundToggle(enabled);
    });
  }

  private buildPicker() {
    for (const type of DIE_TYPES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'die-button';

      const label = document.createElement('span');
      label.textContent = type;
      // Carries how many of this type are staged. Without it the buttons read as
      // on/off toggles and nothing suggests that tapping again adds another die.
      const badge = document.createElement('span');
      badge.className = 'die-count';

      button.append(label, badge);
      button.addEventListener('click', () => this.addDie(type));
      this.picker.appendChild(button);
      this.pickerButtons.set(type, { button, badge });
    }
  }

  private buildModes() {
    for (const mode of RESULT_MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mode-button' + (mode.id === this.mode ? ' active' : '');
      button.textContent = mode.label;
      button.title = mode.description;
      button.setAttribute('aria-pressed', String(mode.id === this.mode));
      button.addEventListener('click', () => {
        this.mode = mode.id;
        this.modes.querySelectorAll('.mode-button').forEach((el, index) => {
          const active = RESULT_MODES[index].id === mode.id;
          el.classList.toggle('active', active);
          el.setAttribute('aria-pressed', String(active));
        });
        this.callbacks.onModeChange(mode.id);
      });
      this.modes.appendChild(button);
    }
  }

  getMode(): ResultMode {
    return this.mode;
  }

  buildSwatches(sets: DiceSet[], activeId: string) {
    this.swatches.textContent = '';
    for (const set of sets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (set.id === activeId ? ' active' : '');
      button.style.background = set.swatch;
      button.title = set.name;
      button.setAttribute('aria-label', set.name);
      button.addEventListener('click', () => {
        this.swatches.querySelectorAll('.swatch').forEach((el) => el.classList.remove('active'));
        button.classList.add('active');
        this.callbacks.onSetChange(set.id);
      });
      this.swatches.appendChild(button);
    }
  }

  private buildAim() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'aim');
    Object.assign(svg.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '10',
      opacity: '0',
      transition: 'opacity 140ms ease',
    } satisfies Partial<CSSStyleDeclaration>);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('stroke', 'rgba(233,200,119,0.75)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-dasharray', '2 7');

    const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    head.setAttribute('fill', 'rgba(233,200,119,0.9)');

    svg.append(line, head);
    document.body.appendChild(svg);
    this.aim = svg;
    this.aimLine = line;
    this.aimHead = head;
  }

  /** Draws the flick vector while the pointer is down. */
  updateAim(drag: DragState) {
    if (!this.aim || !this.aimLine || !this.aimHead) return;
    const dx = drag.currentX - drag.originX;
    const dy = drag.currentY - drag.originY;
    const length = Math.hypot(dx, dy);

    if (!drag.active || length < 12) {
      this.aim.style.opacity = '0';
      return;
    }

    this.aim.style.opacity = '1';
    this.aimLine.setAttribute('x1', String(drag.originX));
    this.aimLine.setAttribute('y1', String(drag.originY));
    this.aimLine.setAttribute('x2', String(drag.currentX));
    this.aimLine.setAttribute('y2', String(drag.currentY));
    // Arrowhead scales with power, so a hard flick reads as a hard flick.
    const size = 7 + drag.power * 13;
    const ux = dx / length;
    const uy = dy / length;
    const tipX = drag.currentX + ux * size * 0.6;
    const tipY = drag.currentY + uy * size * 0.6;
    const points = [
      `${tipX},${tipY}`,
      `${drag.currentX - uy * size * 0.45},${drag.currentY + ux * size * 0.45}`,
      `${drag.currentX + uy * size * 0.45},${drag.currentY - ux * size * 0.45}`,
    ].join(' ');
    this.aimHead.setAttribute('points', points);
  }

  private addDie(type: DieType) {
    if (this.pool.length >= MAX_POOL) return;
    this.setPool([...this.pool, type]);
  }

  private removeDie(type: DieType) {
    const next = [...this.pool];
    const last = next.lastIndexOf(type);
    if (last < 0) return;
    next.splice(last, 1);
    this.setPool(next);
  }

  /** A round −/+ control for one end of a pool chip. */
  private stepper(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  setPool(pool: DieType[]) {
    this.pool = pool;
    this.renderPool();
    this.callbacks.onPoolChange(pool);
  }

  getPool(): DieType[] {
    return [...this.pool];
  }

  private renderPool() {
    this.poolRow.textContent = '';

    const counts = new Map<DieType, number>();
    for (const type of this.pool) counts.set(type, (counts.get(type) ?? 0) + 1);
    const full = this.pool.length >= MAX_POOL;

    // One chip per die type, as a −/+ stepper over its count.
    for (const type of DIE_TYPES) {
      const count = counts.get(type);
      if (!count) continue;

      const chip = document.createElement('span');
      chip.className = 'pool-chip';

      const label = document.createElement('span');
      label.className = 'pool-chip-label';
      label.textContent = count > 1 ? `${type} × ${count}` : type;

      const add = this.stepper('+', `Add one ${type}`, () => this.addDie(type));
      add.disabled = full;

      chip.append(
        this.stepper('−', `Remove one ${type}`, () => this.removeDie(type)),
        label,
        add,
      );
      this.poolRow.appendChild(chip);
    }

    for (const [type, { button, badge }] of this.pickerButtons) {
      const count = counts.get(type) ?? 0;
      button.classList.toggle('active', count > 0);
      badge.textContent = count > 0 ? String(count) : '';
      button.disabled = full;
      button.title = full ? `Maximum ${MAX_POOL} dice` : `Add a ${type}`;
      button.setAttribute(
        'aria-label',
        count > 0 ? `Add a ${type}, ${count} in the pool` : `Add a ${type}`,
      );
    }

    const empty = this.pool.length === 0;
    this.rollButton.disabled = empty;
    this.clearButton.disabled = empty;
  }

  showResult(rolls: Roll[], outcome: Outcome) {
    this.revealTotal.textContent = String(outcome.value);
    this.revealTotal.classList.remove('crit', 'fumble');
    if (outcome.critical) this.revealTotal.classList.add('crit');
    else if (outcome.fumble) this.revealTotal.classList.add('fumble');

    if (outcome.critical) this.revealCaption.textContent = 'critical';
    else if (outcome.fumble) this.revealCaption.textContent = 'fumble';
    else this.revealCaption.textContent = describeRoll(rolls, outcome.mode);

    // With more than one die the breakdown is the only place the dropped dice are
    // accounted for, which is the whole point of highest and lowest.
    this.revealBreakdown.textContent = '';
    if (rolls.length > 1) {
      rolls.forEach((roll, index) => {
        const chip = document.createElement('span');
        if (outcome.keptIndex >= 0) {
          chip.classList.add(index === outcome.keptIndex ? 'kept' : 'dropped');
        }
        // Mark a natural roll on its own chip too — in a sum it would otherwise
        // disappear into the total.
        if (roll.type === 'd20' && roll.value === 20) chip.classList.add('crit');
        else if (roll.type === 'd20' && roll.value === 1) chip.classList.add('fumble');

        chip.append(document.createTextNode(`${roll.type} `));
        const value = document.createElement('b');
        value.textContent = String(roll.value);
        chip.appendChild(value);
        this.revealBreakdown.appendChild(chip);
      });
    }

    // Restart the CSS animation from the top.
    this.reveal.classList.remove('show');
    void this.reveal.offsetWidth;
    this.reveal.classList.add('show');
  }

  setRolling(rolling: boolean) {
    this.controls.classList.toggle('dimmed', rolling);
    if (rolling) {
      this.hasRolled = true;
      this.hint.classList.add('hidden');
      this.reveal.classList.remove('show');
    }
  }

  hideLoader() {
    this.loader.classList.add('done');
    setTimeout(() => this.loader.remove(), 800);
    if (!this.hasRolled) this.hint.classList.remove('hidden');
  }
}

function describeRoll(rolls: Roll[], mode: ResultMode): string {
  if (rolls.length === 0) return '';
  const counts = new Map<DieType, number>();
  for (const roll of rolls) counts.set(roll.type, (counts.get(roll.type) ?? 0) + 1);
  const pool =
    rolls.length === 1 ? rolls[0].type : [...counts.entries()].map(([type, count]) => `${count}${type}`).join(' + ');

  if (mode === 'sum' || rolls.length === 1) return pool;
  return `${pool} · ${mode}`;
}
