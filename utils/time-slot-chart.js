const { durationText } = require('./format');

// Choose a readable ceiling for the largest daily average in an hour bucket.
const SCALE_SECONDS = [15, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600];
const SCALE_MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const SCALE_LABELS = SCALE_MINUTES.map(n => n ? n + '分钟' : '自动');

function buildTimeSlotChart(rawSlots, fixedMinutes = 0) {
  const source = rawSlots || [];
  const peak = source.reduce((max, slot) => Math.max(max, Number(slot.averageSeconds) || 0), 0);
  const fixed = SCALE_MINUTES.includes(Number(fixedMinutes)) ? Number(fixedMinutes) : 0;
  const scaleSeconds = fixed ? fixed * 60 : peak === 0 ? 3600 : SCALE_SECONDS.find(value => value >= peak) || Math.ceil(peak / 900) * 900;
  const slots = source.map(slot => {
    const seconds = Math.max(0, Number(slot.averageSeconds) || 0);
    const start = String(slot.startHour).padStart(2, '0');
    const end = String(slot.startHour + 1).padStart(2, '0');
    return {
      startHour: slot.startHour,
      label: start + '–' + end,
      axisLabel: slot.startHour % 4 === 0 ? start : '',
      height: Math.min(100, seconds / scaleSeconds * 100),
      overScale: !!fixed && seconds > scaleSeconds,
      averageText: seconds > 0 && seconds < .5 ? '不足1秒' : durationText(Math.round(seconds))
    };
  });
  return { slots, scaleText: durationText(scaleSeconds), fixed, scaleIndex: SCALE_MINUTES.indexOf(fixed) };
}

module.exports = { buildTimeSlotChart, SCALE_MINUTES, SCALE_LABELS };
