const { themeColors } = require('./theme');

function channels(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}

function mix(from, to, amount) {
  const a = channels(from), b = channels(to);
  return '#' + a.map((value, index) => Math.round(value + (b[index] - value) * amount)
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}

function luminance(hex) {
  const rgb = channels(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function heatStyle(seconds, theme) {
  const palette = themeColors(theme).heat;
  const duration = Math.max(0, Number(seconds) || 0);
  // Use a fixed 12-hour reference so long study days do not all collapse to the
  // darkest swatch. The power curve keeps short sessions visible while preserving
  // useful color changes through the common 2–8 hour range.
  const progress = Math.min(1, duration / 43200);
  const position = Math.pow(progress, 0.62) * (palette.length - 1);
  const index = Math.min(palette.length - 2, Math.floor(position));
  const color = duration === 0 ? palette[0] : mix(palette[index], palette[index + 1], position - index);
  const textColor = luminance(color) > 0.38 ? '#263327' : '#FFFFFF';
  return 'background-color:' + color + ';color:' + textColor;
}

module.exports = { heatStyle };
