// utils/color.js
// 按 projectId 保存独立颜色；避免哈希碰撞，跨范围/图表/重启同项目同色。
// 主操作保持首页绿色；数据色用更明显的色相差别。v2独立偏好不改变记录。

const PALETTE = [
  "#425B42",
  "#DC6B27",
  "#3976C5",
  "#9A4FB2",
  "#C64458",
  "#16978E",
  "#CF9C22",
  "#685CC6",
  "#78604B",
  "#D17EA5",
  "#75A23D",
  "#288EA9",
  "#AA482D",
  "#476393",
  "#90862B",
  "#665065",
  "#4A8A63",
  "#B75B61",
  "#3B8B9E",
  "#8E74B8",
  "#C17642",
  "#7C788D",
  "#A65D94",
  "#477764",
];

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Allocate distinct colors and keep the assignment across ranges, renames and restarts.
const COLOR_KEY = "yotick/ui-project-colors-v2";
let assignments = Object.create(null),
  adapter = null,
  pending = Promise.resolve();
function hslHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + channel(0) + channel(8) + channel(4);
}
function persist() {
  if (!adapter) return;
  const target = adapter,
    snapshot = Object.assign({}, assignments);
  pending = pending.catch(() => {}).then(() => target.set(COLOR_KEY, snapshot));
  pending.catch(() => {});
}
function pickUnusedColor(used) {
  const channels = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const distance = (a, b) =>
    channels(a).reduce((n, v, i) => n + (v - channels(b)[i]) ** 2, 0);
  let color;
  if (!used.size) color = PALETTE[0];
  else {
    const available = PALETTE.filter((c) => !used.has(c));
    available.sort(
      (a, b) =>
        Math.min(...Array.from(used, (c) => distance(b, c))) -
        Math.min(...Array.from(used, (c) => distance(a, c))),
    );
    color = available[0];
  }
  // More projects than the base palette: extend it rather than reuse a color.
  for (let i = 0; !color; i++) {
    const candidate = hslHex(
      (i * 137.508) % 360,
      52 + (i % 3) * 9,
      37 + (Math.floor(i / 3) % 3) * 9,
    );
    if (!used.has(candidate.toUpperCase())) color = candidate;
  }
  return color.toUpperCase();
}
function defaultColorOf(projectId) {
  const id = String(projectId || "");
  const used = new Set(
    Object.keys(assignments)
      .filter((key) => key !== id)
      .map((key) => assignments[key].toUpperCase()),
  );
  return pickUnusedColor(used);
}
function colorOf(projectId) {
  const id = String(projectId || "");
  if (assignments[id]) return assignments[id];
  assignments[id] = defaultColorOf(id);
  persist();
  return assignments[id];
}
function setProjectColor(projectId, color) {
  const id = String(projectId || "");
  if (!id) return;
  if (color && /^#[0-9a-f]{6}$/i.test(color))
    assignments[id] = color.toUpperCase();
  else {
    delete assignments[id];
    colorOf(id);
  }
  persist();
}
async function initProjectColors(store) {
  const [saved, projects] = await Promise.all([
    store.get(COLOR_KEY),
    store.get("yotick/projects"),
  ]);
  assignments = Object.create(null);
  adapter = null;
  const used = new Set();
  if (saved && typeof saved === "object")
    Object.keys(saved).forEach((id) => {
      const color = saved[id];
      if (
        typeof color === "string" &&
        /^#[0-9a-f]{6}$/i.test(color) &&
        !used.has(color.toLowerCase())
      ) {
        assignments[id] = color.toUpperCase();
        used.add(color.toLowerCase());
      }
    });
  Object.values(projects || {})
    .sort(
      (a, b) =>
        a.creationOrder - b.creationOrder ||
        String(a.id).localeCompare(String(b.id)),
    )
    .forEach((p) => {
      if (p.color && /^#[0-9a-f]{6}$/i.test(p.color))
        assignments[p.id] = p.color.toUpperCase();
      else colorOf(p.id);
    });
  adapter = store;
  if (JSON.stringify(saved || {}) !== JSON.stringify(assignments)) {
    persist();
    await pending;
  }
}
function flushProjectColors() {
  return pending;
}
module.exports = {
  pickUnusedColor,
  colorOf,
  defaultColorOf,
  setProjectColor,
  PALETTE,
  initProjectColors,
  flushProjectColors,
  COLOR_KEY,
};
