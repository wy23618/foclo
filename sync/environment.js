const LAN_DEBUG_API_HOST = "10.22.4.17";
const FOCLO_API_BASE_URL = "https://api.foclo.hellovian.com/api/v1";

function getMiniProgramEnvironment() {
  try {
    if (typeof wx === "undefined") return false;
    const account = wx.getAccountInfoSync();
    const system = wx.getSystemInfoSync();
    return {
      envVersion: account?.miniProgram?.envVersion,
      platform: system?.platform,
    };
  } catch (e) {
    return null;
  }
}

function isDevToolsDevelopment() {
  const env = getMiniProgramEnvironment();
  return env?.envVersion === "develop" && env.platform === "devtools";
}

function isPhoneDevelopment() {
  const env = getMiniProgramEnvironment();
  return (
    env?.envVersion === "develop" &&
    (env.platform === "ios" || env.platform === "android")
  );
}

function isPhoneCloudTesting() {
  const env = getMiniProgramEnvironment();
  return (
    (env?.envVersion === "develop" || env?.envVersion === "trial") &&
    (env.platform === "ios" || env.platform === "android")
  );
}

module.exports = {
  LAN_DEBUG_API_HOST,
  FOCLO_API_BASE_URL,
  getMiniProgramEnvironment,
  isDevToolsDevelopment,
  isPhoneDevelopment,
  isPhoneCloudTesting,
};
