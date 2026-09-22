'use strict';

/* =========================================================
 * AGV 无人工厂 · 无线充电挑战
 * 自动前进换轨跑酷：充电区补电（底充/侧充/坡道充电），
 * 拾取货物送往托盘计分；电量耗尽即失败。
 * 纯原生 JS + Canvas 2D 伪 3D 低多边形风格，双端适配。
 * ========================================================= */

/* ============ 配置（平衡参数集中于此，便于调整） ============ */
const CFG = {
  LANES: 4,            // 轨道数
  LANE_W: 2.5,         // 单轨宽度（世界单位）
  Z_NEAR: 1.15,        // AGV 所在深度
  Z_FAR: 95,           // 生成点深度
  CAM_H: 4.4,          // 摄像机高度
  BASE_SPEED: 14,      // 基础速度
  SPEED_RAMP: 1 / 110, // 速度递增率（110 秒翻倍）
  SPEED_CAP: 2.1,      // 速度上限倍数
  BATTERY_START: 80,   // 初始电量 %
  DRAIN_PER_SEC: 4,    // 耗电 %/秒（80% 约 20 秒耗尽）
  CHARGE_AMOUNT: 5,    // 每次充电恢复 %
  LOW_BATTERY: 30,     // 低电量提醒阈值
  CRIT_BATTERY: 15,    // 危险电量阈值
  ZONE_INTERVAL: 1.18, // 充电区生成间隔（秒）
  ZONE_DOUBLE_CHANCE: 0.25, // 双充电区概率
  CARGO_INTERVAL: 5,   // 货物生成间隔（秒）
  PALLET_AHEAD_SEC: 3.5, // 托盘生成提前量（秒）
  MAX_PALLETS: 3,      // 场上托盘上限
  PLATE_LEN: 3.0,      // 地面板长度
  WALL_X: 6.6,         // 侧墙位置
  WALL_H: 3.4,         // 侧墙高度
  PILLAR_SPACING: 5.0, // 立柱间隔
  BEAM_SPACING: 9.0,   // 横梁间隔
  HORIZON: 0.38        // 地平线比例
};

/* ============ 调色板（低多边形工业风） ============ */
const C = {
  floor1: '#262c37',
  floor2: '#20252e',
  edge: '#55616f',
  divider: '#3a4450',
  wall: '#161b23',
  window: 'rgba(72,168,255,0.16)',
  beam: '#20262f',
  cyan: '#38d9ff',
  green: '#2fe6b8',
  blue: '#6cc4ff',
  red: '#ff4d4d',
  orange: '#ff8c1a',
  crate1: '#c98a4b',
  crate2: '#a86f37',
  strap: '#5a4632',
  pallet1: '#4a7dff',
  pallet2: '#3a63cc',
  ring: '#e8edf4'
};

/* ============ 画布与投影 ============ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, cx = 0, horizonY = 0, focalPx = 0, baseScale = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx = W / 2;
  horizonY = H * CFG.HORIZON;
  focalPx = Math.min(H * 0.30, W * 0.094);
  baseScale = focalPx / CFG.Z_NEAR;
}
window.addEventListener('resize', resize);

function proj(x, z) {
  const s = focalPx / z;
  return { x: cx + x * s, y: horizonY + CFG.CAM_H * s, s: s };
}
function groundX(x, z) { return cx + x * (focalPx / z); }
function groundY(z) { return horizonY + CFG.CAM_H * (focalPx / z); }

/* ============ 素材（本地相对路径引用） ============ */
const imgs = { back: null, front: null };
(function loadAssets() {
  const a = new Image();
  a.src = 'assets/agv_back.png';
  a.onload = function () { imgs.back = a; };
  const b = new Image();
  b.src = 'assets/agv_front.png';
  b.onload = function () { imgs.front = b; };
})();

/* ============ 音频（Web Audio 合成） ============ */
let actx = null;
let muted = false;
try { muted = localStorage.getItem('agv_mute') === '1'; } catch (e) { /* 隐私模式 */ }

function ensureAudio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  }
  if (actx.state === 'suspended') { actx.resume(); }
}
function beep(f0, dur, type, vol, slideTo) {
  if (muted || !actx) return;
  const t0 = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (slideTo) { o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur); }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(actx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}
const sfx = {
  charge: function () { beep(820, 0.08, 'triangle', 0.16, 1280); },
  pickup: function () { beep(430, 0.06, 'square', 0.10, 720); },
  deliver: function () { beep(660, 0.09, 'triangle', 0.18); setTimeout(function () { beep(880, 0.13, 'triangle', 0.16); }, 85); },
  low: function () { beep(240, 0.10, 'sawtooth', 0.12, 200); },
  over: function () { beep(420, 0.18, 'sawtooth', 0.16, 240); setTimeout(function () { beep(260, 0.32, 'sawtooth', 0.14, 110); }, 160); },
  start: function () { beep(440, 0.08, 'triangle', 0.16); setTimeout(function () { beep(660, 0.10, 'triangle', 0.14); }, 90); },
  sw: function () { beep(300, 0.05, 'sine', 0.05, 340); }
};

/* ============ 状态 ============ */
let state = 'start'; // start | playing | paused | over
let best = 0;
let newRecord = false;
try { best = parseInt(localStorage.getItem('agv_best') || '0', 10) || 0; } catch (e) { /* 忽略 */ }

let R = null;

function laneX(i) { return (i - (CFG.LANES - 1) / 2) * CFG.LANE_W; }
function ri(n) { return Math.floor(Math.random() * n); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function speed() { return CFG.BASE_SPEED * (1 + Math.min(R.elapsed * CFG.SPEED_RAMP, CFG.SPEED_CAP - 1)); }

function resetRuntime() {
  R = {
    lane: 1,
    x: laneX(1),
    tilt: 0,
    carrying: false,
    chargeFx: 0,
    battery: CFG.BATTERY_START,
    score: 0,
    elapsed: 0,
    groundOff: 0,
    t: 0,
    zones: [],
    crates: [],
    pallets: [],
    particles: [],
    floats: [],
    timers: { zone: 0.6, cargo: 2.5, palletFree: 5, lowBeep: 0 }
  };
}

/* ============ 生成 ============ */
function spawnZone() {
  const lane = ri(CFG.LANES);
  R.zones.push({ lane: lane, type: ri(3), side: Math.random() < 0.5 ? -1 : 1, z: CFG.Z_FAR, dead: false });
  if (Math.random() < CFG.ZONE_DOUBLE_CHANCE) {
    let l2 = ri(CFG.LANES - 1);
    if (l2 >= lane) { l2++; }
    R.zones.push({ lane: l2, type: ri(3), side: Math.random() < 0.5 ? -1 : 1, z: CFG.Z_FAR + 2, dead: false });
  }
}
function spawnCrate() {
  R.crates.push({ lane: ri(CFG.LANES), z: CFG.Z_FAR, dead: false });
}
function spawnPallet() {
  if (R.pallets.length >= CFG.MAX_PALLETS) return;
  const z = Math.max(CFG.Z_NEAR + 2, CFG.Z_FAR - speed() * CFG.PALLET_AHEAD_SEC);
  R.pallets.push({ lane: ri(CFG.LANES), z: z, dead: false });
}

/* ============ 事件效果 ============ */
function addFloat(text, color) {
  const g = proj(R.x, CFG.Z_NEAR);
  R.floats.push({ x: g.x, y: g.y - 130, text: text, color: color, life: 1.1 });
}
function sparkBurst(hex, n) {
  const g = proj(R.x, CFG.Z_NEAR);
  n = n || 10;
  for (let i = 0; i < n; i++) {
    R.particles.push({
      x: g.x, y: g.y - 20,
      vx: (Math.random() - 0.5) * 220,
      vy: -(60 + Math.random() * 160),
      life: 0.5 + Math.random() * 0.3,
      size: 2 + Math.random() * 2.5,
      color: hex
    });
  }
}
function charge() {
  R.battery = Math.min(100, R.battery + CFG.CHARGE_AMOUNT);
  R.chargeFx = 0.7;
  sfx.charge();
  addFloat('+' + CFG.CHARGE_AMOUNT + '%', C.cyan);
  sparkBurst(C.cyan, 8);
}
function pickupCrate() {
  R.carrying = true;
  sfx.pickup();
  addFloat('已拾取', C.crate1);
  sparkBurst(C.crate1, 8);
  if (R.pallets.length === 0) { spawnPallet(); }
}
function deliver() {
  R.carrying = false;
  R.score++;
  if (R.score > best) {
    best = R.score;
    newRecord = true;
    try { localStorage.setItem('agv_best', String(best)); } catch (e) { /* 忽略 */ }
  }
  sfx.deliver();
  addFloat('+1', C.ring);
  sparkBurst(C.blue, 14);
}

/* ============ 更新 ============ */
function update(dt) {
  R.elapsed += dt;
  R.t += dt;
  const sp = speed();
  const targetX = laneX(R.lane);
  R.x += (targetX - R.x) * Math.min(1, dt * 10);
  R.tilt = (targetX - R.x) * 0.5;
  R.groundOff = (R.groundOff + sp * dt) % CFG.PLATE_LEN;
  R.chargeFx = Math.max(0, R.chargeFx - dt);

  /* 生成 */
  R.timers.zone += dt;
  if (R.timers.zone >= CFG.ZONE_INTERVAL) { spawnZone(); R.timers.zone = 0; }
  R.timers.cargo += dt;
  if (R.timers.cargo >= CFG.CARGO_INTERVAL) { spawnCrate(); R.timers.cargo = 0; }
  R.timers.palletFree += dt;
  if (R.timers.palletFree >= 8 && R.pallets.length < CFG.MAX_PALLETS) { spawnPallet(); R.timers.palletFree = 0; }

  /* 移动 */
  for (let i = 0; i < R.zones.length; i++) { R.zones[i].z -= sp * dt; }
  for (let i = 0; i < R.crates.length; i++) { R.crates[i].z -= sp * dt; }
  for (let i = 0; i < R.pallets.length; i++) { R.pallets[i].z -= sp * dt; }

  /* 交汇判定 */
  for (let i = 0; i < R.zones.length; i++) {
    const o = R.zones[i];
    if (!o.dead && o.z <= CFG.Z_NEAR) {
      o.dead = true;
      if (o.lane === R.lane) { charge(); }
    }
  }
  for (let i = 0; i < R.crates.length; i++) {
    const o = R.crates[i];
    if (!o.dead && o.z <= CFG.Z_NEAR) {
      o.dead = true;
      if (o.lane === R.lane && !R.carrying) { pickupCrate(); }
    }
  }
  for (let i = 0; i < R.pallets.length; i++) {
    const o = R.pallets[i];
    if (!o.dead && o.z <= CFG.Z_NEAR) {
      o.dead = true;
      if (o.lane === R.lane && R.carrying) { deliver(); }
    }
  }
  R.zones = R.zones.filter(function (o) { return !o.dead; });
  R.crates = R.crates.filter(function (o) { return !o.dead; });
  R.pallets = R.pallets.filter(function (o) { return !o.dead; });

  /* 电量 */
  R.battery -= CFG.DRAIN_PER_SEC * dt;
  if (R.battery < CFG.LOW_BATTERY) {
    R.timers.lowBeep -= dt;
    if (R.timers.lowBeep <= 0) { sfx.low(); R.timers.lowBeep = 2; }
  }
  if (R.battery <= 0) { R.battery = 0; gameOver(); return; }

  /* 粒子与浮字 */
  for (let i = 0; i < R.particles.length; i++) {
    const p = R.particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 300 * dt;
    p.life -= dt;
  }
  R.particles = R.particles.filter(function (p) { return p.life > 0; });
  for (let i = 0; i < R.floats.length; i++) {
    R.floats[i].y -= 46 * dt;
    R.floats[i].life -= dt;
  }
  R.floats = R.floats.filter(function (f) { return f.life > 0; });

  updateHUD();
}

/* ============ 渲染 ============ */
function ellipse(x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, horizonY + 4);
  g.addColorStop(0, '#0b0f15');
  g.addColorStop(1, '#18202b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, horizonY + 4);
  /* 远处厂房剪影 */
  ctx.fillStyle = 'rgba(26,33,44,0.9)';
  for (let i = 0; i < 7; i++) {
    const bw = W * (0.10 + (i % 3) * 0.03);
    const bh = H * (0.06 + (i % 2) * 0.03);
    ctx.fillRect(i * W * 0.14 - bw * 0.5, horizonY - bh, bw, bh);
  }
  /* 地平线亮带 */
  const hl = ctx.createLinearGradient(0, horizonY - 8, 0, horizonY + 6);
  hl.addColorStop(0, 'rgba(56,217,255,0.0)');
  hl.addColorStop(0.6, 'rgba(56,217,255,0.14)');
  hl.addColorStop(1, 'rgba(56,217,255,0.0)');
  ctx.fillStyle = hl;
  ctx.fillRect(0, horizonY - 8, W, 14);
  /* 厂房指示灯 */
  for (let i = 0; i < 5; i++) {
    const tw = 0.5 + 0.5 * Math.sin(R.t * 2 + i * 1.7);
    ctx.fillStyle = 'rgba(255,200,80,' + (0.15 + 0.25 * tw).toFixed(3) + ')';
    ellipse(W * (0.16 + i * 0.17), horizonY - H * (0.05 + (i % 3) * 0.018), 3, 3);
  }
}

function drawGround() {
  const k0 = Math.ceil((CFG.Z_NEAR + R.groundOff) / CFG.PLATE_LEN);
  for (let k = k0; k * CFG.PLATE_LEN - R.groundOff <= CFG.Z_FAR; k++) {
    const z1 = k * CFG.PLATE_LEN - R.groundOff;
    const z0 = (k - 1) * CFG.PLATE_LEN - R.groundOff;
    const za = Math.max(z0, CFG.Z_NEAR);
    if (z1 <= za) { continue; }
    ctx.fillStyle = (k % 2 === 0) ? C.floor1 : C.floor2;
    ctx.beginPath();
    ctx.moveTo(groundX(-CFG.WALL_X, za), groundY(za));
    ctx.lineTo(groundX(CFG.WALL_X, za), groundY(za));
    ctx.lineTo(groundX(CFG.WALL_X, z1), groundY(z1));
    ctx.lineTo(groundX(-CFG.WALL_X, z1), groundY(z1));
    ctx.closePath();
    ctx.fill();
  }
  /* 轨道边界与分隔线 */
  for (let j = 0; j <= CFG.LANES; j++) {
    const bx = (j - 2) * CFG.LANE_W;
    const inner = j > 0 && j < CFG.LANES;
    ctx.strokeStyle = inner ? C.divider : C.edge;
    ctx.lineWidth = inner ? 2 : 3;
    ctx.beginPath();
    ctx.moveTo(groundX(bx, CFG.Z_NEAR), groundY(CFG.Z_NEAR));
    ctx.lineTo(groundX(bx, CFG.Z_FAR), groundY(CFG.Z_FAR));
    ctx.stroke();
  }
  /* 地面纵向渐层（前暗后亮，增强景深） */
  const g = ctx.createLinearGradient(0, groundY(CFG.Z_FAR), 0, groundY(CFG.Z_NEAR));
  g.addColorStop(0, 'rgba(90,150,190,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = g;
  ctx.fillRect(0, groundY(CFG.Z_FAR), W, groundY(CFG.Z_NEAR) - groundY(CFG.Z_FAR) + 2);
}

function drawWalls() {
  for (let s = -1; s <= 1; s += 2) {
    const wx = s * CFG.WALL_X;
    const sN = focalPx / CFG.Z_NEAR;
    const sF = focalPx / CFG.Z_FAR;
    const yN = groundY(CFG.Z_NEAR);
    const yF = groundY(CFG.Z_FAR);
    const topN = yN - CFG.WALL_H * sN;
    const topF = yF - CFG.WALL_H * sF;
    /* 墙面 */
    ctx.fillStyle = C.wall;
    ctx.beginPath();
    ctx.moveTo(groundX(wx, CFG.Z_NEAR), yN);
    ctx.lineTo(groundX(wx, CFG.Z_FAR), yF);
    ctx.lineTo(groundX(wx, CFG.Z_FAR), topF);
    ctx.lineTo(groundX(wx, CFG.Z_NEAR), topN);
    ctx.closePath();
    ctx.fill();
    /* 窗户（随地面滚动） */
    const wk0 = Math.ceil((CFG.Z_NEAR + R.groundOff) / 4.2);
    for (let k = wk0; k * 4.2 - R.groundOff <= CFG.Z_FAR; k++) {
      const z = k * 4.2 - R.groundOff;
      if (z < CFG.Z_NEAR) { continue; }
      const s = focalPx / z;
      const ww = CFG.LANE_W * 0.55 * s;
      const wh = 0.7 * s;
      const x0 = groundX(wx - s * 0.35, z);
      const y0 = groundY(z) - 1.9 * s;
      ctx.fillStyle = C.window;
      ctx.fillRect(x0 - ww / 2, y0, ww, wh);
      ctx.fillStyle = 'rgba(120,190,255,0.35)';
      ctx.fillRect(x0 - ww / 2, y0 + wh - 2 * s, ww, Math.max(1, 1.2 * s));
    }
    /* 传送带 */
    const bandY = groundY(CFG.Z_NEAR);
    const bandTF = groundY(CFG.Z_FAR);
    const bandTN = bandY - 0.55 * sN;
    const bandTF2 = bandTF - 0.55 * sF;
    ctx.fillStyle = '#232a35';
    ctx.beginPath();
    ctx.moveTo(groundX(wx + s * 0.28, CFG.Z_NEAR), bandY);
    ctx.lineTo(groundX(wx + s * 0.28, CFG.Z_FAR), bandTF);
    ctx.lineTo(groundX(wx + s * 0.28, CFG.Z_FAR), bandTF2);
    ctx.lineTo(groundX(wx + s * 0.28, CFG.Z_NEAR), bandTN);
    ctx.closePath();
    ctx.fill();
    /* 传送带移动节段 */
    const seg0 = Math.ceil((CFG.Z_NEAR + R.groundOff * 2.4) / 1.6);
    for (let k = seg0; k * 1.6 - R.groundOff * 2.4 <= CFG.Z_FAR; k++) {
      const z = k * 1.6 - R.groundOff * 2.4;
      if (z < CFG.Z_NEAR) { continue; }
      const s = focalPx / z;
      ctx.fillStyle = 'rgba(140,170,200,0.25)';
      const x0 = groundX(wx + s * 0.28, z);
      ctx.fillRect(x0 - 0.5 * s, groundY(z) - 0.42 * s, s * 1.0, Math.max(1, 0.12 * s));
    }
    /* 立柱（安全条纹） */
    const pk0 = Math.ceil((CFG.Z_NEAR + R.groundOff) / CFG.PILLAR_SPACING);
    for (let k = pk0; k * CFG.PILLAR_SPACING - R.groundOff <= CFG.Z_FAR; k++) {
      const z = k * CFG.PILLAR_SPACING - R.groundOff;
      if (z < CFG.Z_NEAR) { continue; }
      const s = focalPx / z;
      const px0 = groundX(wx - s * 0.42, z);
      const pw = 0.55 * s;
      const ph = 2.6 * s;
      ctx.fillStyle = '#1d242e';
      ctx.fillRect(px0 - pw / 2, groundY(z) - ph, pw, ph);
      ctx.fillStyle = C.orange;
      ctx.fillRect(px0 - pw / 2, groundY(z) - ph + ph * 0.55, pw, Math.max(2, ph * 0.11));
    }
  }
}

function drawBeams() {
  const bk0 = Math.ceil((CFG.Z_NEAR + R.groundOff) / CFG.BEAM_SPACING);
  for (let k = bk0; k * CFG.BEAM_SPACING - R.groundOff <= CFG.Z_FAR; k++) {
    const z = k * CFG.BEAM_SPACING - R.groundOff;
    if (z < CFG.Z_NEAR) { continue; }
    const s = focalPx / z;
    const y = groundY(z) - 3.3 * s;
    const x1 = groundX(-CFG.WALL_X + 0.55, z);
    const x2 = groundX(CFG.WALL_X - 0.55, z);
    ctx.fillStyle = C.beam;
    ctx.fillRect(x1, y - 0.14 * s, x2 - x1, Math.max(2, 0.28 * s));
    /* 支撑柱 */
    ctx.fillStyle = '#1a2029';
    ctx.fillRect(x1 - 0.14 * s, y, Math.max(2, 0.28 * s), groundY(z) - y);
    ctx.fillRect(x2 - 0.14 * s, y, Math.max(2, 0.28 * s), groundY(z) - y);
  }
}

/* ---- 充电区三种形态 ---- */
function drawZone(o) {
  const g = proj(laneX(o.lane), o.z);
  const s = focalPx / o.z;
  const pulse = 0.5 + 0.5 * Math.sin(R.t * 6 + o.lane);

  /* 地面光晕（统一底） */
  ctx.fillStyle = 'rgba(56,217,255,' + (0.08 + 0.06 * pulse).toFixed(3) + ')';
  ellipse(g.x, g.y, CFG.LANE_W * 0.52 * s, CFG.LANE_W * 0.30 * s);

  if (o.type === 0) {
    /* 底充：地面感应垫 */
    const w = CFG.LANE_W * 0.78 * s;
    const h = w * 0.40;
    ctx.fillStyle = '#123a4d';
    ctx.beginPath();
    ctx.roundRect(g.x - w / 2, g.y - h / 2, w, h, h * 0.28);
    ctx.fill();
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = Math.max(1.5, 2.4 * s * 0.5);
    ctx.beginPath();
    ctx.roundRect(g.x - w / 2, g.y - h / 2, w, h, h * 0.28);
    ctx.stroke();
    /* 线圈符号 */
    const r = w * 0.15 * (1 + 0.12 * pulse);
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.x, g.y, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C.cyan;
    ellipse(g.x, g.y, r * 0.22, r * 0.22);
  } else if (o.type === 1) {
    /* 侧充：侧向充电臂 */
    const px = laneX(o.lane) + o.side * CFG.LANE_W * 0.42;
    const postW = Math.max(2, 0.3 * s);
    const postH = 1.7 * s;
    ctx.fillStyle = '#1d3a33';
    ctx.fillRect(groundX(px, o.z) - postW / 2, g.y - postH, postW, postH);
    ctx.fillStyle = C.green;
    ctx.fillRect(groundX(px, o.z) - postW / 2, g.y - postH, postW, Math.max(2, 0.16 * s));
    /* 充电臂 */
    const armY = g.y - 1.35 * s;
    const armEndX = groundX(laneX(o.lane) - o.side * CFG.LANE_W * 0.20, o.z);
    ctx.strokeStyle = C.green;
    ctx.lineWidth = Math.max(2, 0.16 * s);
    ctx.beginPath();
    ctx.moveTo(groundX(px, o.z), armY);
    ctx.lineTo(armEndX, armY);
    ctx.stroke();
    /* 臂端线圈 */
    const r = Math.max(4, 0.26 * s) * (1 + 0.15 * pulse);
    ctx.fillStyle = 'rgba(47,230,184,0.25)';
    ellipse(armEndX, armY, r * 1.4, r * 1.4);
    ctx.strokeStyle = C.green;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(armEndX, armY, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C.green;
    ellipse(armEndX, armY, r * 0.3, r * 0.3);
  } else {
    /* 坡道充电：倾斜坡道平台 */
    const w = CFG.LANE_W * 0.88;
    const rampLen = 2.0;
    const zBack = o.z + rampLen;
    const gF = proj(laneX(o.lane), zBack);
    const sF = focalPx / zBack;
    const hF = 1.15 * sF;
    const wF = w * 0.5 * sF * 0.86;
    const wN = w * 0.5 * s;
    ctx.fillStyle = '#15344a';
    ctx.beginPath();
    ctx.moveTo(g.x - wN, g.y);
    ctx.lineTo(g.x + wN, g.y);
    ctx.lineTo(gF.x + wF, gF.y - hF);
    ctx.lineTo(gF.x - wF, gF.y - hF);
    ctx.closePath();
    ctx.fill();
    /* 坡道侧轨 */
    ctx.strokeStyle = C.blue;
    ctx.lineWidth = Math.max(1.5, 0.1 * s);
    ctx.beginPath();
    ctx.moveTo(g.x - wN, g.y - 0.02 * s);
    ctx.lineTo(gF.x - wF, gF.y - hF);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.x + wN, g.y - 0.02 * s);
    ctx.lineTo(gF.x + wF, gF.y - hF);
    ctx.stroke();
    /* 顶部接触平台 */
    ctx.fillStyle = '#1d4a68';
    ctx.beginPath();
    ctx.roundRect(gF.x - wF, gF.y - hF - 0.16 * sF, wF * 2, 0.16 * sF, 2);
    ctx.fill();
    ctx.fillStyle = C.blue;
    ellipse(gF.x, gF.y - hF - 0.08 * sF, Math.max(3, 0.3 * sF) * (1 + 0.12 * pulse), Math.max(2, 0.12 * sF));
  }
}

/* ---- 货物 ---- */
function drawCrate(o) {
  const g = proj(laneX(o.lane), o.z);
  const s = focalPx / o.z;
  const w = 1.05 * s;
  const h = 0.92 * s;
  const d = 0.9 * s;
  const topY = g.y - h;
  /* 顶面 */
  ctx.fillStyle = C.crate1;
  ctx.beginPath();
  ctx.moveTo(g.x - w / 2, topY);
  ctx.lineTo(g.x + w / 2, topY);
  ctx.lineTo(g.x + w / 2 + d * 0.32, topY - d * 0.26);
  ctx.lineTo(g.x - w / 2 + d * 0.32, topY - d * 0.26);
  ctx.closePath();
  ctx.fill();
  /* 正面 */
  ctx.fillStyle = C.crate2;
  ctx.fillRect(g.x - w / 2, topY, w, h);
  /* 打包带 */
  ctx.fillStyle = C.strap;
  ctx.fillRect(g.x - w * 0.28, topY, w * 0.14, h);
  ctx.fillRect(g.x + w * 0.14, topY, w * 0.14, h);
  ctx.fillRect(g.x - w / 2, topY + h * 0.38, w, h * 0.11);
}

/* ---- 托盘 ---- */
function drawPallet(o) {
  const g = proj(laneX(o.lane), o.z);
  const s = focalPx / o.z;
  const w = 1.25 * s;
  const h = 0.5 * s;
  const d = 1.05 * s;
  const topY = g.y - h;
  const blink = 0.5 + 0.5 * Math.sin(R.t * 5 + o.lane);
  /* 顶面 */
  ctx.fillStyle = C.pallet1;
  ctx.beginPath();
  ctx.moveTo(g.x - w / 2, topY);
  ctx.lineTo(g.x + w / 2, topY);
  ctx.lineTo(g.x + w / 2 + d * 0.3, topY - d * 0.24);
  ctx.lineTo(g.x - w / 2 + d * 0.3, topY - d * 0.24);
  ctx.closePath();
  ctx.fill();
  /* 正面 */
  ctx.fillStyle = C.pallet2;
  ctx.fillRect(g.x - w / 2, topY, w, h);
  ctx.fillStyle = '#2e5199';
  ctx.fillRect(g.x - w / 2, topY, w, h * 0.28);
  /* 顶部瞄准环 */
  const cy = topY - d * 0.12;
  ctx.strokeStyle = C.ring;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(g.x, cy, Math.max(3, w * 0.16) * (1 + 0.2 * blink), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = C.ring;
  ellipse(g.x, cy, Math.max(2, w * 0.05), Math.max(2, w * 0.05));
}

/* ---- AGV 主角 ---- */
function drawAGV() {
  const g = proj(R.x, CFG.Z_NEAR);
  const s = baseScale;
  const w = 1.75 * s;
  const img = imgs.back;
  const h = img ? w * (img.height / img.width) : w * 1.15;

  /* 阴影 */
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ellipse(g.x, g.y + 3, w * 0.58, w * 0.16);

  /* 充电光环 */
  if (R.chargeFx > 0) {
    const a = R.chargeFx / 0.7;
    ctx.strokeStyle = 'rgba(56,217,255,' + (0.55 * a).toFixed(3) + ')';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(g.x, g.y - h * 0.3, w * (0.55 + 0.35 * (1 - a)), 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(g.x, g.y + 2);
  ctx.rotate(R.tilt * 0.055);
  if (img) {
    ctx.drawImage(img, -w / 2, -h, w, h);
  } else {
    /* 兜底：低多边形小车 */
    ctx.fillStyle = '#3a4452';
    ctx.fillRect(-w / 2, -h * 0.86, w, h * 0.86);
    ctx.fillStyle = '#2b3340';
    ctx.fillRect(-w / 2 + w * 0.1, -h * 0.66, w * 0.8, h * 0.24);
    ctx.fillStyle = '#151a21';
    ellipse(-w * 0.3, -2, w * 0.16, w * 0.07);
    ellipse(w * 0.3, -2, w * 0.16, w * 0.07);
  }
  /* 装载的货物 */
  if (R.carrying) {
    const cw = w * 0.46;
    const ch = cw * 0.72;
    ctx.fillStyle = C.crate2;
    ctx.fillRect(-cw / 2, -h - ch, cw, ch);
    ctx.fillStyle = C.crate1;
    ctx.beginPath();
    ctx.moveTo(-cw / 2, -h - ch);
    ctx.lineTo(cw / 2, -h - ch);
    ctx.lineTo(cw / 2 + cw * 0.18, -h - ch - cw * 0.14);
    ctx.lineTo(-cw / 2 + cw * 0.18, -h - ch - cw * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C.strap;
    ctx.fillRect(-cw * 0.12, -h - ch, cw * 0.14, ch);
    ctx.fillRect(cw * 0.2, -h - ch, cw * 0.14, ch);
  }
  ctx.restore();
}

/* ---- 粒子与浮字 ---- */
function drawParticles() {
  for (let i = 0; i < R.particles.length; i++) {
    const p = R.particles[i];
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 0.5));
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

function drawFloats() {
  ctx.textAlign = 'center';
  ctx.font = '700 22px system-ui, sans-serif';
  for (let i = 0; i < R.floats.length; i++) {
    const f = R.floats[i];
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life));
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

/* ---- 暗角与低电量警示 ---- */
function drawVignette() {
  const g = ctx.createRadialGradient(cx, H * 0.5, H * 0.35, cx, H * 0.5, H * 1.05);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (state === 'playing' && R.battery < CFG.CRIT_BATTERY) {
    const a = 0.16 + 0.12 * Math.sin(R.t * 6);
    ctx.fillStyle = 'rgba(255,45,45,' + a.toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }
}

function render() {
  if (!R) { return; }
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawGround();
  drawWalls();
  drawBeams();

  const objs = [];
  for (let i = 0; i < R.zones.length; i++) { objs.push({ z: R.zones[i].z, k: 'zone', o: R.zones[i] }); }
  for (let i = 0; i < R.crates.length; i++) { objs.push({ z: R.crates[i].z, k: 'crate', o: R.crates[i] }); }
  for (let i = 0; i < R.pallets.length; i++) { objs.push({ z: R.pallets[i].z, k: 'pallet', o: R.pallets[i] }); }
  objs.sort(function (a, b) { return b.z - a.z; });
  for (let i = 0; i < objs.length; i++) {
    const e = objs[i];
    if (e.k === 'zone') { drawZone(e.o); }
    else if (e.k === 'crate') { drawCrate(e.o); }
    else { drawPallet(e.o); }
  }

  drawAGV();
  drawParticles();
  drawFloats();
  drawVignette();
}

/* ============ 界面切换 ============ */
function setScreen(name) {
  const overlays = document.querySelectorAll('.overlay');
  for (let i = 0; i < overlays.length; i++) { overlays[i].classList.add('hidden'); }
  const el = document.getElementById('screen-' + name);
  if (el) { el.classList.remove('hidden'); }
  const hud = document.getElementById('hud');
  hud.classList.toggle('hidden', name !== 'playing' && name !== 'paused');
  if (name === 'start') {
    document.getElementById('start-best').textContent = best > 0 ? '最高分 ' + best : '';
  }
}

function updateHUD() {
  const pct = Math.max(0, Math.min(100, R.battery));
  const bar = document.getElementById('battery-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('warn', pct < CFG.LOW_BATTERY && pct >= CFG.CRIT_BATTERY);
  bar.classList.toggle('crit', pct < CFG.CRIT_BATTERY);
  document.getElementById('battery-num').textContent = Math.ceil(pct) + '%';
  document.getElementById('score-num').textContent = R.score;
}

function startGame() {
  ensureAudio();
  resetRuntime();
  newRecord = false;
  state = 'playing';
  setScreen('playing');
  updateHUD();
  sfx.start();
  startLoop();
}

function gameOver() {
  state = 'over';
  sfx.over();
  document.getElementById('final-score').textContent = R.score;
  document.getElementById('new-record').classList.toggle('hidden', !(newRecord && R.score > 0));
  document.getElementById('final-best').textContent = '最高分 ' + best;
  setScreen('over');
}

function pauseGame() {
  if (state !== 'playing') { return; }
  state = 'paused';
  setScreen('paused');
  stopLoop();
}
function resumeGame() {
  if (state !== 'paused') { return; }
  ensureAudio();
  state = 'playing';
  setScreen('playing');
  updateHUD();
  startLoop();
}
function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('agv_mute', muted ? '1' : '0'); } catch (e) { /* 忽略 */ }
  document.getElementById('btn-mute').textContent = muted ? '声音：关' : '声音：开';
}

/* ============ 主循环 ============ */
let raf = null;
let last = 0;

function loop(now) {
  raf = requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (state === 'playing') {
    update(dt);
  } else if (state === 'start' || state === 'over') {
    /* 菜单背景缓慢滚动 */
    R.groundOff = (R.groundOff + 3 * dt) % CFG.PLATE_LEN;
    R.t += dt;
  }
  render();
}
function startLoop() {
  if (raf === null) {
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
}
function stopLoop() {
  if (raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
}

/* ============ 输入 ============ */
function move(dir) {
  if (state !== 'playing' || !R) { return; }
  const nl = clamp(R.lane + dir, 0, CFG.LANES - 1);
  if (nl !== R.lane) { R.lane = nl; sfx.sw(); }
}

window.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { move(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { move(1); e.preventDefault(); }
  else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
    if (state === 'playing') { pauseGame(); } else if (state === 'paused') { resumeGame(); }
  }
  else if (e.key === 'm' || e.key === 'M') { toggleMute(); }
  else if (e.key === ' ' || e.key === 'Enter') {
    if (state === 'start' || state === 'over') { startGame(); e.preventDefault(); }
    else if (state === 'paused') { resumeGame(); }
  }
});

/* 滑动 / 点按（Pointer Events 统一） */
let pt = null;
canvas.addEventListener('pointerdown', function (e) {
  pt = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener('pointerup', function (e) {
  if (!pt) { return; }
  const dx = e.clientX - pt.x;
  const dy = e.clientY - pt.y;
  const dt = performance.now() - pt.t;
  if (dt < 450 && Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy)) {
    move(dx > 0 ? 1 : -1);
  }
  pt = null;
});
canvas.addEventListener('pointercancel', function () { pt = null; });

/* 切后台自动暂停 */
document.addEventListener('visibilitychange', function () {
  if (document.hidden && state === 'playing') { pauseGame(); }
});

/* ============ 按钮绑定 ============ */
document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-restart').addEventListener('click', startGame);
document.getElementById('btn-restart2').addEventListener('click', startGame);
document.getElementById('btn-resume').addEventListener('click', resumeGame);
document.getElementById('btn-pause').addEventListener('click', pauseGame);
document.getElementById('btn-mute').addEventListener('click', toggleMute);

/* ============ 启动 ============ */
resize();
resetRuntime();
document.getElementById('btn-mute').textContent = muted ? '声音：关' : '声音：开';
setScreen('start');
startLoop();
