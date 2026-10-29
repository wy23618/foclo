async function refreshRecords(page,app,reload) {
  if(page.data.syncRefreshing)return;
  page.setData({syncRefreshing:true});
  try {
    await app.globalData.readyPromise;
    // Guide scenes share these handlers but must never touch a real account.
    const demo=!!(page.demoSession||page.data.demoSession);
    const result=demo?{demo:true}:await app.globalData.accounts.refreshRecords();
    const loaded=await reload();
    if(loaded===false||loaded?.ok===false||page.data.error)throw new Error(page.data.error||loaded?.error?.message||'页面记录尚未更新，请重试。本机记录仍保留。');
    const detail=page.selectComponent&&page.selectComponent('#dayDetail');
    if(detail&&detail.load){await detail.load(false);if(detail.data&&detail.data.error)throw new Error(detail.data.error);}
    wx.showToast({title:result.demo?'已刷新示例记录':result.localOnly?'已刷新本机记录':'已刷新账号记录',icon:'success'});
  } catch(error) {
    wx.showModal({title:'记录尚未刷新',content:error.message||'请检查网络后重试。本机记录仍保留。',showCancel:false});
  } finally {page.setData({syncRefreshing:false});if(wx.stopPullDownRefresh)wx.stopPullDownRefresh();}
}
module.exports={refreshRecords};
