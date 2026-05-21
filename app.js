"use strict";

// ============================================================
// Phased Array Focusing — outreach demo
// ============================================================
// Tunables. Adjust freely; defaults chosen to look good on a 1400×800
// laptop screen at the default 8-speaker count.
// ============================================================
const C_VIS = 240;             // wave speed (pixels per second)
// Wave-packet envelope width is per-packet, scaled with that packet's
// wavelength so we always see roughly one peak + one trough regardless of
// frequency. SIGMA_WL_FRAC sets the scaling; SIGMA_FLOOR keeps high-freq
// packets visible.
const SIGMA_WL_FRAC = 0.5;        // sigma ≈ 0.5 × wavelength → ~1 cycle visible
const SIGMA_FLOOR   = 12;         // minimum sigma in pixels
function sigmaForFreq(f) { return Math.max(SIGMA_FLOOR, wavelengthForFreq(f) * SIGMA_WL_FRAC); }
// Visual wavelength is anchored at the reference frequency, then scaled by
// the physical λ ∝ 1/f relationship. The wavelength used for a packet is
// captured at the moment it fires (baked into each packet's k), so changing
// the frequency slider mid-flight does NOT retroactively warp packets already
// in the air — each ring set reflects the frequency that produced it.
const VIS_WL_REF_FREQ = 800;      // Hz: frequency at which VIS_WL_REF_PX applies
const VIS_WL_REF_PX   = 52;       // pixels: visual wavelength at the reference freq
function wavelengthForFreq(f) { return VIS_WL_REF_PX * VIS_WL_REF_FREQ / f; }
function kForFreq(f) { return 2 * Math.PI / wavelengthForFreq(f); }
// Wave-packet lifetime is computed per-layout (see computeLayout): the packet
// lives long enough for its envelope to fully exit the visible canvas from the
// worst-case speaker position. PACKET_ENVELOPE_MARGIN is the headroom past the
// far corner, expressed in σ-units, so the Gaussian tail is below ~exp(-8).
const PACKET_ENVELOPE_MARGIN = 4;
const N_MIN = 2, N_MAX = 16, N_DEFAULT = 8;
// Max wave packets concurrently in flight across all speakers. Re-firing a
// speaker pushes a new packet instead of replacing the previous one, so this
// caps how many overlapping rings can coexist. Must match the fragment
// shader's uniform array size + loop bound below.
const MAX_PACKETS = 256;
const FREQ_MIN = 220, FREQ_MAX = 2500;
const FREQ_DEFAULT = 800;
const BEEP_DURATION = 0.20;       // seconds, per-speaker beep length at mic
// Fraction of slider width reserved on the left as the wave's onramp zone.
// Even at delayFrac=0 the peak sits this far in, so the leading edge of the
// Gaussian is visible and the sweep dot has room to rise into the peak.
const VISUAL_PAD_FRAC = 0.14;

// Icon sources come from config.js (window.FUSFUN_CONFIG.icons).
// Edit config.js to swap icons without touching code.

// ============================================================
// State
// ============================================================
const state = {
  freq: FREQ_DEFAULT,
  n: N_DEFAULT,
  speakers: [],         // see rebuildSpeakers() for shape
  packets: [],          // {x, y, fireStart, k} — live wave packets, GC'd each frame
  mic: { x: 800, y: 400 },
  probeMode: 'mic',     // 'mic' = play received sound; 'bubble' = oscillate visually
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
  const ctrl = document.getElementById('control-panel');
  const mainR = main.getBoundingClientRect();
  const ctrlR = ctrl.getBoundingClientRect();
  const w = mainR.width, h = mainR.height;
  const ctrlW = ctrlR.width;
  // The two panels share grid row height, so the same y coords map to the
  // same visual row in both → slider in control-panel lines up with the
  // speaker icon in main-panel.
  const topPad = 110;
  const botPad = 175;
  const usable = h - topPad - botPad;
  const n = state.n;
  const iconSize = Math.max(32, Math.min(68, usable / n - 4));

  // Slider lives inside control-panel, centered horizontally with sliderPadX
  // padding on each side.
  const sliderPadX = 22;
  const sliderW = ctrlW - 2 * sliderPadX;
  const sliderLeft = sliderPadX;

  // Speaker icons sit just inside the left edge of main-panel.
  const speakerLeftMargin = 30;
  const speakerX = speakerLeftMargin + iconSize / 2;
  const speakerLeft = speakerLeftMargin;

  const yFor = (i) => topPad + usable * (n === 1 ? 0.5 : (i + 0.5) / n);

  // tMax sets how long the cursor takes to traverse the slider.
  // To keep that sweep speed constant across N (so the demo's tempo doesn't
  // change when the user adds/removes speakers) we size it against the
  // *worst-case* configuration: N_MAX (smallest icons → mic can be closest →
  // widest spread). Focus will exactly fill the slider only at N_MAX; at
  // smaller N it uses a proportional fraction — acceptable trade.
  const refN = N_MAX;
  const refIconSize = Math.max(32, Math.min(68, usable / refN - 4));
  const refMinMicX = speakerX + refIconSize;
  // Use mic at the top of the panel (one of the worst-case y positions) so
  // tMax covers focus when the mic sits above the topmost speaker or below
  // the bottommost. With mic centered, dMax-dMin shrinks to ~half its
  // worst-case value and the closest speakers' focus delays clip.
  const refMicY = topPad;
  let dMin = Infinity, dMax = 0;
  for (let i = 0; i < refN; i++) {
    const sy = topPad + usable * (i + 0.5) / refN;
    const d = Math.hypot(refMinMicX - speakerX, sy - refMicY);
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  // The visual on/off-ramp pads consume 2*VISUAL_PAD_FRAC of the slider's
  // span, so the usable delay range is (1 - 2*VISUAL_PAD_FRAC)*tMax. Inflate
  // tMax accordingly so reference-N focus still exactly fills that range.
  const tMax = Math.max(0.05, (dMax - dMin) / C_VIS / (1 - 2 * VISUAL_PAD_FRAC));

  // Farthest a wave can need to travel: from the speaker column to whichever
  // canvas corner is furthest. Speakers live at x=speakerX, y∈[topPad,h-botPad],
  // so the worst-case dy is max(topPad, botPad) further than h/2 — bound by h.
  const maxTravel = Math.hypot(Math.max(speakerX, w - speakerX), h);
  // Use the widest possible sigma (low freq → long wavelength) for the
  // worst-case envelope tail when sizing packet lifetime.
  const maxSigma = sigmaForFreq(FREQ_MIN);
  const packetLifetime = (maxTravel + PACKET_ENVELOPE_MARGIN * maxSigma) / C_VIS;

  return {
    w, h,
    speakerX, speakerLeft, sliderW, sliderLeft,
    topPad, botPad, usable,
    iconSize, tMax,
    rowHeight: usable / n,
    yFor,
    packetLifetime,
  };
}

// ============================================================
// Build / rebuild speaker rows
// ============================================================
function rebuildSpeakers() {
  const slidersLayer = document.getElementById('sliders-layer');
  const speakersLayer = document.getElementById('speakers-layer');
  slidersLayer.innerHTML = '';
  speakersLayer.innerHTML = '';
  state.speakers = [];
  state.packets.length = 0;   // drop in-flight wave packets from prior speaker set
  state.layout = computeLayout();
  const L = state.layout;

  for (let i = 0; i < state.n; i++) {
    const y = L.yFor(i);

    // Slider row lives in the control panel.
    const sliderRow = document.createElement('div');
    sliderRow.className = 'slider-row';
    sliderRow.style.left = `${L.sliderLeft}px`;
    sliderRow.style.top  = `${y - L.iconSize/2}px`;
    sliderRow.style.width = `${L.sliderW}px`;
    sliderRow.style.height = `${L.iconSize}px`;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const slider = document.createElementNS(SVG_NS, 'svg');
    slider.setAttribute('class', 'delay-wave');
    slider.setAttribute('width', L.sliderW);
    slider.setAttribute('height', L.iconSize);
    slider.setAttribute('viewBox', `0 0 ${L.sliderW} ${L.iconSize}`);
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('class', 'wave-line');
    slider.appendChild(line);
    sliderRow.appendChild(slider);
    slidersLayer.appendChild(sliderRow);

    // Speaker icon lives in the main (wave) panel at the same y.
    const iconWrap = document.createElement('div');
    iconWrap.className = 'speaker-icon-wrap';
    iconWrap.style.left = `${L.speakerLeft}px`;
    iconWrap.style.top = `${y - L.iconSize/2}px`;
    iconWrap.style.width = `${L.iconSize}px`;
    iconWrap.style.height = `${L.iconSize}px`;

    const icon = document.createElement('div');
    icon.className = 'speaker-icon';
    icon.style.width = `${L.iconSize}px`;
    icon.style.height = `${L.iconSize}px`;
    const iconImg = document.createElement('img');
    iconImg.alt = '';
    iconImg.draggable = false;
    applyIconToImg(iconImg, (window.FUSFUN_CONFIG.icons || {}).speaker);
    icon.appendChild(iconImg);
    iconWrap.appendChild(icon);
    speakersLayer.appendChild(iconWrap);

    const sp = {
      x: L.speakerX,                  // wave emits from icon center
      y,
      delayFrac: 0,                   // 0..1, scaled by layout.tMax for actual seconds
      sweeps: [],                     // active PLAY sweeps: { startTime, armed, cursorEl }
      sliderRow,
      sliderEl: slider,
      lineEl: line,
      iconWrap,
      iconEl: icon,
      idx: i,
      waveParams: null,               // {centerY, amplitude, sigma, k, peakX, w, visualPad} — set by updateThumbPosition
    };
    state.speakers.push(sp);

    updateThumbPosition(sp);
    wireSpeakerRow(sp);
  }

  document.getElementById('count-label').textContent = `${state.n}`;
}

// Evaluate the slider's wave curve at horizontal position x.
// Gaussian-modulated cosine — positive pressure peak above the centerline,
// negative-pressure side lobes (ringing) below it.
//   y = centerY - amplitude * exp(-dx²/(2σ²)) * cos(k*dx)
function waveY(x, wp) {
  const dx = x - wp.peakX;
  const env = Math.exp(-(dx * dx) / (2 * wp.sigma * wp.sigma));
  const osc = Math.cos(wp.k * dx);
  return wp.centerY - wp.amplitude * env * osc;
}

function updateThumbPosition(sp) {
  const L = state.layout;
  const w = L.sliderW;
  const h = L.iconSize;
  // Zero-DC line at the vertical center of the row (= speaker icon centerline).
  const centerY = h / 2;
  const amplitude = (h - 8) / 2;
  const visualPad = w * VISUAL_PAD_FRAC;
  // Subtle linear shrink with frequency: low freq → wider bump, high freq →
  // narrower bump. Just a visual hint, not physically accurate.
  const freqNorm = (state.freq - FREQ_MIN) / (FREQ_MAX - FREQ_MIN);
  const sigmaScale = 1.5 - 1.0 * freqNorm;      // 1.5 at FREQ_MIN, 0.5 at FREQ_MAX
  const sigma = Math.max(8, w * 0.035 * sigmaScale);
  // Wavenumber tied to sigma so ~1 main lobe + small side lobes are visible:
  // wavelength = 2*sigma → k = π/sigma.
  const k = Math.PI / sigma;
  // delayFrac 0..1 maps the peak across [visualPad, sliderW - visualPad] —
  // the left band is reserved for the onramp, the right band for the offramp.
  const peakX = visualPad + sp.delayFrac * (w - 2 * visualPad);
  const wp = { centerY, amplitude, sigma, k, peakX, w, visualPad };
  sp.waveParams = wp;

  // Stroke the wave as a polyline. Sample density scales with sigma so the
  // bump stays smooth even when narrow (high freq → small sigma).
  const N = Math.max(64, Math.ceil((w / sigma) * 10));
  let d = '';
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * w;
    const y = waveY(x, wp);
    d += (i === 0 ? 'M ' : ' L ') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  sp.lineEl.setAttribute('d', d);
  // Reposition any in-flight sweep dots so they sit on the new curve.
  for (const sw of sp.sweeps) {
    const sweepT = state.simTime - sw.startTime;
    const frac = Math.min(1, Math.max(0, sweepT / state.layout.tMax));
    const x = frac * w;
    sw.cursorEl.setAttribute('cx', x);
    sw.cursorEl.setAttribute('cy', waveY(x, wp));
  }
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

  // Click speaker icon → emit immediately (bypass slider/sweep)
  sp.iconEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ensureAudio();
    emitFromSpeaker(sp, state.simTime);
  });
}

function moveDelayFromEvent(e, sp) {
  const rect = sp.sliderEl.getBoundingClientRect();
  const w = rect.width;
  const visualPad = w * VISUAL_PAD_FRAC;
  // Clamp pointer x to the peak's allowed range, then invert the mapping.
  const x = Math.max(visualPad, Math.min(w - visualPad, e.clientX - rect.left));
  sp.delayFrac = (x - visualPad) / (w - 2 * visualPad);
  updateThumbPosition(sp);
}

// ============================================================
// Firing speakers
// ============================================================
// Emit a packet + scheduled beep from a speaker at a given sim time. Used both
// for direct icon clicks (immediate) and for PLAY sweeps reaching the slider
// position (delayed via the sweep, but the actual emit is still "now-ish").
function emitFromSpeaker(sp, fireStart) {
  const firedFreq = state.freq;
  emitPacket(sp.x, sp.y, fireStart, firedFreq, sp);
  sp.iconEl.classList.add('fired');
  setTimeout(() => sp.iconEl.classList.remove('fired'), 200);
  const d = Math.hypot(sp.x - state.mic.x, sp.y - state.mic.y);
  const travelTime = d / C_VIS;
  const amp = 0.55 / Math.sqrt(d / 220 + 1);
  // Only the microphone probe "hears" — bubble mode is silent (it oscillates visually).
  if (state.probeMode === 'mic') {
    const sysLatency = (audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0);
    const visualLead = 0.7 * sigmaForFreq(firedFreq) / C_VIS;
    // fireStart may be in the past (sweep fire from a slightly earlier instant);
    // schedule relative to now, not to fireStart, so we never schedule in the past.
    const ageFromNow = state.simTime - fireStart;
    const scheduleTime = Math.max(0, travelTime - sysLatency - visualLead - ageFromNow);
    playBeep(scheduleTime, amp, firedFreq);
  }
}

// PLAY → push a new sweep onto every speaker. Multiple PLAY presses stack:
// each gets its own dot that travels along the wave curve independently.
function startSweep(sp) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const cursorEl = document.createElementNS(SVG_NS, 'circle');
  cursorEl.setAttribute('class', 'sweep-dot');
  cursorEl.setAttribute('r', '5');
  cursorEl.setAttribute('cx', '0');
  cursorEl.setAttribute('cy', sp.waveParams ? sp.waveParams.centerY : 0);
  sp.sliderEl.appendChild(cursorEl);
  sp.sweeps.push({ startTime: state.simTime, armed: true, cursorEl });
}

function fireAll() {
  ensureAudio();
  for (const sp of state.speakers) startSweep(sp);
  const playBtn = document.getElementById('play');
  playBtn.classList.add('fired');
  setTimeout(() => playBtn.classList.remove('fired'), 220);
}

function applyRandomDelays() {
  for (const sp of state.speakers) {
    sp.delayFrac = Math.random();
    updateThumbPosition(sp);
  }
}

function applyFocusDelays() {
  // delay_i = (d_max - d_i) / C_VIS, where d_i = speaker-to-mic distance.
  // The dynamic delay range is now (1 - VISUAL_PAD_FRAC) * tMax — the visual
  // onramp band on the left consumes the rest. Relative timing is preserved.
  const tMax = state.layout.tMax;
  const effSpan = (1 - 2 * VISUAL_PAD_FRAC) * tMax;
  const dists = state.speakers.map(sp => Math.hypot(sp.x - state.mic.x, sp.y - state.mic.y));
  const dmax = Math.max(...dists);
  state.speakers.forEach((sp, i) => {
    const delaySec = (dmax - dists[i]) / C_VIS;
    sp.delayFrac = Math.max(0, Math.min(1, delaySec / effSpan));
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
    const wp = sp.waveParams;
    // Emit when the sweep dot reaches the wave's leading edge (~2σ before
    // the peak), not the peak itself — so the field viz begins as the dot
    // climbs the upramp, and grows naturally until the dot crests the peak.
    const peakX = wp ? wp.peakX : 0;
    const leadX = Math.max(0, peakX - 2 * (wp ? wp.sigma : 0));
    const emitSec = (leadX / L.sliderW) * tMax;
    const liveSweeps = [];
    for (const sw of sp.sweeps) {
      const sweepT = state.simTime - sw.startTime;
      if (sweepT > tMax + 0.2) {
        if (sw.cursorEl && sw.cursorEl.parentNode) sw.cursorEl.parentNode.removeChild(sw.cursorEl);
        continue;
      }
      const frac = Math.min(1, sweepT / tMax);
      const x = frac * L.sliderW;
      sw.cursorEl.setAttribute('cx', x);
      sw.cursorEl.setAttribute('cy', waveY(x, wp));
      if (sw.armed && sweepT >= emitSec) {
        sw.armed = false;
        emitFromSpeaker(sp, sw.startTime + emitSec);
      }
      liveSweeps.push(sw);
    }
    sp.sweeps = liveSweeps;
  }

  renderWaveField();
  updateMicGlow();
  updateSpeakerPulse();
  requestAnimationFrame(tick);
}

// Each speaker icon pulses with the slider's wave shape sampled exactly at
// the sweep dot's current position — so the icon hits max scale when the
// dot crests the peak, dips below 1 as it crosses the negative side lobes,
// and decays back to baseline as the dot leaves the pulse.
function updateSpeakerPulse() {
  const L = state.layout;
  for (const sp of state.speakers) {
    const wp = sp.waveParams;
    if (!wp) continue;
    let drive = 0;
    for (const sw of sp.sweeps) {
      const sweepT = state.simTime - sw.startTime;
      if (sweepT < 0) continue;
      const x = (sweepT / L.tMax) * L.sliderW;
      const dx = x - wp.peakX;
      // Skip once well past the pulse envelope to keep the icon at baseline.
      if (Math.abs(dx) > 4 * wp.sigma && sweepT > 0) continue;
      const env = Math.exp(-(dx * dx) / (2 * wp.sigma * wp.sigma));
      drive += env * Math.cos(wp.k * dx);
    }
    if (Math.abs(drive) > 0.01) {
      const scale = Math.max(0.7, Math.min(1.4, 1 + drive * 0.35));
      sp.iconEl.style.transform = `scale(${scale})`;
    } else if (sp.iconEl.style.transform) {
      sp.iconEl.style.transform = '';
    }
  }
}

// ============================================================
// Wave packets — one per fire event, independent of which speaker emitted them
// ============================================================
function emitPacket(x, y, fireStart, firedFreq, sp) {
  // Cap concurrent packets: if the pool is full, evict the oldest. With
  // MAX_PACKETS sized at 4× N_MAX this only kicks in under sustained mashing.
  if (state.packets.length >= MAX_PACKETS) state.packets.shift();
  state.packets.push({ x, y, fireStart, k: kForFreq(firedFreq), sigma: sigmaForFreq(firedFreq), sp });
}

function pruneExpiredPackets(t) {
  const lifetime = state.layout.packetLifetime;
  const live = state.packets;
  let w = 0;
  for (let r = 0; r < live.length; r++) {
    if (t - live[r].fireStart <= lifetime) live[w++] = live[r];
  }
  live.length = w;
}

// ============================================================
// Mic glow (sample the field on CPU using the same equation as the shader)
// ============================================================
function fieldAtPoint(px, py, t) {
  let f = 0;
  const lifetime = state.layout.packetLifetime;
  for (const pk of state.packets) {
    const dt = t - pk.fireStart;
    if (dt < 0 || dt > lifetime) continue;
    const dx = pk.x - px, dy = pk.y - py;
    const r = Math.sqrt(dx*dx + dy*dy);
    const wr = C_VIS * dt;
    const arg = r - wr;
    const env = Math.exp(-arg*arg / (2 * pk.sigma * pk.sigma));
    f += env * Math.cos(pk.k * arg) / Math.sqrt(r + 50);
  }
  return f;
}

const micEl = () => document.getElementById('mic');
function updateMicGlow() {
  const f = fieldAtPoint(state.mic.x, state.mic.y, state.simTime);
  const el = micEl();
  const img = el.querySelector('img');
  if (state.probeMode === 'bubble') {
    // Bubble oscillates with the driving waveform: bigger on positive pressure,
    // smaller on rarefaction. Field magnitudes are tiny, so amplify heavily.
    const drive = Math.max(-1, Math.min(1, f * 60));
    const scale = 1 + drive * 0.35;
    const baseRot = parseFloat(img.dataset.rotate) || 0;
    const baseFit = parseFloat(img.dataset.fit) || 1;
    img.style.transform = `rotate(${baseRot}deg) scale(${baseFit * scale})`;
    const glow = Math.abs(drive) * 14;
    el.style.filter = glow > 0.5
      ? `drop-shadow(0 0 ${glow}px rgba(140, 200, 255, ${0.3 + Math.abs(drive) * 0.5}))`
      : '';
  } else {
    const intensity = Math.min(1, Math.abs(f) * 50);
    if (intensity > 0.05) {
      const glow = 6 + intensity * 24;
      el.style.filter = `drop-shadow(0 0 ${glow}px rgba(255, 200, 60, ${0.4 + intensity * 0.6})) brightness(${1 + intensity * 0.4})`;
    } else {
      el.style.filter = '';
    }
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
uniform int uN;             // number of live packets this frame
uniform vec2 uPos[256];
uniform float uStart[256];
uniform float uK[256];      // per-packet visual wavenumber (depends on freq at emit time)
uniform float uSigmaFloor;  // minimum envelope width in pixels (high-freq clamp)
uniform float uC;
uniform float uLifetime;
void main() {
  // Convert physical pixel coord → logical (top-left origin), so we can compare with uPos
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uDpr;
  float field = 0.0;
  for (int i = 0; i < 256; i++) {
    if (i >= uN) break;
    float dt = uTime - uStart[i];
    if (dt < 0.0 || dt > uLifetime) continue;
    vec2 d = p - uPos[i];
    float r = length(d);
    float wr = uC * dt;
    float arg = r - wr;
    // sigma scales with wavelength so packets show ~1 cycle regardless of freq.
    // sigma = 0.5 * wavelength = π / k, clamped to a floor for visibility.
    float s = max(uSigmaFloor, 3.14159265 / uK[i]);
    float env = exp(-arg*arg / (2.0 * s * s));
    float osc = cos(uK[i] * arg);
    field += env * osc / sqrt(r + 50.0);
  }
  float v = clamp(field * 7.0, -1.0, 1.0);
  vec3 base = vec3(1.0);
  vec3 hot  = vec3(0.92, 0.18, 0.18);
  vec3 cold = vec3(0.16, 0.36, 0.86);
  vec3 col;
  if (v > 0.0) col = mix(base, hot, v);
  else         col = mix(base, cold, -v);
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
    uC:          gl.getUniformLocation(program, 'uC'),
    uK:          gl.getUniformLocation(program, 'uK'),
    uSigmaFloor: gl.getUniformLocation(program, 'uSigmaFloor'),
    uLifetime:   gl.getUniformLocation(program, 'uLifetime'),
  };

  gl.uniform1f(uniforms.uC, C_VIS);
  gl.uniform1f(uniforms.uSigmaFloor, SIGMA_FLOOR);

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
  const lifetime = state.layout.packetLifetime;
  pruneExpiredPackets(state.simTime);

  gl.disable(gl.BLEND);
  gl.clearColor(1.0, 1.0, 1.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
  gl.uniform1f(uniforms.uDpr, dpr);
  gl.uniform1f(uniforms.uTime, state.simTime);
  gl.uniform1f(uniforms.uLifetime, lifetime);

  const N = state.packets.length;
  gl.uniform1i(uniforms.uN, N);

  const posArr = new Float32Array(MAX_PACKETS * 2);
  const startArr = new Float32Array(MAX_PACKETS);
  const kArr = new Float32Array(MAX_PACKETS);
  for (let i = 0; i < N; i++) {
    const pk = state.packets[i];
    posArr[2*i + 0] = pk.x;
    posArr[2*i + 1] = pk.y;
    startArr[i] = pk.fireStart;
    kArr[i] = pk.k;
  }
  gl.uniform2fv(uniforms.uPos, posArr);
  gl.uniform1fv(uniforms.uStart, startArr);
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

let resizeProbe = () => {};
function initMic() {
  const el = micEl();
  const img = el.querySelector('img');
  const baseDim = Math.max(36, Math.min(56, state.layout.h * 0.065));

  // Size the mic wrapper to match the image's natural aspect ratio AFTER
  // rotation, so the icon isn't squished. Re-run whenever the image (re)loads
  // or the probe icon is swapped (mic ↔ bubble).
  resizeProbe = () => {
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
  img.addEventListener('load', resizeProbe);
  if (img.complete && img.naturalWidth) resizeProbe();

  setMicPosition(state.layout.w * 0.7, state.layout.topPad + state.layout.usable / 2);

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

const FREQ_THUMB_PX = 28;   // matches CSS #freq-thumb width/height

function updateFreqLabel() {
  document.getElementById('freq-label').textContent = `${Math.round(state.freq)} Hz`;
}
function updateFreqThumb() {
  const wrap = document.getElementById('freq-track-wrap');
  const thumb = document.getElementById('freq-thumb');
  const wrapH = wrap.clientHeight || wrap.getBoundingClientRect().height;
  const half = FREQ_THUMB_PX / 2;
  const usable = Math.max(1, wrapH - FREQ_THUMB_PX);
  // Offset by half-thumb so the thumb's edges never poke outside the wrap
  const centerPx = half + (1 - state.freqThumbPos) * usable;
  thumb.style.top = `${centerPx}px`;
  thumb.style.transform = 'translate(-50%, -50%)';
}

function initFreqSlider() {
  const wrap = document.getElementById('freq-track-wrap');
  state.freqThumbPos = fracFromFreq(state.freq);
  updateFreqLabel();
  updateFreqThumb();

  const updateFromEvent = (e) => {
    const r = wrap.getBoundingClientRect();
    const half = FREQ_THUMB_PX / 2;
    const usable = Math.max(1, r.height - FREQ_THUMB_PX);
    let frac = 1 - ((e.clientY - r.top) - half) / usable;
    frac = Math.max(0, Math.min(1, frac));
    state.freqThumbPos = frac;
    state.freq = freqFromFrac(frac);
    updateFreqLabel();
    updateFreqThumb();
    updateToneFreq();
    for (const sp of state.speakers) updateThumbPosition(sp);
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
// Probe mode toggle (mic ↔ bubble)
// ============================================================
function setProbeMode(mode) {
  if (mode !== 'mic' && mode !== 'bubble') return;
  state.probeMode = mode;
  const iconKey = mode === 'mic' ? 'microphone' : 'bubble';
  const cfg = (window.FUSFUN_CONFIG && window.FUSFUN_CONFIG.icons) || {};
  const el = micEl();
  el.dataset.mode = mode;
  applyIconToImg(el.querySelector('img'), cfg[iconKey]);
  resizeProbe();
  // Clear any lingering filter from the previous mode.
  el.style.filter = '';
  for (const btn of document.querySelectorAll('#probe-toggle .probe-opt')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

function initProbeToggle() {
  for (const btn of document.querySelectorAll('#probe-toggle .probe-opt')) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ensureAudio();
      setProbeMode(btn.dataset.mode);
    });
  }
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
  const L = state.layout;
  for (let i = 0; i < state.speakers.length; i++) {
    const sp = state.speakers[i];
    const y = L.yFor(i);
    sp.x = L.speakerX;
    sp.y = y;
    sp.sliderRow.style.left = `${L.sliderLeft}px`;
    sp.sliderRow.style.top = `${y - L.iconSize/2}px`;
    sp.sliderRow.style.width = `${L.sliderW}px`;
    sp.sliderRow.style.height = `${L.iconSize}px`;
    sp.sliderEl.setAttribute('width', L.sliderW);
    sp.sliderEl.setAttribute('height', L.iconSize);
    sp.sliderEl.setAttribute('viewBox', `0 0 ${L.sliderW} ${L.iconSize}`);
    sp.iconWrap.style.left = `${L.speakerLeft}px`;
    sp.iconWrap.style.top = `${y - L.iconSize/2}px`;
    sp.iconWrap.style.width = `${L.iconSize}px`;
    sp.iconWrap.style.height = `${L.iconSize}px`;
    sp.iconEl.style.width = `${L.iconSize}px`;
    sp.iconEl.style.height = `${L.iconSize}px`;
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
  imgEl.dataset.fit = String(fit);
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
  initProbeToggle();
  initFreqSlider();
  initButtons();
  window.addEventListener('resize', onResize);
  requestAnimationFrame((t) => { lastFrame = t; requestAnimationFrame(tick); });
});

// Prevent scroll/zoom on touch devices
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
