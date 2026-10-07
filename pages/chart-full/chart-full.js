const { themeColors } = require('../../utils/theme');
Page({
  data:{groups:[],segments:[],tree:[],totalText:'—',centerLabel:'',singleExpand:false,theme:'light'},
  onLoad(){
    const payload=getApp().globalData.fullChartPayload;
    if(!payload){wx.navigateBack({delta:1,fail:()=>wx.reLaunch({url:'/pages/stats/stats'})});return;}
    this.setData(Object.assign({}, payload, require('../../utils/theme').pageThemeData(payload.theme, 'fullBackground')));
    // Custom navigation still has native status-bar text; match the full canvas.
    const colors = themeColors(payload.theme);
    try { wx.setNavigationBarColor({ frontColor: colors.navigationFront.toLowerCase(), backgroundColor: colors.fullBackground }); } catch (e) {}
  },
  onReady(){
    const chart=this.selectComponent('#fullChart');
    if(chart)chart.openFullView();
  },
  onUnload(){getApp().globalData.fullChartPayload=null;}
});
