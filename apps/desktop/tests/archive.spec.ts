import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

test("创作库右键移入废纸篓与恢复保留同根对象", async ({}, info) => {
  test.setTimeout(90000);
  const root = path.resolve("../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-archive-")), workspace = path.join(folder, "work"), profile = path.join(folder, "profile");
  await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(folder, "collaboration")], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const app = await electron.launch({args: [path.join(root, "apps/desktop")], env: {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: path.join(folder, "collaboration"), HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server")}});
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width: 1000, height: 700});
    const card = page.getByRole("button", {name: "打开作品 默认小说", exact: true});
    await app.evaluate(({dialog}) => {dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false});});
    await card.click({button: "right"});
    await page.getByRole("menuitem", {name: "移入废纸篓", exact: true}).click();
    const filter = page.getByRole("combobox", {name: "创作状态筛选", exact: true});
    await filter.selectOption("archived");
    const archived = page.getByRole("button", {name: "打开作品 默认小说", exact: true});
    await expect(archived).toBeVisible();
    await archived.click({button: "right"});
    await expect(page.getByRole("menuitem", {name: "从废纸篓恢复", exact: true})).toBeVisible();
    await page.getByRole("menuitem", {name: "从废纸篓恢复", exact: true}).click();
    await expect(archived).toHaveCount(0);
    await filter.selectOption("all"); await expect(page.getByRole("button", {name: "打开作品 默认小说", exact: true})).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({path: info.outputPath("library-archive-restore.png")});
  } finally {await app.close();}
});
