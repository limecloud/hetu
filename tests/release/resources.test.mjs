import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("共享页面在仓库、workspace及外部目录回读相同产物", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = path.join(root, "apps/task-view/scripts/build.mjs");
  for (const cwd of [root, path.join(root, "apps/task-view"), os.tmpdir()])
    execFileSync(process.execPath, [script, "--check"], { cwd, stdio: "pipe" });
});
