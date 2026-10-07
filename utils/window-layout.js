// Keep native capsule geometry in pixels; wide screens must not enlarge it.
function windowMetrics(info) {
  info = info || {};
  const width = Number(info.windowWidth) > 0 ? Number(info.windowWidth) : 375;
  const height = Number(info.windowHeight) > 0 ? Number(info.windowHeight) : 667;
  const status = Number(info.statusBarHeight);
  const statusBar = Number.isFinite(status) && status >= 0 && status <= 96 ? status : 24;
  const bottom = info.safeArea && Number(info.screenHeight) - Number(info.safeArea.bottom);
  return { width, height, statusBar, safeBottom: Number.isFinite(bottom) ? Math.max(0, Math.min(48, bottom)) : 0 };
}

function navigationMetrics(info, menu) {
  const frame = windowMetrics(info);
  // The IDE can return zero or stale capsule coordinates after resizing.
  const usable = menu && Number.isFinite(menu.top) && Number.isFinite(menu.height)
    && menu.height >= 16 && menu.height <= 64
    && menu.top >= frame.statusBar && menu.top <= frame.statusBar + 32
    && menu.top + menu.height < frame.height;
  const top = usable ? menu.top : frame.statusBar + 8;
  const barHeight = usable ? menu.height : 32;
  const validLeft = usable && Number.isFinite(menu.left) && menu.left > frame.width / 2 && menu.left < frame.width;
  return { top, barHeight, navHeight: top + barHeight + 14,
    rightInset: validLeft ? frame.width - menu.left + 8 : 100 };
}

function pickerMetrics(info, topInset, reserveBottomNav) {
  const frame = windowMetrics(info);
  const overlayTop = Math.max(0, Math.min(Number(topInset) || 0, frame.height - 100));
  const overlayBottom = frame.safeBottom + (reserveBottomNav ? frame.width * 108 / 750 : 0);
  const available = Math.max(1, frame.height - overlayTop - overlayBottom - 32);
  const pickerScale = Math.min(frame.width, 450) / 750;
  const cardMaxHeight = Math.max(1, Math.floor(Math.min(720, frame.height * .78, available)));
  const bodyMaxHeight = Math.max(1, cardMaxHeight - 330 * pickerScale);
  const bodyHeight = Math.min(bodyMaxHeight, 146 * pickerScale);
  return {
    overlayTop, overlayBottom,
    pickerScale, cardMaxHeight, bodyMaxHeight, bodyHeight,
    cardHeight: Math.ceil(330 * pickerScale + bodyHeight)
  };
}

module.exports = { windowMetrics, navigationMetrics, pickerMetrics };
