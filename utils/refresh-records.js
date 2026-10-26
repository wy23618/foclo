async function refreshRecords(page,app,reload) {
  if(page.data.syncRefreshing)return;
  page.setData({syncRefreshing:true});
  try {
    await app.globalData.readyPromise;
    const result=await app.globalData.accounts.refreshRecords();
    await reload();
    wx.showToast({title:result.localOnly?'已刷新本机记录':'已刷新账号记录',icon:'success'});
  } catch(error) {
    wx.showModal({title:'记录尚未刷新',content:error.message||'请检查网络后重试。本机记录仍保留。',showCancel:false});
  } finally {page.setData({syncRefreshing:false});if(wx.stopPullDownRefresh)wx.stopPullDownRefresh();}
}
module.exports={refreshRecords};
