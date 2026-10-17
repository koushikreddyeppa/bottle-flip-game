/* ============================================================
   BOTTLE FLIP – game.js
   Full physics simulation + rendering on HTML5 Canvas
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
//  Constants & Config
// ─────────────────────────────────────────────────────────────
const CFG = {
  gravity:          0.38,       // px/frame² (tuned for landscape horizontal arc)
  flipVyMin:        -13,        // base vertical impulse
  flipVyMax:        -16,
  flipVxRange:      0.4,
  flipOmegaMin:     7.2,
  flipOmegaMax:     8.2,
  airDampOmega:     0.998,      // rotational air resistance
  airDampVx:        0.996,      // minimal horizontal drag for clean horizontal travel
  bounceEnergy:     0.22,       // coefficient of restitution
  floorBounce:      0.12,
  uprightTol:       28,
  sideDownTol:      68,
  settleVThresh:    1.5,
  settleOmegaThresh:0.9,
  platformW:        480,        // wide table
  platformH:        24,
  bottleW:          36,         // sleek Kinley bottle in landscape
  bottleH:          116,
  uprightWindow:    28,
};

// ─────────────────────────────────────────────────────────────
//  Hidden Difficulty Engine
//  Cycles through [hard, easy, medium] in shuffled random batches.
//  All tuning is done via invisible physics (spin rate + micro-drift).
//  The player sees and feels an identical launch every time.
// ─────────────────────────────────────────────────────────────

/*
  PHYSICS INSIGHT:
  Flight time ≈ 2 × |vy| / gravity ≈ 2×19/0.42 ≈ 90 frames.
  If omega × 90 = 720° (exactly 2 full spins) → bottle lands near 0° → EASY.
  Deviate omega by ±0.5 → lands ~45° off → MEDIUM.
  Deviate omega by ±1.0 and add edge-drift vx → lands ~90° off → HARD.
  The launch height/speed looks the same; only the invisible spin differs.
*/

const DIFF = {
  // Each profile: { omegaBias, vxBias, window }
  // omegaBias: added to the "perfect" omega so bottle lands off by target degrees
  // vxBias: subtle push toward platform edge on hard
  // window: landing tolerance in degrees
  easy:   { omegaBias:  0.00, vxBias: 0.0,  window: 32 },
  medium: { omegaBias:  0.50, vxBias: 0.15, window: 26 },
  hard:   { omegaBias:  1.05, vxBias: 0.38, window: 20 },
};

// Sequence state
let _diffSeq   = [];   // current shuffled batch of 3
let _diffIdx   = 0;    // pointer into batch
let _diffLevel = 'easy'; // active level for this flip

function _shuffleArray(arr) {
  // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _nextDifficulty() {
  if (_diffIdx >= _diffSeq.length) {
    // Refill with a new random shuffle of [hard, easy, medium]
    _diffSeq = _shuffleArray(['hard', 'easy', 'medium']);
    _diffIdx = 0;
  }
  _diffLevel = _diffSeq[_diffIdx++];
  return DIFF[_diffLevel];
}

function _resetDifficulty() {
  _diffSeq = [];
  _diffIdx = 0;
  _diffLevel = 'easy';
}

// ─────────────────────────────────────────────────────────────
//  Game State
// ─────────────────────────────────────────────────────────────
const State = {
  IDLE:       'idle',      // waiting for input
  FLIPPING:   'flipping',  // in air
  SETTLING:   'settling',  // landed, checking outcome
  LANDED:     'landed',    // confirmed upright landing
  FAILED:     'failed',    // confirmed fail
};

let state         = State.IDLE;
let score         = 0;
let bestScore     = parseInt(localStorage.getItem('bottle_flip_best') || '0', 10);
let animFrame     = null;
let settleTimer   = 0;
let confettiPieces = [];
let particles     = [];
let flightTrail   = []; // trajectory dots during flip flight
let shakeTimer    = 0;
let lastInputTime = 0;

// Hold / Charge timing
let isCharging      = false;
let chargeStartTime = 0;
let currentCharge   = 0;        // 0 to 1+ relative to sweet spot
const CHARGE_SWEET_TIME = 0.58; // optimal spacebar hold time (~580ms)
const CHARGE_MAX_TIME   = 1.35; // auto-release limit

// Canvas / context
let canvas, ctx;
let W, H;  // canvas logical size

// Bottle physics object
const bottle = {
  x: 0, y: 0,         // centre of bottle
  vx: 0, vy: 0,
  angle: 0,            // degrees; 0 = upright
  omega: 0,            // deg/frame
  onGround: false,
};

// Platform / landing table (static)
const platform = {
  x: 0, y: 0, w: 0, h: 0,
};

// Launch stand (visual only – where bottle rests before flip)
const stand = {
  x: 0,      // centre x
  topY: 0,   // top surface y (bottle sits here)
  r: 0,      // radius of stand top
  h: 0,      // stand height
};

// ─────────────────────────────────────────────────────────────
//  DOM References
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  start: $('screen-start'),
  game:  $('screen-game'),
  over:  $('screen-over'),
};

// ─────────────────────────────────────────────────────────────
//  Screen Management
// ─────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─────────────────────────────────────────────────────────────
//  Canvas Setup & Resize
// ─────────────────────────────────────────────────────────────
function initCanvas() {
  canvas = $('game-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  // Widescreen landscape view (16:9)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const targetRatio = 16 / 9;

  let cw, ch;
  if (vw / vh > targetRatio) {
    ch = vh;
    cw = vh * targetRatio;
  } else {
    cw = vw;
    ch = vw / targetRatio;
  }

  // Ensure minimum landscape size and integer pixels
  cw = Math.round(Math.min(cw, vw));
  ch = Math.round(Math.min(ch, vh));

  canvas.width  = Math.max(720, cw);
  canvas.height = Math.max(405, ch);
  canvas.style.width  = cw + 'px';
  canvas.style.height = ch + 'px';

  W = canvas.width;
  H = canvas.height;

  setupLayout();
}

function setupLayout() {
  // ── Landing dining table: wide platform on the right ──
  platform.h = Math.max(22, H * 0.045);
  platform.w = W * 0.52;
  platform.x = W * 0.40;
  platform.y = H * 0.72;

  // ── Launch stand: circular pedestal on the left with clear horizontal gap to table ──
  stand.r    = CFG.bottleW / 2 + Math.round(W * 0.014);
  stand.h    = H * 0.055;
  stand.x    = W * 0.16;
  stand.topY = platform.y - stand.h;

  if (state === State.IDLE || state === State.LANDED) {
    resetBottle();
  }
}

// ─────────────────────────────────────────────────────────────
//  Bottle Reset (place on platform, upright)
// ─────────────────────────────────────────────────────────────
function resetBottle() {
  // Bottle stands upright on the stand pedestal
  bottle.x = stand.x;
  bottle.y = stand.topY - CFG.bottleH / 2 - 2;
  bottle.vx = 0;
  bottle.vy = 0;
  bottle.angle = 0;
  bottle.omega = 0;
  bottle.onGround = true;

  // Clear charging state
  cancelCharging();
}

// ─────────────────────────────────────────────────────────────
//  Charging / Hold Time Mechanics
// ─────────────────────────────────────────────────────────────
function startCharging() {
  if (state !== State.IDLE || isCharging) return;
  isCharging = true;
  chargeStartTime = performance.now();
  currentCharge = 0;

  if (window.soundCtrl) {
    window.soundCtrl.startCharge();
  }
}

function releaseCharging() {
  if (!isCharging) return;
  const holdDurationSec = (performance.now() - chargeStartTime) / 1000;
  cancelCharging();
  launchFlip(holdDurationSec);
}

function cancelCharging() {
  isCharging = false;
  currentCharge = 0;
  if (window.soundCtrl) {
    window.soundCtrl.stopCharge();
  }
}

function updateCharge() {
  if (!isCharging || state !== State.IDLE) return;
  const elapsed = (performance.now() - chargeStartTime) / 1000;
  currentCharge = elapsed / CHARGE_SWEET_TIME; // 1.0 = sweet spot (~0.58s)

  // Auto-release if held beyond maximum limit so it doesn't stay held forever
  if (elapsed >= CHARGE_MAX_TIME) {
    releaseCharging();
    return;
  }

  // Energy spark particles rising from bottle base while charging
  if (Math.random() < 0.40) {
    const isSweet = currentCharge >= 0.82 && currentCharge <= 1.20;
    const isOver  = currentCharge > 1.20;
    particles.push({
      x: bottle.x + (Math.random() - 0.5) * (CFG.bottleW * 0.9),
      y: bottle.y + CFG.bottleH / 2 - 2,
      vx: (Math.random() - 0.5) * 1.8,
      vy: -Math.random() * 2.8 - 0.8,
      life: 0.75,
      decay: 0.05,
      size: 2.5 + Math.random() * 3,
      color: isOver ? '#ff6b6b' : (isSweet ? '#43e97b' : '#f7c948'),
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  Flip Launch (Length & Rotation Depend on Spacebar Hold Duration)
// ─────────────────────────────────────────────────────────────
function launchFlip(holdSec) {
  if (state !== State.IDLE) return;

  // Throttle double inputs
  const now = Date.now();
  if (now - lastInputTime < 150) return;
  lastInputTime = now;

  // Default to sweet-spot hold if called without duration
  const holdDuration = (typeof holdSec === 'number' && !isNaN(holdSec)) ? holdSec : CHARGE_SWEET_TIME;

  // ── Ratio relative to optimal sweet-spot hold (~580ms) ──
  // Clamp between a rapid tap (0.28) and maximum overcharge (1.80)
  const ratio = Math.max(0.28, Math.min(holdDuration / CHARGE_SWEET_TIME, 1.80));

  // ── Hidden Difficulty Adjustment ──
  const diff = _nextDifficulty();

  // 1. Vertical Impulse (vy) & Air Flight Time
  // Base vy is tuned for a sweeping horizontal landscape arc
  const baseVy = -14.2;
  const vy = (baseVy * Math.pow(ratio, 0.45)) + (Math.random() - 0.5) * 0.4;
  const estFlight = (2 * Math.abs(vy)) / CFG.gravity;

  // 2. Length of the Flip (horizontal travel distance vx across the table)
  // Short hold: lands short (gap between stand and table, or front edge)
  // Sweet hold: lands cleanly in the table center
  // Long hold: overshoots towards the far edge or off the table
  const tableCentreX  = platform.x + platform.w * 0.5;
  const idealDistance = tableCentreX - stand.x;
  const distanceFactor = 0.35 + 0.65 * ratio;
  const targetX = stand.x + idealDistance * distanceFactor;

  const edgeSign = Math.random() < 0.5 ? 1 : -1;
  const edgePush = diff.vxBias * edgeSign * (platform.w * 0.012);
  const baseVx   = (targetX - stand.x) / estFlight;
  const vx       = baseVx + (Math.random() - 0.5) * 0.10 + edgePush;

  // 3. Flip Rotation (angular velocity omega)
  // Ideal upright landing requires completing ~720° (2 full spins).
  // When ratio = 1.0 (sweet spot), omega provides ~720° -> lands upright!
  // When ratio < 0.8 (undercharged), omega is slow -> incomplete spin (~180° - 420°).
  // When ratio > 1.2 (overcharged), omega is fast -> over-rotates past 720° (~900°+).
  const perfectOmega = 720 / estFlight;
  const spinFactor   = Math.pow(ratio, 1.22);
  const biasSide     = Math.random() < 0.5 ? 1 : -1;
  const omega        = (perfectOmega * spinFactor) + (diff.omegaBias * biasSide);

  // Spin forward (clockwise)
  const dir = 1;

  // Apply physics values to bottle
  bottle.vy    = vy;
  bottle.vx    = vx;
  bottle.omega = omega * dir;
  bottle.onGround = false;

  // Store active window for this flip for landing tolerance
  CFG._activeWindow = diff.window;

  state = State.FLIPPING;
  settleTimer = 0;
  flightTrail = []; // reset flight trail dots

  // Launch sound power scales with hold duration
  const soundPower = Math.min(1.4, 0.7 + ratio * 0.45);
  window.soundCtrl.playFlip(soundPower);

  // Hide hint after flip
  $('hint-bar').classList.add('hidden');

  // Launch particles
  spawnLaunchParticles();
}

// ─────────────────────────────────────────────────────────────
//  Physics Update (called every frame)
// ─────────────────────────────────────────────────────────────
function physicsTick() {
  if (state !== State.FLIPPING && state !== State.SETTLING) return;

  // Gravity
  bottle.vy += CFG.gravity;

  // Air damping
  bottle.vx *= CFG.airDampVx;
  bottle.omega *= CFG.airDampOmega;

  // Integrate position & angle
  bottle.x += bottle.vx;
  bottle.y += bottle.vy;
  bottle.angle += bottle.omega;

  // Normalise angle to [-180, 180)
  bottle.angle = ((bottle.angle + 180) % 360 + 360) % 360 - 180;

  // Record flight trajectory dots while traveling horizontally in air
  if (state === State.FLIPPING) {
    flightTrail.push({
      x: bottle.x,
      y: bottle.y,
      alpha: 0.88,
      size: 3.8,
      color: '#38f9d7'
    });
  }

  // ── Platform collision ──
  const pfTop = platform.y;
  const pfLeft  = platform.x;
  const pfRight = platform.x + platform.w;

  // Compute bottle's bottom-most point (approx half-height of the bottle)
  const halfH = CFG.bottleH / 2;
  const halfW = CFG.bottleW / 2;
  const rad   = bottle.angle * Math.PI / 180;

  // Corner extremes of the bottle rectangle in world space
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  // Bottom contact point of bottle (lowest in Y)
  const bottleBottomY = bottle.y
    + Math.abs(sinA) * halfW
    + Math.abs(cosA) * halfH;

  // Horizontal extent
  const bottleLeft  = bottle.x - (Math.abs(cosA) * halfW + Math.abs(sinA) * halfH);
  const bottleRight = bottle.x + (Math.abs(cosA) * halfW + Math.abs(sinA) * halfH);

  const overlapX = bottleRight > pfLeft && bottleLeft < pfRight;
  const overlapY = bottleBottomY >= pfTop && bottle.y < pfTop + 40;

  if (overlapX && overlapY && bottle.vy > 0) {
    // Snap to surface
    bottle.y -= (bottleBottomY - pfTop);
    bottle.vy *= -CFG.bounceEnergy;
    bottle.vx *= 0.7;
    bottle.omega *= 0.55;

    if (Math.abs(bottle.vy) < 0.8) bottle.vy = 0;

    // Slight angular bounce
    bottle.omega *= -0.35;

    if (state === State.FLIPPING) {
      state = State.SETTLING;
      settleTimer = 0;
    }
  }

  // ── Floor (fell off) ──
  if (bottle.y > H + 80) {
    triggerFail('fell');
    return;
  }

  // ── Fell off platform sides ──
  if (state === State.SETTLING) {
    const centreOnPlatform = bottle.x > pfLeft + 10 && bottle.x < pfRight - 10;
    if (!centreOnPlatform && bottle.vy >= 0 && bottleBottomY >= pfTop - 5) {
      triggerFail('fell');
      return;
    }
  }

  // ── Settling check ──
  if (state === State.SETTLING) {
    const isQuiet = Math.abs(bottle.vy) < CFG.settleVThresh
                 && Math.abs(bottle.vx) < CFG.settleVThresh
                 && Math.abs(bottle.omega) < CFG.settleOmegaThresh;

    if (isQuiet) {
      settleTimer++;
      if (settleTimer > 18) {
        // Final verdict — use per-flip window set by difficulty engine
        const win      = CFG._activeWindow !== undefined ? CFG._activeWindow : CFG.uprightWindow;
        const absAngle = Math.abs(bottle.angle);
        const uprightDeg  = Math.min(absAngle, Math.abs(absAngle - 360));
        const upsideDown  = Math.abs(Math.abs(bottle.angle) - 180);

        if (uprightDeg <= win || upsideDown <= win) {
          triggerLand();
        } else {
          triggerFail('side');
        }
      }
    } else {
      settleTimer = 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Game Events
// ─────────────────────────────────────────────────────────────
function triggerLand() {
  state = State.LANDED;
  score++;
  if (score > bestScore) {
    bestScore = score;
    localStorage.setItem('bottle_flip_best', bestScore);
    window.soundCtrl.playFanfare();
  } else {
    window.soundCtrl.playLand(score);
  }

  updateHUD();
  popHUDScore();
  spawnConfetti();
  spawnLandParticles('#43e97b');

  // After short celebration, reset for next flip
  setTimeout(() => {
    if (state === State.LANDED) {
      state = State.IDLE;
      resetBottle();
      $('hint-bar').classList.remove('hidden');
    }
  }, 1200);
}

function triggerFail(reason) {
  if (state === State.FAILED) return;
  state = State.FAILED;

  window.soundCtrl.playCrash();
  shakeTimer = 18;
  spawnLandParticles('#ff6b6b');

  setTimeout(() => {
    showGameOver(reason);
  }, 700);
}

// ─────────────────────────────────────────────────────────────
//  HUD Updates
// ─────────────────────────────────────────────────────────────
function updateHUD() {
  $('hud-score').textContent = score;
  $('hud-best').textContent  = bestScore;
}

function popHUDScore() {
  const el = $('hud-score');
  el.classList.remove('pop');
  void el.offsetWidth; // reflow
  el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 250);
}

// ─────────────────────────────────────────────────────────────
//  Particles & Confetti
// ─────────────────────────────────────────────────────────────
function spawnLaunchParticles() {
  for (let i = 0; i < 10; i++) {
    particles.push({
      x: bottle.x + (Math.random() - 0.5) * 30,
      y: bottle.y + CFG.bottleH / 2,
      vx: (Math.random() - 0.5) * 5,
      vy: Math.random() * -4 - 1,
      life: 1,
      decay: 0.06 + Math.random() * 0.04,
      size: 4 + Math.random() * 4,
      color: `hsl(${200 + Math.random() * 60}, 80%, 65%)`,
    });
  }
}

function spawnLandParticles(baseColor) {
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    particles.push({
      x: bottle.x,
      y: bottle.y,
      vx: Math.cos(angle) * (2 + Math.random() * 4),
      vy: Math.sin(angle) * (2 + Math.random() * 4) - 2,
      life: 1,
      decay: 0.04 + Math.random() * 0.04,
      size: 5 + Math.random() * 5,
      color: baseColor,
    });
  }
}

function spawnConfetti() {
  const colors = ['#f7c948','#ff6b6b','#43e97b','#38f9d7','#a855f7','#3b82f6','#f97316'];
  for (let i = 0; i < 48; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    const color = colors[Math.floor(Math.random() * colors.length)];
    el.style.cssText = `
      left: ${10 + Math.random() * 80}%;
      top: 0;
      background: ${color};
      width: ${6 + Math.random() * 8}px;
      height: ${6 + Math.random() * 8}px;
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      animation-duration: ${1.2 + Math.random() * 1.4}s;
      animation-delay: ${Math.random() * 0.4}s;
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
}

function updateParticles() {
  particles = particles.filter(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.2;
    p.vx *= 0.96;
    p.life -= p.decay;
    return p.life > 0;
  });

  // Fade and shrink flight trajectory trail dots
  flightTrail.forEach(d => {
    d.alpha -= 0.024;
    d.size = Math.max(1.2, d.size * 0.985);
  });
  flightTrail = flightTrail.filter(d => d.alpha > 0);
}

// ─────────────────────────────────────────────────────────────
//  Rendering
// ─────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, W, H);

  drawRoomBackground();

  // Camera shake wrapper
  if (shakeTimer > 0) {
    const s = (shakeTimer / 18) * 8;
    ctx.save();
    ctx.translate(
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s
    );
    shakeTimer--;
  }

  drawTable();
  drawStand();
  drawTrajectoryDots(); // Trajectory dots (predictive arc & in-flight trail)
  drawParticles();
  drawBottle();
  drawStateOverlay();

  if (shakeTimer > 0) ctx.restore();
}

// ── Trajectory Dots (Predictive Dotted Arc & In-Flight Trail) ──
function drawTrajectoryDots() {
  // 1. Predictive trajectory dots when on the stand (State.IDLE)
  if (state === State.IDLE) {
    const ratio = isCharging
      ? Math.max(0.28, Math.min(currentCharge, 1.80))
      : 1.0;

    const isGuideOnly = !isCharging;

    const baseVy = -14.2;
    const simVy0 = baseVy * Math.pow(ratio, 0.45);
    const estFlight = (2 * Math.abs(simVy0)) / CFG.gravity;

    const tableCentreX  = platform.x + platform.w * 0.5;
    const idealDistance = tableCentreX - stand.x;
    const distanceFactor = 0.35 + 0.65 * ratio;
    const simTargetX    = stand.x + idealDistance * distanceFactor;
    const simVx0        = (simTargetX - stand.x) / estFlight;

    let sx = bottle.x;
    let sy = bottle.y;
    let svx = simVx0;
    let svy = simVy0;

    const isSweet = ratio >= 0.80 && ratio <= 1.22;
    const isOver  = ratio > 1.22;

    let dotColor;
    if (isGuideOnly) {
      dotColor = 'rgba(255, 255, 255, 0.28)';
    } else if (isOver) {
      dotColor = '#ff6b6b';
    } else if (isSweet) {
      dotColor = '#43e97b';
    } else {
      dotColor = '#f7c948';
    }

    const totalSteps = Math.round(estFlight);
    ctx.save();

    for (let i = 1; i <= totalSteps; i++) {
      svy += CFG.gravity;
      svx *= CFG.airDampVx;
      sx += svx;
      sy += svy;

      // Draw dot every 3 simulation frames
      if (i % 3 === 0) {
        const prog = i / totalSteps;
        const dotRadius = isGuideOnly ? 2.5 : (3.5 + Math.sin(prog * Math.PI) * 1.5);
        const dotAlpha  = isGuideOnly ? (0.22 + 0.15 * Math.sin(prog * Math.PI)) : (0.75 + 0.25 * Math.sin(prog * Math.PI));

        ctx.globalAlpha = dotAlpha;
        ctx.fillStyle = dotColor;
        if (!isGuideOnly) {
          ctx.shadowColor = dotColor;
          ctx.shadowBlur = 8;
        }
        ctx.beginPath();
        ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Check collision with platform surface
      if (sy >= platform.y && sx >= platform.x - 10) {
        // Target landing dot on the table
        const ringAlpha = isGuideOnly ? 0.35 : 0.88;
        ctx.globalAlpha = ringAlpha;
        ctx.fillStyle = dotColor;
        if (!isGuideOnly) {
          ctx.shadowColor = dotColor;
          ctx.shadowBlur = 12;
        }
        // Center landing dot
        ctx.beginPath();
        ctx.arc(sx, platform.y, isGuideOnly ? 4 : 5.5, 0, Math.PI * 2);
        ctx.fill();
        // Target ring
        ctx.strokeStyle = dotColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, platform.y, isGuideOnly ? 8 : 11, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  // 2. Flight Trajectory Dots (fading trail left behind while flipping)
  if (flightTrail.length > 0) {
    ctx.save();
    flightTrail.forEach(dot => {
      if (dot.alpha <= 0) return;
      ctx.globalAlpha = dot.alpha;
      ctx.fillStyle = dot.color || '#38f9d7';
      ctx.shadowColor = dot.color || '#38f9d7';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
}

// No-op kept for compatibility (startGame calls initStars)
function initStars() {}

// ── Home Interior Background ──
function drawRoomBackground() {
  // Sky/wall colour – warm off-white
  const wallTop    = '#f2ebe0';
  const wallMid    = '#ede4d6';
  const wallBot    = '#e6dbc8';

  // Back wall
  const wallGrad = ctx.createLinearGradient(0, 0, 0, H * 0.70);
  wallGrad.addColorStop(0, wallTop);
  wallGrad.addColorStop(1, wallBot);
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, W, H * 0.70);

  // ── Subtle wall panel lines (wainscoting) ──
  ctx.save();
  ctx.strokeStyle = 'rgba(180,160,130,0.35)';
  ctx.lineWidth = 1;
  // Horizontal rail at ~55% height
  const railY = H * 0.55;
  ctx.beginPath(); ctx.moveTo(0, railY); ctx.lineTo(W, railY); ctx.stroke();
  // Top cap line
  ctx.globalAlpha = 0.2;
  ctx.beginPath(); ctx.moveTo(0, H * 0.04); ctx.lineTo(W, H * 0.04); ctx.stroke();
  // Vertical panel dividers
  const panels = 3;
  for (let i = 1; i < panels; i++) {
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.moveTo((W / panels) * i, H * 0.04);
    ctx.lineTo((W / panels) * i, railY);
    ctx.stroke();
  }
  ctx.restore();

  // ── Window (centre-left of wall) ──
  const winX = W * 0.06, winY = H * 0.06;
  const winW = W * 0.22, winH = H * 0.28;
  ctx.save();
  // Window glass – sky blue
  const skyG = ctx.createLinearGradient(winX, winY, winX, winY + winH);
  skyG.addColorStop(0, '#b8d8f0');
  skyG.addColorStop(1, '#d8eefa');
  ctx.fillStyle = skyG;
  roundRect(ctx, winX, winY, winW, winH, 4);
  ctx.fill();
  // Soft sunlight overlay inside window
  ctx.fillStyle = 'rgba(255,240,200,0.18)';
  ctx.fillRect(winX, winY, winW, winH);
  // Cross-bars
  ctx.strokeStyle = '#c8b89a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(winX + winW / 2, winY); ctx.lineTo(winX + winW / 2, winY + winH);
  ctx.moveTo(winX, winY + winH / 2); ctx.lineTo(winX + winW, winY + winH / 2);
  ctx.stroke();
  // Frame
  ctx.strokeStyle = '#b0906a';
  ctx.lineWidth = 5;
  roundRect(ctx, winX, winY, winW, winH, 4);
  ctx.stroke();
  // Curtain left
  const cLG = ctx.createLinearGradient(winX - 10, winY, winX + 14, winY);
  cLG.addColorStop(0, '#d4876a'); cLG.addColorStop(1, 'rgba(212,135,106,0)');
  ctx.fillStyle = cLG;
  ctx.fillRect(winX - 10, winY, 24, winH + 8);
  // Curtain right
  const cRG = ctx.createLinearGradient(winX + winW - 14, winY, winX + winW + 10, winY);
  cRG.addColorStop(0, 'rgba(212,135,106,0)'); cRG.addColorStop(1, '#d4876a');
  ctx.fillStyle = cRG;
  ctx.fillRect(winX + winW - 14, winY, 24, winH + 8);
  ctx.restore();

  // ── Framed picture (right wall) ──
  const picX = W * 0.74, picY = H * 0.06;
  const picW = W * 0.18, picH = H * 0.20;
  ctx.save();
  ctx.fillStyle = '#c8aa88';
  ctx.fillRect(picX - 4, picY - 4, picW + 8, picH + 8);
  // Picture content – simple landscape
  const picG = ctx.createLinearGradient(picX, picY, picX, picY + picH);
  picG.addColorStop(0, '#7ec8e3'); picG.addColorStop(0.55, '#a8d8a0'); picG.addColorStop(1, '#88b878');
  ctx.fillStyle = picG;
  ctx.fillRect(picX, picY, picW, picH);
  // Mountain silhouette
  ctx.fillStyle = '#5a8a60';
  ctx.beginPath();
  ctx.moveTo(picX, picY + picH * 0.8);
  ctx.lineTo(picX + picW * 0.35, picY + picH * 0.45);
  ctx.lineTo(picX + picW * 0.6, picY + picH * 0.65);
  ctx.lineTo(picX + picW * 0.75, picY + picH * 0.5);
  ctx.lineTo(picX + picW, picY + picH * 0.75);
  ctx.lineTo(picX + picW, picY + picH); ctx.lineTo(picX, picY + picH);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // ── Skirting board / baseboard ──
  const sbY = H * 0.695;
  const sbH = H * 0.018;
  const sbG = ctx.createLinearGradient(0, sbY, 0, sbY + sbH);
  sbG.addColorStop(0, '#d4c4a8'); sbG.addColorStop(1, '#b8a888');
  ctx.fillStyle = sbG;
  ctx.fillRect(0, sbY, W, sbH);
  ctx.strokeStyle = 'rgba(140,120,90,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, sbY); ctx.lineTo(W, sbY); ctx.stroke();

  // ── Wooden floor ──
  const floorY = H * 0.71;
  const floorG = ctx.createLinearGradient(0, floorY, 0, H);
  floorG.addColorStop(0, '#c8956a');
  floorG.addColorStop(0.5, '#b07848');
  floorG.addColorStop(1, '#8a5c30');
  ctx.fillStyle = floorG;
  ctx.fillRect(0, floorY, W, H - floorY);
  // Floor planks
  ctx.save();
  ctx.strokeStyle = 'rgba(90,55,20,0.25)';
  ctx.lineWidth = 1.5;
  const plankH = H * 0.065;
  const planks = Math.ceil((H - floorY) / plankH) + 1;
  for (let r = 0; r < planks; r++) {
    const py = floorY + r * plankH;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    // Plank joints (vertical)
    const joints = 3 + r;
    for (let c = 1; c < joints; c++) {
      const px = (W / joints) * c + (r % 2 === 0 ? 0 : W / joints / 2);
      ctx.globalAlpha = 0.18;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + plankH); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  // Floor sheen
  const sheenG = ctx.createLinearGradient(0, floorY, W, floorY);
  sheenG.addColorStop(0.0, 'rgba(255,220,160,0.0)');
  sheenG.addColorStop(0.35,'rgba(255,220,160,0.12)');
  sheenG.addColorStop(0.55,'rgba(255,220,160,0.0)');
  ctx.fillStyle = sheenG;
  ctx.fillRect(0, floorY, W, H - floorY);
  ctx.restore();
}

// ── Big Wooden Dining Table ──
function drawTable() {
  const { x, y, w, h } = platform;
  const legW = Math.max(10, w * 0.04);
  const legH = H * 0.12;
  const legY = y + h;

  // Table legs
  const legGrad = ctx.createLinearGradient(0, legY, 0, legY + legH);
  legGrad.addColorStop(0, '#8B5E3C');
  legGrad.addColorStop(1, '#5C3A1E');

  [[x + legW * 0.5, legY], [x + w - legW * 1.5, legY]].forEach(([lx, ly]) => {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 3;
    ctx.fillStyle = legGrad;
    roundRect(ctx, lx, ly, legW, legH, 3);
    ctx.fill();
    ctx.restore();
    // Leg highlight
    ctx.save();
    ctx.fillStyle = 'rgba(255,200,140,0.18)';
    roundRect(ctx, lx + 2, ly, 3, legH * 0.7, 2);
    ctx.fill();
    ctx.restore();
  });

  // Table top shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur  = 20;
  ctx.shadowOffsetY = 8;

  // Table surface – warm wood
  const tg = ctx.createLinearGradient(x, y, x, y + h);
  tg.addColorStop(0, '#c8864a');
  tg.addColorStop(0.4, '#b8743a');
  tg.addColorStop(1, '#9a5c28');
  ctx.fillStyle = tg;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.restore();

  // Wood grain lines on table
  ctx.save();
  ctx.strokeStyle = 'rgba(80,40,10,0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const gx = x + (w / 6) * (i + 1);
    ctx.beginPath();
    ctx.moveTo(gx + Math.sin(i) * 3, y);
    ctx.lineTo(gx + Math.sin(i + 1) * 3, y + h);
    ctx.stroke();
  }
  ctx.restore();

  // Top-edge shine
  const shine = ctx.createLinearGradient(x, y, x, y + h * 0.5);
  shine.addColorStop(0, 'rgba(255,220,160,0.55)');
  shine.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = shine;
  roundRect(ctx, x + 4, y, w - 8, h * 0.5, 4);
  ctx.fill();

  // Subtle edge outline
  ctx.strokeStyle = 'rgba(80,40,10,0.3)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, 6);
  ctx.stroke();
}

// ── Small Circular Launch Stand ──
function drawStand() {
  const { x, topY, r, h } = stand;

  // Stand body (cylinder)
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;

  // Front face of cylinder (ellipse)
  const sg = ctx.createRadialGradient(x - r * 0.3, topY, r * 0.1, x, topY, r);
  sg.addColorStop(0, '#d0c0a8');
  sg.addColorStop(1, '#9a8870');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.ellipse(x, topY + h * 0.5, r, h * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Stand disc top
  ctx.save();
  const topG = ctx.createRadialGradient(x - r * 0.2, topY, 1, x, topY, r);
  topG.addColorStop(0, '#e8d8c0');
  topG.addColorStop(0.6, '#c8b090');
  topG.addColorStop(1, '#a89070');
  ctx.fillStyle = topG;
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.ellipse(x, topY, r, r * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  // Top rim highlight
  ctx.strokeStyle = 'rgba(255,240,210,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ── Kinley Water Bottle ──
function drawBottle() {
  ctx.save();
  ctx.translate(bottle.x, bottle.y);

  // Charging squash & tension vibration while holding space
  if (isCharging && state === State.IDLE) {
    const chargeClamp = Math.min(currentCharge, 1.4);
    const scaleY = 1.0 - 0.12 * chargeClamp;
    const scaleX = 1.0 + 0.08 * chargeClamp;
    const jitterX = (Math.random() - 0.5) * 2.0 * chargeClamp;
    ctx.translate(jitterX, (1 - scaleY) * (CFG.bottleH / 2));
    ctx.scale(scaleX, scaleY);
  }

  ctx.rotate(bottle.angle * Math.PI / 180);

  const bW = CFG.bottleW;
  const bH = CFG.bottleH;
  const hw = bW / 2;
  const hh = bH / 2;

  // Helper: Kinley PET bottle outline path
  function kinleyPath() {
    ctx.beginPath();
    // Bottom rounded corners
    ctx.moveTo(-hw + 5, hh);
    ctx.quadraticCurveTo(-hw, hh, -hw, hh - 5);
    // Lower body
    ctx.lineTo(-hw, -hh * 0.38);
    // Shoulder taper (narrowing to neck)
    ctx.quadraticCurveTo(-hw * 1.0, -hh * 0.54, -hw * 0.6, -hh * 0.62);
    // Neck straight
    ctx.lineTo(-hw * 0.6, -hh * 0.76);
    // Cap shoulder bevel
    ctx.lineTo(-hw * 0.52, -hh * 0.81);
    ctx.lineTo(hw * 0.52, -hh * 0.81);
    ctx.lineTo(hw * 0.6, -hh * 0.76);
    ctx.lineTo(hw * 0.6, -hh * 0.62);
    ctx.quadraticCurveTo(hw * 1.0, -hh * 0.54, hw, -hh * 0.38);
    // Right body
    ctx.lineTo(hw, hh - 5);
    ctx.quadraticCurveTo(hw, hh, hw - 5, hh);
    ctx.closePath();
  }

  // ── Drop shadow ──
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 6;
  kinleyPath();
  // Transparent body fill for shadow only
  ctx.fillStyle = 'rgba(200,230,250,0.01)';
  ctx.fill();
  ctx.restore();

  // ── Clear PET body ──
  ctx.save();
  kinleyPath();
  const bodyG = ctx.createLinearGradient(-hw, 0, hw, 0);
  bodyG.addColorStop(0.00, 'rgba(210,238,255,0.92)');
  bodyG.addColorStop(0.25, 'rgba(235,248,255,0.80)');
  bodyG.addColorStop(0.60, 'rgba(215,240,255,0.78)');
  bodyG.addColorStop(1.00, 'rgba(180,220,245,0.90)');
  ctx.fillStyle = bodyG;
  ctx.fill();
  // Thin PET outline
  ctx.strokeStyle = 'rgba(100,170,220,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // ── Water fill (bottom ~45%) ──
  ctx.save();
  kinleyPath();
  ctx.clip();
  const waterY = hh * 0.08;
  const wg = ctx.createLinearGradient(0, waterY, 0, hh);
  wg.addColorStop(0, 'rgba(130,200,240,0.38)');
  wg.addColorStop(1, 'rgba(60,150,210,0.55)');
  ctx.fillStyle = wg;
  ctx.fillRect(-hw, waterY, bW, hh - waterY + hh);
  // Water surface wave
  ctx.beginPath();
  ctx.moveTo(-hw + 3, waterY);
  ctx.bezierCurveTo(-hw * 0.3, waterY - 4, hw * 0.3, waterY + 4, hw - 3, waterY - 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  // ── Horizontal rib lines ──
  ctx.save();
  kinleyPath();
  ctx.clip();
  ctx.strokeStyle = 'rgba(120,190,230,0.40)';
  ctx.lineWidth = 1;
  [-hh * 0.32, -hh * 0.22, hh * 0.62, hh * 0.74].forEach(ry => {
    ctx.beginPath();
    ctx.moveTo(-hw + 2, ry); ctx.lineTo(hw - 2, ry);
    ctx.stroke();
  });
  ctx.restore();

  // ── Blue KINLEY label band ──
  ctx.save();
  kinleyPath();
  ctx.clip();
  const labelTop = -hh * 0.18;
  const labelH   =  hh * 0.60;
  // Label gradient (Kinley blue)
  const lg = ctx.createLinearGradient(-hw, 0, hw, 0);
  lg.addColorStop(0.00, '#004a9e');
  lg.addColorStop(0.20, '#0065cc');
  lg.addColorStop(0.50, '#0080ee');
  lg.addColorStop(0.80, '#0065cc');
  lg.addColorStop(1.00, '#003e8a');
  ctx.fillStyle = lg;
  ctx.fillRect(-hw, labelTop, bW, labelH);
  // White label edge lines
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-hw, labelTop); ctx.lineTo(hw, labelTop);
  ctx.moveTo(-hw, labelTop + labelH); ctx.lineTo(hw, labelTop + labelH);
  ctx.stroke();
  // Coca-Cola wave swoosh on label
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-hw, labelTop + labelH * 0.55);
  ctx.bezierCurveTo(-hw * 0.3, labelTop + labelH * 0.30, hw * 0.3, labelTop + labelH * 0.75, hw, labelTop + labelH * 0.50);
  ctx.stroke();
  // KINLEY text
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 ${Math.round(bW * 0.36)}px Nunito, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,30,80,0.5)';
  ctx.shadowBlur = 3;
  ctx.fillText('KINLEY', 0, labelTop + labelH * 0.42);
  // Tagline under
  ctx.font = `600 ${Math.round(bW * 0.18)}px Nunito, Arial, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.80)';
  ctx.shadowBlur = 0;
  ctx.fillText('WATER', 0, labelTop + labelH * 0.72);
  ctx.restore();

  // ── White/silver screw cap ──
  ctx.save();
  const capG = ctx.createLinearGradient(-hw * 0.55, -hh, hw * 0.55, -hh * 0.79);
  capG.addColorStop(0.0, '#f4f4f4');
  capG.addColorStop(0.4, '#ffffff');
  capG.addColorStop(1.0, '#d0d0d0');
  ctx.fillStyle = capG;
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 5;
  roundRect(ctx, -hw * 0.55, -hh, hw * 1.1, hh * 0.21, 4);
  ctx.fill();
  // Cap ribbing
  ctx.strokeStyle = 'rgba(160,160,160,0.4)';
  ctx.lineWidth = 0.7;
  for (let i = 1; i <= 4; i++) {
    const ry = -hh + (hh * 0.21 / 5) * i;
    ctx.beginPath();
    ctx.moveTo(-hw * 0.53, ry); ctx.lineTo(hw * 0.53, ry);
    ctx.stroke();
  }
  // Cap outline
  ctx.strokeStyle = 'rgba(120,120,120,0.4)';
  ctx.lineWidth = 0.8;
  roundRect(ctx, -hw * 0.55, -hh, hw * 1.1, hh * 0.21, 4);
  ctx.stroke();
  ctx.restore();

  // ── Left-side specular shine ──
  ctx.save();
  const shineG = ctx.createLinearGradient(-hw + 2, -hh * 0.5, -hw * 0.1, hh * 0.4);
  shineG.addColorStop(0.0, 'rgba(255,255,255,0.72)');
  shineG.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  shineG.addColorStop(1.0, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = shineG;
  ctx.beginPath();
  ctx.ellipse(-hw * 0.38, -hh * 0.05, hw * 0.16, hh * 0.40, -0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Green flash when landed upright ──
  if (state === State.LANDED) {
    const t = (performance.now() % 800) / 800;
    const alpha = Math.sin(t * Math.PI) * 0.50;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#43e97b';
    ctx.shadowColor = '#43e97b';
    ctx.shadowBlur = 28;
    kinleyPath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

function drawParticles() {
  particles.forEach(p => {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function drawChargeMeter() {
  const mx = bottle.x;
  const my = bottle.y - CFG.bottleH / 2 - 42;
  const mW = 124;
  const mH = 14;

  ctx.save();

  // Outer container shadow & dark glass background
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = 'rgba(18, 14, 34, 0.90)';
  roundRect(ctx, mx - mW / 2, my - mH / 2, mW, mH, 7);
  ctx.fill();

  // Glass border
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1.2;
  roundRect(ctx, mx - mW / 2, my - mH / 2, mW, mH, 7);
  ctx.stroke();

  // Target Sweet-spot bracket on track (maps 0.80 - 1.20 ratio)
  const zoneLeft  = (mx - mW / 2) + (mW * (0.80 / 1.55));
  const zoneWidth = mW * (0.42 / 1.55);
  ctx.fillStyle = 'rgba(67, 233, 123, 0.30)';
  ctx.fillRect(zoneLeft, my - mH / 2 + 2, zoneWidth, mH - 4);

  // Sweet spot bracket markers
  ctx.strokeStyle = '#43e97b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(zoneLeft, my - mH / 2); ctx.lineTo(zoneLeft, my + mH / 2);
  ctx.moveTo(zoneLeft + zoneWidth, my - mH / 2); ctx.lineTo(zoneLeft + zoneWidth, my + mH / 2);
  ctx.stroke();

  // Progress fill bar
  const progressRatio = Math.min(1.0, Math.max(0.04, currentCharge / 1.55));
  const fillW = Math.max(6, mW * progressRatio);

  const isSweet = currentCharge >= 0.80 && currentCharge <= 1.22;
  const isOver  = currentCharge > 1.22;

  let barColor, glowColor;
  if (isOver) {
    barColor = '#ff6b6b';
    glowColor = 'rgba(255, 107, 107, 0.8)';
  } else if (isSweet) {
    barColor = '#43e97b';
    glowColor = 'rgba(67, 233, 123, 0.9)';
  } else {
    barColor = '#f7c948';
    glowColor = 'rgba(247, 201, 72, 0.7)';
  }

  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 10;
  ctx.fillStyle = barColor;
  roundRect(ctx, mx - mW / 2 + 2, my - mH / 2 + 2, fillW - 4, mH - 4, 5);
  ctx.fill();

  // Label text above meter
  ctx.font = 'bold 11px Nunito, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowBlur = 8;
  ctx.fillStyle = barColor;

  if (isOver) {
    ctx.fillText('⚠️ OVERCHARGED!', mx, my - mH / 2 - 5);
  } else if (isSweet) {
    ctx.fillText('⭐ SWEET SPOT! RELEASE! ⭐', mx, my - mH / 2 - 5);
  } else {
    ctx.fillText('HOLDING SPACE...', mx, my - mH / 2 - 5);
  }

  ctx.restore();
}

function drawStateOverlay() {
  if (isCharging && state === State.IDLE) {
    drawChargeMeter();
    return;
  }

  if (state === State.IDLE) {
    // Gentle glow arrow below bottle
    const t = (performance.now() % 1200) / 1200;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);

    ctx.save();
    ctx.globalAlpha = 0.4 + pulse * 0.4;
    ctx.fillStyle = '#f7c948';
    ctx.shadowColor = '#f7c948';
    ctx.shadowBlur = 15;

    const ax = bottle.x, ay = bottle.y - CFG.bottleH / 2 - 20;
    ctx.beginPath();
    ctx.moveTo(ax, ay - 10);
    ctx.lineTo(ax - 10, ay + 2);
    ctx.lineTo(ax - 4, ay + 2);
    ctx.lineTo(ax - 4, ay + 12);
    ctx.lineTo(ax + 4, ay + 12);
    ctx.lineTo(ax + 4, ay + 2);
    ctx.lineTo(ax + 10, ay + 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  if (state === State.LANDED) {
    // ✓ check mark
    const t = performance.now() / 1000;
    const s = 1 + 0.06 * Math.sin(t * 4);
    ctx.save();
    ctx.font = `bold ${Math.round(38 * s)}px Nunito, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#43e97b';
    ctx.shadowColor = '#43e97b';
    ctx.shadowBlur = 20;
    ctx.fillText('✓', bottle.x, bottle.y - CFG.bottleH / 2 - 34);
    ctx.restore();
  }

  if (state === State.FAILED) {
    ctx.save();
    ctx.font = 'bold 34px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff6b6b';
    ctx.shadowColor = '#ff6b6b';
    ctx.shadowBlur = 20;
    ctx.fillText('✗', bottle.x, bottle.y - 50);
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────
//  Logo Canvas (start screen animated bottle)
// ─────────────────────────────────────────────────────────────
let logoAngle = 0;
let logoAnimId = null;

function animateLogo() {
  const lc = $('logo-canvas');
  if (!lc) return;
  const lctx = lc.getContext('2d');
  const lW = lc.width, lH = lc.height;

  lctx.clearRect(0, 0, lW, lH);

  const t = performance.now() / 1000;
  const wobble = Math.sin(t * 1.4) * 12;
  const bounce = Math.abs(Math.sin(t * 1.2)) * 10;

  lctx.save();
  lctx.translate(lW / 2, lH / 2 - bounce);
  lctx.rotate(wobble * Math.PI / 180);

  // ── Logo bottle body ──
  const bW = 36, bH = 110;
  const hw = bW / 2, hh = bH / 2;

  const bg = lctx.createLinearGradient(-hw, -hh, hw, hh);
  bg.addColorStop(0, '#38f9d7');
  bg.addColorStop(0.6, '#0fa8a0');
  bg.addColorStop(1, '#077a7a');
  lctx.fillStyle = bg;

  lctx.beginPath();
  lctx.moveTo(-hw + 5, hh);
  lctx.quadraticCurveTo(-hw, hh, -hw, hh - 5);
  lctx.lineTo(-hw, -hh * 0.45);
  lctx.quadraticCurveTo(-hw, -hh * 0.58, -hw * 0.6, -hh * 0.62);
  lctx.lineTo(-hw * 0.6, -hh * 0.78);
  lctx.quadraticCurveTo(-hw * 0.5, -hh * 0.84, -hw * 0.5, -hh * 0.84);
  lctx.lineTo(hw * 0.5, -hh * 0.84);
  lctx.quadraticCurveTo(hw * 0.5, -hh * 0.84, hw * 0.6, -hh * 0.78);
  lctx.lineTo(hw * 0.6, -hh * 0.62);
  lctx.quadraticCurveTo(hw, -hh * 0.58, hw, -hh * 0.45);
  lctx.lineTo(hw, hh - 5);
  lctx.quadraticCurveTo(hw, hh, hw - 5, hh);
  lctx.closePath();
  lctx.fill();

  // Cap
  const cg = lctx.createLinearGradient(-hw * 0.6, -hh, hw * 0.6, -hh * 0.84);
  cg.addColorStop(0, '#f7c948');
  cg.addColorStop(1, '#d97706');
  lctx.fillStyle = cg;
  roundRectCtx(lctx, -hw * 0.6, -hh, hw * 1.2, hh * 0.18, 3);
  lctx.fill();

  // Shine
  lctx.save();
  const sg = lctx.createLinearGradient(-hw + 3, -hh * 0.4, -hw * 0.15, hh * 0.35);
  sg.addColorStop(0, 'rgba(255,255,255,0.42)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  lctx.fillStyle = sg;
  lctx.beginPath();
  lctx.ellipse(-hw * 0.3, 0, hw * 0.22, hh * 0.35, -0.3, 0, Math.PI * 2);
  lctx.fill();
  lctx.restore();

  lctx.restore();
  logoAnimId = requestAnimationFrame(animateLogo);
}

function roundRectCtx(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

// ─────────────────────────────────────────────────────────────
//  Utility: rounded rect path helper
// ─────────────────────────────────────────────────────────────
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

// ─────────────────────────────────────────────────────────────
//  Main Game Loop
// ─────────────────────────────────────────────────────────────
function gameLoop() {
  updateCharge();
  physicsTick();
  updateParticles();
  render();
  animFrame = requestAnimationFrame(gameLoop);
}

function startGameLoop() {
  if (animFrame) cancelAnimationFrame(animFrame);
  gameLoop();
}

function stopGameLoop() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
}

// ─────────────────────────────────────────────────────────────
//  Game Over Screen
// ─────────────────────────────────────────────────────────────
function showGameOver(reason) {
  stopGameLoop();

  const isNewBest = score > 0 && score >= bestScore;

  if (reason === 'fell') {
    $('over-emoji').textContent = '😱';
    $('over-title').textContent = 'Fell Off!';
    $('over-msg').textContent   = 'The bottle slipped off the platform.';
  } else {
    $('over-emoji').textContent = '😬';
    $('over-title').textContent = 'Oops!';
    $('over-msg').textContent   = 'The bottle tipped over.';
  }

  if (score === 0) {
    $('over-emoji').textContent = '🤔';
    $('over-title').textContent = 'Missed!';
    $('over-msg').textContent   = 'Give it another go!';
  }

  $('over-score').textContent = score;
  $('over-best').textContent  = bestScore;

  const badge = $('new-best-badge');
  if (isNewBest && score > 0) {
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }

  showScreen('over');
}

// ─────────────────────────────────────────────────────────────
//  Start / Restart Game
// ─────────────────────────────────────────────────────────────
function startGame() {
  if (logoAnimId) { cancelAnimationFrame(logoAnimId); logoAnimId = null; }

  score = 0;
  state = State.IDLE;
  particles = [];
  confettiPieces = [];
  shakeTimer = 0;
  settleTimer = 0;
  _resetDifficulty();        // fresh difficulty sequence every new game
  CFG._activeWindow = CFG.uprightWindow;

  updateHUD();
  $('hint-bar').classList.remove('hidden');
  showScreen('game');
  resizeCanvas();
  initStars();
  resetBottle();
  startGameLoop();
}

// ─────────────────────────────────────────────────────────────
//  Input Handling
// ─────────────────────────────────────────────────────────────
function handleFlipInput(e) {
  if (e && e.type === 'click') {
    // Ignore mute button clicks
    if (e.target && (e.target.id === 'btn-mute' || e.target.closest('#btn-mute'))) return;
  }
  launchFlip();
}

// ─────────────────────────────────────────────────────────────
//  Mute Button
// ─────────────────────────────────────────────────────────────
function updateMuteBtn() {
  const btn = $('btn-mute');
  btn.textContent = window.soundCtrl.isMuted() ? '🔇' : '🔊';
  btn.title = window.soundCtrl.isMuted() ? 'Unmute' : 'Mute';
}

// ─────────────────────────────────────────────────────────────
//  Boot / Init
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initCanvas();

  // Update start screen best
  $('start-best-val').textContent = bestScore;
  updateMuteBtn();

  // Start screen logo animation
  animateLogo();

  // ── Event Listeners ──

  // Play button
  $('btn-play').addEventListener('click', () => {
    window.soundCtrl.playPop();
    startGame();
  });

  // Retry / Home buttons
  $('btn-retry').addEventListener('click', () => {
    window.soundCtrl.playPop();
    startGame();
  });
  $('btn-home').addEventListener('click', () => {
    window.soundCtrl.playPop();
    stopGameLoop();
    $('start-best-val').textContent = bestScore;
    showScreen('start');
    animateLogo();
  });

  // Mute toggle
  $('btn-mute').addEventListener('click', (e) => {
    e.stopPropagation();
    const muted = window.soundCtrl.toggleMute();
    updateMuteBtn();
    if (!muted) window.soundCtrl.playPop();
  });

  // Pointer down on canvas (mouse click & hold, or screen touch & hold)
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target && (e.target.id === 'btn-mute' || e.target.closest('#btn-mute'))) return;
    if (screens.game.classList.contains('active') && state === State.IDLE) {
      startCharging();
    }
  });

  // Pointer up anywhere (release flip)
  window.addEventListener('pointerup', () => {
    if (screens.game.classList.contains('active') && isCharging) {
      releaseCharging();
    }
  });

  window.addEventListener('pointercancel', () => {
    if (isCharging) {
      cancelCharging();
    }
  });

  // Spacebar (keydown starts charge, keyup releases and flips)
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (screens.start.classList.contains('active')) {
        if (!e.repeat) {
          window.soundCtrl.playPop();
          startGame();
        }
      } else if (screens.over.classList.contains('active')) {
        if (!e.repeat) {
          window.soundCtrl.playPop();
          startGame();
        }
      } else if (screens.game.classList.contains('active')) {
        if (!e.repeat && state === State.IDLE) {
          startCharging();
        }
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (screens.game.classList.contains('active') && isCharging) {
        releaseCharging();
      }
    }
  });

  // Cancel charging if window loses focus
  window.addEventListener('blur', () => {
    if (isCharging) {
      cancelCharging();
    }
  });

  // Show start screen
  showScreen('start');
});
