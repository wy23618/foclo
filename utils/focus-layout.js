const { windowMetrics, responsiveMetrics, isTabletLandscape } = require('./window-layout');

// Reserve controls before sizing the dial. Width alone cannot size a tablet UI.
function focusLayout(info, navHeight, data, orientation) {
  const frame = windowMetrics(info);
  const tabletLayout = responsiveMetrics(info).tablet;
  if (!tabletLayout) return { tabletLayout: false, focusWideLayout: false, focusLayoutStyle: '' };
  data = data || {};
  const wide = isTabletLandscape(info, orientation);
  const nav = Number(navHeight) || 78;
  const bottom = (wide ? 0 : 64) + frame.safeBottom;
  // Short split windows need two columns even when the bottom nav is retained.
  const focusWideLayout = wide || frame.height < 700;
  const available = Math.max(200, frame.height - nav - bottom - 32);
  const height = Math.min(available, wide ? 500 : 720);
  const contentWidth = wide ? frame.width - 140 : Math.min(frame.width - 48, 720);
  const controlsWidth = focusWideLayout ? Math.max(wide ? 244 : 220, Math.min(280, contentWidth * .44)) : Math.min(contentWidth, 360);
  const idle = !data.cur || data.cur.state === 'IDLE';
  let controlsHeight = idle ? (data.mode !== 'stopwatch' ? 296 : 252) : 234;
  if (data.goalEnabled) controlsHeight += 54;
  if (data.ready && data.isGuest && !data.demoSession && !data.guestHintDismissed && idle && !data.restState && !data.restPrompt)
    controlsHeight += 70;
  if (data.cur && data.cur.clockAnomaly) controlsHeight += 90;
  const dockMax = focusWideLayout ? height : Math.max(204, height - 244);
  const dockHeight = Math.min(controlsHeight, dockMax);
  const dialWidth = focusWideLayout ? contentWidth - controlsWidth - 64 : contentWidth - 32;
  const dialHeight = focusWideLayout ? height - 76 : height - dockHeight - 96;
  const dial = Math.floor(Math.max(120, Math.min(280, dialWidth, dialHeight)));
  const workspaceHeight = Math.min(height, focusWideLayout ? Math.max(dial + 76, dockHeight) : dial + 96 + dockHeight);
  const focusLayoutStyle = [
    'min-height:0', 'height:' + Math.max(200 + bottom + 32, frame.height - nav) + 'px',
    '--focus-nav-height:' + nav + 'px', '--tablet-workspace-height:' + workspaceHeight + 'px',
    '--tablet-controls-width:' + Math.floor(controlsWidth) + 'px',
    '--tablet-dock-max:' + Math.floor(dockMax) + 'px',
    '--tablet-dial-size:' + dial + 'px', '--tablet-bottom-space:' + bottom + 'px'
  ].join(';');
  return { tabletLayout: true, focusWideLayout, focusLayoutStyle };
}

module.exports = { focusLayout };
