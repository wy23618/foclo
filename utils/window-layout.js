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

// Match themes/tablet.wxss. Use the screen so opening the keyboard doesn't
// switch a tablet back to oversized native rpx. Narrow split views use phone UI.
function responsiveMetrics(info) {
  const frame = windowMetrics(info);
  const screenWidth = Number(info && info.screenWidth) || frame.width;
  const screenHeight = Number(info && info.screenHeight) || frame.height;
  const tablet = frame.width >= 500 && Math.min(screenWidth, screenHeight) >= 520;
  return {
    tablet,
    unit: tablet ? .6 : frame.width / 750,
    bottomNavHeight: tablet ? 64 : frame.width * 92 / 750
  };
}

// Match themes/landscape.wxss. A short phone landscape window never qualifies.
function isTabletLandscape(info, orientation) {
  const frame = windowMetrics(info);
  const screenWidth = Number(info && info.screenWidth) || frame.width;
  const screenHeight = Number(info && info.screenHeight) || frame.height;
  const landscape = orientation ? orientation === 'landscape' : screenWidth > screenHeight || frame.width > screenWidth + 1;
  return responsiveMetrics(info).tablet && frame.width >= 680 && frame.width > frame.height && landscape;
}

// Keep geometry updates separate from timer/data lifecycles. Physical screen
// orientation prevents a portrait keyboard from opening the landscape workspace.
function withLandscapeLayout(definition) {
  definition.data.landscapeLayout = false;
  ['onLoad', 'onShow', 'onResize'].forEach(name => {
    const original = definition[name];
    definition[name] = function(...args) {
      if (name !== 'onResize') this.landscapeDeviceOrientation = undefined;
      if (name === 'onResize' && args[0] && /^(portrait|landscape)$/.test(args[0].deviceOrientation || '')) {
        this.landscapeDeviceOrientation = args[0].deviceOrientation;
      }
      let info;
      try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (e) {}
      if (name === 'onResize' && args[0] && args[0].size) info = Object.assign({}, info, args[0].size);
      const landscapeLayout = isTabletLandscape(info, this.landscapeDeviceOrientation);
      if (this.data.landscapeLayout !== landscapeLayout) this.setData({ landscapeLayout });
      return original && original.apply(this, args);
    };
  });
  return definition;
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
  const layout = responsiveMetrics(info);
  const overlayTop = Math.max(0, Math.min(Number(topInset) || 0, frame.height - 100));
  const reserveBottom = reserveBottomNav && !isTabletLandscape(info);
  const overlayBottom = frame.safeBottom + (reserveBottom ? (layout.tablet ? layout.bottomNavHeight : frame.width * 108 / 750) : 0);
  const available = Math.max(1, frame.height - overlayTop - overlayBottom - 32);
  const pickerScale = layout.tablet ? layout.unit : Math.min(frame.width, 450) / 750;
  const cardMaxHeight = Math.max(1, Math.floor(Math.min(720, frame.height * .78, available)));
  const bodyMaxHeight = Math.max(1, cardMaxHeight - 330 * pickerScale);
  const bodyHeight = Math.min(bodyMaxHeight, 146 * pickerScale);
  return {
    overlayTop, overlayBottom,
    pickerScale, cardMaxHeight, bodyMaxHeight, bodyHeight,
    cardHeight: Math.ceil(330 * pickerScale + bodyHeight)
  };
}

module.exports = { windowMetrics, responsiveMetrics, isTabletLandscape, withLandscapeLayout, navigationMetrics, pickerMetrics };
