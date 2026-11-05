/**
 * 编译六段拼装（§12.2）。每段一个函数，输出英文提示词片段 + 中文审阅片段。
 * 所有措辞都来自种子库，不在代码里发明提示词。
 */
import seeds from '../seeds/loader.js';

/** 画幅 → 英文描述 + 竖屏规则 */
export function aspectRules(aspect) {
  const vertical = aspect === '9:16';
  return {
    aspect,
    vertical,
    en: vertical ? '9:16 vertical framing' : aspect === '16:9' ? '16:9 horizontal framing' : `${aspect} framing`,
    zh: vertical ? '竖屏 9:16 构图' : aspect === '16:9' ? '横屏 16:9 构图' : `${aspect} 构图`,
  };
}

/** P1 总设定 */
export function segmentGlobal({ style, director, aspect, duration, quality, emotion }) {
  const a = aspectRules(aspect);
  const en = [
    `${style.art_prompt_en}.`,
    `Overall tone: ${emotion ?? 'neutral'}.`,
    `${a.en}, ${quality ?? '1080p'} cinematic quality.`,
    duration ? `Shot length ${duration} seconds.` : null,
    director ? `Directing style: average shot length ${director.avg_shot_len}s, ${director.rhythm_curve} rhythm.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const zh = [
    `${style.art_prompt_zh}。`,
    `整体情绪：${emotion ?? '中性'}。`,
    `${a.zh}，${quality ?? '1080p'} 电影级画质。`,
    duration ? `镜头时长 ${duration} 秒。` : null,
    director ? `导演原型：${director.name}，平均镜长 ${director.avg_shot_len} 秒，${director.rhythm_curve} 节奏。` : null,
  ]
    .filter(Boolean)
    .join('');
  return { en, zh };
}

/** P2 角色与连续性（角色卡锁面 + 场景锁面 + 道具锁面 + 版本快照） */
export function segmentContinuity({ characterAssets = [], sceneAsset = null, propAssets = [], locks = [] }) {
  const charEn = characterAssets.map((c) => renderLock('character', c)).filter(Boolean);
  const sceneEn = sceneAsset ? [renderLock('scene', sceneAsset)] : [];
  const propEn = propAssets.map((p) => renderLock('prop', p)).filter(Boolean);

  const en = [...charEn, sceneEn.filter(Boolean), ...propEn, ...locks].flat().filter(Boolean).join('. ');
  const zh = [
    ...characterAssets.map((c) => `角色 ${c.name ?? c.asset_code}：${(c.locks ?? []).join('、')}`),
    sceneAsset ? `场景 ${sceneAsset.name ?? sceneAsset.asset_code}：${(sceneAsset.locks ?? []).join('、')}` : null,
    ...propAssets.map((p) => `道具 ${p.name ?? p.asset_code}：${(p.locks ?? []).join('、')}`),
  ]
    .filter(Boolean)
    .join('。');
  return { en: en ? `${en}.` : '', zh: zh ? `${zh}。` : '' };
}

function renderLock(type, asset) {
  if (!asset) return '';
  const tpl = seeds.lockTemplate(type);
  const hasValues = asset.lock_values && Object.keys(asset.lock_values).length > 0;
  if (tpl && hasValues) {
    let s = tpl.prompt_template_en;
    for (const [k, v] of Object.entries(asset.lock_values)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v ?? '');
    }
    return s.replace(/\{\w+\}/g, '').replace(/\s+/g, ' ').trim();
  }
  return (asset.locks ?? []).join(', ');
}

/**
 * P2.5 情绪表演段（第 13 条强制链）。
 *
 * 情绪是资产：每个在场角色必须绑定一张情绪卡，卡片里的 8 条表演锁（眉/眼/嘴/下颌/
 * 呼吸/手势/体态/视线）直接写进提示词，并且**显式强调为最高优先级**——
 * 漫剧最难看的事故不是画风崩，是"该哭的时候在笑、该怒的时候面瘫"。
 *
 * 强调的三重手段：
 *  1. 段落前缀声明优先级（Performance lock / highest priority）
 *  2. 逐角色点名（谁 + 什么情绪 + 具体肌肉动作），不写"情绪：愤怒"这种抽象词
 *  3. 视频追加情绪弧线（起始→发展→落点）与微表情时间轴（按镜内百分比给关键帧）
 */
export function segmentEmotion({ resolved = {}, isVideo = false, duration = 5, speaker = null, characterNames = {} }) {
  const entries = Object.entries(resolved).filter(([, v]) => v && v.card);
  if (!entries.length) return { en: '', zh: '' };

  const enBits = [];
  const zhBits = [];

  for (const [code, v] of entries) {
    const card = v.card;
    const who = characterNames[code] ?? v.asset?.name ?? code;
    // 静态表演锁：卡片 prompt_en 已经是完整的肌肉级描述
    let en = `${who} performs "${card.name}" (emotion card ${card.code}, intensity ${card.intensity}/5): ${card.prompt_en}`;
    let zh = `${who} 表演「${card.name}」（${card.code}，强度 ${card.intensity}/5）：${card.prompt_zh}`;

    // 视频：情绪必须动起来 —— 追加弧线与微表情时间轴
    if (isVideo) {
      en += `. Emotion arc across the shot: ${card.motion_en}`;
      zh += `。镜内情绪弧线：${card.motion_zh}`;
      const tl = (card.micro_timeline ?? []).slice(0, 4);
      if (tl.length) {
        const marks = tl.map((p) => `at ${Math.round(p.t * 100)}% ${p.desc}`).join('; ');
        en += `. Micro-expression timeline: ${marks}`;
        zh += `。微表情时间轴：${tl.map((p) => `${Math.round(p.t * 100)}% ${p.desc}`).join('；')}`;
      }
    }
    // 说话人：语气由情绪驱动
    if (speaker === code && card.voice_hint) {
      const vh = card.voice_hint;
      en += `. Delivery: ${vh.pitch} pitch, ${vh.rate} rate, ${vh.breath}, ${vh.timbre} timbre`;
      zh += `。语气：${vh.pitch}音高，${vh.rate}语速，${vh.breath}，${vh.timbre}音色`;
    }
    enBits.push(en);
    zhBits.push(zh);
  }

  // 强调前缀：告诉模型这段的优先级高于风格与构图
  const head = isVideo
    ? 'Performance lock, highest priority, the facial performance must remain consistent and clearly readable for the entire shot:'
    : 'Performance lock, highest priority, the facial expression must be clearly readable:';
  const zhHead = '表演锁定（最高优先级，整镜不得漂移、必须清晰可读）：';

  return {
    en: `${head} ${enBits.join('. ')}.`,
    zh: `${zhHead}${zhBits.join('。')}。`,
  };
}

/** P3 镜头语言（镜头卡 + 运动 + 竖屏适配） */
export function segmentCamera({ shotCard, moveCard, aspect, verticalNotes = [] }) {
  const a = aspectRules(aspect);
  const parts = [shotCard?.prompt_en];
  if (moveCard && moveCard.code !== shotCard?.code) parts.push(moveCard.prompt_en);
  let en = parts.filter(Boolean).join(', ');
  if (a.vertical) {
    en += '. Keep the subject centered horizontally, avoid the right 15% of frame (platform UI zone), leave the bottom 12% clear for captions';
  }
  if (a.vertical && shotCard) en += `. Vertical 9:16 adaptation: ${shotCard.vertical_note}`;
  for (const n of verticalNotes) en += `. ${n}`;

  const zhParts = [shotCard?.prompt_zh, moveCard && moveCard.code !== shotCard?.code ? moveCard.prompt_zh : null];
  let zh = zhParts.filter(Boolean).join('，');
  if (a.vertical) zh += '。竖屏适配：主体避开右侧 15% 平台 UI 区，底部 12% 留字幕安全区';
  if (a.vertical && shotCard) zh += `；${shotCard.vertical_note}`;
  return { en: `${en}.`, zh: `${zh}。` };
}

/** P4 光影 */
export function segmentLighting({ lightingCards = [], colorTemp }) {
  if (!lightingCards.length) return { en: '', zh: '' };
  const en = lightingCards.map((c) => c.prompt_en).join(', ');
  const zh = lightingCards.map((c) => c.name).join('、');
  return {
    en: `${en}.${colorTemp ? ` Color temperature ${colorTemp}.` : ''}`,
    zh: `光影：${zh}${colorTemp ? `，色温 ${colorTemp}` : ''}。`,
  };
}

/** P3.5 大师语法（构图 / 焦段 / 调色 / 氛围）
 *
 * 与 P3 镜头语言的分工：P3 说"这个镜头怎么拍"（景别+运镜），
 * 这一段说"这一镜为什么这么拍"——构图骨架、焦距选择、调色倾向、空气质感。
 * 四类卡都来自 cinema_grammar.json，任何一项缺失就跳过，不影响既有链路。
 */
export function segmentGrammar({ composition = null, lens = null, color = null, atmosphere = null, recipeName = null, intent = null, why = null }) {
  const enBits = [];
  const zhBits = [];
  if (composition?.prompt_en) enBits.push(composition.prompt_en);
  if (lens?.prompt_en) enBits.push(lens.prompt_en);
  if (color?.prompt_en) enBits.push(color.prompt_en);
  if (atmosphere?.prompt_en) enBits.push(`atmosphere: ${atmosphere.prompt_en}`);
  if (composition?.prompt_zh) zhBits.push(composition.prompt_zh);
  if (lens?.prompt_zh) zhBits.push(lens.prompt_zh);
  if (color?.prompt_zh) zhBits.push(color.prompt_zh);
  if (atmosphere?.prompt_zh) zhBits.push(`氛围：${atmosphere.prompt_zh}`);

  if (!enBits.length) return { en: '', zh: '' };
  // 英文段只放英文字段：配方名与 why 是中文，混进 prompt_en 会让模型把中文当画面内容
  return {
    en: `${enBits.join(', ')}.`,
    zh: `${recipeName ? `【${recipeName}${intent ? ' · ' + intent : ''}】` : ''}${zhBits.join('，')}${why ? `。意图：${why}` : ''}。`,
  };
}

/** P5 动作与场景反馈 */
export function segmentAction({ actionStart, actionEnd, actionStartZh, actionEndZh, ambient = [], reactions = [] }) {
  const bits = [];
  if (actionStart) bits.push(`At the start, ${actionStart}`);
  if (actionEnd) bits.push(`By the end, ${actionEnd}`);
  if (ambient.length) bits.push(`Ambient elements: ${ambient.join(', ')}`);
  if (reactions.length) bits.push(`Background reaction: ${reactions.join(', ')}`);
  const zhBits = [];
  if (actionStartZh ?? actionStart) zhBits.push(`起始状态：${actionStartZh ?? actionStart}`);
  if (actionEndZh ?? actionEnd) zhBits.push(`结束状态：${actionEndZh ?? actionEnd}`);
  if (ambient.length) zhBits.push(`环境元素：${ambient.join('、')}`);
  return { en: bits.join('. ') ? `${bits.join('. ')}.` : '', zh: zhBits.join('；') ? `${zhBits.join('；')}。` : '' };
}

/** P6 转场与声音 */
export function segmentTransitionSound({ transitionCard, ambientSound, musicEntry, dialogue, silentOthers = [] }) {
  const bits = [];
  if (transitionCard && transitionCard.code !== 'TRN-HARDCUT') bits.push(transitionCard.prompt_en);
  if (dialogue) bits.push(`The character says: "${dialogue}"`);
  if (silentOthers.length) {
    bits.push(`${silentOthers.join(' and ')} present in frame with lips closed, saying nothing`);
  }
  if (ambientSound) bits.push(`Ambient sound: ${ambientSound}`);
  bits.push(musicEntry ?? 'No music');

  const zhBits = [];
  if (transitionCard && transitionCard.code !== 'TRN-HARDCUT') zhBits.push(`转场：${transitionCard.name}`);
  if (dialogue) zhBits.push(`对白：${dialogue}`);
  if (silentOthers.length) zhBits.push(`同框其他角色：${silentOthers.join('、')} 闭口不说话`);
  if (ambientSound) zhBits.push(`环境音：${ambientSound}`);
  zhBits.push(musicEntry === 'No music' ? '无音乐' : (musicEntry ?? '无音乐'));
  return { en: bits.join('. ') ? `${bits.join('. ')}.` : '', zh: zhBits.join('；') ? `${zhBits.join('；')}。` : '' };
}

/** 负面词：通用 + 表情基线 + 风格特有 + 导演强化 + 情绪卡自带 */
export function buildNegative({ style, director, emotionCards = [], extra = [] }) {
  const common = [
    'text', 'watermark', 'logo', 'subtitle', 'deformed fingers', 'extra limbs',
    'distorted face', 'misaligned facial features', 'inconsistent art style', 'style shift',
    'duplicate faces', 'low resolution', 'blurry', 'noise', 'overexposed', 'crushed blacks',
  ];
  const zhCommon = [
    '文字', '水印', 'Logo', '字幕', '畸形手指', '多余肢体', '脸部扭曲', '五官错位',
    '画风不一致', '风格突变', '多人重复面孔', '低分辨率', '模糊', '噪点', '过曝', '死黑',
  ];
  // 表情基线：无论什么情绪，都不允许"没有表情"
  const expressionBase = [
    'blank expression', 'emotionless', 'vacant stare', 'neutral mannequin face',
    'expression changing mid-shot', 'inconsistent expression between frames',
  ];
  const expressionBaseZh = ['面无表情', '表情僵硬', '空洞眼神', '表情中途突变', '帧间表情不一致'];
  // 情绪卡自带负面（如"压抑的暴怒"禁"张嘴大喊"）
  const emotionNeg = [...new Set(emotionCards.flatMap((c) => c.negative ?? []))];
  // 风格/导演的负面词在种子库里是中文，需要映射成英文给模型（未命中的保留原词）
  const toEn = (list = []) => list.map((z) => NEGATIVE_ZH2EN[z] ?? z);
  return {
    en: [...new Set([...common, ...expressionBase, ...emotionNeg, ...toEn(style?.negative_extra), ...toEn(director?.negative_boost), ...extra])].join(', '),
    zh: [...new Set([...zhCommon, ...expressionBaseZh, ...emotionNeg, ...(style?.negative_extra ?? []), ...(director?.negative_boost ?? []), ...(extra.length ? ['自定义'] : [])])].join('、'),
  };
}

/** 中文负面词映射（风格里是中文，英文模型需要英文负面词） */
export const NEGATIVE_ZH2EN = {
  现代服装: 'modern clothing',
  现代建筑: 'modern architecture',
  电线杆: 'utility poles',
  汽车: 'cars',
  霓虹: 'neon',
  古装: 'ancient costume',
  水墨: 'ink wash',
  写实照片质感: 'photorealistic texture',
  真人皮肤纹理: 'realistic skin texture',
  写实光影: 'realistic lighting',
  卡通渲染: 'cartoon shading',
  赛璐璐: 'cel shading',
  插画感: 'illustration look',
  塑料感皮肤: 'plastic skin',
  田园: 'pastoral scenery',
  木质: 'wooden material',
  暖色黄昏: 'warm dusk',
  古典建筑: 'classical architecture',
  明亮均匀布光: 'bright even lighting',
  欢快色调: 'cheerful colors',
  柔光晕: 'soft bloom',
  高饱和: 'oversaturated',
  冷硬调: 'cold hard tone',
  硬阴影: 'hard shadows',
  不协和音: 'dissonance',
  低对比: 'low contrast',
  慢节奏: 'slow pacing',
  夸张畸变: 'exaggerated distortion',
  强对比硬光: 'harsh high contrast light',
  快速剪辑感: 'fast cutting feel',
  硬切密集: 'dense hard cuts',
  平淡布光: 'flat lighting',
  低饱和: 'desaturated',
};
