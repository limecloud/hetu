import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PluginInstallations } from "../src/installations.ts";
import { PluginPackage } from "../src/package.ts";
const root = path.resolve(import.meta.dirname, "../../..");

test("运行已安装快照只重验字节，不重写文件，篡改后拒绝且不静默修补", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"hetu-readonly-snapshot-"));
  const store = new PluginInstallations(directory);
  const original = await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
  const snapshot = await store.snapshot(original);
  const installed = await PluginPackage.inspect(snapshot,original.sha256);
  const entry = path.join(snapshot,"index.html"), before = await stat(entry,{bigint:true});
  assert.equal(await store.snapshot(installed),snapshot);
  assert.equal((await stat(entry,{bigint:true})).mtimeNs,before.mtimeNs);
  await writeFile(entry,"篡改后的页面");
  await assert.rejects(store.snapshot(installed),/摘要不一致/);
  assert.equal(await readFile(entry,"utf8"),"篡改后的页面");
});

test("定向发现只核对目标与依赖，停用或替换依赖后不能继续", async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),"hetu-selected-host-"));
  const store=new PluginInstallations(directory);
  const base=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
  const targetDirectory=path.join(directory,"target");
  const {mkdir}=await import("node:fs/promises");
  for (const [name,bytes] of base.entries()) {
    const file=path.join(targetDirectory,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
  }
  const manifest={...base.manifest,id:"org.test.selected",dependencies:[{id:base.manifest.id,version:base.manifest.version}]};
  await writeFile(path.join(targetDirectory,"plugin.json"),JSON.stringify(manifest));
  const target=await PluginPackage.inspect(targetDirectory);
  const basePath=await store.snapshot(base),targetPath=await store.snapshot(target);
  const state={packages:[{path:basePath,manifest:base.manifest,sha256:base.sha256,enabled:true},
    {path:targetPath,manifest:target.manifest,sha256:target.sha256,enabled:true},
    {path:path.join(directory,"unreadable-unrelated"),manifest:{...base.manifest,id:"org.test.unrelated"},sha256:"a".repeat(64),enabled:true}],grants:{}};
  await store.save(state,(await store.read()).sha256);
  let selected=await store.host((await store.read()).state,target.manifest.id);
  assert.equal(selected.active(target.manifest.id),true);
  assert.equal(selected.states().length,2);
  assert.equal(selected.loadErrors.has("org.test.unrelated"),false);
  assert.equal((await store.host(state)).loadErrors.has("org.test.unrelated"),true);
  state.packages[0].enabled=false;
  selected=await store.host(state,target.manifest.id);
  assert.equal(selected.active(target.manifest.id),false);
  state.packages[0].enabled=true;
  state.packages[0].sha256="b".repeat(64);
  assert.equal((await store.host(state,target.manifest.id)).active(target.manifest.id),false);
});

test("无窗口安装、停用和卸载共用状态；原键恢复，拒绝旧基线和包替换", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-installations-"));
  const store = new PluginInstallations(directory), other = new PluginInstallations(directory);
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  let revoked = 0;
  const revoke = async () => { revoked++; };
  const input = { action: "install", package_directory: path.join(root, "plugins/relationships/dist"),
    package_sha256: pkg.sha256, expected_sha256: (await store.read()).sha256,
    operation_key: "install", client_adapter: "codex", authorization_note: "测试用户明确要求安装关系图。" };
  const installed = await store.apply(input, revoke);
  assert.equal((await other.inspect()).states[0].state, "active");
  assert.deepEqual(await other.apply(input, revoke), installed);
  assert.deepEqual(await other.getOperation("codex", "install"), installed);
  assert.equal(revoked, 0);
  await assert.rejects(other.apply({ ...input, package_sha256: "0".repeat(64) }, revoke), /原操作键/);
  await assert.rejects(other.apply({ ...input, operation_key: "stale" }, revoke), /状态已变化/);
  const current = await other.read();
  await other.apply({ ...input, action: "disable", plugin_id: pkg.manifest.id,
    operation_key: "disable", expected_sha256: current.sha256 }, revoke);
  assert.equal(revoked, 1);
  assert.equal((await store.inspect()).states[0].state, "disabled");
  await assert.rejects(store.save(current.state, current.sha256), /另一入口/);
  await other.apply({ ...input, action: "uninstall", plugin_id: pkg.manifest.id,
    operation_key: "uninstall", expected_sha256: (await store.read()).sha256 }, revoke);
  assert.equal((await store.inspect()).states.length, 0);
  assert.equal((await store.read()).state.packages[0].removed, true);
});

test("并行安装入口只有一个事务可提交，不覆盖对方状态", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-install-race-"));
  const a = new PluginInstallations(directory), b = new PluginInstallations(directory);
  const before = await a.read();
  const results = await Promise.allSettled([
    a.save({ ...before.state, grants: { a: "fixture-a" } }, before.sha256),
    b.save({ ...before.state, grants: { b: "fixture-b" } }, before.sha256),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(Object.keys((await a.read()).state.grants).length, 1);
});

test("损坏固定包隔离失败，无关包仍可用且可沿机器入口停用卸载坏包", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-broken-install-"));
  const store = new PluginInstallations(directory);
  const good = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const broken = await PluginPackage.inspect(path.join(root, "plugins/timeline/dist"));
  const goodPath = await store.snapshot(good), brokenPath = await store.snapshot(broken);
  await store.save({ packages: [good, broken].map((pkg, index) => ({
    path: index ? brokenPath : goodPath, manifest: pkg.manifest, sha256: pkg.sha256, enabled: true,
  })), grants: {} }, (await store.read()).sha256);
  await writeFile(path.join(brokenPath, "index.html"), "被改写的固定包");
  const status = await store.inspect();
  assert.equal(status.states.find(s => s.id === good.manifest.id)?.state, "active");
  assert.equal(status.states.find(s => s.id === broken.manifest.id)?.state, "failed");
  assert.match(status.states.find(s => s.id === broken.manifest.id)?.reason ?? "", /摘要不一致/);
  let revocations = 0;
  for (const action of ["disable", "uninstall"]) {
    await store.apply({ action, plugin_id: broken.manifest.id, package_sha256: broken.sha256,
      expected_sha256: (await store.read()).sha256, operation_key: action, client_adapter: "codex",
      authorization_note: `测试作者明确要求${action}损坏插件。` }, async identity => {
      assert.equal(identity.sha256, broken.sha256); revocations++;
    });
    assert.equal((await store.inspect()).states.find(s => s.id === good.manifest.id)?.state, "active");
  }
  assert.equal(revocations, 2);
  assert.ok(!(await store.inspect()).states.some(s => s.id === broken.manifest.id));
});

test("安装格式读取保留旧v1字节，写入显式版本，未知版本与控制字段失败关闭", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-install-format-"));
  const store = new PluginInstallations(directory), legacy = JSON.stringify({ packages: [], grants: {} });
  await writeFile(store.file, legacy);
  const before = await store.read();
  assert.equal(await readFile(store.file, "utf8"), legacy);
  await store.save(before.state, before.sha256);
  assert.equal((await store.read()).state.format_version, 1);
  for (const invalid of [{ format_version: 2, packages: [], grants: {} }, { packages: [], grants: {}, author: true }]) {
    const bytes = JSON.stringify(invalid);
    await writeFile(store.file, bytes);
    await assert.rejects(store.read(), /状态无效/);
    assert.equal(await readFile(store.file, "utf8"), bytes);
  }
});


test("定向运行只核验依赖闭包，拒绝缺失、停用、错版和被篡改依赖",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"hetu-targeted-install-")),store=new PluginInstallations(directory);
 const dependency=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const targetDirectory=path.join(directory,"target");await cp(path.join(root,"plugins/timeline/dist"),targetDirectory,{recursive:true});
 const targetManifest=JSON.parse(await readFile(path.join(targetDirectory,"plugin.json"),"utf8"));targetManifest.dependencies=[{id:dependency.manifest.id,version:dependency.manifest.version}];
 await writeFile(path.join(targetDirectory,"plugin.json"),JSON.stringify(targetManifest));const target=await PluginPackage.inspect(targetDirectory);
 const depPath=await store.snapshot(dependency),targetPath=await store.snapshot(target);
 const state={packages:[{path:depPath,manifest:dependency.manifest,sha256:dependency.sha256,enabled:true},{path:targetPath,manifest:target.manifest,sha256:target.sha256,enabled:true},{path:"/not-read-unrelated",manifest:{...dependency.manifest,id:"org.test.unrelated"},sha256:"0".repeat(64),enabled:true}],grants:{}};
 const original=PluginPackage.inspect,seen:string[]=[];PluginPackage.inspect=async function(path:string){seen.push(path);return original.call(this,path);};
 try{
  assert.equal((await store.host(state,target.manifest.id)).active(target.manifest.id),true);assert.deepEqual(new Set(seen),new Set([depPath,targetPath]));
 }finally{PluginPackage.inspect=original;}
 const disabled=structuredClone(state);disabled.packages[0].enabled=false;assert.equal((await store.host(disabled,target.manifest.id)).active(target.manifest.id),false);
 const missing=structuredClone(state);missing.packages.splice(0,1);assert.equal((await store.host(missing,target.manifest.id)).active(target.manifest.id),false);
 const wrong=structuredClone(state);wrong.packages[0].manifest.version="99.0.0";wrong.packages[0].sha256="0".repeat(64);assert.equal((await store.host(wrong,target.manifest.id)).active(target.manifest.id),false);
 await writeFile(path.join(depPath,"index.html"),"被改写");assert.equal((await store.host(state,target.manifest.id)).active(target.manifest.id),false);
});
