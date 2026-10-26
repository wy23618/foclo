// Share the public entry rather than a user's current project or account state.
function withShare(definition) {
  return Object.assign({}, definition, {
    onShareAppMessage() {
      return { title:'Foclo · 把专注留给自己', path:'/pages/focus/focus', imageUrl:'/assets/share/foclo-cover.jpg' };
    }
  });
}
module.exports = { withShare };
