import {test, expect} from "@playwright/test";
import {mkdtemp, readFile, writeFile, mkdir} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {AppServer} from "../src/main/rpc.ts";

test("旧安装制品、第二版迁移及发行回退保留确切设置原字节", async () => {
  const previous = process.env.HETU_ACCEPT_PREVIOUS_APP_SERVER;
  test.skip(!previous, "需指定仍使用第一版偏好的真实前版制品");
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-reading-rollback-")), before = process.env.HETU_LOCAL_SETTINGS_DIR;
  process.env.HETU_LOCAL_SETTINGS_DIR = directory;
  const current = path.resolve("../../target/debug/hetu-app-server"), file = path.join(directory, "settings.json");
  try {
    let server = await AppServer.open(previous!);
    try {const old = await server.request("local_settings/host", {method: "get", input: {}}); expect(old.schema_version).toBe(1);} finally {await server.close();}
    const legacy = JSON.parse(await readFile(file, "utf8"));
    Object.assign(legacy.preferences, {font_family: "pingfang", font_size: 22, line_spacing: 8, first_line_indent: false, autosave: false, appearance: "dark"});
    const original = JSON.stringify(legacy, null, 2).replace(/\n/g, "\r\n"); await writeFile(file, original);
    server = await AppServer.open(current);
    try {
      const next = await server.request("local_settings/host", {method: "get", input: {}});
      expect(next.schema_version).toBe(3); expect(next.preferences.reading_profiles.novel.font_size).toBe(22);
      expect(next.preferences.reading_profiles.novel.line_height).toBeCloseTo(1.35 + 8 / 22, 12);
    } finally {await server.close();}
    const migrated = await readFile(file), backup = await readFile(path.join(directory, "migrations/v1/settings.json"));
    expect(backup.toString()).toBe(original);
    // 前版读取第二版必须拒绝或保留只读，不能重置或改写新设置。
    let oldRejected = false;
    try {server = await AppServer.open(previous!); try {await server.request("local_settings/host", {method: "get", input: {}});} finally {await server.close();}}
    catch {oldRejected = true;}
    expect(oldRejected).toBe(true); expect(await readFile(file)).toEqual(migrated);
    const rollback = path.join(directory, "rollback"); await mkdir(rollback);
    await writeFile(path.join(rollback, "settings.json"), backup);
    process.env.HETU_LOCAL_SETTINGS_DIR = rollback;
    server = await AppServer.open(previous!);
    try {
      const restored = await server.request("local_settings/host", {method: "get", input: {}});
      expect(restored.schema_version).toBe(1); expect(restored.preferences.font_size).toBe(22); expect(restored.preferences.line_spacing).toBe(8);
    } finally {await server.close();}
    expect(await readFile(path.join(rollback, "settings.json"))).toEqual(backup);
    process.env.HETU_LOCAL_SETTINGS_DIR = directory;
    server = await AppServer.open(current);
    try {expect((await server.request("local_settings/host", {method: "get", input: {}})).schema_version).toBe(3);} finally {await server.close();}
    expect(await readFile(file)).toEqual(migrated); expect(await readFile(path.join(directory, "migrations/v1/settings.json"))).toEqual(backup);
  } finally {if (before === undefined) delete process.env.HETU_LOCAL_SETTINGS_DIR; else process.env.HETU_LOCAL_SETTINGS_DIR = before;}
});
