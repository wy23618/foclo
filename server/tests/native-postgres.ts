import EmbeddedPostgres from "embedded-postgres";
import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
export async function testPostgres(dir: string, port: number) {
  if (process.platform !== "win32")
    return new EmbeddedPostgres({
      databaseDir: join(dir, "db"),
      port,
      persistent: true,
      user: "postgres",
      password: "test-only-password",
      initdbFlags: ["--locale=C", "--encoding=UTF8"],
      onLog: () => {},
      onError: () => {},
    });
  // PostgreSQL Windows binaries fail to initialize from non-ASCII install paths.
  const pkg = dirname(
      fileURLToPath(import.meta.resolve("@embedded-postgres/windows-x64")),
    ),
    native = join(dir, "native");
  await cp(join(pkg, "..", "native"), native, { recursive: true });
  const bin = join(native, "bin");
  let processHandle: ChildProcess | undefined;
  const run = (name: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(join(bin, name + ".exe"), args, {
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(name + " failed: " + stderr)),
      );
    });
  return {
    binaryPath: bin,
    async initialise() {
      await run("initdb", [
        "-D",
        join(dir, "db"),
        "-U",
        "postgres",
        "--auth=trust",
        "--locale=C",
        "--encoding=UTF8",
      ]);
    },
    async start() {
      processHandle = spawn(
        join(bin, "postgres.exe"),
        ["-D", join(dir, "db"), "-p", String(port), "-h", "127.0.0.1"],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("PostgreSQL startup timeout")),
          15000,
        );
        processHandle!.on("error", reject);
        processHandle!.stderr!.on("data", (d) => {
          if (String(d).includes("ready to accept connections")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        processHandle!.on("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error("postgres exited " + code));
        });
      });
    },
    async stop() {
      if (processHandle)
        await run("pg_ctl", ["-D", join(dir, "db"), "stop", "-m", "fast"]);
    },
  };
}
