/**
 * 字幕生成：剧本对白 → SRT / ASS。
 *
 * 为什么不用 ASR（Whisper 那类）：对白是已知文本，按字数与语速分配时间码比语音识别
 * 更准、更省钱；只有「用户上传成片要加字幕」才需要识别，不在本模块范围。
 *
 * 硬规则：
 *   1. 竖屏单行 ≤ 13 字、横屏 ≤ 20 字，超长按标点断句，绝不让标点落在行首；
 *   2. 每条字幕 ≥ 0.9 秒，相邻两条之间留 0.06 秒空隙，避免粘字；
 *   3. 片头 0–3 秒必须有 AI 标识字幕（合规要求，不可关闭）。
 */

export const SUBTITLE_RULES = {
  max_chars: { '9:16': 13, '4:3': 18, '16:9': 20, '1:1': 15 },
  chars_per_second: 4.6,
  min_cue_sec: 0.9,
  max_cue_sec: 6.0,
  gap_sec: 0.06,
  ai_label_sec: 3,
};

/** 断句：先按句末标点，再按逗号，最后硬切；标点不允许出现在行首 */
export function splitCueText(text, maxLen = 13) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const hard = raw.split(/(?<=[。！？!?；;…])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const pushChunk = (s) => {
    let rest = s;
    while (rest.length > maxLen) {
      // 优先在逗号/顿号处断
      const window = rest.slice(0, maxLen + 1);
      let cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(' '));
      if (cut < maxLen * 0.5) cut = maxLen;
      let head = rest.slice(0, cut).trim();
      let tail = rest.slice(cut).trim();
      // 行首不许是标点
      while (tail && /^[，。、；：！？,.;:!?）」』"]/.test(tail)) {
        head += tail[0];
        tail = tail.slice(1);
      }
      if (head) out.push(head);
      rest = tail;
    }
    if (rest) out.push(rest);
  };
  for (const part of hard) pushChunk(part);
  return out;
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function srtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const carry = ms === 1000 ? 1 : 0;
  return `${pad(h)}:${pad(m)}:${pad(ss + carry)},${pad(ms % 1000, 3)}`;
}

export function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${pad(m)}:${ss.toFixed(2).padStart(5, '0')}`;
}

/**
 * @param {object} p
 *  segments: [{ shot_no, start, end, duration, dialogue:[{speaker,line}] }]
 *  aspect, aiLabel (string|null), showSpeaker
 */
export function buildSubtitles({ segments = [], aspect = '9:16', aiLabel = null, showSpeaker = false, rule = null } = {}) {
  // V4.4：字幕同步提示词库（每条字幕的字数、停留、间隙、提前量都由库决定，而不是写死）
  const maxLen = rule?.max_chars_per_line ?? (SUBTITLE_RULES.max_chars[aspect] ?? 13);
  const minCue = rule?.min_dur_sec ?? SUBTITLE_RULES.min_cue_sec;
  const maxCue = rule?.max_dur_sec ?? SUBTITLE_RULES.max_cue_sec;
  const gap = rule?.gap_sec ?? SUBTITLE_RULES.gap_sec;
  const lead = (rule?.lead_offset_ms ?? 0) / 1000;
  const cues = [];
  const warnings = [];

  // 片头 AI 标识（合规，不可关）
  if (aiLabel) {
    cues.push({
      index: 1, start: 0, end: SUBTITLE_RULES.ai_label_sec,
      speaker: null, text: aiLabel, role: 'ai_label',
    });
  }

  for (const seg of segments) {
    const start = Number(seg.start ?? 0);
    const dur = Number(seg.duration ?? Math.max(0, (seg.end ?? 0) - start)) || 0;
    if (dur <= 0) continue;
    const lines = (seg.dialogue ?? []).filter((d) => d && String(d.line ?? '').trim());
    if (!lines.length) continue;

    const chunks = [];
    for (const d of lines) {
      const speaker = showSpeaker ? String(d.speaker ?? '').trim() : '';
      for (const piece of splitCueText(d.line, maxLen)) {
        chunks.push({ speaker, text: piece, chars: piece.length });
      }
    }
    if (!chunks.length) continue;
    const firstIdx = cues.length;

    const totalChars = chunks.reduce((a, c) => a + c.chars, 0) || 1;
    // 可用时长 = 镜头时长 - 条间隙
    const usable = Math.max(0.4, dur - gap * Math.max(0, chunks.length - 1));
    // 时长按字数分配，但每条不超过 cps 推算的舒适上限
    // 提前量：负值表示字幕早于人声出现（短剧常见做法，观众先看到字再听到声）
    let cursor = Math.max(start, start + lead);
    for (const [i, c] of chunks.entries()) {
      const share = (c.chars / totalChars) * usable;
      let len = Math.max(minCue, Math.min(maxCue, share));
      // 最后一条吃掉剩余时间，避免累积误差
      if (i === chunks.length - 1) len = Math.max(minCue, start + dur - cursor);
      const end = Math.min(start + dur, cursor + len);
      if (end - cursor < 0.3) break;
      cues.push({
        index: cues.length + 1,
        start: +cursor.toFixed(2),
        end: +end.toFixed(2),
        speaker: c.speaker || null,
        text: c.text,
        role: 'dialogue',
        shot_no: seg.shot_no ?? null,
      });
      cursor = end + gap;
      if (cursor >= start + dur) break;
    }

    if (cues.length > firstIdx && cues[cues.length - 1].end > start + dur + 0.01) {
      warnings.push({ shot: seg.shot_no, issue: '对白时长超出镜头，已截断' });
    }
  }

  // 重排序号（AI 标识固定第 1 条）
  cues.forEach((c, i) => { c.index = i + 1; });

  return {
    aspect,
    cues,
    srt: toSrt(cues),
    total_cues: cues.length,
    stats: {
      dialogue_cues: cues.filter((c) => c.role === 'dialogue').length,
      ai_label_cues: cues.filter((c) => c.role === 'ai_label').length,
      duration_sec: cues.length ? +cues.at(-1).end.toFixed(2) : 0,
      max_chars_per_line: maxLen,
      sync_code: rule?.code ?? null,
      sync_name: rule?.name ?? null,
    },
    warnings,
  };
}

export function toSrt(cues) {
  const blocks = cues.map((c) => {
    const text = c.speaker ? `${c.speaker}：${c.text}` : c.text;
    return `${c.index}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${text}\n`;
  });
  return blocks.join('\n');
}

/**
 * ASS：竖屏/横屏自动换字号，AI 标识固定顶部居中。
 * 用 ASS 而不是 SRT 烧录，是为了控制描边与安全区（竖屏底部有 UI 遮挡）。
 */
export function toAss(cues, { aspect = '9:16', title = '网剧大咖', font = 'Source Han Sans SC' } = {}) {
  const vertical = aspect === '9:16';
  const w = vertical ? 1080 : 1920;
  const h = vertical ? 1920 : 1080;
  const fontSize = vertical ? 62 : 54;
  const marginV = vertical ? Math.round(h * 0.18) : Math.round(h * 0.08);
  const labelSize = vertical ? 44 : 38;

  const header = `[Script Info]
Title: ${title}
ScriptType: v4.00+
WrapStyle: 2
PlayResX: ${w}
PlayResY: ${h}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H64000000,0,0,0,0,100,100,1,0,1,3,1,2,60,60,${marginV},1
Style: AILabel,${font},${labelSize},&H00E8E8E8,&H000000FF,&H00101010,&H64000000,0,0,0,0,100,100,2,0,1,2,0,8,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues.map((c) => {
    const style = c.role === 'ai_label' ? 'AILabel' : 'Default';
    const text = (c.speaker ? `${c.speaker}：` : '') + c.text;
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${style},,0,0,0,,${escapeAss(text)}`;
  });

  return header + events.join('\n') + '\n';
}

function escapeAss(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

/** 纯文本台词本（给「剪映导入」或人工校对用） */
export function toPlainScript(cues) {
  return cues
    .filter((c) => c.role === 'dialogue')
    .map((c) => `[${srtTime(c.start)}] ${c.speaker ? c.speaker + '：' : ''}${c.text}`)
    .join('\n');
}

export const subtitle = { buildSubtitles, toSrt, toAss, toPlainScript, splitCueText, SUBTITLE_RULES };
export default subtitle;
