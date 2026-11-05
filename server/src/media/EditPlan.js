/**
 * 剪辑单（EDL）：把「分镜 + 生成片段 + 字幕 + 音效 + 配乐」合成一份可执行的成片方案。
 *
 * 设计目标（对应「剪辑成片」环节）：
 *   1. 纯函数 buildEditPlan()：不碰磁盘，可被单测断言；
 *   2. materialize()：把字幕/配乐/音效真正写成文件（走 /media 静态服务）；
 *   3. render()：本机有 ffmpeg 就真渲染，没有就返回可复制的命令（绝不假装成功）。
 *
 * 交付物：成片 mp4 + 字幕 srt/ass + 剪辑单 md + 台词本 + 素材清单 csv + 授权署名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config } from '../config/env.js';
import seeds from '../seeds/loader.js';
import { timeline as timelineEngine } from './Timeline.js';
import { renderer } from './Renderer.js';
import { MEDIA_ROOT } from '../api/media.js';
import { buildSubtitles, toAss, toPlainScript } from './Subtitle.js';
import { buildSoundSheet } from './SoundDesign.js';
import { synthBed, synthSfx, saveWav } from './SynthBGM.js';

export const RENDER_ROOT = path.join(config.server.dataDir, 'renders');

/** 画幅 × 画质 → 像素尺寸（与 model_registry 里的能力校验保持一致） */
export const RESOLUTION_MAP = {
  '9:16': { '720p': '720x1280', '1080p': '1080x1920', '2k': '1440x2560' },
  '16:9': { '720p': '1280x720', '1080p': '1920x1080', '2k': '2560x1440' },
  '4:3': { '720p': '960x720', '1080p': '1440x1080', '2k': '1920x1440' },
  '1:1': { '720p': '720x720', '1080p': '1080x1080', '2k': '1440x1440' },
};

export function resolutionOf(aspect = '9:16', quality = '1080p') {
  return RESOLUTION_MAP[aspect]?.[quality] ?? RESOLUTION_MAP[aspect]?.['1080p'] ?? '1080x1920';
}

/** 曲库条目是否真的有可播音频（现在的 12 条全是占位，必须识别出来） */
export function isPlayableTrack(track) {
  if (!track) return false;
  if (track._status === 'TEMPLATE_NEED_REAL_ASSET') return false;
  return /^(https?:)?\/\//.test(track.local_path ?? '') || /^\/media\//.test(track.local_path ?? '');
}

function normalizeDialogue(list = []) {
  return (list ?? [])
    .map((d) => ({ speaker: d?.speaker ?? null, line: String(d?.line ?? '').trim() }))
    .filter((d) => d.line);
}

/**
 * 只有「拿不到片子」才算阻断；节奏/转场比例这类是质量建议，不能拦着用户出片。
 */
export const FATAL_CODES = new Set(['MISSING_CLIP', 'NO_CLIPS', 'TRANSITION_NOT_FOUND']);

/**
 * @param {object} p
 *  shots: [{ shot_no, clip_url, duration, transition, transition_reason, dialogue:[{speaker,line}],
 *            emotions:[code], atmosphere:code, is_episode_end, time_jump_days, is_flashback }]
 */
export function buildEditPlan({
  projectId,
  episodeNo = 'E01',
  shots = [],
  style = null,
  director = null,
  aspect = '9:16',
  quality = '1080p',
  fps = 30,
  aiLabel = config.compliance.aiLabelText,
  bgmUrl = null,
  bgmTrackId = null,
  voiceUrl = null,
  subtitleRule = null,
  editRecipe = null,
} = {}) {
  const errors = [];
  const warnings = [];

  const usable = [];
  for (const s of shots) {
    if (!s?.clip_url) {
      errors.push({ shot: s?.shot_no ?? '?', code: 'MISSING_CLIP', severity: 'fatal', issue: '该镜还没有生成片段' });
      continue;
    }
    const dialogue = normalizeDialogue(s.dialogue);
    usable.push({
      shot_no: s.shot_no,
      clip_url: s.clip_url,
      duration: Number(s.duration ?? style?.avg_shot_len ?? 4),
      transition: s.transition ?? 'TRN-HARDCUT',
      transition_reason: s.transition_reason ?? null,
      // Timeline 用真值判断「有没有对白」，空数组是 truthy，必须显式转 null
      dialogue: dialogue.length ? dialogue.map((d) => d.line).join(' ') : null,
      is_episode_end: !!s.is_episode_end,
      time_jump_days: s.time_jump_days ?? 0,
      is_flashback: !!s.is_flashback,
      _meta: { dialogue, emotions: s.emotions ?? [], atmosphere: s.atmosphere ?? null, still: !!s.still },
    });
  }

  if (!usable.length) {
    return {
      ok: false,
      blocking: 1,
      errors: errors.length ? errors : [{ code: 'NO_CLIPS', severity: 'fatal', issue: '没有任何可剪辑的片段' }],
      warnings,
    };
  }

  const tl = timelineEngine.build(usable, { directorProfile: director?.code ?? 'DIR-BALANCED' });
  for (const e of tl.errors) {
    errors.push({
      shot: e.shot,
      code: e.code,
      severity: FATAL_CODES.has(e.code) ? 'fatal' : 'advisory',
      issue: e.detail ?? (e.ratio !== undefined ? `非硬切占比 ${e.ratio} > ${e.max}` : e.transition ?? ''),
    });
  }
  for (const w of tl.warnings) warnings.push({ shot: w.shot, code: w.code, issue: w.suggestion ?? '' });

  // 把业务字段补回时间线切片（Timeline 只保留渲染必需字段）
  const metaByShot = new Map(usable.map((s) => [s.shot_no, s._meta]));
  const segments = tl.segments.map((seg) => {
    const meta = metaByShot.get(seg.shot_no) ?? { dialogue: [], emotions: [], atmosphere: null };
    return {
      ...seg,
      dialogue_list: meta.dialogue,
      emotions: meta.emotions,
      atmosphere: meta.atmosphere,
      still: meta.still,
      has_dialogue: meta.dialogue.length > 0,
    };
  });

  // —— 字幕 ——
  const subs = buildSubtitles({
    segments: segments.map((s) => ({
      shot_no: s.shot_no,
      start: s.start,
      end: s.end,
      duration: s.duration,
      dialogue: s.dialogue_list,
    })),
    aspect,
    aiLabel,
    rule: subtitleRule,
  });
  for (const w of subs.warnings) warnings.push({ shot: w.shot, code: 'SUBTITLE_OVERFLOW', issue: w.issue });

  // —— 音效与氛围 ——
  const sound = buildSoundSheet({
    segments: segments.map((s) => ({
      shot_no: s.shot_no,
      index: s.index,
      start: s.start,
      end: s.end,
      duration: s.duration,
      transition: s.transition,
      dialogue: s.has_dialogue,
      emotions: s.emotions,
      atmosphere: s.atmosphere,
      is_episode_end: s.is_episode_end,
    })),
    style,
    totalSec: tl.total_sec,
  });
  for (const w of sound.warnings) warnings.push({ shot: w.shot, code: 'SFX_MISSING', issue: w.issue });

  // —— 配乐：用户上传 > 曲库真文件 > 程序合成 ——
  let bgm = { mode: 'none', mood: sound.mood, bpm: sound.bpm, url: null, track: null, note: null };
  if (bgmUrl) {
    bgm = { mode: 'provided', mood: sound.mood, bpm: sound.bpm, url: bgmUrl, track: null, note: '用户上传' };
  } else {
    const candidates = bgmTrackId ? [seeds.bgm(bgmTrackId)] : seeds.licensableBgm(sound.mood);
    const track = candidates.find((t) => isPlayableTrack(t)) ?? null;
    if (track) {
      bgm = {
        mode: 'library', mood: sound.mood, bpm: track.bpm ?? sound.bpm,
        url: track.local_path, track, note: '曲库真文件',
      };
    } else {
      bgm = {
        mode: 'synth', mood: sound.mood, bpm: sound.bpm, url: null, track: null,
        note: '曲库无可用音频，走程序合成（100% 无版权）',
        synth: { mood: sound.mood, bpm: sound.bpm, seconds: Math.ceil(tl.total_sec) + 1 },
      };
      warnings.push({ code: 'BGM_SYNTH_FALLBACK', issue: '曲库 12 条均为占位资产，本集使用程序合成 BGM' });
    }
  }

  const resolution = resolutionOf(aspect, quality);
  const aspectTag = aspect.replace(':', 'x');
  const blocking = errors.filter((e) => e.severity !== 'advisory').length;

  return {
    ok: blocking === 0,
    blocking,
    advisories: errors.length - blocking,
    project_id: projectId ?? null,
    episode: episodeNo,
    video: { aspect, quality, resolution, fps, width: +resolution.split('x')[0], height: +resolution.split('x')[1] },
    timeline: { ...tl, segments: segments.map((s) => ({ ...s, resolution })) },
    subtitles: {
      total: subs.total_cues,
      stats: subs.stats,
      cues: subs.cues,
      srt: subs.srt,
      edit_recipe: editRecipe ? { code: editRecipe.code, name: editRecipe.name } : null,
      subtitle_sync: subtitleRule ? { code: subtitleRule.code, name: subtitleRule.name } : null,
      ass: toAss(subs.cues, { aspect, title: `网剧大咖 ${episodeNo}` }),
      plain: toPlainScript(subs.cues),
    },
    sound: { mood: sound.mood, bpm: sound.bpm, cues: sound.cues, ambience: sound.ambience, mix: sound.mix },
    bgm,
    audio: { voice_url: voiceUrl },
    deliverables: [
      { name: `${episodeNo}.mp4`, type: 'video', size_hint: `${Math.round(tl.total_sec)}s · ${resolution}` },
      { name: `${episodeNo}.srt`, type: 'subtitle', note: '可直接上传平台' },
      { name: `${episodeNo}.ass`, type: 'subtitle', note: '带样式，用于烧录' },
      { name: `剪辑单_${episodeNo}.md`, type: 'editsheet', note: '逐刀入出点，可拖进剪映重建' },
      { name: `台词本_${episodeNo}.txt`, type: 'script', note: '逐句时间码' },
      { name: `素材清单_${episodeNo}.csv`, type: 'manifest', note: '片段来源与镜号' },
    ],
    credits: bgm.track?.attribution_required
      ? [{ track: bgm.track.track_id, text: bgm.track.attribution_text }]
      : [],
    ai_label: { text: aiLabel, subtitle: true, metadata: true, removable: false },
    warnings,
    errors,
    _aspect_tag: aspectTag,
  };
}

/** 把方案落成真实文件（字幕 / 配乐 / 音效），返回可喂给 ffmpeg 的本地路径 */
export function materialize(plan, { dir = null } = {}) {
  if (!plan?.ok) {
    const fatal = (plan?.errors ?? []).filter((e) => e.severity !== 'advisory').map((e) => e.code);
    throw new Error(`剪辑单不可用：${fatal.join(',')}`);
  }
  const outDir = dir ?? path.join(RENDER_ROOT, sanitize(plan.project_id ?? 'p'), sanitize(plan.episode ?? 'E01'));
  fs.mkdirSync(outDir, { recursive: true });

  const assPath = path.join(outDir, `${plan.episode}.ass`);
  const srtPath = path.join(outDir, `${plan.episode}.srt`);
  const scriptPath = path.join(outDir, `台词本_${plan.episode}.txt`);
  const sheetPath = path.join(outDir, `剪辑单_${plan.episode}.md`);
  const manifestPath = path.join(outDir, `素材清单_${plan.episode}.csv`);

  fs.writeFileSync(assPath, plan.subtitles.ass, 'utf8');
  fs.writeFileSync(srtPath, plan.subtitles.srt, 'utf8');
  fs.writeFileSync(scriptPath, plan.subtitles.plain, 'utf8');
  fs.writeFileSync(sheetPath, renderEditSheet(plan), 'utf8');
  fs.writeFileSync(manifestPath, renderManifest(plan), 'utf8');

  // 配乐
  let bgmFile = null;
  let bgmUrl = plan.bgm?.url ?? null;
  if (plan.bgm?.mode === 'synth') {
    const bed = synthBed({
      mood: plan.bgm.synth.mood,
      seconds: plan.bgm.synth.seconds,
      bpm: plan.bgm.synth.bpm,
      seed: hashSeed(`${plan.project_id}|${plan.episode}|${plan.bgm.synth.mood}`),
    });
    const saved = saveWav(bed.buffer, 'bgm');
    bgmFile = saved.file;
    bgmUrl = saved.url;
  } else if (plan.bgm?.url) {
    // 库文件若是 /media 相对路径，转成本地绝对路径（ffmpeg 读文件比走 HTTP 稳）
    bgmFile = plan.bgm.url.startsWith('/media/')
      ? path.join(MEDIA_ROOT, plan.bgm.url.slice('/media/'.length))
      : plan.bgm.url;
  }

  // 音效（同一 code 只合成一次）
  const cache = new Map();
  const sfx = [];
  for (const cue of plan.sound.cues) {
    const card = seeds.sfx(cue.code);
    if (!card) continue;
    if (!cache.has(card.code)) {
      const wav = synthSfx(card);
      cache.set(card.code, saveWav(wav, 'sfx'));
    }
    const saved = cache.get(card.code);
    sfx.push({ url: saved.file, t: cue.t, gain_db: cue.gain_db, code: card.code });
  }
  for (const bed of plan.sound.ambience) {
    const card = seeds.sfx(bed.code);
    if (!card) continue;
    if (!cache.has(card.code)) {
      const wav = synthSfx({ ...card, duration: Math.max(2, bed.duration) });
      cache.set(card.code, saveWav(wav, 'amb'));
    }
    const saved = cache.get(card.code);
    sfx.push({ url: saved.file, t: bed.t, gain_db: bed.gain_db, code: card.code });
  }

  const outputPath = path.join(outDir, `${plan.episode}.mp4`);
  return {
    dir: outDir, assPath, srtPath, scriptPath, sheetPath, manifestPath,
    bgmFile, bgmUrl, sfx, outputPath,
    files: [assPath, srtPath, scriptPath, sheetPath, manifestPath],
  };
}

/** 生成 ffmpeg 命令（不执行）；preset 对应剪辑档位（veryfast / medium / slow） */
export function buildCommand(plan, assets, { preset = 'medium' } = {}) {
  return renderer.buildCommand({
    timeline: plan.timeline,
    audio: {
      voice_url: plan.audio?.voice_url ?? null,
      bgm_url: assets.bgmFile,
      bgm_gain_db: plan.sound.mix.bgm_gain_db,
      sfx: assets.sfx,
    },
    subtitlesPath: assets.assPath,
    resolution: plan.video.resolution,
    fps: plan.video.fps,
    output: assets.outputPath,
    preset,
  });
}

export function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 真渲染。成功返回文件信息；失败抛出带 stderr 尾部的原因（绝不返回假成功）。
 */
export function render(plan, assets, { timeoutMs = 15 * 60 * 1000, preset = 'medium' } = {}) {
  return new Promise((resolve, reject) => {
    if (!hasFfmpeg()) {
      const err = new Error('本机未安装 ffmpeg，无法渲染；命令已生成，可在有 ffmpeg 的机器上执行');
      err.code = 'FFMPEG_MISSING';
      return reject(err);
    }
    const built = buildCommand(plan, assets, { preset });
    const started = Date.now();
    const child = spawn('ffmpeg', built.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const collect = (d) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      tail += '\n[timeout] 渲染超时，已终止进程';
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      const err = new Error(`ffmpeg 启动失败：${e.message}`);
      err.code = 'FFMPEG_SPAWN_FAILED';
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`ffmpeg 退出码 ${code}：${tail.split('\n').slice(-6).join(' | ')}`);
        err.code = 'FFMPEG_FAILED';
        err.stderr = tail;
        return reject(err);
      }
      const stat = fs.existsSync(assets.outputPath) ? fs.statSync(assets.outputPath) : null;
      if (!stat) {
        const err = new Error('ffmpeg 返回成功但没有产出文件');
        err.code = 'FFMPEG_NO_OUTPUT';
        return reject(err);
      }
      resolve({
        ok: true,
        file: assets.outputPath,
        bytes: stat.size,
        duration_ms: Date.now() - started,
        cmd: built.cmd,
      });
    });
  });
}

function renderEditSheet(plan) {
  const rows = plan.timeline.segments.map((s) => {
    const line = (s.dialogue_list ?? []).map((d) => `${d.speaker ? d.speaker + '：' : ''}${d.line}`).join(' / ') || '—';
    const sfx = plan.sound.cues.filter((c) => c.shot_no === s.shot_no).map((c) => c.name).join('、') || '—';
    return `| ${s.shot_no} | ${s.start.toFixed(2)} | ${s.end.toFixed(2)} | ${s.duration.toFixed(2)}s | ${s.transition} | ${line} | ${sfx} |`;
  });
  return `# 剪辑单 · ${plan.episode}

- 画幅：${plan.video.aspect}（${plan.video.resolution} @ ${plan.video.fps}fps）
- 总时长：${plan.timeline.total_sec}s ｜ 片段数：${plan.timeline.segments.length}
- 配乐：${plan.bgm.mode} · ${plan.bgm.mood} · ${plan.bgm.bpm}bpm
- 字幕条数：${plan.subtitles.total}（竖屏单行 ≤ ${plan.subtitles.stats.max_chars_per_line} 字）

| 镜号 | 入点 | 出点 | 时长 | 转场 | 台词 | 音效 |
|---|---|---|---|---|---|---|
${rows.join('\n')}

## 声音

- 目标响度：${plan.sound.mix.target_lufs} LUFS / 峰值 ${plan.sound.mix.true_peak_dbtp} dBTP
- 对白闪避：-${Math.abs(plan.sound.mix.ducking.reduction_db)}dB，attack ${plan.sound.mix.ducking.attack_ms}ms / release ${plan.sound.mix.ducking.release_ms}ms

## 合规

- 片头 3 秒 AI 标识：${plan.ai_label.text}
- 元数据标识：ai_generated=true（不可移除）
`;
}

function renderManifest(plan) {
  const head = 'shot_no,start,end,duration,transition,clip_url';
  const rows = plan.timeline.segments.map((s) =>
    [s.shot_no, s.start, s.end, s.duration, s.transition, `"${s.clip_url}"`].join(',')
  );
  return [head, ...rows].join('\n');
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const editPlan = { buildEditPlan, materialize, buildCommand, render, hasFfmpeg, resolutionOf, isPlayableTrack, RENDER_ROOT };
export default editPlan;
