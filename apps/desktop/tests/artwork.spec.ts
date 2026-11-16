import { documentAction, navigate } from "./navigation.ts";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sampleImage } from "./fixtures/media.ts";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("图片库按固定人物与正文关联、原比例预览、历史批次反馈和作品隔离", async () => {
  test.setTimeout(300000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-artwork-")),
    workspace = path.join(folder, "作品"),
    access = path.join(folder, "access"),
    profile = path.join(folder, "profile"),
    imageFile = path.join(folder, "source.png");
  const png = sampleImage();
  await writeFile(imageFile, png);
  const pkg = await PluginPackage.inspect(
    path.join(root, "plugins/relationships/dist"),
  );
  const fixture = spawnSync(
    path.join(root, "target/debug/examples/plugin_fixture"),
    [
      workspace,
      access,
      path.join(pkg.source, "plugin.json"),
      pkg.sha256,
      "0",
      "--artwork",
      imageFile,
      createHash("sha256").update(png).digest("hex"),
    ],
    { encoding: "utf8" },
  );
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  const executable = process.env.HETU_PACKAGED_APP;
  const application = await electron.launch({
    ...(executable ? { executablePath: executable, args: [] } : { args: [path.join(root, "apps/desktop")] }),
    env: {
      ...process.env,
      HETU_DESKTOP_PROFILE: profile,
      HETU_COLLABORATION_DIR: path.join(folder, "collaboration"),
      HETU_PLUGIN_ACCESS_DIR: access,
      ...(!executable ? { HETU_PLUGIN_NODE: process.execPath,
        HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server") } : {}),
    },
  });
  const renderErrors: string[] = [];
  try {
    const page = await application.firstWindow();
    page.on("pageerror", error => renderErrors.push(error.stack ?? error.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      dialog.showMessageBoxSync = () => 1;
    }, workspace);
    await page
      .getByRole("button", { name: "打开作品", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await navigate(page, "图片成果");
    const gallery = page.getByRole("region", {
      name: "作品图片成果",
      exact: true,
    });
    await expect(gallery.locator(".artwork-item")).toHaveCount(3);
    const panelBounds = await page.locator('.workbench-page').boundingBox();
    const viewport = page.viewportSize()!;
    expect(panelBounds!.y + panelBounds!.height).toBeGreaterThan(viewport.height - 24);
    const heading = await page.getByRole('heading', { name: '图片成果', exact: true }).boundingBox();
    const search = await page.getByRole('searchbox', { name: '搜索图片', exact: true }).boundingBox();
    expect(Math.abs(heading!.y + heading!.height / 2 - search!.y - search!.height / 2)).toBeLessThan(3);
    expect(await gallery.getByRole('tab').count()).toBe(8);
    await page.screenshot({path:path.join(root,'output/rea-mac-ui-20261116/artwork-grid-light.png')});
    await gallery.getByRole("tab", { name: "人物", exact: true }).click();
    await expect(gallery.locator(".artwork-item")).toHaveCount(1);
    await gallery.getByRole("button", { name: /雾中的旅人/ }).click();
    const detail = page.getByRole("dialog", { name: "固定图片详情", exact: true });
    const size = await detail
      .locator(".artwork-preview")
      .evaluate((img: HTMLImageElement) => ({
        width: img.naturalWidth,
        height: img.naturalHeight,
        fit: getComputedStyle(img).objectFit,
      }));
    expect(size.width / size.height).toBeCloseTo(2 / 3, 2);
    expect(size.fit).toBe('contain');
    await page.screenshot({path:path.join(root,'output/rea-mac-ui-20261116/artwork-detail-light.png')});
    // 外部 Agent 独立提交下一批，打开的详情仍固定于旧批次。
    const next = structuredClone(context.artwork.submit_input);
    next.operation_key = "next-images";
    next.candidates[0].title = "第二批人物形象";
    const submitted = spawnSync(
      path.join(root, "target/debug/hetu"),
      ["--workspace", workspace, "--task", context.artwork.task_ref.task_id,
        "call", "hetu.creative_tasks.submit_result", "--input", "-"],
      { encoding: "utf8", input: JSON.stringify(next) },
    );
    expect(submitted.status, submitted.stderr).toBe(0);
    await expect(detail.getByRole("heading", { name: "雾中的旅人", exact: true })).toBeVisible();
    await detail.getByRole("textbox", { name: "图片修改意见", exact: true })
      .fill("只调整旧版人物的衣领，保留原来的神态。");
    await expect(detail.getByRole("button", { name: "旧外套的侧面", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "继续编辑", exact: true }).click();
    await detail.getByRole("button", { name: "按此修改", exact: true }).click();
    await expect(detail.getByRole("status")).toContainText("修改意见已保存");
    const fixed = await page.evaluate(async (ref) => (window as any).hetuDesktop.tasks("call", ref, {
      name: "hetu_open_task_view", arguments: { task_ref: ref },
    }), context.artwork.task_ref);
    const feedback = fixed.structuredContent.data.last_feedback;
    expect(feedback.target_refs).toHaveLength(3);
    expect(feedback.target_refs.every((ref: any) =>
      ref.candidate_ref.submission_id === context.artwork.submission_id)).toBe(true);
    expect(feedback.selected_refs).toEqual([feedback.target_refs[0]]);
    expect(feedback.public_comment).toBe("只调整旧版人物的衣领，保留原来的神态。");
    await detail.getByRole("button", { name: "关闭图片详情", exact: true }).click();
    await page.getByRole("button", { name: "刷新图片", exact: true }).click();
    await expect(gallery.getByRole("button", { name: /第二批人物形象/ })).toBeVisible();
    await page.getByRole("searchbox", { name: "搜索图片", exact: true }).fill("黎明前");
    await gallery.getByRole("tab", { name: "全部", exact: true }).click();
    await expect(gallery.locator(".artwork-item")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "搜索图片", exact: true }).fill("");
    await expect(gallery.locator(".artwork-item")).toHaveCount(3);
    await navigate(page, "作品设定");
    await expect(page.getByRole("button", { name: "查看江岚", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, "output/rea-mac-ui-20261116/canon-grid.png") });
    const primary = page.locator(".canon-entity.character .canon-entity-image");
    await expect(primary.getByRole("img", { name: "江岚", exact: true })).toBeVisible();
    expect(await primary.evaluate(el => el.getBoundingClientRect().height)).toBe(240);
    await page.getByRole("button", { name: "查看江岚", exact: true }).click();
    await expect(page.getByRole("article", { name: "设定详情", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, "output/rea-mac-ui-20261116/canon-light.png") });
    await page
      .getByRole("button", { name: "查看关联图片", exact: true })
      .click();
    const related = page.getByRole("region", { name: "关联图片", exact: true });
    await expect(related.locator(".artwork-item")).toHaveCount(2);
    await expect(
      related.getByRole("img", { name: "黎明前的灯塔", exact: true }),
    ).toHaveCount(0);
    await related
      .getByRole("button", { name: "让 AI 准备图片", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("已复制图片协作请求");
    const handoff = await application.evaluate(({ clipboard }) =>
      JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
    );
    expect(
      handoff.fixed_refs.some(
        (ref: any) => ref.entity_ref === context.artwork.character_id,
      ),
    ).toBe(true);
    expect(handoff.page).toBe("work.images");
    await page.getByRole("button", { name: "关闭设定详情", exact: true }).click();
    const originalCanon = await page.evaluate(() => window.hetuDesktop.canon("get"));
    const character = page.locator(".canon-entity.character").filter({ hasText: "江岚" });
    await character.getByRole("button", { name: "编辑", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑人物设定", exact: true });
    await edit.getByLabel("描述", { exact: true }).fill("灯塔守望者");
    await edit.getByLabel("别名", { exact: true }).fill("阿岚\n守望者");
    await page.keyboard.press("Escape");
    await expect(edit).toContainText("修改尚未保存");
    await edit.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.screenshot({ path: path.join(root, "output/rea-mac-ui-20261116/canon-editor.png") });
    await edit.getByRole("button", { name: "保存设定", exact: true }).click();
    await expect(edit).not.toBeVisible();
    const updated = await page.evaluate(() => window.hetuDesktop.canon("get"));
    expect(updated.blueprint.characters[0].aliases).toEqual(["阿岚", "守望者"]);
    const more = page.locator('summary[aria-label="更多设定操作"]');
    await more.click(); await page.getByRole("button", { name: "设定历史", exact: true }).click();
    const history = page.getByRole("dialog", { name: "设定历史", exact: true });
    await history.getByLabel("设定修订", { exact: true }).fill(String(originalCanon.revision));
    await history.getByRole("button", { name: "查看修订", exact: true }).click();
    await expect(history).toContainText("雾港的来客");
    await expect(history).not.toContainText("灯塔守望者");
    await page.screenshot({ path: path.join(root, "output/rea-mac-ui-20261116/canon-history.png") });
    await history.getByRole("button", { name: "关闭", exact: true }).click();
    await more.click(); await page.getByRole("button", { name: "锁定设定", exact: true }).click();
    const lock = page.getByRole("dialog", { name: "锁定设定", exact: true });
    await lock.getByLabel("原因", { exact: true }).fill("核对完毕，固定本版设定");
    await lock.getByRole("button", { name: "确认锁定", exact: true }).click();
    await expect(lock).not.toBeVisible();
    await expect(character.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
    expect((await page.evaluate(() => window.hetuDesktop.canon("get"))).blueprint.lock.locked).toBe(true);
    await more.click(); await page.getByRole("button", { name: "解锁设定", exact: true }).click();
    const unlock = page.getByRole("dialog", { name: "解锁设定", exact: true });
    await unlock.getByLabel("原因", { exact: true }).fill("继续完善人物事实");
    await unlock.getByRole("button", { name: "确认解锁", exact: true }).click();
    await expect(unlock).not.toBeVisible();
    await character.getByRole("button", { name: "编辑", exact: true }).click();
    await edit.getByLabel("描述", { exact: true }).fill("保留当前未保存输入");
    const concurrentCanon = await page.evaluate(() => window.hetuDesktop.canon("get"));
    await page.evaluate(value => window.hetuDesktop.canon("save", { expected: { blueprint_id: value.blueprint.blueprint_id, revision: value.revision, sha256: value.sha256 }, typed_changes: [{ type: "upsert_character", entity: { ...value.blueprint.characters[0], description: "另一个窗口的修改" } }] }), concurrentCanon);
    await edit.getByRole("button", { name: "保存设定", exact: true }).click();
    await expect(edit.getByRole("alert")).toBeVisible();
    await expect(edit.getByLabel("描述", { exact: true })).toHaveValue("保留当前未保存输入");
    expect((await page.evaluate(() => window.hetuDesktop.canon("get"))).blueprint.characters[0].description).toBe("另一个窗口的修改");
    await edit.getByRole("button", { name: "关闭", exact: true }).click();
    await edit.getByRole("button", { name: "放弃修改并关闭", exact: true }).click();
    await page.getByRole("button", { name: "小说", exact: true }).click();
    await page
      .getByRole("button", { name: "第一章 雾港", exact: true })
      .click();
    await page.locator("summary[aria-label='文稿操作']").click();
    await documentAction(page, "本稿图片");
    await expect(related.locator(".artwork-item")).toHaveCount(1);
    await expect(
      related.getByRole("img", { name: "黎明前的灯塔", exact: true }),
    ).toBeVisible();
    await navigate(page, "图片成果");
    await expect(gallery.locator(".artwork-item")).toHaveCount(3);
    await page.screenshot({
      path: path.join(root, "output/plugin-doc-qa/artwork-library.png"),
    });
    await page.getByRole("button", { name: "返回创作库", exact: true }).click();
    await page.getByRole("button", { name: /独立剧本/ }).click();
    await navigate(page, "图片成果");
    await expect(gallery).toHaveAttribute("aria-busy", "false");
    await expect(gallery.getByText("还没有图片成果", { exact: true })).toBeVisible();
    await expect(gallery.locator(".artwork-item")).toHaveCount(0);
    const empty = gallery.locator('.artwork-empty');
    const emptyBounds = await empty.boundingBox(), galleryBounds = await gallery.boundingBox();
    expect(emptyBounds!.height).toBeGreaterThan(300);
    expect(galleryBounds!.y + galleryBounds!.height).toBeGreaterThan(page.viewportSize()!.height - 60);
    await page.screenshot({path:path.join(root,'output/rea-mac-ui-20261116/artwork-empty-light.png')});
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
    await page.screenshot({path:path.join(root,'output/rea-mac-ui-20261116/artwork-empty-dark.png')});
    await page.setViewportSize({width:960,height:800});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:path.join(root,'output/rea-mac-ui-20261116/artwork-empty-narrow.png')});
  } catch (error) {
    const page = await application.firstWindow();
    await page.screenshot({ path: path.join(root, "output/rea-mac-ui-20261116/artwork-failure.png") }).catch(() => {});
    await writeFile(path.join(root, "output/rea-mac-ui-20261116/artwork-render-errors.json"), JSON.stringify(renderErrors, null, 2));
    throw error;
  } finally {
    await application.close();
  }
});
