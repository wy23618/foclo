import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { ServerConfig } from "./config.js";
import { uuid } from "./protocol.js";

export interface AuthContext {
  userId: string;
  spaceId: string;
  generation: string;
  sessionId: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshExpiresIn: number;
  account: { userId: string; spaceId: string; generation: string };
}

export class AuthFailure extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string) {
    super(code);
    this.name = "AuthFailure";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const unauthorized = () => new AuthFailure(401, "AUTH_REQUIRED");
const serviceUnavailable = () =>
  new AuthFailure(503, "IDENTITY_PROVIDER_UNAVAILABLE");

export function hashOpaqueToken(token: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(token, "utf8").digest();
}

function encryptionKey(pepper: string): Buffer {
  return createHash("sha256")
    .update("YoTick auth refresh replay v1\0")
    .update(pepper, "utf8")
    .digest();
}

export function encryptReplayResponse(
  value: AuthTokens,
  pepper: string,
): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(pepper), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

export function decryptReplayResponse(
  ciphertext: Buffer,
  nonce: Buffer,
  tag: Buffer,
  pepper: string,
): AuthTokens {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(pepper),
    nonce,
  );
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    ),
  ) as AuthTokens;
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function clientError(error: unknown): boolean {
  return error instanceof AuthFailure;
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function exchangeWechatCode(
  code: string,
  appId: string,
  appSecret: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", appId);
  url.searchParams.set("secret", appSecret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw serviceUnavailable();
  }
  if (!response.ok) throw serviceUnavailable();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw serviceUnavailable();
  }
  if (!payload || typeof payload !== "object") throw serviceUnavailable();
  const result = payload as { openid?: unknown; errcode?: unknown };
  if (
    (result.errcode !== undefined && result.errcode !== 0) ||
    typeof result.openid !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(result.openid)
  ) {
    throw unauthorized();
  }
  return result.openid;
}

function buildTokenResponse(
  config: ServerConfig,
  account: AuthTokens["account"],
): AuthTokens {
  return {
    accessToken: opaqueToken(),
    refreshToken: opaqueToken(),
    tokenType: "Bearer",
    expiresIn: config.accessTokenTtlSeconds,
    refreshExpiresIn: config.refreshTokenTtlSeconds,
    account,
  };
}

function requestUserAgent(request: FastifyRequest): string | null {
  const value = request.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 256) : null;
}

async function establishSession(
  pool: Pool,
  config: ServerConfig,
  subject: string,
  userAgent: string | null,
  deviceId: string | null,
): Promise<AuthTokens> {
  return withTransaction(pool, async (client) => {
    let identity = await client.query<{
      user_id: string;
      space_id: string;
      generation: string;
    }>(
      `SELECT i.user_id, s.id AS space_id, s.generation::text AS generation
       FROM auth_identities i JOIN spaces s ON s.user_id=i.user_id
       WHERE i.provider='wechat-mini' AND i.app_id=$1 AND i.subject=$2 AND s.user_id=i.user_id
       FOR UPDATE OF s`,
      [config.wechatAppId, subject],
    );
    if (identity.rowCount === 0) {
      const newUserId = randomUUID();
      const newSpaceId = randomUUID();
      await client.query("INSERT INTO users(id) VALUES($1)", [newUserId]);
      await client.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
        newSpaceId,
        newUserId,
      ]);
      const inserted = await client.query(
        `INSERT INTO auth_identities(provider,app_id,subject,user_id)
         VALUES('wechat-mini',$1,$2,$3) ON CONFLICT(provider,app_id,subject) DO NOTHING RETURNING user_id`,
        [config.wechatAppId, subject, newUserId],
      );
      if (inserted.rowCount === 1) {
        identity = {
          rows: [{ user_id: newUserId, space_id: newSpaceId, generation: "1" }],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      } else {
        await client.query("DELETE FROM spaces WHERE id=$1", [newSpaceId]);
        await client.query("DELETE FROM users WHERE id=$1", [newUserId]);
        identity = await client.query<{
          user_id: string;
          space_id: string;
          generation: string;
        }>(
          `SELECT i.user_id, s.id AS space_id, s.generation::text AS generation
           FROM auth_identities i JOIN spaces s ON s.user_id=i.user_id
           WHERE i.provider='wechat-mini' AND i.app_id=$1 AND i.subject=$2`,
          [config.wechatAppId, subject],
        );
      }
    }
    const accountRow = identity.rows[0];
    if (!accountRow) throw new Error("Identity space invariant is violated");
    const account = {
      userId: accountRow.user_id,
      spaceId: accountRow.space_id,
      generation: accountRow.generation,
    };
    const tokens = buildTokenResponse(config, account);
    const now = Date.now();
    await client.query(
      `INSERT INTO auth_sessions(id,user_id,space_id,family_id,access_token_hash,refresh_token_hash,
        access_expires_at,refresh_expires_at,user_agent,device_id)
       VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),$9,$10)`,
      [
        randomUUID(),
        account.userId,
        account.spaceId,
        randomUUID(),
        hashOpaqueToken(tokens.accessToken, config.tokenPepper),
        hashOpaqueToken(tokens.refreshToken, config.tokenPepper),
        (now + config.accessTokenTtlSeconds * 1000) / 1000,
        (now + config.refreshTokenTtlSeconds * 1000) / 1000,
        userAgent,
        deviceId,
      ],
    );
    return tokens;
  });
}

async function rotateRefreshToken(
  pool: Pool,
  config: ServerConfig,
  rawToken: string,
): Promise<AuthTokens> {
  const providedHash = hashOpaqueToken(rawToken, config.tokenPepper);
  let replayRevoked = false;
  const tokens = await withTransaction(pool, async (client) => {
    const located = await client.query<{ id: string }>(
      `SELECT id FROM auth_sessions WHERE refresh_token_hash=$1
       UNION SELECT session_id AS id FROM auth_session_refresh_history WHERE token_hash=$1 LIMIT 1`,
      [providedHash],
    );
    const locatedId = located.rows[0]?.id;
    if (!locatedId) throw unauthorized();
    // Lock the stable session ID first. A waiter then reads history in a fresh
    // statement snapshot after the preceding rotation commits.
    await client.query("SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE", [
      locatedId,
    ]);
    const found = await client.query<{
      id: string;
      user_id: string;
      space_id: string;
      family_id: string;
      generation: string;
      refresh_token_hash: Buffer;
      refresh_expires_at: Date;
      revoked_at: Date | null;
      history_hash: Buffer | null;
      rotated_at: Date | null;
      replay_until: Date | null;
      response_ciphertext: Buffer | null;
      response_nonce: Buffer | null;
      response_tag: Buffer | null;
    }>(
      `SELECT s.id,s.user_id,s.space_id,s.family_id,s.refresh_token_hash,s.refresh_expires_at,s.revoked_at,
              sp.generation::text AS generation,h.token_hash AS history_hash,h.rotated_at,h.replay_until,
              h.response_ciphertext,h.response_nonce,h.response_tag
       FROM auth_sessions s JOIN spaces sp ON sp.id=s.space_id
       LEFT JOIN auth_session_refresh_history h ON h.session_id=s.id AND h.token_hash=$1
       WHERE s.id=$2 LIMIT 1`,
      [providedHash, locatedId],
    );
    const row = found.rows[0];
    if (!row || row.revoked_at) throw unauthorized();
    const isCurrent = row.refresh_token_hash.equals(providedHash);
    const nowMs = Date.now();
    if (!isCurrent) {
      if (
        row.replay_until &&
        row.replay_until.getTime() >= nowMs &&
        row.response_ciphertext &&
        row.response_nonce &&
        row.response_tag
      ) {
        return decryptReplayResponse(
          row.response_ciphertext,
          row.response_nonce,
          row.response_tag,
          config.tokenPepper,
        );
      }
      await client.query(
        "UPDATE auth_sessions SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL",
        [row.family_id],
      );
      replayRevoked = true;
      return null;
    }
    if (row.refresh_expires_at.getTime() <= nowMs) {
      await client.query(
        "UPDATE auth_sessions SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL",
        [row.family_id],
      );
      throw unauthorized();
    }
    const account = {
      userId: row.user_id,
      spaceId: row.space_id,
      generation: row.generation,
    };
    const nextTokens = buildTokenResponse(config, account);
    const sealed = encryptReplayResponse(nextTokens, config.tokenPepper);
    const nextAccessHash = hashOpaqueToken(
      nextTokens.accessToken,
      config.tokenPepper,
    );
    const nextRefreshHash = hashOpaqueToken(
      nextTokens.refreshToken,
      config.tokenPepper,
    );
    const graceUntil = new Date(nowMs + config.refreshGraceSeconds * 1000);
    await client.query(
      `INSERT INTO auth_session_refresh_history(session_id,token_hash,rotated_at,replay_until,response_ciphertext,response_nonce,response_tag)
       VALUES($1,$2,to_timestamp($3),$4,$5,$6,$7)`,
      [
        row.id,
        providedHash,
        nowMs / 1000,
        graceUntil,
        sealed.ciphertext,
        sealed.nonce,
        sealed.tag,
      ],
    );
    await client.query(
      `UPDATE auth_sessions SET access_token_hash=$2,refresh_token_hash=$3,
       access_expires_at=to_timestamp($4),refresh_expires_at=to_timestamp($5),last_seen_at=now()
       WHERE id=$1`,
      [
        row.id,
        nextAccessHash,
        nextRefreshHash,
        (nowMs + config.accessTokenTtlSeconds * 1000) / 1000,
        (nowMs + config.refreshTokenTtlSeconds * 1000) / 1000,
      ],
    );
    return nextTokens;
  });
  if (replayRevoked || !tokens) throw unauthorized();
  return tokens;
}

export async function authenticate(
  pool: Pool,
  config: ServerConfig,
  request: FastifyRequest,
): Promise<AuthContext> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") throw unauthorized();
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) throw unauthorized();
  const result = await pool.query<AuthContext>(
    `SELECT s.user_id AS "userId",s.space_id AS "spaceId",sp.generation::text AS generation,s.id AS "sessionId"
     FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN spaces sp ON sp.id=s.space_id
     WHERE s.access_token_hash=$1 AND s.revoked_at IS NULL AND s.access_expires_at>now() AND u.status='active'`,
    [hashOpaqueToken(match[1]!, config.tokenPepper)],
  );
  const context = result.rows[0];
  if (!context) throw unauthorized();
  enforceRateLimit(request, "account:" + context.userId, 180);
  return context;
}

const loginWindows = new Map<string, { start: number; count: number }>();
function enforceRateLimit(
  request: FastifyRequest,
  key: string,
  cap: number,
): void {
  const now = Date.now();
  if (loginWindows.size > 10_000) {
    for (const [address, window] of loginWindows)
      if (now - window.start > 60_000) loginWindows.delete(address);
  }
  const bucketKey = `${key}:${request.ip}`;
  let window = loginWindows.get(bucketKey);
  if (!window && loginWindows.size >= 10000)
    throw new AuthFailure(429, "RATE_LIMITED");
  if (!window || now - window.start >= 60_000) {
    window = { start: now, count: 0 };
    loginWindows.set(bucketKey, window);
  }
  window.count += 1;
  if (window.count > cap) throw new AuthFailure(429, "RATE_LIMITED");
}

function stringBody(
  value: unknown,
  key: string,
  maxLength: number,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" &&
    field.length > 0 &&
    field.length <= maxLength
    ? field
    : undefined;
}

export function registerAuth(
  app: FastifyInstance,
  pool: Pool,
  config: ServerConfig,
): void {
  app.post("/api/v1/auth/wechat-mini", async (request, reply) => {
    enforceRateLimit(request, "login", 10);
    const code = stringBody(request.body, "code", 256);
    if (!code || !/^[\x21-\x7e]+$/.test(code))
      throw new AuthFailure(400, "INVALID_PAYLOAD");
    const subject = await exchangeWechatCode(
      code,
      config.wechatAppId,
      config.wechatAppSecret,
    );
    const deviceId = stringBody(request.body, "deviceId", 36);
    if (deviceId && !uuid(deviceId))
      throw new AuthFailure(400, "INVALID_PAYLOAD");
    const tokens = await establishSession(
      pool,
      config,
      subject,
      requestUserAgent(request),
      deviceId || null,
    );
    return reply.code(200).send(tokens);
  });

  app.post("/api/v1/auth/refresh", async (request, reply) => {
    enforceRateLimit(request, "refresh", 60);
    const refreshToken = stringBody(request.body, "refreshToken", 128);
    if (!refreshToken || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken))
      throw unauthorized();
    return reply.send(await rotateRefreshToken(pool, config, refreshToken));
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const auth = await authenticate(pool, config, request);
    await pool.query(
      "UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL",
      [auth.sessionId],
    );
    return reply.code(204).send();
  });

  app.get("/api/v1/me", async (request) => {
    const auth = await authenticate(pool, config, request);
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM users WHERE id=$1",
      [auth.userId],
    );
    const user = result.rows[0];
    if (!user || user.status !== "active") throw unauthorized();
    return {
      userId: auth.userId,
      spaceId: auth.spaceId,
      generation: auth.generation,
      protocolVersion: 1,
    };
  });
}
