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
    const summary = await accounts.getGuestSummary();
    if (!summary.hasData || (!explicit && !summary.shouldAsk)) return { imported: false };
    if (!(await confirmImport(summary))) {
      await accounts.deferGuestImport(summary.signature);
      return { imported: false, deferred: true };
    }
    await accounts.migrateGuest();
    const result = await accounts.commitGuestMigration({}, {}, { automatic:true });
    return { imported:true, result };
  } catch (error) {
    error.loggedIn = true;
    throw error;
  }
}
function confirmGuestImport(summary) {
  return new Promise((resolve, reject) => wx.showModal({
    title: "保存之前的记录？",
    content: "有 " + (summary.sessionCount ? summary.sessionCount + " 条专注记录" : summary.projectCount + " 个项目") +
      "尚未保存到账号，要一起保存吗？",
    confirmText: "一起保存",
    cancelText: "暂不保存",
    success: (result) => resolve(!!result.confirm),
    fail: (error) => reject(Object.assign(
      new Error('迁移确认提示暂时无法打开，请稍后再试'),
      { code:'IMPORT_CONFIRM_FAILED', errMsg:error && error.errMsg },
    )),
  }));
}
module.exports = { loginAndImport, importGuestWithConfirmation, confirmGuestImport };
