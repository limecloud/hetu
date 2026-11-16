import { navigate } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { AppServer } from "../src/main/rpc.ts";
import { sampleImage, sampleAudio } from "./fixtures/media.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("固定图片等比预览、真实音视频播放和seek、损坏提示及切换撤销", async () => {
  test.setTimeout(120000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-media-preview-")),
    workspace = path.join(folder, "作品"),
    access = path.join(folder, "access"),
    profile = path.join(folder, "profile");
  const pkg = await PluginPackage.inspect(
    path.join(root, "plugins/relationships/dist"),
  );
  const fixture = spawnSync(
    path.join(root, "target/debug/examples/plugin_fixture"),
    [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
    { encoding: "utf8" },
  );
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  const setup = await AppServer.open(
    path.join(root, "target/debug/hetu-app-server"),
    workspace,
  );
  const action = async (name: string, input: any) => {
    const value = await setup.request("workspace/request", {
      action: `hetu.${name}`,
      contract_revision: "1",
      input,
    });
    expect(value.status, JSON.stringify(value)).toBe("succeeded");
    return value.data;
  };
  const png = sampleImage(),
    wav = sampleAudio(),
    mp4 = await readFile(
      path.join(import.meta.dirname, "fixtures/preview.mp4"),
    );
  const assets: any[] = [];
  // 可信作者夹具只准备媒体样本；真实Agent固定方案另由media.spec.ts验收。
  try {
    for (const [name, filename, bytes] of [
      ["渡口竖图", "渡口.png", png],
      ["四秒声音", "渡口.wav", wav],
      ["四秒片段", "渡口.mp4", mp4],
      ["截断图片", "截断.png", png.subarray(0, 64)],
    ] as const) {
      const inline_source = {
        filename,
        base64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const scan = await action("assets.inspect", {
        work_ref: context.work_ref,
        inline_source,
      });
      assets.push(
        await action("assets.import", {
          work_ref: context.work_ref,
          inline_source,
          expected_file: { sha256: scan.sha256, size_bytes: scan.size_bytes },
          title: name,
          source: {
            source_type: "author_supplied",
            creator_statement: "可重复生成的媒体测试样本",
          },
          rights_status: "author_owned",
          redistribution_allowed: false,
          rights_statement: "",
          operation_key: name,
        }),
      );
    }
  } finally {
    await setup.close();
  }
  let app: ElectronApplication | undefined;
  const reference = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Reference</title><p>Reference</p>");
  });
  await new Promise<void>((resolve) =>
    reference.listen(0, "127.0.0.1", resolve),
  );
  try {
    app = await electron.launch({
      args: [path.join(root, "apps/desktop")],
      env: {
        ...process.env,
        HETU_DESKTOP_PROFILE: profile,
        HETU_PLUGIN_ACCESS_DIR: access,
        HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
        HETU_PLUGIN_NODE: process.execPath,
      },
    });
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    }, workspace);
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "打开作品", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await expect(page.locator(".workspace-switcher .workspace-title")).toHaveText("插件集成测试");
    await navigate(page, "素材与线索");
    await page.getByRole("button", { name: "渡口竖图 作者所有" }).click();
    const image = page.getByRole("img", { name: "渡口竖图", exact: true });
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(120);
    const proportions = await image.evaluate((el: HTMLImageElement) => ({
      width: el.clientWidth,
      height: el.clientHeight,
      natural: el.naturalHeight,
    }));
    expect(proportions.natural).toBe(180);
    expect(proportions.width / proportions.height).toBeCloseTo(2 / 3, 2);
    const oldUrl = await image.getAttribute("src");
    await page.getByRole("button", { name: "四秒声音 作者所有" }).click();
    const audio = page.locator("audio");
    await expect
      .poll(() =>
        audio.evaluate((el: HTMLAudioElement) =>
          Number.isFinite(el.duration) ? el.duration : 0,
        ),
      )
      .toBeCloseTo(4, 1);
    await audio.evaluate((el: HTMLAudioElement) => el.play());
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
      .toBeGreaterThan(0.2);
    await audio.evaluate((el: HTMLAudioElement) => el.pause());
    const released = await app.evaluate(
      async ({ session }, url) =>
        (await session.defaultSession.fetch(url!)).status,
      oldUrl,
    );
    expect(released).toBe(404);
    await page.getByRole("button", { name: "四秒片段 作者所有" }).click();
    const video = page.locator("video");
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth))
      .toBe(160);
    expect(await video.evaluate((el: HTMLVideoElement) => el.autoplay)).toBe(
      false,
    );
    await video.evaluate((el: HTMLVideoElement) => el.play());
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(0.2);
    await video.evaluate((el: HTMLVideoElement) => {
      el.currentTime = 2;
    });
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(2.2);
    await video.evaluate((el: HTMLVideoElement) => el.pause());
    const videoUrl = await video.getAttribute("src");
    const range = await app.evaluate(async ({ session }, url) => {
      const r = await session.defaultSession.fetch(url!, {
        headers: { Range: "bytes=5-31" },
      });
      return {
        status: r.status,
        range: r.headers.get("content-range"),
        bytes: Array.from(new Uint8Array(await r.arrayBuffer())),
      };
    }, videoUrl);
    expect(range.status).toBe(206);
    expect(Buffer.from(range.bytes)).toEqual(mp4.subarray(5, 32));
    const out = path.join(root, "output/plugin-doc-qa");
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: path.join(out, "media-video-preview.png") });
    await page.getByRole("button", { name: "截断图片 作者所有" }).click();
    await expect(page.getByRole("alert")).toContainText("无法预览此素材");
    await expect(
      page.getByRole("button", { name: "重新加载预览" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重新加载预览" }).click();
    await expect(page.getByRole("alert")).toContainText("无法预览此素材");
    await page.getByRole("button", { name: "返回创作库", exact: true }).click();
    await page.getByRole("button", { name: /独立剧本/ }).click();
    await expect(page.locator(".workspace-switcher .workspace-title")).toHaveText("独立剧本");
    expect(
      await app.evaluate(
        async ({ session }, url) =>
          (await session.defaultSession.fetch(url!)).status,
        videoUrl,
      ),
    ).toBe(404);
    const a = assets[0];
    await expect(
      page.evaluate(
        (a) =>
          (window as any).hetuDesktop.media("open", {
            asset_id: a.asset.asset_id,
            revision: 1,
            sha256: a.sha256,
          }),
        a,
      ),
    ).rejects.toThrow("不属于当前作品");
    // 普通参考页和独立插件session均没有工作台媒体协议或可信preload。
    const address = reference.address();
    if (!address || typeof address === "string")
      throw new Error("参考页未启动");
    const referenceUrl = `http://127.0.0.1:${address.port}/`;
    await page.evaluate(
      (url) => (window as any).hetuDesktop.browser(url),
      referenceUrl,
    );
    const isolation = await app.evaluate(
      async ({ webContents, session }, { referenceUrl, videoUrl }) => {
        const browser = webContents
          .getAllWebContents()
          .find((w) => w.getURL() === referenceUrl)!;
        return {
          bridge: await browser.executeJavaScript("typeof window.hetuDesktop"),
          media: await browser.session.protocol.isProtocolHandled("hetu-media"),
          pluginMedia: await session
            .fromPartition("plugin-media-isolation", { cache: false })
            .protocol.isProtocolHandled("hetu-media"),
          image: await browser.executeJavaScript(
            `new Promise(resolve => { const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('blocked'); image.src = ${JSON.stringify(videoUrl)}; })`,
          ),
        };
      },
      { referenceUrl, videoUrl },
    );
    expect(isolation).toEqual({
      bridge: "undefined",
      media: false,
      pluginMedia: false,
      image: "blocked",
    });
    await expect(
      page.evaluate(() =>
        (window as any).hetuDesktop.media("open", { file_path: "/arbitrary" }),
      ),
    ).rejects.toThrow("固定素材");
  } finally {
    await app?.close();
    await new Promise<void>((resolve, reject) =>
      reference.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
