const LAN_DEBUG_API_HOST = "192.168.199.9";

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

module.exports = {
  LAN_DEBUG_API_HOST,
  getMiniProgramEnvironment,
  isDevToolsDevelopment,
  isPhoneDevelopment,
};
