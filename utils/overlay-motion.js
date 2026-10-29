// Keep only the painted surface alive during exit. Logical state and native
// back history close immediately, so animation never delays the user's action.
const EXIT_MS = 140;
function present(host, key, open, patch, done) {
  const timers = host.overlayMotionTimers || (host.overlayMotionTimers = {});
  clearTimeout(timers[key]);
  delete timers[key];
  if (!open && !host.data[key + 'Mounted']) {
    host.setData(Object.assign({}, patch, { [key]: false, [key + 'Mounted']: false, [key + 'Leaving']: false }), done);
    return;
  }
  host.setData(Object.assign({}, patch, {
    [key]: open, [key + 'Mounted']: true, [key + 'Leaving']: !open
  }), done);
  if (!open) timers[key] = setTimeout(() => {
    delete timers[key];
    host.setData({ [key + 'Mounted']: false, [key + 'Leaving']: false });
  }, EXIT_MS);
}
function dispose(host) {
  Object.values(host.overlayMotionTimers || {}).forEach(clearTimeout);
  host.overlayMotionTimers = {};
}
module.exports = { present, dispose, EXIT_MS };
