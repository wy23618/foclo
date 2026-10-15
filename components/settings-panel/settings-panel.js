const { resolveTheme } = require('../../utils/theme');
const { buildSettingsGroups } = require('../../utils/settings-summary');

Component({
  options:{styleIsolation:'apply-shared'},
  properties:{opened:{type:Boolean,value:false,observer:'onOpenedChange'},theme:{type:String,value:'light',observer:'onThemeChange'}},
  data:{activated:false,groups:buildSettingsGroups(null),themeClass:'light'},
  lifetimes:{attached(){this.isAttached=true;this.setData({themeClass:this.properties.theme});if(this.properties.opened)this.activate();}},
  pageLifetimes:{show(){if(this.properties.opened&&this.wasPageHidden)this.activate();this.wasPageHidden=false;},hide(){this.wasPageHidden=true;}},
  methods:{
    onThemeChange(theme){if(this.isAttached&&theme)this.setData({themeClass:theme});},
    onOpenedChange(opened){if(opened&&this.isAttached)this.activate();},
    async activate(){
      if(!this.data.activated)this.setData({activated:true});
      const app=getApp();
      if(!app.globalData.ready)await app.globalData.readyPromise;
      const prefs=await app.globalData.service.getPrefs();
      const themeClass=resolveTheme(prefs&&prefs.theme||'system',prefs&&prefs.lightTheme),groups=buildSettingsGroups(prefs),patch={};
      if(themeClass!==this.data.themeClass)patch.themeClass=themeClass;
      if(JSON.stringify(groups)!==JSON.stringify(this.data.groups))patch.groups=groups;
      if(Object.keys(patch).length)this.setData(patch);
    },
    openSection(e){
      const key=e.currentTarget.dataset.key;
      if(!this.data.groups.some(group=>group.items.some(item=>item.key===key)))return;
      if(key==='guide'){wx.navigateTo({url:'/pages/guide/guide'});return;}
      if(key==='projects'){wx.navigateTo({url:'/pages/manage/manage'});return;}
      if(key==='account'){wx.navigateTo({url:'/pages/account/account'});return;}
      if(key==='privacy'){wx.navigateTo({url:'/pages/privacy/privacy'});return;}
      wx.navigateTo({url:'/pages/settings-detail/settings-detail?section='+key});
    },
    goFocus(){this.triggerEvent('switchtab',{tab:0});}
  }
});
