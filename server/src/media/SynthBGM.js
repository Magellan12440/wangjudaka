/**
 * 零依赖音频合成器（BGM + 音效）。
 *
 * 为什么要有它：`bgm_library.json` 里的 12 条曲目全部是 `TEMPLATE_NEED_REAL_ASSET`，
 * 只有授权元数据、没有真实音频文件。要让「每条成片都自带 BGM」成立，必须有一条
 * 永远能兜住的路：不联网、不花钱、无版权风险。
 *
 * 产出规格：22050Hz / 16bit / 单声道 WAV。
 * 质量定位：氛围铺底（pad + bass + pulse + 少量铃音），不是大师配乐；
 * 对白之上 -20dB 左右完全够用，且能被 FFmpeg 后续转成 AAC。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEDIA_ROOT } from '../api/media.js';

export const SAMPLE_RATE = 22050;
const TWO_PI = Math.PI * 2;

// —— 情绪 → 调式 / 速度 / 和弦进行 / 配器 ——
export const MOOD_TABLE = {
  suspense: { root: 220.0, bpm: 62, prog: [[0, 'min'], [8, 'min'], [5, 'min'], [7, 'maj']], layers: { pad: 1.0, bass: 0.75, pulse: 0.18, bell: 0.30, perc: 0.0 } },
  tense: { root: 164.8, bpm: 96, prog: [[0, 'min'], [0, 'min'], [1, 'maj'], [0, 'min']], layers: { pad: 0.85, bass: 0.85, pulse: 0.55, bell: 0.12, perc: 0.35 } },
  sad: { root: 220.0, bpm: 56, prog: [[0, 'min'], [5, 'min'], [3, 'maj'], [7, 'min']], layers: { pad: 1.0, bass: 0.6, pulse: 0.10, bell: 0.40, perc: 0.0 } },
  warm: { root: 261.6, bpm: 74, prog: [[0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']], layers: { pad: 0.95, bass: 0.55, pulse: 0.22, bell: 0.35, perc: 0.0 } },
  epic: { root: 146.8, bpm: 86, prog: [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']], layers: { pad: 1.0, bass: 0.9, pulse: 0.35, bell: 0.25, perc: 0.55 } },
  action: { root: 196.0, bpm: 112, prog: [[0, 'min'], [10, 'maj'], [8, 'maj'], [7, 'maj']], layers: { pad: 0.7, bass: 1.0, pulse: 0.6, bell: 0.1, perc: 0.8 } },
  mystery: { root: 174.6, bpm: 66, prog: [[0, 'min'], [1, 'maj'], [0, 'min'], [8, 'min']], layers: { pad: 0.9, bass: 0.7, pulse: 0.2, bell: 0.45, perc: 0.1 } },
  cyber: { root: 185.0, bpm: 104, prog: [[0, 'min'], [3, 'min'], [8, 'maj'], [10, 'maj']], layers: { pad: 0.75, bass: 1.0, pulse: 0.7, bell: 0.18, perc: 0.6 } },
  daily: { root: 261.6, bpm: 82, prog: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']], layers: { pad: 0.8, bass: 0.5, pulse: 0.35, bell: 0.3, perc: 0.0 } },
};
export const DEFAULT_MOOD = 'daily';

const CHORDS = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  dim: [0, 3, 6],
  sus2: [0, 2, 7],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
};

/** 确定性伪随机（同一 seed 出同一段音乐，便于复现与测试） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noteHz = (root, semitone) => root * Math.pow(2, semitone / 12);

/** 谐波叠加锯齿：用波表避免每样本 6 次 Math.sin（90 秒曲子快 20 倍以上） */
const SAW_TABLE = (() => {
  const N = 4096;
  const t = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = (TWO_PI * i) / N;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(p * h) / h;
    t[i] = v * 0.55;
  }
  return t;
})();
function saw(phase) {
  let p = phase % TWO_PI;
  if (p < 0) p += TWO_PI;
  return SAW_TABLE[(p * (SAW_TABLE.length / TWO_PI)) | 0];
}
const tri = (phase) => (2 / Math.PI) * Math.asin(Math.sin(phase));

/** 包络：a 起振，d 衰减，s 保持，r 释放（均为秒） */
function adsr(t, dur, a, d, s, r) {
  if (t < 0 || t > dur) return 0;
  if (t < a) return a > 0 ? t / a : 1;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / Math.max(d, 1e-6));
  if (t < dur - r) return s;
  return s * Math.max(0, (dur - t) / Math.max(r, 1e-6));
}

/** 一阶低通（状态沿用，避免每样本重算） */
function lowpass(x, state, cutoff) {
  const dt = 1 / SAMPLE_RATE;
  const rc = 1 / (TWO_PI * Math.max(cutoff, 20));
  const alpha = dt / (rc + dt);
  state.y += alpha * (x - state.y);
  return state.y;
}

/** 双二阶带通（用于噪声扫频） */
function biquadBandpass(x, st, f0, q) {
  const w0 = (TWO_PI * Math.min(f0, SAMPLE_RATE * 0.45)) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.2));
  const cos = Math.cos(w0);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const y = (b0 / a0) * x + (b2 / a0) * st.x2 - (a1 / a0) * st.y1 - (a2 / a0) * st.y2;
  st.x2 = st.x1;
  st.x1 = x;
  st.y2 = st.y1;
  st.y1 = y;
  return y;
}

/**
 * 生成一段 BGM。
 * @param {object} p { mood, seconds, bpm?, seed?, gain? }
 * @returns {{ buffer: Buffer, meta: object }}
 */
export function synthBed({ mood = DEFAULT_MOOD, seconds = 60, bpm = null, seed = 1, gain = 0.55 } = {}) {
  const cfg = MOOD_TABLE[mood] ?? MOOD_TABLE[DEFAULT_MOOD];
  const bpmUse = bpm ?? cfg.bpm;
  const total = Math.max(2, Math.round(seconds));
  const n = total * SAMPLE_RATE;
  const out = new Float32Array(n);
  const rnd = mulberry32(seed);
  const beat = 60 / bpmUse;
  const bar = beat * 4;
  const bars = Math.ceil(total / bar);
  const L = cfg.layers;

  // —— pad：和弦铺底 ——
  for (let b = 0; b < bars; b++) {
    const [semi, type] = cfg.prog[b % cfg.prog.length];
    const notes = (CHORDS[type] ?? CHORDS.min).map((x) => noteHz(cfg.root, semi + x));
    const t0 = b * bar;
    const dur = Math.min(bar * 1.05, total - t0);
    if (dur <= 0) continue;
    for (const f of notes) {
      for (const detune of [-0.0035, 0.0035]) {
        const ff = f * (1 + detune);
        const ph0 = rnd() * TWO_PI;
        for (let i = 0; i < dur * SAMPLE_RATE; i++) {
          const t = i / SAMPLE_RATE;
          const idx = Math.round(t0 * SAMPLE_RATE) + i;
          if (idx >= n) break;
          const env = adsr(t, dur, 1.1, 0.6, 0.72, 1.4) * 0.16 * L.pad;
          out[idx] += saw(TWO_PI * ff * t + ph0) * env;
        }
      }
    }
  }

  // —— bass：每小节根音 ——
  for (let b = 0; b < bars; b++) {
    const [semi] = cfg.prog[b % cfg.prog.length];
    const f = noteHz(cfg.root, semi - 12);
    const t0 = b * bar;
    const dur = Math.min(bar * 0.95, total - t0);
    if (dur <= 0) continue;
    const ph0 = rnd() * TWO_PI;
    for (let i = 0; i < dur * SAMPLE_RATE; i++) {
      const t = i / SAMPLE_RATE;
      const idx = Math.round(t0 * SAMPLE_RATE) + i;
      if (idx >= n) break;
      const env = adsr(t, dur, 0.015, 0.5, 0.45, 0.5) * 0.26 * L.bass;
      out[idx] += Math.sin(TWO_PI * f * t + ph0) * env;
    }
  }

  // —— pulse：八分音符脉冲 ——
  if (L.pulse > 0) {
    const step = beat / 2;
    for (let t0 = 0; t0 < total; t0 += step) {
      const dur = Math.min(step * 0.9, 0.22);
      const f = noteHz(cfg.root, 12);
      for (let i = 0; i < dur * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        const idx = Math.round(t0 * SAMPLE_RATE) + i;
        if (idx >= n) break;
        const env = Math.exp(-t * 18) * 0.12 * L.pulse;
        out[idx] += tri(TWO_PI * f * t) * env;
      }
    }
  }

  // —— bell：稀疏铃音，靠随机但确定性的点缀 ——
  if (L.bell > 0) {
    const scale = [0, 2, 3, 5, 7, 8, 10];
    for (let t0 = 0; t0 < total; t0 += beat * 2) {
      if (rnd() > 0.42) continue;
      const semi = scale[Math.floor(rnd() * scale.length)] + 24;
      const f = noteHz(cfg.root, semi);
      const dur = Math.min(1.8, total - t0);
      for (let i = 0; i < dur * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        const idx = Math.round(t0 * SAMPLE_RATE) + i;
        if (idx >= n) break;
        const env = Math.exp(-t * 3.2) * 0.07 * L.bell;
        out[idx] += (Math.sin(TWO_PI * f * t) + 0.4 * Math.sin(TWO_PI * f * 2.01 * t)) * env;
      }
    }
  }

  // —— perc：低频打点（动作/赛博） ——
  if (L.perc > 0) {
    for (let t0 = 0; t0 < total; t0 += beat) {
      const dur = 0.16;
      for (let i = 0; i < dur * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        const idx = Math.round(t0 * SAMPLE_RATE) + i;
        if (idx >= n) break;
        const env = Math.exp(-t * 26) * 0.14 * L.perc;
        out[idx] += (rnd() * 2 - 1) * env * 0.5 + Math.sin(TWO_PI * 58 * t) * env;
      }
    }
  }

  // —— 后处理：低通 + 淡入淡出 + 归一 ——
  const lp = { y: 0 };
  for (let i = 0; i < n; i++) out[i] = lowpass(out[i], lp, 6800);

  const fadeIn = Math.min(1.2, total * 0.1) * SAMPLE_RATE;
  const fadeOut = Math.min(2.0, total * 0.15) * SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    if (i < fadeIn) out[i] *= i / fadeIn;
    if (i > n - fadeOut) out[i] *= (n - i) / fadeOut;
  }
  normalize(out, gain);

  return {
    buffer: encodeWav(out),
    meta: { mood, bpm: bpmUse, seconds: total, sample_rate: SAMPLE_RATE, seed, layers: L },
  };
}

function normalize(buf, peakTarget = 0.55) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak < 1e-6) return buf;
  const k = peakTarget / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

/** 软削波，防止叠加后刺耳 */
function softClip(x) {
  if (x > 0.8) return 0.8 + (1 - Math.exp(-(x - 0.8) * 4)) * 0.2;
  if (x < -0.8) return -0.8 - (1 - Math.exp(-(-x - 0.8) * 4)) * 0.2;
  return x;
}

/** 16bit PCM 单声道 WAV */
export function encodeWav(float32) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, softClip(float32[i])));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * 生成单个音效。
 * @param {object} card 来自 sfx_library.json 的条目
 */
export function synthSfx(card) {
  const synth = card?.synth ?? { type: 'noise_bed' };
  const dur = Math.max(0.05, card?.duration || 0.6);
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const rnd = mulberry32(hashCode(card?.code ?? 'sfx'));

  switch (synth.type) {
    case 'noise_sweep': {
      const st = { x1: 0, x2: 0, y1: 0, y2: 0 };
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const f = synth.f0 + (synth.f1 - synth.f0) * p;
        const env = adsr(i / SAMPLE_RATE, dur, synth.attack ?? 0.05, dur * 0.2, 0.85, synth.release ?? 0.3);
        out[i] = biquadBandpass(rnd() * 2 - 1, st, f, synth.q ?? 1.2) * env;
      }
      break;
    }
    case 'tone_sweep': {
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const f = synth.f0 + (synth.f1 - synth.f0) * p * p;
        ph += (TWO_PI * f) / SAMPLE_RATE;
        const env = adsr(i / SAMPLE_RATE, dur, synth.attack ?? 0.5, 0.2, 0.9, synth.release ?? 0.3);
        out[i] = (synth.wave === 'saw' ? saw(ph) : synth.wave === 'triangle' ? tri(ph) : Math.sin(ph)) * env;
      }
      break;
    }
    case 'thump': {
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const f = synth.f0 + (synth.f1 - synth.f0) * Math.sqrt(p);
        ph += (TWO_PI * f) / SAMPLE_RATE;
        const env = Math.exp(-p * 6) * (synth.attack ? Math.min(1, i / (synth.attack * SAMPLE_RATE || 1)) : 1);
        out[i] = (Math.sin(ph) * 0.9 + (rnd() * 2 - 1) * Math.exp(-p * 30) * 0.25) * env;
      }
      break;
    }
    case 'two_thump': {
      const gap = synth.gap ?? 0.28;
      for (let k = 0; k < 2; k++) {
        const off = Math.round(k * gap * SAMPLE_RATE);
        let ph = 0;
        for (let i = off; i < n; i++) {
          const t = (i - off) / SAMPLE_RATE;
          const p = (i - off) / Math.max(1, n - off);
          ph += (TWO_PI * synth.f0 * (1 - p * 0.35)) / SAMPLE_RATE;
          const env = Math.exp(-t * 7) * Math.min(1, t / 0.01) * (k === 0 ? 1 : 0.8);
          out[i] += Math.sin(ph) * env * 0.8;
        }
      }
      break;
    }
    case 'noise_bed': {
      const st = { x1: 0, x2: 0, y1: 0, y2: 0 };
      const color = synth.color ?? 'pink';
      for (let i = 0; i < n; i++) {
        const w = rnd() * 2 - 1;
        let x = w;
        if (color === 'pink') x = 0.7 * w + 0.3 * st.y1;
        if (color === 'brown') x = 0.85 * st.y1 + 0.15 * w;
        st.y1 = x;
        const env = adsr(i / SAMPLE_RATE, dur, synth.attack ?? 0.5, 0.3, 0.9, synth.release ?? 0.6);
        out[i] = biquadBandpass(x, st, synth.f0 ?? 800, synth.q ?? 0.7) * env * 1.6;
      }
      break;
    }
    case 'chord_stab': {
      const notes = synth.notes ?? [0, 3, 7];
      for (const semi of notes) {
        const f = noteHz(synth.root_hz ?? 220, semi);
        for (const dt of [-(synth.detune ?? 0.006), synth.detune ?? 0.006]) {
          let ph = 0;
          for (let i = 0; i < n; i++) {
            const t = i / SAMPLE_RATE;
            ph += (TWO_PI * f * (1 + dt)) / SAMPLE_RATE;
            const env = Math.exp(-t * 3.4) * Math.min(1, t / (synth.attack ?? 0.006));
            out[i] += saw(ph) * env * 0.12;
          }
        }
      }
      break;
    }
    case 'bell_cluster': {
      const notes = synth.notes ?? [0, 7];
      const sparse = !!synth.sparse;
      for (const semi of notes) {
        const f = noteHz(synth.root_hz ?? 880, semi);
        const start = sparse ? Math.floor(rnd() * n * 0.6) : 0;
        for (let i = start; i < n; i++) {
          const t = (i - start) / SAMPLE_RATE;
          const env = Math.exp(-t * (synth.release ?? 1.4) * 2.2) * (synth.attack ?? 0.002);
          out[i] += Math.sin(TWO_PI * f * t) * env * 0.09;
        }
      }
      break;
    }
    default:
      break;
  }

  normalize(out, 0.5);
  return encodeWav(out);
}

function hashCode(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 落盘到 /media 可访问的目录：<24hex>.wav */
export function saveWav(buffer, prefix = 'bgm') {
  fs.mkdirSync(MEDIA_ROOT, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.wav`;
  const file = path.join(MEDIA_ROOT, name);
  fs.writeFileSync(file, buffer);
  return { url: `/media/${name}`, file, bytes: buffer.length, prefix, sample_rate: SAMPLE_RATE };
}

export const synth = { synthBed, synthSfx, saveWav, encodeWav, MOOD_TABLE, SAMPLE_RATE };
export default synth;
