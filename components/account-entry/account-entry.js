Component({
  options: { styleIsolation:'apply-shared' },
  properties: { theme:{ type:String, value:'light' } },
  data: { opened:false },
  lifetimes: { detached() { if (this.resolveChoice) this.resolveChoice(false); } },
  methods: {
    request() {
      if (this.resolveChoice) return Promise.reject(new Error('请先完成当前登录选择'));
      return new Promise(resolve => {
        this.resolveChoice = resolve;
        this.setData({ opened:true });
        this.triggerEvent('visibilitychange', { opened:true });
      });
    },
    login() { this.finish(true); },
    experience() { this.finish(false); },
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
