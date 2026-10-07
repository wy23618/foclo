const WELCOME_KEY = 'yotick/guide/welcome-v1';

function welcomeStatus(seen, meta, prefs) {
  if (seen) return 'seen';
  // A missing or malformed metadata record is not proof of a fresh install.
  if (!meta || !meta.id || !Number.isInteger(meta.dataRevision) || !Number.isInteger(meta.nextCreationOrder)) return 'unavailable';
  if (meta.activeSessionId || meta.dataRevision !== 0 || meta.nextCreationOrder !== 1 || Object.keys(prefs || {}).length) return 'existing';
  return 'new';
}

function canPresentWelcome(data) {
  return !!(data && data.ready && data.activeTab === 0 && data.cur && data.cur.state === 'IDLE' &&
    !data.cur.projectId && !data.blocked && !data.pickerOpen && !data.customOpen && !data.todayOpen &&
    !data.immersive && !data.screenLocked && !data.restState && !data.restPrompt && !data.completionVisible);
}

async function readWelcomeStatus(adapter) {
  const values = await Promise.all([adapter.get(WELCOME_KEY), adapter.get('yotick/meta'), adapter.get('yotick/prefs')]);
  return welcomeStatus(values[0], values[1], values[2]);
}

async function rememberWelcome(adapter) {
  await adapter.set(WELCOME_KEY, true);
}

module.exports = { WELCOME_KEY, welcomeStatus, canPresentWelcome, readWelcomeStatus, rememberWelcome };
