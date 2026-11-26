import {test, expect} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {fixtureBinary, machineBinary} from "../../desktop/tests/acceptance-paths.ts";
import {openWorkbenchHost} from "./workbench-host.ts";

for (const transport of ["stdio", "codex"] as const) test(`${transport} 块字母排序、固定源保存、浅暗窄窗及单次撤销`, async ({page}, info) => {
  test.skip(transport === "codex" && !process.env.HETU_ACCEPT_CODEX_BINARY, "需指定官方Codex CLI"); test.setTimeout(120000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-sort-ui-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile"), collaboration = path.join(directory, "collaboration");
  await mkdir(profile);
  const fixture = spawnSync(fixtureBinary("baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  const source = "apple\r\nApple\néclair\r\nEclair\r\nÉclair\neclair\nss\r\nß\na 10\r\na 2\nZebra\r\nzebra";
  const ordered = ["a 10", "a 2", "apple", "Apple", "éclair", "Éclair", "Eclair", "eclair", "ss", "ß", "Zebra", "zebra"];
  const breaks = source.match(/\r\n?|\n/g)!;
  const expectedSource = ordered.map((line, index) => line + (breaks[index] ?? "")).join("");
  const author = await AppServer.open(machineBinary("hetu-app-server"), workspace);
  try {
    const saved = await author.request("workspace/request", {action: "hetu.documents.save", contract_revision: "1", input: {document_id: refs.document.document.document_id, base_revision_id: refs.document.revision.revision_id, source_format: "markdown", content: source, operation_key: "sort-source"}});
    expect(saved.status).toBe("succeeded");
  } finally {await author.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "排序验收"}]}]}));
  const env = {HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_PLUGIN_STATE_DIR: profile, HETU_PLUGIN_NODE: process.execPath, HETU_COLLABORATION_DIR: collaboration};
  const host = await openWorkbenchHost(transport, page, {...process.env, ...env, HETU_APP_SERVER: machineBinary("hetu-app-server"), HETU_CLI: machineBinary("hetu"), ...(!process.env.HETU_PACKAGED_APP ? {HETU_INTEGRATIONS_DIR: path.join(root, "integrations")} : {})});
  const view = host.view, errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.setViewportSize({width: 1440, height: 797});
    await view.locator("#root").evaluate(() => {
      (window as any).__menuPointer = [];
      document.addEventListener("pointermove", event => {
        const target = event.target instanceof Element ? event.target.closest('[role="menuitem"],[role="menuitemcheckbox"]') : null;
        if (!target) return;
        const values = (window as any).__menuPointer as unknown[];
        values.push({x: event.clientX, y: event.clientY, item: target.getAttribute("aria-label"), expanded: target.getAttribute("aria-expanded")});
        if (values.length > 100) values.shift();
      });
    });
    await view.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await navigate(view,"小说");
    const editor = view.getByRole("textbox", {name: "文稿编辑", exact: true}); await expect(editor).toBeVisible();
    await view.locator("#root").evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {autosave: false}});});
    const sort = async (label: string) => {
      await editor.press("ControlOrMeta+a"); await editor.press("Shift+F10");
      await view.getByRole("menuitem", {name: "排序", exact: true}).hover();
      const submenu = view.getByRole("menu", {name: "排序", exact: true});
      await expect(submenu).toBeVisible();
      await writeFile(info.outputPath(`${label}-menu-geometry.json`), JSON.stringify(await view.locator('[role="menu"]').evaluateAll(elements => elements.map(element => ({label: element.getAttribute("aria-label"), bounds: element.getBoundingClientRect().toJSON(), items: Array.from(element.querySelectorAll("button")).map(button => ({label: button.getAttribute("aria-label"), bounds: button.getBoundingClientRect().toJSON()}))}))), null, 2) + "\n");
      const choice = submenu.getByRole("menuitem", {name: label, exact: true}), bounds = (await choice.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3, {steps: 24});
      await expect(choice).toBeVisible(); await choice.click({timeout: 10000});
    };
    await sort("排序 A → Z"); await expect(editor.locator(".cm-line")).toHaveText(ordered);
    await page.screenshot({path: info.outputPath(`${transport}-sort-light.png`)});
    await editor.press("ControlOrMeta+s");
    const read = () => view.locator("#root").evaluate(async (_element, id) => (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id}), refs.document.document.document_id);
    await expect.poll(async () => (await read()).data.content).toBe(expectedSource);
    await view.locator("#root").evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {appearance: "dark"}});});
    await page.setViewportSize({width: 760, height: 700});
    await sort("排序 Z → A");
    await expect(editor.locator(".cm-line")).toHaveText([...ordered].reverse());
    await page.screenshot({path: info.outputPath(`${transport}-sort-dark-narrow.png`)});
    await editor.press("ControlOrMeta+z"); await expect(editor.locator(".cm-line")).toHaveText(ordered);
    await expect(view.getByRole("button", {name: "保存修订", exact: true})).toBeDisabled();
    expect((await read()).data.content).toBe(expectedSource);
    expect(await page.evaluate(() => window.harness.invalidToolArguments)).toBe(0); expect(errors).toEqual([]);
  } finally {
    const pointer = await view.locator("#root").evaluate(() => (window as any).__menuPointer).catch(() => undefined);
    await writeFile(info.outputPath("menu-pointer.json"), JSON.stringify(pointer ?? null, null, 2) + "\n");
    await host.close();
  }
});
