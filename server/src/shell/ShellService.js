/**
 * 剧壳服务（V4.3）：系列剧的独特标识。
 *
 * 「剧壳」= 系列名卡 + 片头 + 片尾 + 水印。它属于**项目**（一季一个壳），
 * 同一系列续集可以一键继承，保证观众在不同集数里看到同一个标识。
 *
 * 实现边界（诚实）：
 *  - 片头/片尾卡由本机 ffmpeg 现场生成（纯色底 + 标题 + 副标题 + 可选台标）；
 *  - 容器里没装 ffmpeg / 没有可用字体时，不会假装成功：返回可复制的命令与原因，
 *    前端把命令给用户，在本地机器执行后把 mp4 传回来即可（同样算剧壳资产）。
 *  - 剪辑时把片头/片尾作为独立镜头接在正片前后，字幕与混音自动跟着时间轴走。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { db } from '../store/db.js';
import { nowIso } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';
import { MEDIA_ROOT } from '../api/media.js';
import { editPlan } from '../media/EditPlan.js';

const PROJECTS = 'projects';

export const DEFAULT_SHELL = {
  enabled: true,
  series_title: '',
  tagline: '',
  author: '',
  theme_color: '#0B0E14',
  opening: { enabled: true, sec: 3, text: '' },
  ending: { enabled: true, sec: 4, text: '下集更精彩 · 关注不迷路' },
  intro_path: null,
  intro_url: null,
  outro_path: null,
  outro_url: null,
  inherit_from: null,
  updated_at: null,
};

function escapeDrawtext(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%');
}

function randomFile(ext) {
  return path.join(MEDIA_ROOT, `${crypto.randomBytes(12).toString('hex')}.${ext}`);
}

export class ShellService {
  get(projectId) {
    const p = db.findOne(PROJECTS, (x) => x.id === projectId);
    if (!p) fail(ERR.NOT_FOUND, '项目不存在');
    const s = p.shell ?? {};
    return {
      ...DEFAULT_SHELL,
      ...s,
      series_title: s.series_title || p.series_title || p.title || '',
      opening: { ...DEFAULT_SHELL.opening, ...(s.opening ?? {}) },
      ending: { ...DEFAULT_SHELL.ending, ...(s.ending ?? {}) },
    };
  }

  /** 保存剧壳设置（只接受白名单字段，避免前端塞任意结构进项目） */
  save(projectId, patch = {}) {
    const p = db.findOne(PROJECTS, (x) => x.id === projectId);
    if (!p) fail(ERR.NOT_FOUND, '项目不存在');
    const cur = this.get(projectId);
    const text = (v, max = 40) => (v === undefined ? undefined : String(v ?? '').slice(0, max));
    const next = {
      ...cur,
      enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
      series_title: text(patch.series_title, 30) ?? cur.series_title,
      tagline: text(patch.tagline, 40) ?? cur.tagline,
      author: text(patch.author, 20) ?? cur.author,
      theme_color: /^#[0-9a-fA-F]{6}$/.test(patch.theme_color ?? '') ? patch.theme_color : cur.theme_color,
      opening: {
        enabled: patch.opening?.enabled === undefined ? cur.opening.enabled : !!patch.opening.enabled,
        sec: Math.max(1, Math.min(10, Number(patch.opening?.sec ?? cur.opening.sec) || 3)),
        text: text(patch.opening?.text, 30) ?? cur.opening.text,
      },
      ending: {
        enabled: patch.ending?.enabled === undefined ? cur.ending.enabled : !!patch.ending.enabled,
        sec: Math.max(1, Math.min(15, Number(patch.ending?.sec ?? cur.ending.sec) || 4)),
        text: text(patch.ending?.text, 40) ?? cur.ending.text,
      },
      updated_at: nowIso(),
    };
    if (patch.intro_url) { next.intro_url = patch.intro_url; next.intro_path = patch.intro_path ?? null; }
    if (patch.outro_url) { next.outro_url = patch.outro_url; next.outro_path = patch.outro_path ?? null; }
    if (patch.clear_intro) { next.intro_url = null; next.intro_path = null; }
    if (patch.clear_outro) { next.outro_url = null; outroClear(next); }
    db.update(PROJECTS, projectId, { shell: next, series_title: next.series_title });
    return next;
  }

  /** 续集继承剧壳（只继承样式与文案，不继承已生成视频，避免一季的片头串到另一季） */
  inherit(fromProjectId, toProjectId) {
    const from = this.get(fromProjectId);
    const shell = {
      ...DEFAULT_SHELL,
      ...from,
      intro_path: null, intro_url: null, outro_path: null, outro_url: null,
      inherit_from: fromProjectId,
      updated_at: nowIso(),
    };
    db.update(PROJECTS, toProjectId, { shell, series_title: shell.series_title });
    return shell;
  }

  /** 生成片头/片尾卡命令（纯色底 + 标题 + 副标题 + 集末文案） */
  buildCardCommand(project, kind = 'intro', { width = 1080, height = 1920, fps = 30 } = {}) {
    const shell = this.get(project.id);
    const isIntro = kind === 'intro';
    const spec = isIntro ? shell.opening : shell.ending;
    const sec = Math.max(1, Number(spec.sec) || (isIntro ? 3 : 4));
    const title = escapeDrawtext(isIntro ? (spec.text || shell.series_title) : (spec.text || '感谢观看'));
    const sub = escapeDrawtext(isIntro ? shell.tagline : shell.author);
    const color = String(shell.theme_color || '#0B0E14').replace('#', '0x');
    const out = randomFile('mp4');
    const vf = [
      `drawtext=text='${title}':fontcolor=white:fontsize=${Math.round(width / 12)}:x=(w-text_w)/2:y=(h-text_h)/2-40`,
      sub ? `drawtext=text='${sub}':fontcolor=0xF2C14E:fontsize=${Math.round(width / 26)}:x=(w-text_w)/2:y=(h-text_h)/2+90` : '',
      'format=yuv420p',
    ].filter(Boolean).join(',');
    const args = [
      '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=${sec}:r=${fps}`,
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', out,
    ];
    return { cmd: `ffmpeg ${args.map((a) => (/[\s:]/.test(a) ? `"${a}"` : a)).join(' ')}`, args, out, sec };
  }

  /**
   * 生成并登记片头/片尾。
   * @returns {{ok:boolean, url?:string, path?:string, sec?:number, code?:string, cmd?:string, hint?:string}}
   */
  renderCard(projectId, kind = 'intro') {
    const p = db.findOne(PROJECTS, (x) => x.id === projectId);
    if (!p) fail(ERR.NOT_FOUND, '项目不存在');
    if (!editPlan.hasFfmpeg()) {
      const built = this.buildCardCommand(p, kind);
      return {
        ok: false,
        code: 'FFMPEG_MISSING',
        cmd: built.cmd,
        hint: '当前环境没有 ffmpeg，命令已生成；在装有 ffmpeg 的机器执行后，把 mp4 作为素材上传即可当片头',
      };
    }
    const built = this.buildCardCommand(p, kind);
    const r = spawnSync(built.args[0], built.args.slice(1), { timeout: 60_000, encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(built.out)) {
      return {
        ok: false,
        code: 'CARD_RENDER_FAILED',
        cmd: built.cmd,
        hint: `片头生成失败（多为容器缺中文字体）：${String(r.stderr ?? '').split('\n').slice(-3).join(' ')}`,
      };
    }
    const filename = path.basename(built.out);
    const url = `/media/${filename}`;
    const shell = this.get(projectId);
    const patch = kind === 'intro'
      ? { ...shell, intro_url: url, intro_path: built.out, updated_at: nowIso() }
      : { ...shell, outro_url: url, outro_path: built.out, updated_at: nowIso() };
    db.update(PROJECTS, projectId, { shell: patch });
    return { ok: true, url, path: built.out, sec: built.sec, cmd: built.cmd };
  }

  /** 剪辑用：片头/片尾片段（只在文件真实存在时返回，避免时间线里挂死链） */
  segments(projectId) {
    const shell = this.get(projectId);
    const out = { intro: null, outro: null };
    if (!shell.enabled) return out;
    if (shell.opening.enabled && shell.intro_path && fs.existsSync(shell.intro_path)) {
      out.intro = {
        shot_no: 'SHELL-INTRO',
        clip_url: shell.intro_path,
        still: false,
        duration: Number(shell.opening.sec) || 3,
        transition: 'TRN-HARDCUT',
        transition_reason: '剧壳片头',
        dialogue: [],
        emotions: [],
        atmosphere: null,
        is_episode_end: false,
        mood_tags: [],
        shell: true,
      };
    }
    if (shell.ending.enabled && shell.outro_path && fs.existsSync(shell.outro_path)) {
      out.outro = {
        shot_no: 'SHELL-OUTRO',
        clip_url: shell.outro_path,
        still: false,
        duration: Number(shell.ending.sec) || 4,
        transition: 'TRN-FREEZE',
        transition_reason: '剧壳片尾',
        dialogue: [],
        emotions: [],
        atmosphere: null,
        is_episode_end: true,
        mood_tags: [],
        shell: true,
      };
    }
    return out;
  }
}

function outroClear(shell) {
  shell.outro_url = null;
  shell.outro_path = null;
}

export const shellService = new ShellService();
export default shellService;
