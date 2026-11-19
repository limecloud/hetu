import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { PluginPackage } from "../src/package.ts";
import { BackendSupervisor } from "../src/backend.ts";
import { RecoveryStore } from "../../../apps/desktop/src/main/recovery.ts";
const root = path.resolve(import.meta.dirname, "../../..");
const work = {
  workspace_id: "workspace_00000000-0000-4000-8000-000000000000",
  kind: "novel" as const,
  object_id: "novel_00000000-0000-4000-8000-000000000000",
};
test(
  "独立Node后端拒绝任意文件、网络、子进程和read动作写入",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-sandbox-"));
    await writeFile(
      path.join(directory, "plugin.json"),
      JSON.stringify({
        manifest_version: 1,
        host_api: "1",
        id: "org.test.sandbox",
        version: "1.0.0",
        display: { "zh-CN": "测试", en: "Test" },
        description: { "zh-CN": "隔离测试", en: "Test" },
        license: "MIT",
        permissions: [],
        dependencies: [],
        runtime: { entry: "backend.mjs" },
        contributions: {
          views: [],
          data: [],
          actions: [
            {
              id: "probe",
              title: "测试",
              effect: "read",
              input_schema: { type: "object" },
            },
          ],
        },
      }),
    );
    await writeFile(
      path.join(directory, "backend.mjs"),
      `
 import {readFile,writeFile} from "node:fs/promises";
 import {spawn} from "node:child_process";
 process.on("SIGTERM",()=>{});
 let context; export function apply(c){context=c;c.effect(()=>new Promise(()=>{}));}
 export async function invoke(action,input){
  if(input.kind==="pid")return process.pid;
  if(input.kind==="core")return context.request("hetu.extensions.objects.save",{operation_key:"forged"});
  try {
   if(input.kind==="read")await readFile(input.path);
   if(input.kind==="write")await writeFile(input.path,"altered");
   if(input.kind==="net")await fetch(input.address);
   if(input.kind==="spawn")spawn(process.execPath,["-e","process.exit(0)"]);
   return "allowed";
  }catch(e){return e.code ?? e.cause?.code;}
 }
 `,
    );
    const secret = path.join(
      await mkdtemp(path.join(os.tmpdir(), "hetu-outside-")),
      "secret.txt",
    );
    await writeFile(secret, "private");
    const pkg = await PluginPackage.inspect(directory);
    let calls = 0;
    const makeBackend = (node: string, electron = false) =>
      new BackendSupervisor({
        node,
        electron,
        bootstrap: path.join(root, "packages/plugin-host/src/worker.mjs"),
        snapshot: directory,
        pkg,
        work_ref: work,
        request: async () => {
          calls++;
          throw new Error("unexpected");
        },
      });
    let hits = 0;
    const http = createServer((_request, response) => {
      hits++;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      for (const [node, electron] of [
        [process.execPath, false],
        [createRequire(import.meta.url)("electron"), true],
      ] as const) {
        const backend = makeBackend(node, electron);
        try {
          if (electron) {
            await assert.rejects(
              () => backend.initialize(),
              /unsupported_node_runtime/,
            );
            continue;
          }
          await backend.initialize();
          for (const kind of ["read", "write", "net", "spawn"])
            assert.equal(
              await backend.invoke("probe", {
                kind,
                path: secret,
                address:
                  "http://127.0.0.1:" + (http.address() as any).port + "/",
              }),
              "ERR_ACCESS_DENIED",
              (electron ? "Electron " : "Node ") + kind,
            );
          assert.equal(hits, 0);
          assert.equal(await readFile(secret, "utf8"), "private");
          await assert.rejects(() => backend.invoke("probe", { kind: "core" }));
          assert.equal(calls, 0);
        } finally {
          await backend.dispose().catch(() => {});
        }
        const stalled = makeBackend(node, electron);
        await stalled.initialize();
        const pid = await stalled.invoke("probe", { kind: "pid" }) as number;
        const started = Date.now();
        await assert.rejects(() => stalled.dispose(), /清理超时/);
        assert.ok(Date.now() - started < 3000);
        assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
      }
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);
test("并发恢复稿以最后一次输入为准，损坏文件保持可诊断", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-recovery-")),
    file = path.join(directory, "buffers", "draft.json"),
    store = new RecoveryStore();
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      store.write(file, { content: "中文".repeat(i), order: i }, 1024 * 1024),
    ),
  );
  await store.flush();
  assert.equal(((await store.read(file)) as any).order, 29);
  await writeFile(file, "broken");
  await assert.rejects(() => store.read(file), /无法读取/);
});

test("后端清理按倒序全部尝试，失败回报且重复关闭共享结果", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-cleanup-"));
  await writeFile(path.join(directory, "plugin.json"), JSON.stringify({
    manifest_version: 1, host_api: "1", id: "org.test.cleanup", version: "1.0.0",
    display: { "zh-CN": "清理测试", en: "Cleanup" }, description: { "zh-CN": "清理测试", en: "Cleanup" },
    license: "MIT", permissions: [], dependencies: [], runtime: { entry: "backend.mjs" },
    contributions: { views: [], data: [], actions: [] },
  }));
  await writeFile(path.join(directory, "backend.mjs"), `
    export function apply(ctx) {
      ctx.effect(() => ctx.request("hetu.extensions.objects.list", { marker: "first" }));
      ctx.effect(() => { throw new Error("private cleanup detail"); });
      ctx.effect(() => ctx.request("hetu.extensions.objects.list", { marker: "last" }));
    }
  `);
  const calls: unknown[] = [];
  const backend = new BackendSupervisor({ node: process.execPath,
    bootstrap: path.join(root, "packages/plugin-host/src/worker.mjs"), snapshot: directory,
    pkg: await PluginPackage.inspect(directory), work_ref: work,
    request: async (_action, input) => { calls.push(input.marker); return { spec_version: "0.2.1", status: "succeeded", data: {} }; },
  });
  try {
    await backend.initialize();
    const first = backend.dispose(), second = backend.dispose();
    assert.equal(first, second);
    await assert.rejects(first, error => String(error).includes("runtime_failure") && !String(error).includes("private cleanup detail"));
    assert.deepEqual(calls, ["last", "first"]);
    await assert.rejects(second);
  } finally { backend.close(); }
});
