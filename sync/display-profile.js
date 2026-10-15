const { uuid } = require('../core/ids');
function normalizeProfile(value) {
  const nickname = String(value && value.nickname || '').trim();
  const avatarUrl = String(value && value.avatarUrl || '');
  if (!nickname || nickname.length > 32) throw new Error('请填写 1～32 字的昵称');
  if (!avatarUrl || avatarUrl.length > 1024 || !/^(?:wxfile:\/\/|https?:\/\/|[A-Za-z]:[\\/]|\/)/.test(avatarUrl))
    throw new Error('请通过微信选择头像');
  return { nickname, avatarUrl };
}
async function keepAvatar(path, api = typeof wx === 'undefined' ? null : wx) {
  if (!api || !api.getFileSystemManager || !api.env || !api.env.USER_DATA_PATH)
    throw new Error('当前环境无法保存头像，请更新微信后重试');
  const fs = api.getFileSystemManager();
  const info = await new Promise((resolve, reject) => fs.getFileInfo({ filePath:path, success:resolve, fail:reject }));
  if (!info.size || info.size > 512 * 1024) throw new Error('头像大小需在 512 KB 以内，请重新选择');
  const target = api.env.USER_DATA_PATH + '/yotick-avatar-' + uuid() + '.jpg';
  await new Promise((resolve, reject) => fs.copyFile({ srcPath:path, destPath:target, success:resolve, fail:reject }));
  return target;
}
async function discardAvatar(path, api = typeof wx === 'undefined' ? null : wx) {
  if (!api || !api.getFileSystemManager || !api.env) return;
  const prefix = api.env.USER_DATA_PATH + '/yotick-avatar-';
  if (!path || !path.startsWith(prefix) || !/^[a-f0-9-]+\.jpg$/.test(path.slice(prefix.length))) return;
  await new Promise(resolve => api.getFileSystemManager().unlink({ filePath:path, success:resolve, fail:resolve }));
}
module.exports = { normalizeProfile, keepAvatar, discardAvatar };
