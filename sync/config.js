// The loopback endpoint is enabled only inside the WeChat DevTools simulator.
// It is never selected by preview devices or uploaded mini-program versions.
// Production HTTPS endpoints belong here after a server is publicly configured.
const {
  isDevToolsDevelopment,
  isPhoneDevelopment,
  LAN_DEBUG_API_HOST,
} = require("./environment");

const apiBaseUrl = isDevToolsDevelopment()
  ? "http://127.0.0.1:3000/api/v1"
  : isPhoneDevelopment()
    ? "http://" + LAN_DEBUG_API_HOST + ":3000/api/v1"
    : "";

module.exports = {
  apiBaseUrl,
};
