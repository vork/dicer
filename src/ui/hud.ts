import type { DiceSet } from '../assets';
import { DIE_TYPES, type DieType } from '../dice/values';
import type { DragState } from '../input/throw-input';

export interface RollResult {
  total: number;
  rolls: { type: DieType; value: number }[];
}

export interface HudCallbacks {
  onPoolChange(pool: DieType[]): void;
  onRoll(): void;
  onSetChange(setId: string): void;
  onSoundToggle(enabled: boolean): void;
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

  private aim: SVGSVGElement | null = null;
  private aimLine: SVGLineElement | null = null;
  private aimHead: SVGPolygonElement | null = null;
  private hasRolled = false;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.buildPicker();
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
      button.textContent = type;
      button.addEventListener('click', () => this.addDie(type));
      this.picker.appendChild(button);
    }
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

    // Collapse duplicates into "3 x d6" style chips.
    const counts = new Map<DieType, number>();
    for (const type of this.pool) counts.set(type, (counts.get(type) ?? 0) + 1);

    for (const type of DIE_TYPES) {
      const count = counts.get(type);
      if (!count) continue;
      const chip = document.createElement('span');
      chip.className = 'pool-chip';
      chip.append(document.createTextNode(count > 1 ? `${count} × ${type}` : type));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '−';
      remove.setAttribute('aria-label', `Remove one ${type}`);
      remove.addEventListener('click', () => {
        const next = [...this.pool];
        next.splice(next.lastIndexOf(type), 1);
        this.setPool(next);
      });
      chip.appendChild(remove);
      this.poolRow.appendChild(chip);
    }

    const empty = this.pool.length === 0;
    this.rollButton.disabled = empty;
    this.clearButton.disabled = empty;
    this.picker.querySelectorAll('.die-button').forEach((button, index) => {
      button.classList.toggle('active', counts.has(DIE_TYPES[index]));
    });
  }

  showResult(result: RollResult) {
    const { total, rolls } = result;
    this.revealTotal.textContent = String(total);
    this.revealTotal.classList.remove('crit', 'fumble');

    // A lone d20 gets the natural-20 treatment; anything else just reads its total.
    const single = rolls.length === 1 ? rolls[0] : null;
    if (single?.type === 'd20' && single.value === 20) {
      this.revealTotal.classList.add('crit');
      this.revealCaption.textContent = 'critical';
    } else if (single?.type === 'd20' && single.value === 1) {
      this.revealTotal.classList.add('fumble');
      this.revealCaption.textContent = 'fumble';
    } else {
      this.revealCaption.textContent = describePool(rolls);
    }

    this.revealBreakdown.textContent = '';
    if (rolls.length > 1) {
      for (const roll of rolls) {
        const chip = document.createElement('span');
        chip.append(document.createTextNode(`${roll.type} `));
        const value = document.createElement('b');
        value.textContent = String(roll.value);
        chip.appendChild(value);
        this.revealBreakdown.appendChild(chip);
      }
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

  showError(message: string) {
    this.loader.classList.remove('done');
    this.loader.textContent = '';
    const text = document.createElement('div');
    text.className = 'loader-text';
    text.textContent = message;
    this.loader.appendChild(text);
  }
}

function describePool(rolls: { type: DieType; value: number }[]): string {
  if (rolls.length === 0) return '';
  if (rolls.length === 1) return rolls[0].type;
  const counts = new Map<DieType, number>();
  for (const roll of rolls) counts.set(roll.type, (counts.get(roll.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${count}${type}`).join(' + ');
}
