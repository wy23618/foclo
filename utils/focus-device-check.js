async function confirmOtherFocus(accounts) {
  if(!accounts?.getCurrent())return true;
  const result=await accounts.checkOtherFocus();
  if(result.available&&!result.otherDevices.length)return true;
  const reasons={auth:'当前登录已失效，无法查询同一账号的其他设备。请重新登录后再检查；也可以先在本机计时，记录会留在这台设备。',network:'本次没有连接到服务器，无法检查其他设备。可以继续本机计时，联网后再上传。',service:'计时状态查询暂不可用，无法检查其他设备。可以继续本机计时，稍后再同步。'};
  return new Promise((resolve,reject)=>wx.showModal({
    title:result.available?'另一设备有未结束的计时':result.reason==='auth'?'重新登录后才能检查':'本次未能检查其他设备',
    content:result.available?'同一账号的另一台设备在最近两分钟内上报了未结束的计时。它此刻可能已经离线。建议先在原设备确认并结束，再在这里开始。继续后两台设备会分别记录，时间可能重叠；这里不会替你停止原设备。':(reasons[result.reason]||reasons.service)+' 本次无法保证与其他设备没有时间重叠。',
    confirmText:'继续计时',cancelText:'先不开始',success:r=>resolve(!!r.confirm),fail:reject,
  }));
}
module.exports={confirmOtherFocus};
