/**
 * 渲染 Worker（命令生成层）：把 EDL 变成可执行的 FFmpeg 命令 + 混音规格 + AI 标识。
 *
 * 设计：本机不强制安装 FFmpeg；本模块产出命令与规格，由渲染 Worker 执行。
 * 这样命令可被单元测试断言，也便于换成云端渲染服务。
 *
 * 三条不可跳过的硬规则（§10.5 / §19）：
 *   1. 主输出 -16 LUFS，真峰值 ≤ -1.5 dBTP
 *   2. 需署名曲目必须写入片尾字幕与 credits.txt
 *   3. AI 标识：片头 3 秒 + 封面 + 简介 + MP4 元数据，且不提供去标识功能
 */
import seeds from '../seeds/loader.js';
import { config } from '../config/env.js';

export const MIX_RULES = {
  target_lufs: -16,
  true_peak_dbtp: -1.5,
  dialogue_over_bgm_db: [6, 9],
  ducking_reduction_db: -12,
  ducking_attack_ms: 120,
  ducking_release_ms: 400,
  sample_rate: 48000,
  head_fade_in_sec: 3,
  tail_fade_out_sec: 1.5,
  silence_around_empathy_sec: [0.8, 1.5],
};

export class Renderer {
  /**
   * 生成 FFmpeg 命令（拼接 + 转场 + 字幕 + 混音 + 响度归一 + AI 标识烧录）
   * @param {object} p
   *  timeline, audio: { voice_url, bgm_url, bgm_gain_db, sfx: [{url,t,gain_db,duration}] },
   *  output, cover, subtitlesPath, resolution, fps
   */
  buildCommand({ timeline, audio = {}, output = 'out/episode.mp4', cover = null, subtitlesPath = null, resolution = null, fps = 30, preset = 'medium' }) {
    const segs = timeline.segments ?? [];
    if (!segs.length) throw new Error('空时间线');

    const scale = resolution ?? timeline.segments[0]?.resolution ?? '1080x1920';
    // 同时维护 argv（给 spawn 用，不做任何引号转义）与字符串命令（给人看 / 给接口返回）
    const inputArgs = [];
    for (const s of segs) {
      // 静态漫剧：图片按镜头时长循环成一段视频流，否则 concat 会因无时长失败
      if (s.still) inputArgs.push('-loop', '1', '-t', String(s.duration ?? 4));
      inputArgs.push('-i', s.clip_url);
    }

    const sfx = (audio.sfx ?? []).filter((c) => c.url);
    let idx = segs.length;
    const voiceIdx = audio.voice_url ? idx++ : null;
    if (audio.voice_url) inputArgs.push('-i', audio.voice_url);
    const bgmIdx = audio.bgm_url ? idx++ : null;
    if (audio.bgm_url) inputArgs.push('-i', audio.bgm_url);
    const sfxIdx = [];
    for (const c of sfx) {
      sfxIdx.push(idx++);
      inputArgs.push('-i', c.url);
    }

    const filters = [];

    // 1) 统一规格：等比缩放 + 补边（不同模型出的画幅不一致，直接 scale 会变形）
    const [W, H] = String(scale).split('x');
    for (let i = 0; i < segs.length; i++) {
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
      );
    }

    // 2) 转场链：offset 必须相对「已合并流的累计时长」，不是上一段时长
    const nonHard = segs.filter((s) => s.transition !== 'TRN-HARDCUT' && s.transition_ffmpeg);
    if (nonHard.length === 0) {
      filters.push(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[vcat]`);
    } else {
      let prev = 'v0';
      let acc = segs[0].duration;
      for (let i = 1; i < segs.length; i++) {
        const s = segs[i];
        const dur = s.transition_duration ?? 0.5;
        const tag = `x${i}`;
        if (s.transition !== 'TRN-HARDCUT' && s.transition_ffmpeg) {
          const offset = Math.max(0, +(acc - dur).toFixed(2));
          const expr = s.transition_ffmpeg.replace('{D}', dur).replace('{OFF}', offset);
          filters.push(`[${prev}][v${i}]${expr}[${tag}]`);
          acc = +(acc + s.duration - dur).toFixed(2);
        } else {
          filters.push(`[${prev}][v${i}]concat=n=2:v=1:a=0[${tag}]`);
          acc = +(acc + s.duration).toFixed(2);
        }
        prev = tag;
      }
      filters.push(`[${prev}]copy[vcat]`);
    }

    // 3) 字幕：有 ASS 就烧 ASS（里面已含片头 AI 标识），否则退回 drawtext
    if (subtitlesPath) {
      filters.push(`[vcat]ass=filename='${escapeFilterPath(subtitlesPath)}'[vlabel]`);
    } else if (config.compliance.aiLabelEnabled) {
      const text = config.compliance.aiLabelText.replace(/([:'])/g, '\\\\$1');
      filters.push(
        `[vcat]drawtext=text='${text}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.08:enable='between(t,0,3)'[vlabel]`
      );
    } else {
      filters.push('[vcat]copy[vlabel]');
    }

    // 4) 音频：对白 + BGM(sidechain 闪避) + SFX + 响度归一
    const audioLabels = [];
    if (voiceIdx !== null) {
      filters.push(`[${voiceIdx}:a]aresample=${MIX_RULES.sample_rate},volume=1.0[avoice]`);
      audioLabels.push('[avoice]');
    }
    if (bgmIdx !== null) {
      const bgmGain = audio.bgm_gain_db ?? -20;
      const fadeOut = Math.max(0, (timeline.total_sec ?? 0) - MIX_RULES.tail_fade_out_sec);
      filters.push(
        `[${bgmIdx}:a]aresample=${MIX_RULES.sample_rate},volume=${dbToGain(bgmGain)},afade=t=in:st=0:d=${MIX_RULES.head_fade_in_sec},afade=t=out:st=${fadeOut}:d=${MIX_RULES.tail_fade_out_sec}[abgmraw]`
      );
      if (voiceIdx !== null) {
        // 对白出现时 BGM 自动下压：这是「有导演感」和「KTV 伴奏」的分界线
        filters.push(
          `[abgmraw][avoice]sidechaincompress=threshold=0.03:ratio=8:attack=${MIX_RULES.ducking_attack_ms}:release=${MIX_RULES.ducking_release_ms}[abgm]`
        );
      } else {
        filters.push('[abgmraw]anull[abgm]');
      }
      audioLabels.push('[abgm]');
    }
    sfx.forEach((c, k) => {
      const ms = Math.round(Math.max(0, c.t ?? 0) * 1000);
      const gain = dbToGain(c.gain_db ?? -12);
      filters.push(
        `[${sfxIdx[k]}:a]aresample=${MIX_RULES.sample_rate},volume=${gain},adelay=${ms}|${ms}[asfx${k}]`
      );
      audioLabels.push(`[asfx${k}]`);
    });

    let audioFilter = '';
    if (audioLabels.length) {
      if (audioLabels.length === 1) {
        filters.push(`${audioLabels[0]}anull[aout]`);
      } else {
        filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0:dropout_transition=0[aout]`);
      }
      filters.push(`[aout]loudnorm=I=${MIX_RULES.target_lufs}:TP=${MIX_RULES.true_peak_dbtp}:LRA=11[anorm]`);
      audioFilter = '-map "[anorm]"';
    }

    // 5) 输出（tokens → argv；字符串版本只用于展示与接口返回）
    const tokens = [
      '-y',
      ...inputArgs,
      '-filter_complex', filters.join(';'),
      '-map', '[vlabel]',
      ...(audioLabels.length ? ['-map', '[anorm]'] : []),
      '-c:v', 'libx264', '-preset', preset, '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', String(MIX_RULES.sample_rate),
      '-metadata', `comment=${config.compliance.aiLabelEnabled ? config.compliance.aiLabelText : ''}`,
      '-metadata', 'ai_generated=true',
      '-movflags', '+faststart',
      output,
    ];
    const cmd = ['ffmpeg', ...tokens.map((t) => (/[\s;"']/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t))]
      .join(' ')
      // 展示层加引号，argv 里仍是裸值
      .replace('ai_generated=true', 'ai_generated="true"');

    return {
      cmd,
      args: tokens,
      filters,
      inputs: segs.length,
      output,
      cover,
      mix: MIX_RULES,
      subtitle: subtitlesPath ? 'ass' : config.compliance.aiLabelEnabled ? 'drawtext' : 'none',
      sfx_count: sfx.length,
    };
  }

  /** 逐镜配乐规格（§10.4） */
  buildMusicSpec({ timeline, moodByShot = {}, ducking = true }) {
    const items = [];
    for (const s of timeline.segments ?? []) {
      const mood = moodByShot[s.shot_no] ?? 'daily';
      const track = seeds.licensableBgm(mood)[0] ?? null;
      items.push({
        t_start: s.start,
        t_end: s.end,
        type: 'bgm',
        track: track?.track_id ?? null,
        vol: 0.3,
        mood,
        ducking: ducking && !!s.dialogue,
        note: track ? null : '曲库无匹配，需走 AI 生成兜底并单独登记授权',
      });
    }
    const credits = items
      .filter((i) => i.track)
      .map((i) => seeds.bgm(i.track))
      .filter((t) => t?.attribution_required)
      .map((t) => ({ track: t.track_id, text: t.attribution_text }));

    return {
      timeline: items,
      ducking: {
        trigger: 'tts',
        reduction_db: MIX_RULES.ducking_reduction_db,
        attack_ms: MIX_RULES.ducking_attack_ms,
        release_ms: MIX_RULES.ducking_release_ms,
      },
      master_loudness: { target_lufs: MIX_RULES.target_lufs, true_peak_dbtp: MIX_RULES.true_peak_dbtp },
      credits_required: credits,
    };
  }

  /** 交付包清单（含 AI 创作说明材料，这是过审杀手锏） */
  buildDeliveryPackage({ projectId, episodeNo, timeline, musicSpec, generations = [] }) {
    return {
      project_id: projectId,
      episode: episodeNo,
      files: [
        { name: `${episodeNo}.mp4`, type: 'video', note: '含片头 AI 标识与元数据标识' },
        { name: `${episodeNo}_cover.jpg`, type: 'cover', note: '封面含 AI 标识角标' },
        { name: 'credits.txt', type: 'credits', content: musicSpec.credits_required },
        { name: 'ai_declaration.md', type: 'declaration', note: 'AI 创作说明正文' },
        { name: 'ai_evidence/', type: 'dir', note: '创作过程截图包（全屏、带网址、带时间）' },
      ],
      ai_evidence: [
        '项目创建页（含项目名与时间戳）',
        '剧本生成记录（含提示词与生成时间）',
        '分镜表页面（含镜号与镜头卡）',
        '资产生成记录（含角色卡与版本）',
        '关键帧生成记录（含提示词、种子、时间）',
        '视频生成记录（含模型与镜号）',
        '剪辑时间线（含转场与理由）',
      ],
      ai_label: {
        head_3s: config.compliance.aiLabelEnabled,
        cover: config.compliance.aiLabelEnabled,
        description: config.compliance.aiLabelEnabled,
        metadata: config.compliance.aiLabelEnabled,
        removable: false,
        text: config.compliance.aiLabelText,
      },
      generations: generations.map((g) => ({
        shot_no: g.shot_no,
        model: g.model,
        prompt_zh: g.prompt_zh,
        credits: g.actual_credits,
        created_at: g.created_at,
      })),
    };
  }
}

/** dB → 线性增益（FFmpeg volume 用线性值） */
function dbToGain(db) {
  return +Math.pow(10, Number(db) / 20).toFixed(4);
}

/** FFmpeg 滤镜里的路径转义：Windows 反斜杠统一成正斜杠，冒号与单引号转义 */
function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export const renderer = new Renderer();
export default renderer;
