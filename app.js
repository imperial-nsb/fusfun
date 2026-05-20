"use strict";

// ============================================================
// Phased Array Focusing — outreach demo
// ============================================================
// Tunables. Adjust freely; defaults chosen to look good on a 1400×800
// laptop screen at the default 8-speaker count.
// ============================================================
const C_VIS = 240;             // wave speed (pixels per second)
const SIGMA    = 32;              // wave-packet envelope width (pixels)
// Visual wavelength is anchored at the reference frequency, then scaled by
// the physical λ ∝ 1/f relationship. The wavelength used for a packet is
// captured at the moment it fires (see sp.firedFreq), so changing the
// frequency slider mid-flight does NOT retroactively warp packets already
// in the air — each ring set reflects the frequency that produced it.
const VIS_WL_REF_FREQ = 800;      // Hz: frequency at which VIS_WL_REF_PX applies
const VIS_WL_REF_PX   = 52;       // pixels: visual wavelength at the reference freq
function wavelengthForFreq(f) { return VIS_WL_REF_PX * VIS_WL_REF_FREQ / f; }
function kForFreq(f) { return 2 * Math.PI / wavelengthForFreq(f); }
const PACKET_LIFETIME = 4.0;      // seconds before a wave packet is dropped from the field
const N_MIN = 2, N_MAX = 16, N_DEFAULT = 8;
const FREQ_MIN = 220, FREQ_MAX = 2500;
const FREQ_DEFAULT = 800;
const SPEAKER_X_FRACTION = 0.22;  // where the speaker column sits across main panel width
const SLIDER_W_FRACTION  = 0.16;  // slider width as fraction of main panel width
const BEEP_DURATION = 0.20;       // seconds, per-speaker beep length at mic

// Icon sources come from config.js (window.FUSFUN_CONFIG.icons).
// Edit config.js to swap icons without touching code.

// ============================================================
// State
// ============================================================
const state = {
  freq: FREQ_DEFAULT,
  n: N_DEFAULT,
  speakers: [],         // see rebuildSpeakers() for shape
  mic: { x: 800, y: 400 },
  dragging: null,       // 'freq' | 'mic' | { type:'delay', sp }
  freqThumbPos: 0,      // 0..1, 0=bottom (low), 1=top (high)
  simTime: 0,
  layout: null,         // computed each resize
};

// ============================================================
// Audio
// ============================================================
let audioCtx = null;
let masterGain = null, compressor = null;
let toneOsc = null, toneGain = null;

function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.6;
  compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 8;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.08;
  masterGain.connect(compressor);
  compressor.connect(audioCtx.destination);
}

function startTone() {
  ensureAudio();
  if (toneOsc) return;
  toneOsc = audioCtx.createOscillator();
  toneGain = audioCtx.createGain();
  toneOsc.type = 'sine';
  toneOsc.frequency.value = state.freq;
  const now = audioCtx.currentTime;
  toneGain.gain.setValueAtTime(0, now);
  toneGain.gain.linearRampToValueAtTime(0.15, now + 0.02);
  toneOsc.connect(toneGain);
  toneGain.connect(masterGain);
  toneOsc.start();
  document.getElementById('freq-speaker').classList.add('tone-active');
}

function updateToneFreq() {
  if (!toneOsc) return;
  toneOsc.frequency.setTargetAtTime(state.freq, audioCtx.currentTime, 0.01);
}

function stopTone() {
  if (!toneOsc) return;
  const now = audioCtx.currentTime;
  const g = toneGain, o = toneOsc;
  g.gain.cancelScheduledValues(now);
  g.gain.setValueAtTime(g.gain.value, now);
  g.gain.linearRampToValueAtTime(0, now + 0.06);
  o.stop(now + 0.1);
  toneOsc = null; toneGain = null;
  document.getElementById('freq-speaker').classList.remove('tone-active');
}

function playBeep(whenFromNow, amplitude, freq, duration = BEEP_DURATION) {
  ensureAudio();
  const t0 = audioCtx.currentTime + Math.max(0, whenFromNow);
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const attack = Math.min(0.008, duration * 0.15);
  const release = duration - attack;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(amplitude, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + release);
  osc.connect(g);
  g.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

// ============================================================
// Layout
// ============================================================
function computeLayout() {
  const main = document.getElementById('main-panel');
  const r = main.getBoundingClientRect();
  const w = r.width, h = r.height;
  const topPad = 70;
  const botPad = 90;
  const usable = h - topPad - botPad;
  const n = state.n;
  const iconSize = Math.max(32, Math.min(68, usable / n - 4));
  const speakerX = w * SPEAKER_X_FRACTION;          // x of icon center (where wave emits)
  const sliderW  = w * SLIDER_W_FRACTION;
  const sliderLeft = speakerX - iconSize/2 - 10 - sliderW;
  const yFor = (i) => topPad + usable * (n === 1 ? 0.5 : (i + 0.5) / n);

  // tMax = max focus delay needed when the mic is at its closest allowed
  // position. The mic is clamped to x ≥ speakerX + iconSize, so the worst
  // case is mic centered there. This sizes the slider so Focus exactly
  // spans it at the closest position.
  const minMicX = speakerX + iconSize;
  const micY = topPad + usable / 2;
  let dMin = Infinity, dMax = 0;
  for (let i = 0; i < n; i++) {
    const sy = yFor(i);
    const d = Math.hypot(minMicX - speakerX, sy - micY);
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  const tMax = Math.max(0.05, (dMax - dMin) / C_VIS);

  return {
    w, h,
    speakerX, sliderW, sliderLeft,
    topPad, botPad, usable,
    iconSize, tMax,
    rowHeight: usable / n,
    yFor,
  };
}

// ============================================================
// Build / rebuild speaker rows
// ============================================================
function rebuildSpeakers() {
  const layer = document.getElementById('speakers-layer');
  layer.innerHTML = '';
  state.speakers = [];
  state.layout = computeLayout();
  const L = state.layout;

  for (let i = 0; i < state.n; i++) {
    const y = L.yFor(i);

    const row = document.createElement('div');
    row.className = 'speaker-row';
    row.style.left = `${L.sliderLeft}px`;
    row.style.top  = `${y - L.iconSize/2}px`;
    row.style.height = `${L.iconSize}px`;

    const slider = document.createElement('div');
    slider.className = 'delay-slider';
    slider.style.width = `${L.sliderW}px`;
    slider.style.height = `${L.iconSize}px`;
    slider.innerHTML = `
      <div class="track"></div>
      <div class="cursor"></div>
      <div class="thumb"></div>
    `;

    const icon = document.createElement('div');
    icon.className = 'speaker-icon';
    icon.style.width = `${L.iconSize}px`;
    icon.style.height = `${L.iconSize}px`;
    const iconImg = document.createElement('img');
    iconImg.alt = '';
    iconImg.draggable = false;
    applyIconToImg(iconImg, (window.FUSFUN_CONFIG.icons || {}).speaker);
    icon.appendChild(iconImg);

    row.appendChild(slider);
    row.appendChild(icon);
    layer.appendChild(row);

    const sp = {
      x: L.speakerX,                  // wave emits from icon center
      y,
      delayFrac: 0,                   // 0..1, scaled by layout.tMax for actual seconds
      cursorStart: -Infinity,
      fireStart: -Infinity,
      firedFreq: FREQ_DEFAULT,        // captured at fire time → controls visual wavelength
      armed: false,
      row,
      sliderEl: slider,
      thumbEl: slider.querySelector('.thumb'),
      cursorEl: slider.querySelector('.cursor'),
      iconEl: icon,
      idx: i,
    };
    state.speakers.push(sp);

    updateThumbPosition(sp);
    wireSpeakerRow(sp);
  }

  document.getElementById('count-label').textContent = `${state.n}`;
}

function updateThumbPosition(sp) {
  const L = state.layout;
  sp.thumbEl.style.left = `${sp.delayFrac * L.sliderW}px`;
}

function wireSpeakerRow(sp) {
  // Drag thumb / click track sets delay
  sp.sliderEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    state.dragging = { type: 'delay', sp };
    moveDelayFromEvent(e, sp);
    sp.sliderEl.setPointerCapture(e.pointerId);
  });
  sp.sliderEl.addEventListener('pointermove', (e) => {
    if (state.dragging && state.dragging.type === 'delay' && state.dragging.sp === sp) {
      moveDelayFromEvent(e, sp);
    }
  });
  sp.sliderEl.addEventListener('pointerup', (e) => {
    if (state.dragging && state.dragging.type === 'delay') state.dragging = null;
    try { sp.sliderEl.releasePointerCapture(e.pointerId); } catch (_) {}
  });
  sp.sliderEl.addEventListener('pointercancel', () => state.dragging = null);

  // Click speaker icon → fire just this one
  sp.iconEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ensureAudio();
    fireSpeaker(sp);
  });
}

function moveDelayFromEvent(e, sp) {
  const rect = sp.sliderEl.getBoundingClientRect();
  let frac = (e.clientX - rect.left) / rect.width;
  frac = Math.max(0, Math.min(1, frac));
  sp.delayFrac = frac;
  updateThumbPosition(sp);
}

// ============================================================
// Firing speakers
// ============================================================
function fireSpeaker(sp) {
  sp.cursorStart = state.simTime;
  sp.armed = true;
  sp.sliderEl.classList.add('armed');
}

function fireAll() {
  ensureAudio();
  for (const sp of state.speakers) fireSpeaker(sp);
}

function applyRandomDelays() {
  for (const sp of state.speakers) {
    sp.delayFrac = Math.random();
    updateThumbPosition(sp);
  }
}

function applyFocusDelays() {
  // delay_i = (d_max - d_i) / C_VIS, where d_i = speaker-to-mic distance.
  // layout.tMax is sized so at the closest mic position this exactly spans the slider.
  const tMax = state.layout.tMax;
  const dists = state.speakers.map(sp => Math.hypot(sp.x - state.mic.x, sp.y - state.mic.y));
  const dmax = Math.max(...dists);
  state.speakers.forEach((sp, i) => {
    const delaySec = (dmax - dists[i]) / C_VIS;
    sp.delayFrac = Math.max(0, Math.min(1, delaySec / tMax));
    updateThumbPosition(sp);
  });
}

// ============================================================
// Per-frame tick
// ============================================================
let lastFrame = performance.now();

function tick(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  state.simTime += dt;

  const L = state.layout;
  const tMax = L.tMax;
  for (const sp of state.speakers) {
    const sweepT = state.simTime - sp.cursorStart;
    const delaySec = sp.delayFrac * tMax;
    if (sp.cursorStart === -Infinity || sweepT < 0) {
      sp.sliderEl.classList.remove('armed');
    } else if (sweepT > tMax + 0.2) {
      sp.sliderEl.classList.remove('armed');
      sp.cursorStart = -Infinity;
    } else {
      sp.sliderEl.classList.add('armed');
      const frac = Math.min(1, sweepT / tMax);
      sp.cursorEl.style.left = `${frac * L.sliderW}px`;
      if (sp.armed && sweepT >= delaySec) {
        sp.armed = false;
        sp.fireStart = sp.cursorStart + delaySec;
        sp.firedFreq = state.freq;              // freeze freq at emit-time → visual wavelength
        sp.iconEl.classList.add('fired');
        setTimeout(() => sp.iconEl.classList.remove('fired'), 320);
        const d = Math.hypot(sp.x - state.mic.x, sp.y - state.mic.y);
        const travelTime = d / C_VIS;
        const amp = 0.55 / Math.sqrt(d / 220 + 1);
        // Two sources of perceived audio lag, both subtracted from schedule:
        //  1. audio output latency: hardware/driver buffer (Bluetooth is much worse).
        //  2. visual lead: the Gaussian glow at the mic rises well before peak, so
        //     the brain marks the "event" at the rising edge — align audio onset to
        //     that edge (~0.7σ before envelope peak) instead of to peak.
        const sysLatency = (audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0);
        const visualLead = 0.7 * SIGMA / C_VIS;
        const scheduleTime = Math.max(0, travelTime - sysLatency - visualLead);
        playBeep(scheduleTime, amp, sp.firedFreq);
      }
    }
  }

  renderWaveField();
  updateMicGlow();
  requestAnimationFrame(tick);
}

// ============================================================
// Mic glow (sample the field on CPU using the same equation as the shader)
// ============================================================
function fieldAtPoint(px, py, t) {
  let f = 0;
  for (const sp of state.speakers) {
    if (sp.fireStart === -Infinity) continue;
    const dt = t - sp.fireStart;
    if (dt < 0 || dt > PACKET_LIFETIME) continue;
    const dx = sp.x - px, dy = sp.y - py;
    const r = Math.sqrt(dx*dx + dy*dy);
    const wr = C_VIS * dt;
    const arg = r - wr;
    const env = Math.exp(-arg*arg / (2 * SIGMA * SIGMA));
    const k = kForFreq(sp.firedFreq);
    f += env * Math.cos(k * arg) / Math.sqrt(r + 50);
  }
  return f;
}

const micEl = () => document.getElementById('mic');
function updateMicGlow() {
  const f = fieldAtPoint(state.mic.x, state.mic.y, state.simTime);
  const intensity = Math.min(1, Math.abs(f) * 50);
  const el = micEl();
  if (intensity > 0.05) {
    const glow = 6 + intensity * 24;
    el.style.filter = `drop-shadow(0 0 ${glow}px rgba(255, 200, 60, ${0.4 + intensity * 0.6})) brightness(${1 + intensity * 0.4})`;
  } else {
    el.style.filter = '';
  }
}

// ============================================================
// WebGL2 wave-field renderer
// ============================================================
let gl, program, posBuf, uniforms, canvas;

const VS = `#version 300 es
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uResolution;   // physical pixels (matches gl_FragCoord)
uniform float uDpr;
uniform float uTime;
uniform int uN;
uniform vec2 uPos[16];
uniform float uStart[16];
uniform float uActive[16];
uniform float uK[16];      // per-packet visual wavenumber (depends on freq at emit time)
uniform float uC;
uniform float uSigma;
uniform float uLifetime;
void main() {
  // Convert physical pixel coord → logical (top-left origin), so we can compare with uPos
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uDpr;
  float field = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uN) break;
    if (uActive[i] < 0.5) continue;
    float dt = uTime - uStart[i];
    if (dt < 0.0 || dt > uLifetime) continue;
    vec2 d = p - uPos[i];
    float r = length(d);
    float wr = uC * dt;
    float arg = r - wr;
    float env = exp(-arg*arg / (2.0 * uSigma * uSigma));
    float osc = cos(uK[i] * arg);
    field += env * osc / sqrt(r + 50.0);
  }
  // Magnitude → inferno. Zero field → near-black background; peaks → yellow.
  // Polynomial fit of matplotlib's inferno colormap (Matt Zucker).
  float t = clamp(abs(field) * 7.0, 0.0, 1.0);
  const vec3 ic0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
  const vec3 ic1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  const vec3 ic2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  const vec3 ic3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  const vec3 ic4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  const vec3 ic5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  const vec3 ic6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  vec3 col = ic0 + t*(ic1 + t*(ic2 + t*(ic3 + t*(ic4 + t*(ic5 + t*ic6)))));
  outColor = vec4(col, 1.0);
}`;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(s), '\n', src);
    throw new Error('Shader failed to compile');
  }
  return s;
}

function initGL() {
  canvas = document.getElementById('wave-canvas');
  gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl) {
    alert("WebGL2 is required. Please use a modern browser (Chrome / Safari / Firefox).");
    return;
  }
  const vs = compileShader(gl.VERTEX_SHADER, VS);
  const fs = compileShader(gl.FRAGMENT_SHADER, FS);
  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Link error:', gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1,  1,-1,  -1, 1,
    -1, 1,  1,-1,   1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  uniforms = {
    uResolution: gl.getUniformLocation(program, 'uResolution'),
    uDpr:        gl.getUniformLocation(program, 'uDpr'),
    uTime:       gl.getUniformLocation(program, 'uTime'),
    uN:          gl.getUniformLocation(program, 'uN'),
    uPos:        gl.getUniformLocation(program, 'uPos'),
    uStart:      gl.getUniformLocation(program, 'uStart'),
    uActive:     gl.getUniformLocation(program, 'uActive'),
    uC:          gl.getUniformLocation(program, 'uC'),
    uSigma:      gl.getUniformLocation(program, 'uSigma'),
    uK:          gl.getUniformLocation(program, 'uK'),
    uLifetime:   gl.getUniformLocation(program, 'uLifetime'),
  };

  gl.uniform1f(uniforms.uC, C_VIS);
  gl.uniform1f(uniforms.uSigma, SIGMA);
  gl.uniform1f(uniforms.uLifetime, PACKET_LIFETIME);

  resizeGL();
}

function resizeGL() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const W = Math.round(r.width * dpr);
  const H = Math.round(r.height * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
  }
  gl.viewport(0, 0, W, H);
}

function renderWaveField() {
  if (!gl) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
  gl.uniform1f(uniforms.uDpr, dpr);
  gl.uniform1f(uniforms.uTime, state.simTime);

  const N = state.speakers.length;
  gl.uniform1i(uniforms.uN, N);

  const posArr = new Float32Array(N_MAX * 2);
  const startArr = new Float32Array(N_MAX);
  const activeArr = new Float32Array(N_MAX);
  const kArr = new Float32Array(N_MAX);
  for (let i = 0; i < N; i++) {
    const sp = state.speakers[i];
    posArr[2*i + 0] = sp.x;
    posArr[2*i + 1] = sp.y;
    const dt = state.simTime - sp.fireStart;
    if (sp.fireStart !== -Infinity && dt >= 0 && dt <= PACKET_LIFETIME) {
      startArr[i] = sp.fireStart;
      activeArr[i] = 1.0;
      kArr[i] = kForFreq(sp.firedFreq);
    } else {
      startArr[i] = 0;
      activeArr[i] = 0.0;
      kArr[i] = 0;
    }
  }
  gl.uniform2fv(uniforms.uPos, posArr);
  gl.uniform1fv(uniforms.uStart, startArr);
  gl.uniform1fv(uniforms.uActive, activeArr);
  gl.uniform1fv(uniforms.uK, kArr);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// ============================================================
// Mic dragging
// ============================================================
function setMicPosition(x, y) {
  const L = state.layout;
  state.mic.x = Math.max(L.speakerX + L.iconSize, Math.min(L.w - 10, x));
  state.mic.y = Math.max(10, Math.min(L.h - 10, y));
  const el = micEl();
  el.style.left = `${state.mic.x}px`;
  el.style.top  = `${state.mic.y}px`;
}

function initMic() {
  const el = micEl();
  const img = el.querySelector('img');
  const baseDim = Math.max(36, Math.min(56, state.layout.h * 0.065));

  // Size the mic wrapper to match the image's natural aspect ratio AFTER
  // rotation, so the icon isn't squished. Re-run whenever the image (re)loads.
  const resize = () => {
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const rot = parseFloat(img.dataset.rotate) || 0;
    const rad = rot * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const effW = nw * cos + nh * sin;
    const effH = nh * cos + nw * sin;
    const maxDim = Math.max(effW, effH);
    el.style.width  = `${baseDim * effW / maxDim}px`;
    el.style.height = `${baseDim * effH / maxDim}px`;
    setMicPosition(state.mic.x, state.mic.y);   // re-clamp under new size
  };
  if (img.complete && img.naturalWidth) resize();
  else img.addEventListener('load', resize);

  setMicPosition(state.layout.w * 0.7, state.layout.h * 0.5);

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    state.dragging = 'mic';
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (state.dragging !== 'mic') return;
    const mainRect = document.getElementById('main-panel').getBoundingClientRect();
    setMicPosition(e.clientX - mainRect.left, e.clientY - mainRect.top);
  });
  el.addEventListener('pointerup', (e) => {
    if (state.dragging === 'mic') state.dragging = null;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener('pointercancel', () => state.dragging = null);
}

// ============================================================
// Frequency slider
// ============================================================
function freqFromFrac(frac) {
  const lo = Math.log(FREQ_MIN), hi = Math.log(FREQ_MAX);
  return Math.exp(lo + frac * (hi - lo));
}
function fracFromFreq(f) {
  const lo = Math.log(FREQ_MIN), hi = Math.log(FREQ_MAX);
  return (Math.log(f) - lo) / (hi - lo);
}

function updateFreqLabel() {
  document.getElementById('freq-label').textContent = `${Math.round(state.freq)} Hz`;
}
function updateFreqThumb() {
  const thumb = document.getElementById('freq-thumb');
  const frac = state.freqThumbPos;
  thumb.style.top = `${(1 - frac) * 100}%`;
}

function initFreqSlider() {
  const wrap = document.getElementById('freq-track-wrap');
  state.freqThumbPos = fracFromFreq(state.freq);
  updateFreqLabel();
  updateFreqThumb();

  const updateFromEvent = (e) => {
    const r = wrap.getBoundingClientRect();
    let frac = 1 - (e.clientY - r.top) / r.height;
    frac = Math.max(0, Math.min(1, frac));
    state.freqThumbPos = frac;
    state.freq = freqFromFrac(frac);
    updateFreqLabel();
    updateFreqThumb();
    updateToneFreq();
  };

  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    state.dragging = 'freq';
    startTone();
    updateFromEvent(e);
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (state.dragging !== 'freq') return;
    updateFromEvent(e);
  });
  const release = (e) => {
    if (state.dragging === 'freq') {
      state.dragging = null;
      stopTone();
      try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);

  // Click the speaker icon → play a beep at current freq
  const freqSpeakerEl = document.getElementById('freq-speaker');
  freqSpeakerEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    playBeep(0, 0.4, state.freq, 0.25);
    freqSpeakerEl.classList.add('fired');
    setTimeout(() => freqSpeakerEl.classList.remove('fired'), 320);
  });
}

// ============================================================
// Top-level buttons
// ============================================================
function initButtons() {
  document.getElementById('play').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    fireAll();
  });
  document.getElementById('btn-random').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    applyRandomDelays();
  });
  document.getElementById('btn-focus').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    applyFocusDelays();
  });
  document.getElementById('btn-plus').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state.n < N_MAX) { state.n++; rebuildSpeakers(); }
  });
  document.getElementById('btn-minus').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state.n > N_MIN) { state.n--; rebuildSpeakers(); }
  });

  // Spacebar = play (suppress page scroll, ignore key repeat)
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    ensureAudio();
    fireAll();
  });
}

// ============================================================
// Resize handling
// ============================================================
function onResize() {
  state.layout = computeLayout();
  for (let i = 0; i < state.speakers.length; i++) {
    const sp = state.speakers[i];
    const y = state.layout.yFor(i);
    sp.x = state.layout.speakerX;
    sp.y = y;
    sp.row.style.left = `${state.layout.sliderLeft}px`;
    sp.row.style.top  = `${y - state.layout.iconSize/2}px`;
    sp.row.style.height = `${state.layout.iconSize}px`;
    sp.sliderEl.style.width = `${state.layout.sliderW}px`;
    sp.sliderEl.style.height = `${state.layout.iconSize}px`;
    sp.iconEl.style.width = `${state.layout.iconSize}px`;
    sp.iconEl.style.height = `${state.layout.iconSize}px`;
    updateThumbPosition(sp);
  }
  setMicPosition(state.mic.x, state.mic.y);
  resizeGL();
  updateFreqThumb();
}

// ============================================================
// Boot
// ============================================================
// Resolve a config icon entry into { src, rotate }. Accepts either a plain
// string ('assets/x.png') or an object ({ src, rotate }).
function resolveIcon(entry) {
  if (!entry) return { src: '', rotate: 0 };
  if (typeof entry === 'string') return { src: entry, rotate: 0 };
  return { src: entry.src || '', rotate: entry.rotate || 0 };
}

// Apply src + rotation to an <img>. Uses object-fit: contain so the image
// never stretches. Wraps rotation with a scale-to-fit factor so a square
// wrapper still contains the rotated content (e.g. 45° → scale 1/√2).
function applyIconToImg(imgEl, entry) {
  const { src, rotate } = resolveIcon(entry);
  const rad = rotate * Math.PI / 180;
  const fit = 1 / (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)));
  imgEl.style.objectFit = 'contain';
  imgEl.style.transformOrigin = 'center center';
  imgEl.style.transform = `rotate(${rotate}deg) scale(${fit})`;
  imgEl.dataset.rotate = String(rotate);
  imgEl.src = src;
}

function applyIconConfig() {
  const cfg = (window.FUSFUN_CONFIG && window.FUSFUN_CONFIG.icons) || {};
  for (const img of document.querySelectorAll('img[data-icon]')) {
    const key = img.dataset.icon;
    if (cfg[key]) applyIconToImg(img, cfg[key]);
  }
}

window.addEventListener('load', () => {
  applyIconConfig();
  initGL();
  rebuildSpeakers();
  initMic();
  initFreqSlider();
  initButtons();
  window.addEventListener('resize', onResize);
  requestAnimationFrame((t) => { lastFrame = t; requestAnimationFrame(tick); });
});

// Prevent scroll/zoom on touch devices
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
