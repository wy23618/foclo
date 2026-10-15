// Persistent file tier for large namespaced YoTick facts. Small device/global
// keys and the handful of synchronous UI stores continue to use the raw KV tier.

const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const { readInBatches } = require("../core/bounded-read");
const ROOT_NAME = "yotick-facts-v1";
const TEMP_DIR_NAME = ".yotick-write-tmp";
const FILE_PREFIXES = ["yotick-space/", "yotick-legacy-snapshot/"];
const FAST_SPACE_KEYS = new Set([
  "yotick/rest-break/v1",
  "yotick/rest-round-count",
  "yotick/guide/welcome-v1",
  "yotick/ui-project-colors-v2",
]);

function utf8ByteLength(value) {
  return unescape(encodeURIComponent(value)).length;
}

function errorText(error) {
  return String((error && (error.errMsg || error.message)) || "");
}

function isMissing(error) {
  if (!error) return false;
  const code = error.code || error.errno || error.errCode;
  return (
    code === "ENOENT" ||
    code === -2 ||
    code === 1300002 ||
    /\bENOENT\b|no such file(?: or directory)?|\b(?:readFile|readdir|stat|unlink):fail\b[\s\S]*?\bnot found\b/i.test(errorText(error))
  );
}

function isAlreadyExists(error) {
  const code = error && (error.code || error.errno || error.errCode);
  return (
    code === "EEXIST" ||
    code === 1301005 ||
    /file already exists|already exists/i.test(errorText(error))
  );
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createFileTierAdapter(raw, wxApi, options) {
  options = options || {};
  if (
    !raw ||
    typeof raw.get !== "function" ||
    typeof raw.set !== "function" ||
    typeof raw.remove !== "function" ||
    typeof raw.keys !== "function"
  ) {
    throw new TypeError("raw must implement get, set, remove, and keys");
  }

  const api = wxApi || (typeof wx !== "undefined" ? wx : null);
  const fs =
    api && typeof api.getFileSystemManager === "function"
      ? api.getFileSystemManager()
      : api;
  const userDataPath =
    options.basePath || (api && api.env && api.env.USER_DATA_PATH);
  if (!fs || !userDataPath)
    throw new TypeError(
      "wxApi must provide FileSystemManager and USER_DATA_PATH",
    );
  const maxBytes =
    options.maxBytes == null ? DEFAULT_MAX_BYTES : options.maxBytes;
  if (!Number.isFinite(maxBytes) || maxBytes < 0)
    throw new TypeError("maxBytes must be a non-negative finite number");

  const rootPath = String(userDataPath).replace(/\/$/, "") + "/" + ROOT_NAME;
  const tempPath = rootPath + "/" + TEMP_DIR_NAME;
  let fileSizes = new Map();
  let indexedBytes = 0;
  let indexed = false;
  let mutationQueue = Promise.resolve();
  let tempSequence = 0;

  function inFileTier(key) {
    if (typeof key !== "string") return false;
    if (key.indexOf("yotick-legacy-snapshot/") === 0) return true;
    if (key.indexOf("yotick-space/") !== 0) return false;
    const namespaceEnd = key.indexOf("/", "yotick-space/".length);
    if (namespaceEnd < 0) return false;
    const suffix = key.slice(namespaceEnd + 1);
    return !FAST_SPACE_KEYS.has(suffix);
  }

  function checkedSegments(key) {
    if (typeof key !== "string" || !inFileTier(key))
      throw makeError("FILE_KEY_INVALID", "Key is not routed to the file tier");
    if (
      !key ||
      key.charCodeAt(0) === 47 ||
      /^[A-Za-z]:/.test(key) ||
      key.indexOf("\\") >= 0
    ) {
      throw makeError("FILE_KEY_INVALID", "Absolute or invalid file-tier key");
    }
    if (/[\x00-\x1f\x7f]/.test(key))
      throw makeError(
        "FILE_KEY_INVALID",
        "Control characters are not allowed in file-tier keys",
      );
    const segments = key.split("/");
    if (
      segments.some(
        (part) =>
          !part || part === "." || part === ".." || /^[A-Za-z]:/.test(part),
      )
    ) {
      throw makeError(
        "FILE_KEY_INVALID",
        "Traversal or empty path segments are not allowed",
      );
    }
    return segments;
  }

  function encodedSegments(key) {
    return checkedSegments(key).map((part) => encodeURIComponent(part));
  }

  function filePath(key) {
    const parts = encodedSegments(key);
    parts[parts.length - 1] += ".json";
    return rootPath + "/" + parts.join("/");
  }

  function call(method, args) {
    return new Promise((resolve, reject) => {
      if (!fs || typeof fs[method] !== "function") {
        reject(
          makeError(
            "FILE_API_UNAVAILABLE",
            "FileSystemManager." + method + " is unavailable",
          ),
        );
        return;
      }
      try {
        fs[method](Object.assign({}, args, { success: resolve, fail: reject }));
      } catch (error) {
        reject(error);
      }
    });
  }

  async function ensureDirectory(path) {
    try {
      await call("mkdir", { dirPath: path, recursive: true });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  async function readFile(path) {
    const result = await call("readFile", { filePath: path, encoding: "utf8" });
    return typeof result.data === "string" ? result.data : String(result.data);
  }

  async function statSize(path) {
    const result = await call("stat", { path });
    const stat = Array.isArray(result.stats) ? result.stats[0] : result.stats;
    if (!stat || !Number.isFinite(stat.size))
      throw makeError(
        "FILE_STAT_INVALID",
        "FileSystemManager.stat returned no file size",
      );
    return stat.size;
  }

  async function readdir(path) {
    const result = await call("readdir", { dirPath: path });
    if (!result || !Array.isArray(result.files))
      throw makeError(
        "FILE_READDIR_INVALID",
        "FileSystemManager.readdir returned no file list",
      );
    return result.files;
  }

  function tempName() {
    tempSequence++;
    const random = Math.random().toString(36).slice(2, 12) || "0";
    return (
      "yotick-" +
      Date.now().toString(36) +
      "-" +
      tempSequence.toString(36) +
      "-" +
      random +
      ".tmp"
    );
  }

  async function cleanOwnedTemps() {
    let names;
    try {
      names = await readdir(tempPath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!/^yotick-[a-z0-9-]+-[a-z0-9-]+-[a-z0-9]+\.tmp$/i.test(name))
        continue;
      try {
        await call("unlink", { filePath: tempPath + "/" + name });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  async function scanDirectory(path, relative, result) {
    let names;
    try {
      names = await readdir(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    let files = [];
    async function flushFiles() {
      const sizes = await readInBatches(files, statSize);
      for (let i = 0; i < files.length; i++) result.set(files[i], sizes[i]);
      files = [];
    }
    for (const name of names) {
      if (
        !name ||
        name === "." ||
        name === ".." ||
        name.indexOf("/") >= 0 ||
        name.indexOf("\\") >= 0 ||
        /[\x00-\x1f\x7f]/.test(name)
      )
        continue;
      if (!relative && name === TEMP_DIR_NAME) continue;
      const childPath = path + "/" + name;
      const childRelative = relative ? relative + "/" + name : name;
      // Data files always have an explicit .json suffix; extensionless entries
      // are directories. This avoids depending on a platform-specific dirent API.
      if (name.slice(-5) === ".json") {
        files.push(childPath);
        if (files.length === 8) await flushFiles();
      } else {
        await flushFiles();
        await scanDirectory(childPath, childRelative, result);
      }
    }
    await flushFiles();
  }

  async function rebuildIndex() {
    await cleanOwnedTemps();
    const next = new Map();
    await scanDirectory(rootPath, "", next);
    fileSizes = next;
    indexedBytes = 0;
    for (const size of next.values()) indexedBytes += size;
    indexed = true;
    return totalBytes();
  }

  function totalBytes() {
    return indexedBytes;
  }

  async function ensureIndex() {
    if (!indexed) await rebuildIndex();
  }

  function enqueueMutation(fn) {
    const result = mutationQueue.then(fn);
    mutationQueue = result.catch(() => undefined);
    return result;
  }

  async function removeRawFallback(key) {
    await raw.remove(key);
  }

  async function get(key) {
    if (!inFileTier(key)) return raw.get(key);
    const path = filePath(key);
    try {
      const text = await readFile(path);
      return JSON.parse(text);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // One-time transparent read fallback for scoped keys written before this
    // adapter was installed. The legacy KV copy remains intact until a verified
    // file write succeeds.
    return raw.get(key);
  }

  async function set(key, value) {
    if (!inFileTier(key)) return raw.set(key, value);
    const path = filePath(key);
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw makeError(
        "FILE_VALUE_INVALID",
        "File-tier values must be JSON serializable",
      );
    const bytes = utf8ByteLength(serialized);

    return enqueueMutation(async () => {
      await ensureIndex();
      const oldSize = fileSizes.get(path) || 0;
      const usedBytes = totalBytes();
      // The temporary replacement coexists with the previous durable file.
      if (usedBytes + bytes > maxBytes) {
        throw makeError(
          "FILE_TIER_QUOTA",
          "YoTick file storage budget would be exceeded",
        );
      }

      const slash = path.lastIndexOf("/");
      const parentPath = path.slice(0, slash);
      const tmp = tempPath + "/" + tempName();
      try {
        await ensureDirectory(parentPath);
        await ensureDirectory(tempPath);
        await call("writeFile", {
          filePath: tmp,
          data: serialized,
          encoding: "utf8",
        });
        await call("rename", { oldPath: tmp, newPath: path });
      } catch (error) {
        try {
          await call("unlink", { filePath: tmp });
        } catch (cleanupError) {
          if (!isMissing(cleanupError)) error.cleanupError = cleanupError;
        }
        // A platform can complete a rename but lose its success callback. Scan
        // after any failure so usage accounting reflects the durable files.
        try {
          await rebuildIndex();
        } catch (scanError) {
          error.rebuildError = scanError;
        }
        throw error;
      }

      fileSizes.set(path, bytes);
      indexedBytes += bytes - oldSize;
      await removeRawFallback(key);
    });
  }

  async function remove(key) {
    if (!inFileTier(key)) return raw.remove(key);
    const path = filePath(key);
    return enqueueMutation(async () => {
      try {
        await call("unlink", { filePath: path });
        indexedBytes -= fileSizes.get(path) || 0;
        fileSizes.delete(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await removeRawFallback(key);
    });
  }

  async function keys() {
    return enqueueMutation(async () => {
      const rawKeys = await raw.keys();
      await ensureIndex();
      const result = new Set(rawKeys);
      for (const path of fileSizes.keys()) {
        if (path.indexOf(rootPath + "/") !== 0) continue;
        const relative = path.slice(rootPath.length + 1);
        const encoded = relative.split("/");
        encoded[encoded.length - 1] = encoded[encoded.length - 1].slice(0, -5);
        let key;
        try {
          key = encoded.map((part) => decodeURIComponent(part)).join("/");
        } catch (error) {
          continue;
        }
        try {
          if (inFileTier(key) && filePath(key) === path) result.add(key);
        } catch (error) {
          /* Ignore malformed files without exposing their paths. */
        }
      }
      return Array.from(result);
    });
  }

  async function capacity() {
    return enqueueMutation(async () => {
      await rebuildIndex();
      const usedBytes = totalBytes();
      return {
        tier: "files",
        usedBytes,
        limitBytes: maxBytes,
        availableBytes: Math.max(0, maxBytes - usedBytes),
      };
    });
  }

  const adapter = { get, set, remove, keys, capacity, type: "file-tier" };
  if (typeof raw.getStorageSync === "function") {
    adapter.getStorageSync = (key) => {
      if (inFileTier(key))
        throw makeError(
          "FILE_SYNC_UNSUPPORTED",
          "File-tier keys are asynchronous",
        );
      return raw.getStorageSync(key);
    };
  }
  if (typeof raw.setStorageSync === "function") {
    adapter.setStorageSync = (key, value) => {
      if (inFileTier(key))
        throw makeError(
          "FILE_SYNC_UNSUPPORTED",
          "File-tier keys are asynchronous",
        );
      return raw.setStorageSync(key, value);
    };
  }
  if (typeof raw.removeStorageSync === "function") {
    adapter.removeStorageSync = (key) => {
      if (inFileTier(key))
        throw makeError(
          "FILE_SYNC_UNSUPPORTED",
          "File-tier keys are asynchronous",
        );
      return raw.removeStorageSync(key);
    };
  }
  return adapter;
}

module.exports = { createFileTierAdapter, DEFAULT_MAX_BYTES, isMissing };
