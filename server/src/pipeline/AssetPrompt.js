/**
 * 资产提示词自动填充（V4.14）。
 *
 * 用户的原话：「如角色，可以上传本地照片，同时自动提取剧本中刻画的形象，
 * 结合风格设定，自动填充提示词，其它环节以此类推」。
 *
 * 为什么不做成"再调一次大模型"：
 *  1. 抽描写是**检索**问题，不是创作问题 —— 剧本里已经写了"青衫、眉骨很高、左手有旧疤"，
 *     再让模型复述一遍只会引入幻觉，还会多花一次钱；
 *  2. 抽出来的句子要能被用户核对："这句是从第 7 集第 3 场的原文里来的"，
 *     比模型凭空写的"气质清冷"有用得多。
 *
 * 所以这里是**确定性抽取**：按人名/物名在剧本里定位句子，按"外形相关度"打分取前几条，
 * 再拼上风格、色板、已上传参考图，得到一段可直接用的提示词，并把出处一并回给前端。
 */
import { db } from '../store/db.js';
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';

const PROJECT = 'projects';
const PLANS = 'director_plans';
const ASSETS = 'assets';

/** 外形相关词：命中越多，句子越可能是"长相/穿着描写" */
const LOOK_WORDS = [
  '眼', '眉', '脸', '发', '唇', '鼻', '肤', '身材', '身量', '个头', '肩', '手', '疤', '痣',
  '穿', '衣', '袍', '衫', '裙', '靴', '冠', '簪', '饰', '腰', '袖', '领',
  '岁', '年约', '容貌', '长相', '气质', '神', '瘦', '胖', '高', '矮', '苍白', '古铜',
];

/** 与"这个人是干什么的"相关（身份/性格），作为第二优先级 */
const ROLE_WORDS = ['是', '身为', '出身', '惯', '素来', '性子', '脾气', '素', '向来', '人称'];

const SCENE_WORDS = ['厅', '堂', '院', '房', '街', '巷', '山', '林', '河', '桥', '殿', '楼', '阁', '店', '铺', '野', '城', '村', '宫', '牢', '舱', '室', '道', '台'];

const PROP_WORDS = ['刀', '剑', '枪', '伞', '灯', '镜', '盒', '匣', '信', '印', '玉', '珠', '杯', '壶', '书', '卷', '牌', '符', '琴', '笛'];

function scoreSentence(sentence, type) {
  const words = type === 'scene' ? SCENE_WORDS : type === 'prop' ? PROP_WORDS : LOOK_WORDS;
  let s = 0;
  for (const w of words) if (sentence.includes(w)) s += 2;
  if (type === 'character') {
    for (const w of ROLE_WORDS) if (sentence.includes(w)) s += 1;
  }
  // 太短的是"他走了"这类过场句，没有信息量
  if (sentence.length < 8) s -= 3;
  if (sentence.length > 60) s -= 1;
  return s;
}

/** 把长文切成句子（中英文标点都切），保留原顺序 */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/[。！？!?\n\r；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 120);
}

/** 收集剧本里所有可检索的正文：大纲分集 + 剧本场次 + 分镜动作/画面描述 */
function corpusOf(planRec) {
  const out = [];
  const outline = planRec?.outline ?? {};
  const eps = outline.episodes ?? planRec?.plan?.episodes ?? [];
  for (const ep of eps) {
    const no = ep.no ?? ep.episode ?? null;
    for (const key of ['title', 'summary', 'hook', 'beat', 'logline']) {
      if (ep[key]) out.push({ text: String(ep[key]), where: `第 ${no ?? '?'} 集 · ${key}` });
    }
    for (const c of ep.conflicts ?? []) {
      out.push({ text: String(c.desc ?? c.text ?? c), where: `第 ${no ?? '?'} 集 · 冲突` });
    }
  }
  const script = planRec?.script;
  for (const ep of script?.episodes ?? []) {
    for (const sc of ep.scenes ?? []) {
      if (sc.summary) out.push({ text: sc.summary, where: `第 ${ep.no ?? '?'} 集 第 ${sc.no ?? '?'} 场 · 场景说明` });
      if (sc.action) out.push({ text: sc.action, where: `第 ${ep.no ?? '?'} 集 第 ${sc.no ?? '?'} 场 · 动作` });
      for (const d of sc.dialogue ?? []) {
        if (d.line) out.push({ text: `${d.speaker ?? ''}：${d.line}`, where: `第 ${ep.no ?? '?'} 集 第 ${sc.no ?? '?'} 场 · 台词` });
      }
    }
  }
  for (const st of planRec?.storyboard?.shots ?? []) {
    if (st.shot_card) out.push({ text: st.shot_card, where: `${st.no} · 镜头描述` });
    if (st.action_start) out.push({ text: st.action_start, where: `${st.no} · 动作` });
  }
  return out;
}

function styleLine(style) {
  if (!style) return '';
  const palette = (style.palette ?? []).slice(0, 5).join(' ');
  return [
    `画风：${style.name}（${style.art_prompt_zh ?? ''}）`,
    palette ? `严格色板：${palette}，不得引入色板外色相` : '',
    style.negative_extra?.length ? `规避：${style.negative_extra.slice(0, 4).join('、')}` : '',
  ].filter(Boolean).join('；');
}

const TYPE_TPL = {
  character: {
    head: (name) => `${name} 的定妆设定`,
    extra: '要求：单人全身入画，中性表情，纯浅灰背景，五官与服装细节清晰，便于后续镜头保持同一张脸。',
  },
  scene: {
    head: (name) => `${name} 的场景概念`,
    extra: '要求：广角全景，空间结构完整，画面中不出现人物，光源方向清晰，便于作为镜头背景参考。',
  },
  prop: {
    head: (name) => `${name} 的道具设定`,
    extra: '要求：单件道具居中，45 度视角，材质与做旧程度清楚，浅灰背景。',
  },
};

class AssetPrompt {
  /**
   * 自动生成一版提示词草稿。
   * @returns {{prompt:string, basis:object}}
   */
  draft({ projectId, assetCode }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const asset = db.findOne(ASSETS, (a) => a.project_id === projectId && a.asset_code === assetCode);
    if (!asset) fail(ERR.ASSET_NOT_FOUND, `资产不存在: ${assetCode}`);
    const planRec = db.findOne(PLANS, (x) => x.project_id === projectId);
    const type = asset.asset_type === 'scene' ? 'scene' : asset.asset_type === 'prop' ? 'prop' : 'character';
    const tpl = TYPE_TPL[type];
    const style = seeds.style(project.spec?.style_code);
    const refs = Array.isArray(asset.reference_images) ? asset.reference_images : [];

    // —— 1. 在剧本里找"这个资产"出现过的地方 ——
    const name = String(asset.name ?? asset.asset_code ?? '');
    const keys = [name, asset.asset_code].filter(Boolean);
    const corpus = corpusOf(planRec);
    const hits = [];
    for (const item of corpus) {
      if (!keys.some((k) => item.text.includes(k))) continue;
      for (const s of sentencesOf(item.text)) {
        if (!keys.some((k) => s.includes(k))) continue;
        hits.push({ text: s, where: item.where, score: scoreSentence(s, type) });
      }
    }
    // 同一个句子可能在多处出现，去重后按相关度取前 3 条，且保持剧本原顺序
    const seen = new Set();
    const picked = [];
    for (const h of hits.sort((a, b) => b.score - a.score)) {
      if (seen.has(h.text)) continue;
      seen.add(h.text);
      if (h.score > 0) picked.push(h);
      if (picked.length >= 3) break;
    }

    // —— 2. 已有设定（锁 / 手工写的 desc / 已有 prompt）优先 ——
    const lv = asset.lock_values ?? {};
    const owns = [lv.prompt, lv.traits, lv.role, lv.desc, asset.meta?.traits, asset.meta?.desc]
      .filter(Boolean).map(String);

    // —— 3. 拼装 ——
    const lines = [tpl.head(name)];
    if (owns.length) lines.push(`设定：${owns.join('；')}`);
    if (picked.length) lines.push(`剧本描写：${picked.map((p) => p.text).join('／')}`);
    lines.push(styleLine(style));
    if (refs.length) {
      lines.push(`参考图：已上传 ${refs.length} 张，以第 1 张的长相/结构为准，其余作为服装与氛围参考`);
    }
    lines.push(tpl.extra);
    lines.push(`连续性锁（必须保留）：${(asset.locks ?? []).join('、') || '（无）'}`);

    const prompt = lines.filter(Boolean).join('\n');

    return {
      ok: true,
      asset_code: asset.asset_code,
      asset_type: asset.asset_type,
      prompt,
      basis: {
        // 出处全部回给前端，用户能核对"这句是从第 7 集第 3 场抽的"
        quotes: picked,
        quoted_count: picked.length,
        corpus_size: corpus.length,
        style: style ? { code: style.code, name: style.name, palette: style.palette ?? [] } : null,
        reference_count: refs.length,
        existing: owns.length,
        confidence: picked.length >= 2 ? 'high' : picked.length === 1 ? 'medium' : refs.length ? 'medium' : 'low',
        note: picked.length
          ? '描写来自剧本原文，可直接改；改完点「保存提示词」再出图。'
          : '剧本里没找到对这个资产的外形描写——建议上传一张参考照片，或手动补两句。',
      },
    };
  }
}

export const assetPrompt = new AssetPrompt();
export default assetPrompt;
