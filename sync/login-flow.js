// Guest history is uploaded only after the user agrees to assign it to this account.
async function loginAndImport(accounts, confirmImport, confirmLogin) {
  if (confirmLogin && !(await confirmLogin())) {
    await accounts.stayGuest();
    return { cancelled:true, imported:false };
  }
  await accounts.login();
  return importGuestWithConfirmation(accounts, confirmImport);
}
async function importGuestWithConfirmation(accounts, confirmImport, explicit = false) {
  try {
    const target = accounts.getCurrent && accounts.getCurrent();
    const checkAccount = () => {
      if (!target) return;
      const current = accounts.getCurrent();
      if (!current || current.userId !== target.userId || current.spaceId !== target.spaceId || String(current.generation) !== String(target.generation))
        throw Object.assign(new Error('账号已切换，未继续导入。请确认当前账号后重新选择'), { code:'ACCOUNT_CHANGED' });
    };
    const summary = await accounts.getGuestSummary();
    checkAccount();
    if (!summary.hasData || (!explicit && !summary.shouldAsk)) return { imported: false };
    if (!(await confirmImport(summary))) {
      checkAccount();
      await accounts.deferGuestImport(summary.signature);
      return { imported: false, deferred: true };
    }
    checkAccount();
    await accounts.migrateGuest();
    checkAccount();
    const result = await accounts.commitGuestMigration({}, {}, { automatic:true });
    return { imported:true, result };
  } catch (error) {
    error.loggedIn = true;
    throw error;
  }
}
function confirmGuestImport(summary) {
  const contents = [];
  if (summary.projectCount) contents.push(summary.projectCount + ' 个项目');
  if (summary.sessionCount) contents.push(summary.sessionCount + ' 条专注记录');
  const scope = contents.length ? contents.join('、') : '本机游客记录';
  return new Promise((resolve, reject) => wx.showModal({
    title: "把本机记录存入账号？",
    content: "来源：这台设备未登录时的 " + scope + "。\n去向：当前微信账号" +
      (summary.accountSuffix ? "（尾号 " + summary.accountSuffix + "）" : "") + "。\n" +
      "「存入账号」：合并这些记录，其他设备登录同一账号后可看到；账号已有内容和删除状态为准，游客原记录仍保留。\n" +
      "「留在本机」：不上传这些游客记录；账号原有记录仍正常同步。\n" +
      (summary.overlapSessionCount ? "其中 " + summary.overlapSessionCount + " 条与账号记录有专注时间交叠，导入后会分别计入总时长，请确认是否为独立记录。" : "") +
      "请选择这些游客记录的保存位置。",
    confirmText: "存入账号",
    cancelText: "留在本机",
    success: (result) => resolve(!!result.confirm),
    fail: (error) => reject(Object.assign(
      new Error('迁移确认提示暂时无法打开，请稍后再试'),
      { code:'IMPORT_CONFIRM_FAILED', errMsg:error && error.errMsg },
    )),
  }));
}
module.exports = { loginAndImport, importGuestWithConfirmation, confirmGuestImport };
