import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export class ProtocolError extends Error {
  constructor(
    public code: string,
    message = code,
    public detail: unknown = null,
  ) {
    super(message);
  }
}
export function requireValue(
  value: unknown,
  code = "INVALID_PAYLOAD",
): asserts value {
  if (!value) throw new ProtocolError(code);
}
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",") +
    "}"
  );
}
export const digest = (v: any) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export function signCursor(value: unknown, secret: string) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function readCursor(token: string, secret: string): any {
  try {
    const [body, sig, ...extra] = token.split(".");
    requireValue(body && sig && !extra.length, "INVALID_CURSOR");
    const expected = createHmac("sha256", secret).update(body).digest();
    const actual = Buffer.from(sig, "base64url");
    requireValue(
      actual.length === expected.length && timingSafeEqual(actual, expected),
      "INVALID_CURSOR",
    );
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw new ProtocolError("INVALID_CURSOR");
  }
}
export const PREF_KEYS = [
  "startupMode",
  "defaultMinutes",
  "commonMinutes",
  "confirmEnd",
  "dailyGoalEnabled",
  "dailyGoalMinutes",
  "weekStartsSunday",
  "restEnabled",
  "shortBreakMinutes",
  "longBreakMinutes",
  "longBreakEvery",
];
export function validatePrefs(p: any) {
  requireValue(p && typeof p === "object" && !Array.isArray(p));
  for (const [k, v] of Object.entries(p)) {
    requireValue(PREF_KEYS.includes(k), "INVALID_PREF");
    if (
      [
        "confirmEnd",
        "dailyGoalEnabled",
        "weekStartsSunday",
        "restEnabled",
      ].includes(k)
    )
      requireValue(typeof v === "boolean");
    else if (k === "startupMode")
      requireValue(
        ["remember", "countdown", "stopwatch"].includes(v as string),
      );
    else if (k === "commonMinutes")
      requireValue(
        Array.isArray(v) &&
          v.length === 4 &&
          new Set(v).size === 4 &&
          v.every((n) => Number.isInteger(n) && n >= 1 && n <= 1440),
      );
    else if (k === "longBreakEvery")
      requireValue(Number.isInteger(v) && Number(v) >= 2 && Number(v) <= 8);
    else if (k === "shortBreakMinutes")
      requireValue(Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 60);
    else if (k === "longBreakMinutes")
      requireValue(Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 120);
    else
      requireValue(Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 1440);
  }
}
export function validateProject(p: any) {
  requireValue(p && uuid(p.id));
  requireValue(Number.isSafeInteger(p.createdAtSec)&&Number.isSafeInteger(p.updatedAtSec));
  requireValue(
    typeof p.name === "string" &&
      p.name === p.name.trim() &&
      Array.from(p.name).length > 0 &&
      Array.from(p.name).length <= 120,
    "INVALID_NAME",
  );
  requireValue(p.parentId === null || uuid(p.parentId));
  requireValue(typeof p.archived === "boolean");
  requireValue(
    typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color),
    "INVALID_COLOR",
  );
  requireValue(
    p.shortName == null ||
      (typeof p.shortName === "string" && Array.from(p.shortName).length <= 8),
  );
}
export function validateSession(s: any) {
  requireValue(
    s && uuid(s.id) && uuid(s.projectId) && s.status === "COMPLETED",
  );
  for (const k of ["startedAtSec", "endedAtSec", "durationSeconds"])
    requireValue(Number.isSafeInteger(s[k]) && s[k] >= 0);
  requireValue(s.endedAtSec >= s.startedAtSec);
  requireValue(Number.isSafeInteger(s.createdAtSec)&&Number.isSafeInteger(s.updatedAtSec));
  requireValue(
    s.targetSeconds === null ||
      (Number.isSafeInteger(s.targetSeconds) &&
        s.targetSeconds >= 60 &&
        s.targetSeconds <= 3153600000),
  );
  requireValue(Array.isArray(s.pauses) && s.pauses.length <= 10000);
  let end = s.startedAtSec,
    total = 0;
  const seen = new Set();
  for (const p of s.pauses) {
    requireValue(
      uuid(p.id) &&
        !seen.has(p.id) &&
        p.sessionId === s.id &&
        p.status === "COMPLETED",
    );
    seen.add(p.id);
    requireValue(
      Number.isSafeInteger(p.startedAtSec) &&
        Number.isSafeInteger(p.endedAtSec) &&
        p.startedAtSec >= end &&
        p.endedAtSec >= p.startedAtSec &&
        p.endedAtSec <= s.endedAtSec &&
        p.durationSeconds === p.endedAtSec - p.startedAtSec,
    );
    end = p.endedAtSec;
    total += p.durationSeconds;
  }
  requireValue(
    s.durationSeconds === s.endedAtSec - s.startedAtSec - total,
    "INVALID_DURATION",
  );
  requireValue(
    s.targetSeconds === null || s.durationSeconds <= s.targetSeconds,
    "INVALID_DURATION",
  );
}
