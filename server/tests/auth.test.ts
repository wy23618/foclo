import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptReplayResponse,
  encryptReplayResponse,
  exchangeWechatCode,
  hashOpaqueToken,
  type AuthTokens,
} from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const secrets = {
  TOKEN_PEPPER: "t".repeat(48),
  CURSOR_SECRET: "c".repeat(48),
};

test("config rejects disabled production TLS and repeated credentials", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://app:pw@db/yotick",
    MIGRATION_DATABASE_URL: "postgres://migrator:pw@db/yotick",
    WECHAT_APP_ID: "wx-id",
    WECHAT_APP_SECRET: "wx-secret",
    ...secrets,
  };
  assert.throws(
    () => loadConfig({ ...base, DATABASE_SSL: "false" }),
    /cannot be disabled/,
  );
  assert.throws(
    () => loadConfig({ ...base, CURSOR_SECRET: secrets.TOKEN_PEPPER }),
    /must be different/,
  );
  const config = loadConfig(base);
  assert.equal(config.databaseSsl, true);
  assert.equal(config.accessTokenTtlSeconds, 900);
  assert.throws(()=>loadConfig({...base,DATABASE_URL:base.DATABASE_URL+'?sslmode=no-verify'}),/TLS through/);
});

test("opaque token hashes are deterministic and keyed", () => {
  const a = hashOpaqueToken("opaque-token", secrets.TOKEN_PEPPER);
  assert.deepEqual(a, hashOpaqueToken("opaque-token", secrets.TOKEN_PEPPER));
  assert.notDeepEqual(
    a,
    hashOpaqueToken("opaque-token", "different".repeat(5)),
  );
});

test("refresh replay payload is authenticated encryption", () => {
  const value: AuthTokens = {
    accessToken: "a".repeat(43),
    refreshToken: "r".repeat(43),
    tokenType: "Bearer",
    expiresIn: 900,
    refreshExpiresIn: 2592000,
    account: { userId: "user", spaceId: "space", generation: "1" },
  };
  const sealed = encryptReplayResponse(value, secrets.TOKEN_PEPPER);
  assert.deepEqual(
    decryptReplayResponse(
      sealed.ciphertext,
      sealed.nonce,
      sealed.tag,
      secrets.TOKEN_PEPPER,
    ),
    value,
  );
  assert.throws(() =>
    decryptReplayResponse(
      sealed.ciphertext,
      sealed.nonce,
      Buffer.alloc(16),
      secrets.TOKEN_PEPPER,
    ),
  );
});

test("WeChat exchange uses the fixed HTTPS endpoint and rejects invalid identity payloads", async () => {
  let requested: URL | undefined;
  const openid = await exchangeWechatCode(
    "once-code",
    "app-id",
    "app-secret",
    async (input) => {
      requested = new URL(input.toString());
      return new Response(JSON.stringify({ openid: "valid-subject" }), {
        status: 200,
      });
    },
  );
  assert.equal(openid, "valid-subject");
  assert.equal(requested?.protocol, "https:");
  assert.equal(requested?.hostname, "api.weixin.qq.com");
  assert.equal(requested?.searchParams.get("js_code"), "once-code");
  await assert.rejects(
    exchangeWechatCode(
      "code",
      "app-id",
      "app-secret",
      async () =>
        new Response(JSON.stringify({ openid: "x", errcode: 40029 }), {
          status: 200,
        }),
    ),
    { code: "AUTH_REQUIRED" },
  );
});
