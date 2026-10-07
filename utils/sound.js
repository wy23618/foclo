let audio;
let selection = '静音';
let level = 0.5;

function context() {
  if (!audio) {
    audio = wx.createInnerAudioContext();
    audio.obeyMuteSwitch = true;
    audio.onError(() => wx.showToast({ title: '声音播放失败，请切换静音', icon: 'none' }));
  }
  return audio;
}
function stop() { if (audio) audio.stop(); }
function setVolume(volume) {
  if (Number.isFinite(volume)) level = Math.max(0, Math.min(1, volume));
  if (audio) audio.volume = level;
}
function play(name, volume) {
  selection = name;
  if (Number.isFinite(volume)) level = Math.max(0, Math.min(1, volume));
  stop();
  if (name === '静音') return;
  try {
    const player = context();
    player.loop = true;
    player.volume = level;
    const files = { '林间细雨': 'rain', '风声': 'wind', '流水': 'water', '白噪音': 'white' };
    player.src = '/assets/sounds/' + files[name] + '.wav';
    player.play();
  } catch (e) { wx.showToast({ title: '当前环境不支持音频播放', icon: 'none' }); }
}
function playCompletion(volume) {
  if (Number.isFinite(volume)) level = Math.max(0, Math.min(1, volume));
  try {
    const player = context();
    player.stop();
    player.loop = false;
    player.volume = level;
    player.src = '/assets/sounds/completion.wav';
    player.play();
    return true;
  } catch (e) { return false; }
}
function resume() { play(selection); }
module.exports = { play, playCompletion, stop, resume, setVolume };
