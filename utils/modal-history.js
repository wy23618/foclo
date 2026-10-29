// A native back gesture already removed the page-container layer. If a save is
// still in progress, re-arm just that layer while leaving its visible UI intact.
function restoreLayer(host, key, stillOpen) {
  const rearming = host.modalHistoryRearming || (host.modalHistoryRearming = {});
  rearming[key] = true;
  host.setData({ [key]: false }, () => {
    const restore = () => { if (stillOpen()) host.setData({ [key]: true }); else rearming[key] = false; };
    if (typeof wx !== 'undefined' && wx.nextTick) wx.nextTick(restore);
    else setTimeout(restore, 0);
  });
}
function layerEntered(host, key) { if (host.data[key] && host.modalHistoryRearming) host.modalHistoryRearming[key] = false; }
function isRearming(host, key) { return !!(host.modalHistoryRearming && host.modalHistoryRearming[key]); }

function dismissStatsLayer(page) {
  if (page.data.recordEditorOpen) {
    const detail = page.selectComponent && page.selectComponent('#dayDetail');
    if (detail && detail.dismissEditor) detail.dismissEditor();
    return true;
  }
  if (page.data.rangeOpen) { page.closeRange(); return true; }
  if (page.data.scopeOpen) {
    const picker = page.selectComponent && page.selectComponent('#subjectPicker');
    if (picker && picker.close) picker.close(); else page.closeSubjects();
    return true;
  }
  if (page.data.heatmapOpen) {
    const heatmap = page.selectComponent && page.selectComponent('#heatmapCard');
    if (heatmap && heatmap.close) heatmap.close(); else page.closeHeatmap();
    return true;
  }
  return false;
}

function recordEditorChanged(page, event) {
  const open = !!event.detail.open;
  if (open) page.pageOverlayKind = 'records';
  page.setData({ recordEditorOpen: open });
}

function beforeStatsLeave(page) {
  if (isRearming(page, 'overlayHistoryEnabled')) return;
  page.overlayLeaving = page.data.recordEditorOpen ? 'records' : page.data.rangeOpen ? 'range' : page.pageOverlayKind;
  if (page.overlayLeaving === 'subjects') {
    const picker = page.selectComponent('#subjectPicker');
    if (picker && picker.onBeforeLeave) picker.onBeforeLeave();
  }
}

function afterStatsLeave(page) {
  if (isRearming(page, 'overlayHistoryEnabled')) return;
  const kind = page.overlayLeaving || page.pageOverlayKind;
  page.overlayLeaving = '';
  if (kind === 'heatmap') {
    const card = page.selectComponent && page.selectComponent('#heatmapCard');
    if (card && card.data.scopePickerOpen) {
      card.closeScopePicker();
      restoreLayer(page, 'overlayHistoryEnabled', () => page.data.heatmapOpen);
      return;
    }
    require('./heatmap-modal').afterHeatmapLeave.call(page);
  } else if (kind === 'subjects') {
    if (page.data.scopeOpen) page.setData({ scopeOpen: false });
    const picker = page.selectComponent('#subjectPicker');
    if (picker && picker.onAfterLeave) picker.onAfterLeave();
  } else if (kind === 'range') page.closeRange();
  else if (kind === 'records') {
    dismissStatsLayer(page);
    if (page.data.recordEditorOpen) {
      restoreLayer(page, 'overlayHistoryEnabled', () => page.data.recordEditorOpen);
      return;
    }
  }
  page.pageOverlayKind = '';
}

module.exports = { restoreLayer, layerEntered, isRearming, dismissStatsLayer, recordEditorChanged, beforeStatsLeave, afterStatsLeave };
