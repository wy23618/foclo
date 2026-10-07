// pages/manage/manage.js
const { uuid } = require('../../core/ids.js');
const { applyPageTheme, themeColors } = require('../../utils/theme');
const { colorOf, defaultColorOf, PALETTE } = require('../../utils/color.js');
const FIRST_COLORS = [PALETTE[0], PALETTE[16], PALETTE[5], PALETTE[18], PALETTE[2], PALETTE[7], PALETTE[3], PALETTE[9], PALETTE[4], PALETTE[1], PALETTE[6], PALETTE[10]];
const COLOR_CHOICES = FIRST_COLORS.concat(PALETTE.filter(color => !FIRST_COLORS.includes(color)));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rgbHex = (r, g, b) => '#' + [r, g, b].map(value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
function rgbOf(hex) { const value = String(hex || '').replace('#', ''); return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) || 0); }
function hsvOf(r, g, b) {
  const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
  let hue = 0;
  if (delta) {
    if (high === r) hue = ((g - b) / delta) % 6;
    else if (high === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation: high ? delta / high : 0, brightness: high / 255 };
}
function rgbFromHsv(hue, saturation, brightness) {
  const chroma = brightness * saturation, segment = hue / 60, second = chroma * (1 - Math.abs(segment % 2 - 1)), offset = brightness - chroma;
  const rgb = segment < 1 ? [chroma, second, 0] : segment < 2 ? [second, chroma, 0] : segment < 3 ? [0, chroma, second] : segment < 4 ? [0, second, chroma] : segment < 5 ? [second, 0, chroma] : [chroma, 0, second];
  return rgb.map(value => Math.round((value + offset) * 255));
}
function mixerState(hex) {
  const [red, green, blue] = rgbOf(hex), { hue, saturation, brightness } = hsvOf(red, green, blue);
  return { mixRed:red, mixGreen:green, mixBlue:blue, mixHue:hue, mixSaturation:saturation, mixBrightness:brightness, mixX:Math.round(saturation * 100), mixY:Math.round((1 - brightness) * 100), mixHueX:Math.round(hue / 360 * 100), mixHueColor:rgbHex(...rgbFromHsv(hue, 1, 1)) };
}

const app = getApp();

Page({
  data: {
    appearanceProjectId: '', appearanceName: '', appearanceColor: '', appearanceShortName: '', appearanceHexInput: '', appearanceHexError: '', appearanceDefaultColor: '', appearancePreviewColor: '', appearancePaletteExpanded: false, appearanceMixerOpen: false,
    mixRed: 66, mixGreen: 91, mixBlue: 66, mixHue: 120, mixSaturation: 0.27, mixBrightness: 0.36, mixX: 27, mixY: 64, mixHueX: 33, mixHueColor: '#00FF00',
    visiblePalette: FIRST_COLORS, loading: true, mixerTrack: themeColors('light').mixerTrack
  },
  onLoad(q) { this.projectId = decodeURIComponent((q && q.id) || ''); this.load(); },
  onShow() { applyPageTheme(this).then(() => this.setData({ mixerTrack: themeColors(this.data.themeClass).mixerTrack })); },
  async load() {
    await app.globalData.readyPromise;
    const env = await app.globalData.service.getManageData();
    if (!env.ok) { this.setData({ loading: false }); wx.showToast({ title: env.error.message, icon: 'none' }); return; }
    const row = env.data.active.concat(env.data.archived).find(item => item.projectId === this.projectId);
    if (!row) { this.setData({ loading: false }); wx.showToast({ title: '项目已不存在', icon: 'none' }); return; }
    this.openAppearance(Object.assign({}, row, { displayColor: row.color || colorOf(row.projectId) }));
    this.setData({ loading: false });
  },
  openAppearance(row) {
    const appearanceDefaultColor = row.color ? defaultColorOf(row.projectId) : row.displayColor;
    const appearanceColor = row.color || '';
    const appearancePaletteExpanded = !!appearanceColor && !FIRST_COLORS.includes(appearanceColor);
    const preview = appearanceColor || appearanceDefaultColor;
    this.setData(Object.assign({ appearanceProjectId: row.projectId, appearanceName: row.name, appearanceColor, appearanceShortName: row.shortName || '', appearanceHexInput: appearanceColor, appearanceHexError: '', appearanceDefaultColor, appearancePreviewColor: preview, appearancePaletteExpanded, appearanceMixerOpen: false, visiblePalette: appearancePaletteExpanded ? COLOR_CHOICES : FIRST_COLORS }, mixerState(preview)));
  },
  closeAppearance() { wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/manage/manage' }) }); },
  applyAppearanceColor(appearanceColor, appearanceHexInput = appearanceColor, mixerOverrides = {}) {
    const appearancePreviewColor = appearanceColor || this.data.appearanceDefaultColor;
    this.setData(Object.assign({ appearanceColor, appearanceHexInput, appearanceHexError: '', appearancePreviewColor }, mixerState(appearancePreviewColor), mixerOverrides));
  },
  chooseAppearanceColor(e) { this.applyAppearanceColor(e.currentTarget.dataset.color || ''); },
  chooseAppearanceDefault() { this.applyAppearanceColor(''); },
  inputAppearanceHex(e) {
    const appearanceHexInput = String(e.detail.value || '').trim();
    const digits = appearanceHexInput.replace(/^#/, '');
    if (!appearanceHexInput) { this.chooseAppearanceDefault(); return; }
    if (/^[0-9a-fA-F]{6}$/.test(digits)) { this.applyAppearanceColor('#' + digits.toUpperCase(), appearanceHexInput); return; }
    this.setData({ appearanceHexInput, appearanceHexError: digits.length >= 6 ? '请输入 6 位有效色码' : '' });
  },
  toggleAppearanceMixer() { this.setData({ appearanceMixerOpen: !this.data.appearanceMixerOpen }); },
  changeRGB(e) {
    const channel = e.currentTarget.dataset.channel, value = clamp(Math.round(Number(e.detail.value) || 0), 0, 255);
    const red = channel === 'red' ? value : this.data.mixRed;
    const green = channel === 'green' ? value : this.data.mixGreen;
    const blue = channel === 'blue' ? value : this.data.mixBlue;
    this.applyAppearanceColor(rgbHex(red, green, blue));
  },
  startMixSquare(e) {
    this.createSelectorQuery().select('.appearance-color-square').boundingClientRect(rect => {
      if (!rect) return;
      this.mixSquareRect = rect;
      this.moveMixSquare(e);
    }).exec();
  },
  moveMixSquare(e) {
    const rect = this.mixSquareRect, touch = e.touches && e.touches[0];
    if (!rect || !touch) return;
    const saturation = clamp((touch.clientX - rect.left) / rect.width, 0, 1);
    const brightness = 1 - clamp((touch.clientY - rect.top) / rect.height, 0, 1);
    const color = rgbHex(...rgbFromHsv(this.data.mixHue, saturation, brightness));
    this.applyAppearanceColor(color, color, { mixHue:this.data.mixHue, mixHueX:this.data.mixHueX, mixHueColor:this.data.mixHueColor, mixSaturation:saturation, mixBrightness:brightness, mixX:Math.round(saturation * 100), mixY:Math.round((1 - brightness) * 100) });
  },
  endMixSquare() { this.mixSquareRect = null; },
  startMixHue(e) {
    this.createSelectorQuery().select('.appearance-hue-track').boundingClientRect(rect => {
      if (!rect) return;
      this.mixHueRect = rect;
      this.moveMixHue(e);
    }).exec();
  },
  moveMixHue(e) {
    const rect = this.mixHueRect, touch = e.touches && e.touches[0];
    if (!rect || !touch) return;
    const hueX = clamp((touch.clientX - rect.left) / rect.width, 0, 1);
    const hue = hueX * 359.99;
    const color = rgbHex(...rgbFromHsv(hue, this.data.mixSaturation, this.data.mixBrightness));
    this.applyAppearanceColor(color, color, { mixHue:hue, mixHueX:Math.round(hueX * 100), mixHueColor:rgbHex(...rgbFromHsv(hue, 1, 1)), mixSaturation:this.data.mixSaturation, mixBrightness:this.data.mixBrightness, mixX:this.data.mixX, mixY:this.data.mixY });
  },
  endMixHue() { this.mixHueRect = null; },
  toggleAppearancePalette() { const appearancePaletteExpanded = !this.data.appearancePaletteExpanded; this.setData({ appearancePaletteExpanded, visiblePalette: appearancePaletteExpanded ? COLOR_CHOICES : FIRST_COLORS }); },
  inputAppearanceShortName(e) { this.setData({ appearanceShortName: e.detail.value }); },
  async saveAppearance() {
    if (this.appearanceSaving) return;
    const hex = String(this.data.appearanceHexInput || '').trim().replace(/^#/, '');
    if (hex && !/^[0-9a-fA-F]{6}$/.test(hex)) { this.setData({ appearanceHexError: '请输入 6 位有效色码' }); return; }
    this.appearanceSaving = true;
    const env = await app.globalData.service.setProjectAppearance({ operationId: uuid(), projectId: this.data.appearanceProjectId, color: this.data.appearanceColor || null, shortName: this.data.appearanceShortName });
    this.appearanceSaving = false;
    if (!env.ok) { wx.showToast({ title: env.error.message, icon: 'none' }); return; }
    this.closeAppearance();
  },

});
