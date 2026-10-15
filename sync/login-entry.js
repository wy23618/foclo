// Reuse an existing account offline; never interrupt a local focus/rest timer.
function entryAction({ account, status, guestSession, activeTimer }) {
  if (activeTimer || guestSession) return "continue";
  if (account && status !== "auth-required") return "continue";
  return "login";
}
module.exports = { entryAction };
