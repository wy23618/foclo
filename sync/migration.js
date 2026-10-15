const { uuid } = require("../core/ids");
const { createService } = require("../core/service");
const { createAccountAdapter } = require("../storage/account-adapter");
const local = require("./local");
const bytes = (value) =>
  unescape(encodeURIComponent(JSON.stringify(value))).length;
const KEY = "yotick/import/current";
async function guestSummary(raw) {
  const guest = createAccountAdapter(raw, "guest");
  const meta = await guest.get("yotick/meta");
  const projects = Object.values((await guest.get("yotick/projects")) || {});
  const keys = (await guest.keys()).filter((k) => k.startsWith("yotick/s/"));
  // The repository has one ACTIVE session at meta.activeSessionId; all other
  // session keys are completed facts. Count keys without reading years of files.
  const sessionCount = keys.filter((key) => key !== "yotick/s/" + (meta && meta.activeSessionId)).length;
  return {
    projectCount: projects.length,
    sessionCount,
    signature: JSON.stringify([meta && meta.id, meta && meta.dataRevision]),
    hasData: projects.length > 0 || sessionCount > 0,
  };
}
async function prepare(raw, accountAdapter) {
  let state = await accountAdapter.get(KEY);
  if (state && state.status !== "committed") return state;
  if (state)
    await accountAdapter.set("yotick/import-history/" + state.id, state);
  const guest = createAccountAdapter(raw, "guest"),
    service = createService(guest, { syncEnabled: false });
  const init = await service.init();
  if (!init.ok) throw new Error(init.error.message);
  const current = await service.getCurrent();
  if (current.data.sessionId || (await guest.get("yotick/rest-break/v1")))
    throw new Error("游客空间还有计时，请先结束");
  const backup = await service.createBackup();
  if (!backup.ok) throw new Error(backup.error.message);
  const colors = (await guest.get("yotick/ui-project-colors-v2")) || {},
    snapshot = backup.data;
  const chunks = [];
  let chunk = { projects: [], sessions: [] };
  function append(type, item) {
    if (bytes(item) > 220 * 1024)
      throw new Error("单条资料超出迁移大小限制，请导出保全");
    chunk[type].push(item);
    if (bytes(chunk) > 240 * 1024) {
      chunk[type].pop();
      chunks.push(chunk);
      chunk = { projects: [], sessions: [] };
      chunk[type].push(item);
    }
  }
  const usedColors = new Set(
    Object.values(colors)
      .concat(snapshot.projects.map((p) => p.color))
      .filter(Boolean)
      .map((c) => c.toUpperCase()),
  );
  for (const p of snapshot.projects
    .slice()
    .sort(
      (a, b) => a.creationOrder - b.creationOrder || a.id.localeCompare(b.id),
    )) {
    const color =
      p.color ||
      colors[p.id] ||
      require("../utils/color").pickUnusedColor(usedColors);
    usedColors.add(color.toUpperCase());
    append("projects", local.projectPayload({ ...p, color }));
  }
  for (const s of snapshot.sessions)
    if (s.status === "COMPLETED") append("sessions", local.sessionPayload(s));
  chunks.push(chunk);
  if (chunks.reduce((n, c) => n + bytes(c), 0) > 8 * 1024 * 1024)
    throw new Error("迁移资料超过当前 8 MiB 上限，请保留游客原副本");
  const id = uuid();
  for (let i = 0; i < chunks.length; i++)
    await accountAdapter.set("yotick/import/" + id + "/" + i, chunks[i]);
  state = {
    id,
    sourceId: "guest:" + snapshot.spaceId,
    chunkCount: chunks.length,
    status: "prepared",
    projectCount: snapshot.projects.length,
    sessionCount: snapshot.sessions.length,
    guestSignature: (await guestSummary(raw)).signature,
  };
  await accountAdapter.set(KEY, state);
  return state;
}
async function upload(
  raw,
  adapter,
  request,
  generation,
  onProgress = () => {},
) {
  let state = await prepare(raw, adapter);
  const create = () =>
    request("POST", "/imports", {
      jobId: state.id,
      sourceId: state.sourceId,
      chunkCount: state.chunkCount,
      generation,
    });
  try {
    await create();
  } catch (e) {
    if (!["IMPORT_EXPIRED", "IMPORT_NOT_FOUND"].includes(e.code)) throw e;
    const original = state.chunkSourceId || state.id;
    state = {
      ...state,
      id: uuid(),
      chunkSourceId: original,
      status: "prepared",
      preview: null,
    };
    await adapter.set(KEY, state);
    await create();
  }
  const job = await request("GET", "/imports/" + state.id, {}),
    received = new Set(job.received.map((r) => r.chunk_index));
  for (let i = 0; i < state.chunkCount; i++) {
    if (!received.has(i))
      await request(
        "PUT",
        "/imports/" + state.id + "/chunks/" + i,
        await adapter.get(
          "yotick/import/" + (state.chunkSourceId || state.id) + "/" + i,
        ),
      );
    onProgress({
      stage: "uploading",
      completed: i + 1,
      total: state.chunkCount,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const preview = await request("POST", "/imports/preview", {
    jobId: state.id,
  });
  state = { ...state, status: "preview", preview };
  await adapter.set(KEY, state);
  return preview;
}
async function commit(adapter, request, deviceId, mapping, sessionMapping, options = {}) {
  const state = await adapter.get(KEY);
  if (!state?.preview) throw new Error("请先预览迁移");
  if (options.automatic && state.preview.mergePolicy !== 'KEEP_ACCOUNT')
    throw new Error('自动保存服务尚未更新，登录前的记录已保留，请稍后再试');
  const result = await request("POST", "/imports/" + state.id + "/commit", {
    confirmation: "MERGE_GUEST_DATA",
    deviceId,
    sourceDigest: state.preview.digest,
    mapping: mapping || {},
    sessionMapping: sessionMapping || {},
    ...(options.automatic ? { mergePolicy:'KEEP_ACCOUNT' } : {}),
  });
  await adapter.set(KEY, { ...state, status: "committed", result });
  return result;
}
module.exports = { prepare, upload, commit, guestSummary };
