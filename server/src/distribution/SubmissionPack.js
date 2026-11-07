/**
 * 分发资料包（V4.3）：把平台审核要的材料一次性备齐，打成可整包上传的 zip。
 *
 * 平台要的从来不是「一个 mp4」，而是一整套：成片 + 字幕 + 封面 + AI 创作说明 +
 * 创作过程截图 + 音乐署名 + 版权链 + 平台材料清单。少一样就被打回，
 * 而创作者往往在提审那一刻才发现缺东西 —— 这就是本模块存在的理由。
 *
 * 边界（必须说清）：第三方平台没有开放的上传 API，小程序也无法内嵌其登录态，
 * 所以「一键上传」= 一键准备好整包 + 一键登记已提交 + 一键复制上传入口。
 * 真正的「点上传」只能在平台创作者中心完成，任何声称能代传的说法都是假的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';
import { MEDIA_ROOT } from '../api/media.js';
import objectStore from '../storage/ObjectStore.js';
import { zipBuffer } from '../util/zip.js';
import seeds from '../seeds/loader.js';
import editService, { normalizeEpisodeNo } from '../pipeline/EditService.js';
import compliancePack from '../compliance/CompliancePack.js';
import distributionHub from './DistributionHub.js';
import { shellService } from '../shell/ShellService.js';

const PROJECTS = 'projects';

/**
 * 读取媒体内容（V4.8）。
 * 本地 `/media/<name>` 直接读盘；云存储 `cloud://` 先换临时链接再回源下载。
 * 返回 { buf, ext } 或 null —— 拿不到就当成「素材缺失」，不塞空文件进包。
 */
async function readMedia(url) {
  const s = String(url ?? '');
  if (!s) return null;
  if (s.startsWith('/media/')) {
    const m = s.match(/^\/media\/([A-Za-z0-9._-]+)$/);
    if (!m) return null;
    const p = path.join(MEDIA_ROOT, m[1]);
    try {
      if (!fs.statSync(p).isFile()) return null;
      return { buf: fs.readFileSync(p), ext: path.extname(m[1]).replace('.', '') };
    } catch {
      return null;
    }
  }
  if (s.startsWith('cloud://')) {
    const buf = await objectStore.read(s);
    if (!buf?.length) return null;
    return { buf, ext: path.extname(s.split('?')[0]).replace('.', '') || 'bin' };
  }
  return null;
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export class SubmissionPack {
  /**
   * 准备资料包。
   * @param {object} p { projectId, episode, platformCode, userId }
   */
  async prepare({ projectId, episode = null, platformCode = null, userId = null }) {
    const project = db.findOne(PROJECTS, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    if (userId && project.user_id && project.user_id !== userId) {
      fail(ERR.OBJECT_FORBIDDEN, '不能操作其他用户的项目');
    }
    const platform = platformCode ? distributionHub.platform(platformCode) : null;
    const ep = normalizeEpisodeNo(episode) ?? 'E01';

    // 1) 成片 / 字幕（同一集取最新一次渲染）
    const film = editService.latestFilm(projectId, ep);
    const entries = [];
    const added = [];
    const missing = [];

    const filmMedia = film?.url ? await readMedia(film.url) : null;
    if (filmMedia) {
      entries.push({ name: `01_成片/${ep}.mp4`, data: filmMedia.buf });
      added.push({ key: 'video_1080p', name: `${ep}.mp4`, bytes: filmMedia.buf.length });
    } else {
      missing.push({ key: 'video_1080p', label: '成片 MP4', hint: '先去「成片」把这一集渲染出来' });
    }

    for (const [key, field, ext] of [['subtitle', 'srt_url', 'srt'], ['editsheet', 'sheet_url', 'md']]) {
      const med = film?.[field] ? await readMedia(film[field]) : null;
      if (med) {
        entries.push({ name: `02_字幕与剪辑单/${ep}.${ext}`, data: med.buf });
        added.push({ key, name: `${ep}.${ext}` });
      }
    }

    // 2) 封面：优先项目资产图，其次首帧生成图（只取本地文件，外链不硬塞进包里）
    const assets = db.find('assets', (a) => a.project_id === projectId);
    const gens = db.find('generations', (g) => g.project_id === projectId && g.status === 'done');
    const coverCandidates = [
      ...assets.map((a) => a.image_url),
      ...gens.filter((g) => g.kind === 'image').map((g) => g.result_url || g.url),
    ];
    let coverAdded = false;
    for (const url of coverCandidates) {
      const med = await readMedia(url);
      if (!med) continue;
      const ext = med.ext || 'jpg';
      entries.push({ name: `03_封面/cover.${ext}`, data: med.buf });
      added.push({ key: 'cover', name: `cover.${ext}` });
      coverAdded = true;
      break;
    }
    if (!coverAdded) {
      missing.push({ key: 'cover', label: '封面图', hint: '生成一张关键帧，或上传一张封面素材' });
    }

    // 3) AI 创作说明 + 创作过程证据（平台硬要求，尤其红果）
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    let pack = null;
    if (planRec?.storyboard?.shots?.length) {
      try {
        const plan = editService.plan(projectId, ep);
        pack = compliancePack.build({
          projectId,
          episodeNo: ep,
          project,
          plan: planRec.plan,
          script: planRec.script,
          storyboard: planRec.storyboard,
          assets,
          generations: gens,
          timeline: plan?.timeline ?? null,
          musicSpec: { credits_required: plan?.credits ?? [] },
          coverage: plan?.coverage ?? null,
        });
        for (const [file, zipName] of [
          ['ai_declaration.md', '04_AI创作说明/AI创作说明.md'],
          ['ai_evidence.html', '04_AI创作说明/创作过程证据.html'],
          ['manifest.json', '04_AI创作说明/证据清单.json'],
          ['credits.txt', '04_AI创作说明/音乐署名.txt'],
        ]) {
          const f = path.join(pack.dir, file);
          if (fs.existsSync(f)) {
            entries.push({ name: zipName, data: fs.readFileSync(f) });
            added.push({ key: file === 'ai_declaration.md' ? 'ai_declaration' : 'ai_evidence', name: zipName });
          }
        }
      } catch (e) {
        logger.warn('合规包生成失败', { projectId, msg: e.message });
        missing.push({ key: 'ai_declaration', label: 'AI 创作说明', hint: e.message });
      }
    } else {
      missing.push({ key: 'ai_declaration', label: 'AI 创作说明', hint: '先生成剧本与分镜' });
    }

    // 4) 剧壳信息（系列标识）+ 平台材料清单 + 版权链模板
    const shell = shellService.get(projectId);
    entries.push({
      name: '05_项目信息/剧壳与系列信息.json',
      data: Buffer.from(JSON.stringify({
        project: { id: project.id, index: project.index_label ?? null, title: project.title },
        series: project.series_title ?? null,
        season_no: project.season_no ?? 1,
        shell: {
          enabled: shell.enabled, series_title: shell.series_title, tagline: shell.tagline,
          opening: shell.opening, ending: shell.ending,
        },
        spec: project.spec ?? {},
        generated_at: nowIso(),
      }, null, 2), 'utf8'),
    });

    const checklist = platform ? distributionHub.checklist(platform.code) : [
      { key: 'video_1080p', label: '成片 MP4', required: true },
      { key: 'cover', label: '封面图', required: true },
      { key: 'ai_declaration', label: 'AI 创作说明', required: true },
      { key: 'ai_evidence', label: '创作过程截图包', required: true },
      { key: 'copyright_chain', label: '版权链证明', required: true },
    ];
    const doneKeys = new Set(added.map((a) => a.key));
    const checklistState = checklist.map((c) => ({
      ...c,
      done: doneKeys.has(c.key),
      missing: c.required && !doneKeys.has(c.key),
    }));

    const platformLines = platform ? [
      `平台：${platform.name}`,
      `上传端：${platform.upload_client}`,
      `入口：${platform.creator_url}`,
      `身份：${platform.identity_choice}`,
      `审核时长：${platform.review_days}`,
      `AI 声明：${platform.ai_declaration_required ? platform.ai_declaration_note : '不需要'}`,
      `收益：${platform.revenue}`,
      '',
      '材料清单：',
      ...checklistState.map((c) => `- [${c.done ? 'x' : ' '}] ${c.label}${c.required ? '（必需）' : '（可选）'}`),
      '',
      '提示：',
      ...(platform.tips ?? []).map((t) => `- ${t}`),
    ].join('\n') : [
      '通用材料清单（未指定平台）：',
      ...checklistState.map((c) => `- [${c.done ? 'x' : ' '}] ${c.label}`),
    ].join('\n');
    entries.push({ name: '05_项目信息/平台材料清单.md', data: Buffer.from(platformLines, 'utf8') });
    added.push({ key: 'platform_checklist', name: '平台材料清单.md' });
    added.push({ key: 'project_info', name: '剧壳与系列信息.json' });

    // 5) 打包：落对象存储（容器本地盘重启即丢，分发包丢了用户就交不了片）
    const buf = zipBuffer(entries);
    const saved = await objectStore.put(buf, { ext: '.zip', mime: 'application/zip', prefix: 'packs' });

    const rec = db.insert('submission_packs', {
      id: newId('sub'),
      project_id: projectId,
      user_id: project.user_id ?? userId ?? null,
      episode: ep,
      platform: platform?.code ?? null,
      platform_name: platform?.name ?? null,
      zip_url: saved.url,
      bytes: buf.length,
      files: added,
      missing,
      checklist: checklistState,
      ready: missing.filter((m) => checklist.find((c) => c.key === m.key)?.required).length === 0,
      created_at: nowIso(),
    });

    return {
      id: rec.id,
      episode: ep,
      zip: { url: rec.zip_url, bytes: rec.bytes },
      files: added,
      missing,
      checklist: checklistState,
      ready: rec.ready,
      creator_url: platform?.creator_url ?? null,
      upload_client: platform?.upload_client ?? null,
      ai_declaration_required: platform?.ai_declaration_required ?? true,
      note: '打包完成：在电脑端打开创作者中心，把整个 zip 解压后按清单上传；小程序不做代传，也不代签合同。',
    };
  }

  /** 登记「已提交到平台」（用户点完上传后回来打勾，分发四步闭环由此推进） */
  markSubmitted({ packId, distributionId = null }) {
    const rec = db.findOne('submission_packs', (x) => x.id === packId);
    if (!rec) fail(ERR.NOT_FOUND, '资料包不存在');
    const updated = db.update('submission_packs', packId, { submitted_at: nowIso() });
    if (distributionId) {
      try {
        distributionHub.updateStatus(distributionId, '审核中');
      } catch (e) {
        logger.warn('分发状态推进失败', { distributionId, msg: e.message });
      }
    }
    return updated;
  }

  list(projectId) {
    return db.find('submission_packs', (x) => x.project_id === projectId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
}

export const submissionPack = new SubmissionPack();
export default submissionPack;
