// Display names and persisted IDs for available light palettes, ordered by accent hue.
const LIGHT_THEMES = [
  { id: 'terracotta', name: '陶土' },
  { id: 'almond-cream', name: '杏仁' },
  { id: 'dune-beige', name: '沙丘' },
  { id: 'amber', name: '琥珀' },
  { id: 'sprout-green', name: '芽绿' },
  { id: 'forest', name: '森林' },
  { id: 'celadon', name: '青瓷' },
  { id: 'frost', name: '冰灰' },
  { id: 'glacier-blue', name: '冰川' },
  { id: 'midnight', name: '午夜' },
  { id: 'twilight-indigo', name: '靛蓝' },
  { id: 'haze-violet', name: '雾紫' },
  { id: 'mauve', name: '烟紫' },
  { id: 'cherry-pink', name: '樱粉' },
  { id: 'mist-rose', name: '雾粉' },
  { id: 'slate', name: '银灰' }
];
const LIGHT_THEME_NAMES = LIGHT_THEMES.reduce((names, theme) => {
  names[theme.id] = theme.name;
  return names;
}, {});
function isLightTheme(id) { return Object.prototype.hasOwnProperty.call(LIGHT_THEME_NAMES, id); }
function lightThemeName(id) { return LIGHT_THEME_NAMES[id] || LIGHT_THEME_NAMES.forest; }
module.exports = { LIGHT_THEMES, isLightTheme, lightThemeName };
