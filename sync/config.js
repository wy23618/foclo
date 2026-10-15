// DevTools and phones share the same account server by default.
// Trial connectivity requires phone debugging and real-device acceptance.
// Release selects no endpoint until a production domain is configured.
const {
  isDevToolsDevelopment,
  isPhoneCloudTesting,
  TEMP_CLOUD_DEBUG_API_HOST,
} = require("./environment");

const apiBaseUrl = isDevToolsDevelopment() || isPhoneCloudTesting()
    ? "https://" + TEMP_CLOUD_DEBUG_API_HOST + "/api/v1"
    : "";

module.exports = {
  apiBaseUrl,
};
