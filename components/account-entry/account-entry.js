Component({
  options: { styleIsolation:'apply-shared' },
  properties: { theme:{ type:String, value:'light' } },
  data: { opened:false, agreementAccepted:false },
  lifetimes: { detached() { if (this.resolveChoice) this.resolveChoice(false); } },
  methods: {
    request() {
      if (this.resolveChoice) return Promise.reject(new Error('请先完成当前登录选择'));
      return new Promise(resolve => {
        this.resolveChoice = resolve;
        this.setData({ opened:true, agreementAccepted:false });
        this.triggerEvent('visibilitychange', { opened:true });
      });
    },
    toggleAgreement() { this.setData({ agreementAccepted:!this.data.agreementAccepted }); },
    login() {
      if (!this.data.agreementAccepted) {
        wx.showToast({ title:'请先勾选并同意相关协议', icon:'none' });
        return;
      }
      this.finish(true);
    },
    experience() { this.finish(false); },
    openPrivacy() { wx.navigateTo({ url:'/pages/privacy/privacy' }); },
    openTerms() { wx.navigateTo({ url:'/pages/terms/terms' }); },
    finish(value) {
      const resolve = this.resolveChoice;
      this.resolveChoice = null;
      this.setData({ opened:false });
      this.triggerEvent('visibilitychange', { opened:false });
      if (resolve) resolve(value);
    },
    noop() {}
  }
});
