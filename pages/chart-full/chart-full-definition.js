// Shared by the normal page and its isolated guide demonstration.
module.exports = function createPage(app, runtime) {
  runtime = runtime || {};
  const navigation = runtime.platform || {
    navigateTo: options => wx.navigateTo(options),
    redirectTo: options => wx.redirectTo(options),
    reLaunch: options => wx.reLaunch(options)
  };
const { themeColors } = require('../../utils/theme');
const definition = {
  data:{groups:[],segments:[],tree:[],totalText:'—',centerLabel:'',singleExpand:false,theme:'light'},
  onLoad(){
    const payload=app.globalData.fullChartPayload;
    if(!payload){wx.navigateBack({delta:1,fail:()=>navigation.reLaunch({url:'/pages/stats/stats'})});return;}
    this.setData(Object.assign({}, payload, require('../../utils/theme').pageThemeData(payload.theme, 'fullBackground')));
    // Custom navigation still has native status-bar text; match the full canvas.
    const colors = themeColors(payload.theme);
    try { wx.setNavigationBarColor({ frontColor: colors.navigationFront.toLowerCase(), backgroundColor: colors.fullBackground }); } catch (e) {}
  },
  onReady(){
    const chart=this.selectComponent('#fullChart');
    if(chart)chart.openFullView();
  },
  onUnload(){app.globalData.fullChartPayload=null;}
};

  definition.data.demoSession = '';
  const load = definition.onLoad;
  definition.onLoad = function(options) {
    this.runtimeApp = app;
    if (load) return load.call(this, options || {});
  };
  return definition;
};
