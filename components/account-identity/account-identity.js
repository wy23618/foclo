Component({
  options:{ styleIsolation:'apply-shared' },
  properties:{ theme:{ type:String, value:'light' } },
  data:{ opened:false, avatarUrl:'', nickname:'', canConfirm:false, editing:false },
  lifetimes:{ detached() { if (this.resolveIdentity) this.resolveIdentity(null); } },
  methods:{
    request(profile, options = {}) {
      if (this.resolveIdentity) return Promise.reject(new Error('请先完成当前账号确认'));
      this.setData({ opened:true, editing:!!options.editing, avatarUrl:profile && profile.avatarUrl || '', nickname:profile && profile.nickname || '',
        canConfirm:!!(profile && profile.avatarUrl && profile.nickname) });
      this.triggerEvent('visibilitychange', { opened:true });
      return new Promise(resolve => { this.resolveIdentity = resolve; });
    },
    onChooseAvatar(e) {
      const avatarUrl = e.detail.avatarUrl;
      if (avatarUrl) this.setData({ avatarUrl, canConfirm:!!this.data.nickname.trim() });
    },
    onNickname(e) {
      const nickname = String(e.detail.value || '').trim();
      this.setData({ nickname, canConfirm:!!(nickname && this.data.avatarUrl) });
    },
    confirm() {
      if (!this.data.canConfirm) return;
      this.finish({ nickname:this.data.nickname, avatarUrl:this.data.avatarUrl });
    },
    cancel() { this.finish(null); },
    finish(value) {
      const resolve = this.resolveIdentity;
      this.resolveIdentity = null;
      this.setData({ opened:false });
      this.triggerEvent('visibilitychange', { opened:false });
      if (resolve) resolve(value);
    },
    noop() {}
  }
});
