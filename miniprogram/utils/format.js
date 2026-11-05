/** 展示层格式化：所有 wxml 里不该出现的计算，都在这里做掉。 */

const COVERS = ['a', 'b', 'c', 'd', 'e', 'f'];

function hash(str) {
  const s = String(str || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h;
}

function coverOf(key) {
  return COVERS[hash(key) % COVERS.length];
}

function charOf(title) {
  const s = String(title || '').trim();
  return s ? s.slice(0, 1) : '剧';
}

function fmtNumber(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}万`;
  return String(Math.round(v));
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  const fixed = Math.abs(v % 1) < 0.005 ? String(Math.round(v)) : v.toFixed(2);
  return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${Math.round(s)}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${Math.round(s % 60)}秒`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} 天前`;
  const dt = new Date(t);
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
}

const PROJECT_STATUS = {
  draft: { text: '草稿', cls: 'pill-gray' },
  running: { text: '制作中', cls: 'pill-gold' },
  done: { text: '已完成', cls: 'pill-green' },
  failed: { text: '异常', cls: 'pill-red' },
  paused: { text: '已暂停', cls: 'pill-gray' },
};

function projectStatus(status) {
  return PROJECT_STATUS[status] || PROJECT_STATUS.draft;
}

const NODE_STATUS = {
  pending: { text: '待执行', cls: '', dot: '' },
  running: { text: '执行中', cls: 'pill-gold', dot: 'running' },
  done: { text: '已完成', cls: 'pill-green', dot: 'done' },
  failed: { text: '失败', cls: 'pill-red', dot: 'failed' },
  skipped: { text: '跳过', cls: 'pill-gray', dot: 'skipped' },
};

function nodeStatus(status) {
  return NODE_STATUS[status] || NODE_STATUS.pending;
}

function styleMap(styles) {
  const map = {};
  (styles || []).forEach((s) => { map[s.code] = s; });
  return map;
}

/**
 * 项目视图模型。
 * 后端 /api/home 已给出 episodes/shots/progress，这里只做展示口径统一。
 */
function projectView(p, map) {
  const spec = p.spec || {};
  const style = (map || {})[spec.style_code];
  const styleName = p.style_name || (style ? style.name : (spec.style_code || '都市'));
  const st = projectStatus(p.status);
  const episodes = Number(p.episodes) || Math.max(1, Math.ceil((Number(spec.total_minutes) || 10) * 60 / (Number(spec.episode_sec) || 90)));
  const progress = typeof p.progress === 'number' ? Math.max(2, Math.min(100, p.progress)) : (p.status === 'done' ? 100 : 8);
  return {
    id: p.id,
    title: p.title || '未命名网剧',
    cover: coverOf(p.id || p.title),
    char: charOf(p.title),
    styleName,
    styleCode: spec.style_code || '',
    episodes,
    minutes: Number(spec.total_minutes) || 0,
    shots: Number(p.shots) || 0,
    progress,
    statusText: st.text,
    statusCls: st.cls,
    meta: `${styleName} · ${episodes} 集 · ${Number(spec.total_minutes) || 0} 分钟`,
    timeText: timeAgo(p.created_at),
    credits: p.credits || 0,
    seasonNo: Number(p.season_no) || 1,
    seasonTag: (Number(p.season_no) || 1) > 1 ? `第 ${Number(p.season_no)} 季` : '',
    seriesId: p.series_id || '',
  };
}

function percent(done, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function shortId(id) {
  return String(id || '').replace(/^[a-z]+_/, '').slice(-6).toUpperCase();
}

module.exports = {
  coverOf,
  charOf,
  fmtNumber,
  fmtMoney,
  fmtDuration,
  timeAgo,
  projectStatus,
  nodeStatus,
  styleMap,
  projectView,
  percent,
  shortId,
};
