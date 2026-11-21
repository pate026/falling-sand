'use strict';

// grid is simulated at 200x150 cells and scaled up to 800x600 by css
const GRID_W = 200;
const GRID_H = 150;
const CELLS = GRID_W * GRID_H;

const EMPTY = 0;
const SAND = 1;
const WATER = 2;
const STONE = 3;
const WOOD = 4;
const FIRE = 5;
const SMOKE = 6;
const GUNPOWDER = 7;
const ACID = 8;
const LAVA = 9;

const FIRE_LIFE = 70;
const SMOKE_LIFE = 120;
const IGNITE_CHANCE = 0.06;
const BLAST_RADIUS = 6;
const ACID_DISSOLVE_CHANCE = 0.15;
const LAVA_FLOW_CHANCE = 0.25;
const LAVA_IGNITE_CHANCE = 0.15;
const STEP_MS = 1000 / 60;

// four-way neighbour offsets, used by the reaction rules
const DIR_X = [0, 0, -1, 1];
const DIR_Y = [-1, 1, 0, 0];

const DISSOLVES = [];
DISSOLVES[STONE] = true;
DISSOLVES[WOOD] = true;
DISSOLVES[SAND] = true;
DISSOLVES[GUNPOWDER] = true;

const KEY_TYPES = {
  0: EMPTY,
  1: SAND,
  2: WATER,
  3: STONE,
  4: WOOD,
  5: FIRE,
  6: SMOKE,
  7: GUNPOWDER,
  8: ACID,
  9: LAVA
};

const rand = Math.random;

// image data is a byte buffer, so colours are packed for the host byte order
const LITTLE_ENDIAN = (() => {
  const probe = new ArrayBuffer(4);
  new Uint32Array(probe)[0] = 0x01020304;
  return new Uint8Array(probe)[0] === 0x04;
})();

function pack(r, g, b) {
  return (LITTLE_ENDIAN
    ? (0xff000000 | (b << 16) | (g << 8) | r)
    : ((r << 24) | (g << 16) | (b << 8) | 0xff)) >>> 0;
}

function ramp(from, to, steps) {
  const out = new Uint32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = steps > 1 ? i / (steps - 1) : 0;
    out[i] = pack(
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t)
    );
  }
  return out;
}

const BACKGROUND = pack(0x12, 0x12, 0x14);

const SAND_PALETTE = ramp([240, 208, 124], [196, 148, 66], 8);
const WATER_PALETTE = ramp([92, 168, 234], [34, 92, 176], 8);
const STONE_PALETTE = ramp([138, 138, 148], [92, 92, 102], 6);
const WOOD_PALETTE = ramp([152, 108, 62], [104, 70, 40], 6);
const FIRE_PALETTE = ramp([255, 226, 130], [140, 22, 4], 12);
const SMOKE_PALETTE = ramp([188, 188, 198], [18, 18, 20], 16);
const GUNPOWDER_PALETTE = ramp([104, 102, 110], [44, 43, 48], 8);
const ACID_PALETTE = ramp([186, 255, 96], [72, 200, 44], 8);
const LAVA_PALETTE = ramp([255, 214, 110], [176, 38, 8], 6);

const grid = new Uint8Array(CELLS);
const life = new Uint8Array(CELLS);
const tint = new Uint8Array(CELLS);
const moved = new Uint8Array(CELLS);

let frame = 0;
let paused = false;
let activeType = SAND;
let brushSize = 4;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const image = ctx.createImageData(GRID_W, GRID_H);
const pixels = new Uint32Array(image.data.buffer);

const fpsEl = document.getElementById('fps');
const particlesEl = document.getElementById('particles');
const brushEl = document.getElementById('brush');
const brushValueEl = document.getElementById('brush-value');
const pauseEl = document.getElementById('pause');
const stepEl = document.getElementById('step');
const clearEl = document.getElementById('clear');
const elementButtons = Array.from(document.querySelectorAll('.element'));

function initialLife(type) {
  if (type === FIRE) return FIRE_LIFE * (0.75 + rand() * 0.25);
  if (type === SMOKE) return SMOKE_LIFE;
  return 0;
}

function place(i, type) {
  grid[i] = type;
  tint[i] = (rand() * 8) | 0;
  life[i] = initialLife(type);
}

function moveCell(from, to) {
  grid[to] = grid[from];
  life[to] = life[from];
  tint[to] = tint[from];
  grid[from] = EMPTY;
  life[from] = 0;
  moved[from] = 1;
  moved[to] = 1;
}

function swapCells(a, b) {
  const type = grid[a];
  grid[a] = grid[b];
  grid[b] = type;

  const ttl = life[a];
  life[a] = life[b];
  life[b] = ttl;

  const shade = tint[a];
  tint[a] = tint[b];
  tint[b] = shade;

  moved[a] = 1;
  moved[b] = 1;
}

// fire that meets water or burns out leaves smoke behind
function extinguish(i) {
  grid[i] = SMOKE;
  life[i] = SMOKE_LIFE;
  tint[i] = (rand() * 8) | 0;
}

function tryIgnite(i) {
  if (grid[i] !== WOOD || rand() >= IGNITE_CHANCE) return;
  place(i, FIRE);
  moved[i] = 1;
}

function neighborIndex(x, y, type) {
  for (let n = 0; n < 4; n++) {
    const nx = x + DIR_X[n];
    const ny = y + DIR_Y[n];
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
    const j = ny * GRID_W + nx;
    if (grid[j] === type) return j;
  }
  return -1;
}

function touches(x, y, type) {
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= GRID_H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= GRID_W) continue;
      if (grid[ny * GRID_W + nx] === type) return true;
    }
  }
  return false;
}

function detonateGunpowderNear(x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= GRID_H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= GRID_W) continue;
      if (grid[ny * GRID_W + nx] === GUNPOWDER) detonate(nx, ny);
    }
  }
}

// clears loose material in a circle and fills it with fire and smoke
function detonate(cx, cy) {
  const radius = BLAST_RADIUS;
  const radiusSq = radius * radius;

  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= GRID_H) continue;

    for (let dx = -radius; dx <= radius; dx++) {
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;

      const x = cx + dx;
      if (x < 0 || x >= GRID_W) continue;

      const j = y * GRID_W + x;
      const type = grid[j];
      const wasPowder = type === GUNPOWDER;
      if (type === SAND || type === WOOD || type === GUNPOWDER) grid[j] = EMPTY;
      else if (type !== EMPTY) continue;

      const dist = Math.sqrt(distSq);
      const roll = rand();
      if (wasPowder) {
        // burning powder keeps the chain reaction alive
        if (roll < 0.9) place(j, FIRE);
        else place(j, SMOKE);
      } else if (dist < 2.5) {
        if (roll < 0.8) place(j, FIRE);
        else if (roll < 0.95) place(j, SMOKE);
      } else if (dist < 4.5) {
        if (roll < 0.4) place(j, FIRE);
        else if (roll < 0.85) place(j, SMOKE);
      } else if (roll < 0.3) {
        place(j, FIRE);
      } else if (roll < 0.7) {
        place(j, SMOKE);
      }

      moved[j] = 1;
    }
  }
}

function dissolveNeighbor(x, y, i) {
  const start = (rand() * 4) | 0;
  for (let k = 0; k < 4; k++) {
    const n = (start + k) & 3;
    const nx = x + DIR_X[n];
    const ny = y + DIR_Y[n];
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;

    const j = ny * GRID_W + nx;
    if (!DISSOLVES[grid[j]]) continue;

    // the acid is spent along with whatever it eats through
    grid[j] = EMPTY;
    grid[i] = EMPTY;
    life[i] = 0;
    return;
  }
}

// one liquid step: down, diagonally down, then a sideways slide of up to `spread`
function flowLiquid(x, y, i, spread, snuffFire) {
  if (y + 1 < GRID_H) {
    const down = i + GRID_W;
    const below = grid[down];
    if (below === EMPTY) {
      moveCell(i, down);
      return;
    }
    if (snuffFire && below === FIRE) {
      extinguish(down);
      swapCells(i, down);
      return;
    }

    const dir = rand() < 0.5 ? -1 : 1;
    for (let s = 0; s < 2; s++) {
      const d = s === 0 ? dir : -dir;
      const nx = x + d;
      if (nx < 0 || nx >= GRID_W) continue;
      const j = down + d;
      if (snuffFire && grid[j] === FIRE) {
        extinguish(j);
        swapCells(i, j);
        return;
      }
      if (grid[j] === EMPTY) {
        moveCell(i, j);
        return;
      }
    }
  }

  // blocked below: slide sideways so the surface finds a level
  const dir = rand() < 0.5 ? -1 : 1;
  for (let s = 0; s < 2; s++) {
    const d = s === 0 ? dir : -dir;
    let target = i;
    for (let step = 1; step <= spread; step++) {
      const nx = x + d * step;
      if (nx < 0 || nx >= GRID_W) break;
      const j = i + d * step;
      if (grid[j] !== EMPTY) break;
      target = j;
    }
    if (target !== i) {
      moveCell(i, target);
      return;
    }
  }
}

function updateSand(x, y, i) {
  if (y + 1 >= GRID_H) return;
  const down = i + GRID_W;

  if (grid[down] === EMPTY) {
    moveCell(i, down);
    return;
  }
  // sand is denser than water, so the two swap places
  if (grid[down] === WATER) {
    swapCells(i, down);
    return;
  }

  const dir = rand() < 0.5 ? -1 : 1;
  for (let s = 0; s < 2; s++) {
    const d = s === 0 ? dir : -dir;
    const nx = x + d;
    if (nx < 0 || nx >= GRID_W) continue;
    const target = down + d;
    if (grid[target] === EMPTY) {
      moveCell(i, target);
      return;
    }
    if (grid[target] === WATER && rand() < 0.6) {
      swapCells(i, target);
      return;
    }
  }
}

function updateWater(x, y, i) {
  // water meeting lava chills it even when the lava is stepped later
  const lava = neighborIndex(x, y, LAVA);
  if (lava >= 0) {
    grid[lava] = STONE;
    life[lava] = 0;
    extinguish(i);
    return;
  }

  flowLiquid(x, y, i, 3, true);
}

function updateGunpowder(x, y, i) {
  if (touches(x, y, FIRE) || touches(x, y, LAVA)) {
    detonate(x, y);
    return;
  }
  updateSand(x, y, i);
}

function updateAcid(x, y, i) {
  if (rand() < ACID_DISSOLVE_CHANCE) dissolveNeighbor(x, y, i);
  if (grid[i] !== ACID) return;
  flowLiquid(x, y, i, 3, false);
}

function updateLava(x, y, i) {
  const water = neighborIndex(x, y, WATER);
  if (water >= 0) {
    // lava chills into stone and the water flashes to steam
    grid[i] = STONE;
    life[i] = 0;
    extinguish(water);
    return;
  }

  for (let n = 0; n < 4; n++) {
    const nx = x + DIR_X[n];
    const ny = y + DIR_Y[n];
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
    const j = ny * GRID_W + nx;
    if (grid[j] === WOOD && rand() < LAVA_IGNITE_CHANCE) {
      place(j, FIRE);
      moved[j] = 1;
    }
  }

  detonateGunpowderNear(x, y);

  // lava creeps instead of flowing
  if (rand() < LAVA_FLOW_CHANCE) flowLiquid(x, y, i, 1, false);
}

function updateFire(x, y, i) {
  if ((y + 1 < GRID_H && grid[i + GRID_W] === WATER) ||
      (y > 0 && grid[i - GRID_W] === WATER) ||
      (x > 0 && grid[i - 1] === WATER) ||
      (x + 1 < GRID_W && grid[i + 1] === WATER)) {
    extinguish(i);
    return;
  }

  if (y > 0) tryIgnite(i - GRID_W);
  if (y + 1 < GRID_H) tryIgnite(i + GRID_W);
  if (x > 0) tryIgnite(i - 1);
  if (x + 1 < GRID_W) tryIgnite(i + 1);

  detonateGunpowderNear(x, y);

  if (life[i] > 0) life[i]--;
  if (life[i] === 0) extinguish(i);
}

function updateSmoke(x, y, i) {
  if (life[i] > 0) life[i]--;
  if (life[i] === 0) {
    grid[i] = EMPTY;
    return;
  }

  if (y > 0 && grid[i - GRID_W] === EMPTY) {
    moveCell(i, i - GRID_W);
    return;
  }

  const dir = rand() < 0.5 ? -1 : 1;
  for (let s = 0; s < 2; s++) {
    const d = s === 0 ? dir : -dir;
    const nx = x + d;
    if (y === 0 || nx < 0 || nx >= GRID_W) continue;
    const target = i - GRID_W + d;
    if (grid[target] === EMPTY) {
      moveCell(i, target);
      return;
    }
  }

  if (rand() < 0.3) {
    const nx = x + dir;
    if (nx >= 0 && nx < GRID_W && grid[i + dir] === EMPTY) {
      moveCell(i, i + dir);
    }
  }
}

function update() {
  moved.fill(0);
  const flip = rand() < 0.5;

  // bottom to top, with a fresh horizontal direction each frame
  for (let y = GRID_H - 1; y >= 0; y--) {
    const row = y * GRID_W;
    for (let k = 0; k < GRID_W; k++) {
      const x = flip ? GRID_W - 1 - k : k;
      const i = row + x;
      if (moved[i]) continue;

      const type = grid[i];
      if (type === SAND) updateSand(x, y, i);
      else if (type === WATER) updateWater(x, y, i);
      else if (type === FIRE) updateFire(x, y, i);
      else if (type === SMOKE) updateSmoke(x, y, i);
      else if (type === GUNPOWDER) updateGunpowder(x, y, i);
      else if (type === ACID) updateAcid(x, y, i);
      else if (type === LAVA) updateLava(x, y, i);
    }
  }

  frame++;
}

function render() {
  let count = 0;
  const t = frame;

  for (let y = 0; y < GRID_H; y++) {
    const row = y * GRID_W;
    for (let x = 0; x < GRID_W; x++) {
      const i = row + x;
      const type = grid[i];
      if (type === EMPTY) {
        pixels[i] = BACKGROUND;
        continue;
      }

      count++;
      const shade = tint[i];

      switch (type) {
        case SAND:
          pixels[i] = SAND_PALETTE[shade & 7];
          break;
        case WATER:
          pixels[i] = WATER_PALETTE[(shade + ((x + y + (t >> 3)) & 3)) & 7];
          break;
        case STONE:
          pixels[i] = STONE_PALETTE[shade % 6];
          break;
        case WOOD:
          pixels[i] = WOOD_PALETTE[shade % 6];
          break;
        case GUNPOWDER:
          pixels[i] = GUNPOWDER_PALETTE[shade & 7];
          break;
        case ACID:
          pixels[i] = ACID_PALETTE[(shade + ((x + y + (t >> 3)) & 3)) & 7];
          break;
        case LAVA:
          pixels[i] = LAVA_PALETTE[(shade + (t >> 4)) % 6];
          break;
        case FIRE: {
          let idx = ((1 - life[i] / FIRE_LIFE) * (FIRE_PALETTE.length - 1)) | 0;
          idx += ((shade + t) & 3) - 1;
          if (idx < 0) idx = 0;
          else if (idx >= FIRE_PALETTE.length) idx = FIRE_PALETTE.length - 1;
          pixels[i] = FIRE_PALETTE[idx];
          break;
        }
        case SMOKE: {
          let idx = ((1 - life[i] / SMOKE_LIFE) * (SMOKE_PALETTE.length - 1)) | 0;
          if (idx < 0) idx = 0;
          else if (idx >= SMOKE_PALETTE.length) idx = SMOKE_PALETTE.length - 1;
          pixels[i] = SMOKE_PALETTE[idx];
          break;
        }
        default:
          pixels[i] = BACKGROUND;
          break;
      }
    }
  }

  ctx.putImageData(image, 0, 0);
  particlesEl.textContent = count.toLocaleString('en-US');
}

function paintAt(cx, cy) {
  const radius = brushSize / 2;
  const radiusSq = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(GRID_W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(GRID_H - 1, Math.ceil(cy + radius));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radiusSq) continue;

      const i = y * GRID_W + x;
      if (activeType === EMPTY) {
        grid[i] = EMPTY;
        life[i] = 0;
      } else {
        place(i, activeType);
      }
    }
  }
}

function paintLine(x0, y0, x1, y1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    paintAt(
      Math.round(x0 + (x1 - x0) * t),
      Math.round(y0 + (y1 - y0) * t)
    );
  }
}

function pointerCell(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.floor(((event.clientX - rect.left) / rect.width) * GRID_W),
    y: Math.floor(((event.clientY - rect.top) / rect.height) * GRID_H)
  };
}

let painting = false;
let lastCell = null;

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  painting = true;
  canvas.setPointerCapture(event.pointerId);
  lastCell = pointerCell(event);
  paintAt(lastCell.x, lastCell.y);
});

canvas.addEventListener('pointermove', (event) => {
  if (!painting) return;
  const cell = pointerCell(event);
  if (lastCell) paintLine(lastCell.x, lastCell.y, cell.x, cell.y);
  else paintAt(cell.x, cell.y);
  lastCell = cell;
});

function stopPainting() {
  painting = false;
  lastCell = null;
}

canvas.addEventListener('pointerup', stopPainting);
canvas.addEventListener('pointercancel', stopPainting);

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  setBrush(brushSize + (event.deltaY < 0 ? 1 : -1));
}, { passive: false });

function setBrush(size) {
  brushSize = Math.min(10, Math.max(1, size));
  brushEl.value = String(brushSize);
  brushValueEl.textContent = String(brushSize);
}

function selectType(type) {
  activeType = type;
  for (const button of elementButtons) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.type) === type));
  }
}

function togglePause() {
  paused = !paused;
  pauseEl.textContent = paused ? 'Resume' : 'Pause';
  pauseEl.setAttribute('aria-pressed', String(paused));
}

for (const button of elementButtons) {
  button.addEventListener('click', () => selectType(Number(button.dataset.type)));
}

brushEl.addEventListener('input', () => setBrush(Number(brushEl.value)));
pauseEl.addEventListener('click', togglePause);
stepEl.addEventListener('click', () => {
  update();
  render();
});
clearEl.addEventListener('click', () => {
  grid.fill(EMPTY);
  life.fill(0);
  render();
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    togglePause();
    return;
  }

  const type = KEY_TYPES[event.key];
  if (event.key.length === 1 && type !== undefined) selectType(type);
});

let lastTime = performance.now();
let accumulator = 0;
let fpsFrames = 0;
let fpsElapsed = 0;

function loop(now) {
  const dt = Math.min(now - lastTime, 250);
  lastTime = now;

  if (!paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < 4) {
      update();
      accumulator -= STEP_MS;
      steps++;
    }
    if (steps === 4) accumulator = 0;
  } else {
    accumulator = 0;
  }

  render();

  fpsFrames++;
  fpsElapsed += dt;
  if (fpsElapsed >= 500) {
    fpsEl.textContent = String(Math.round((fpsFrames * 1000) / fpsElapsed));
    fpsFrames = 0;
    fpsElapsed = 0;
  }

  requestAnimationFrame(loop);
}

setBrush(brushSize);
selectType(activeType);
requestAnimationFrame(loop);
