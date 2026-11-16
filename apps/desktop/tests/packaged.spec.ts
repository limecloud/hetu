import { navigate, openDirectory } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { cp, lstat, mkdtemp, readFile, readlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { AppServer } from "../src/main/rpc.ts";
import { sampleImage, sampleAudio } from "./fixtures/media.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test(
  "独立开发应用使用随包Rust、Node及CLI/MCP完成作者与插件旅程", async () => {
    test.setTimeout(300000);
    test.skip(
      !process.env.HETU_PACKAGED_APP || !process.env.HETU_PACKAGE_MANIFEST,
      "需要实际打包应用与装配清单。",
    );
    const executable = process.env.HETU_PACKAGED_APP!;
    const manifestPath = process.env.HETU_PACKAGE_MANIFEST!;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const bundle =
      process.platform === "darwin"
        ? path.resolve(executable, "../../..")
        : path.dirname(executable);
    const packageDirectory =
      process.platform === "darwin" ? path.dirname(bundle) : bundle;
    const artifactErrors: string[] = [];
    for (const [relative, expected] of Object.entries(manifest.artifacts) as [
      string,
      any,
    ][]) {
      const file = path.join(packageDirectory, relative),
        stat = await lstat(file);
      if (expected.symlink) {
        if (await readlink(file) !== expected.symlink)
          artifactErrors.push(relative + ": symbolic link mismatch");
      }
      else {
        if (stat.size !== expected.size_bytes)
          artifactErrors.push(relative + ": size mismatch");
        if (createHash("sha256").update(await readFile(file)).digest("hex") !== expected.sha256)
          artifactErrors.push(relative + ": SHA-256 mismatch");
      }
    }
    // 完整核验每个制品后统一断言，避免数千条追踪步骤拖慢实际应用旅程。
    expect(artifactErrors).toEqual([]);
    if (process.platform === "darwin") {
      const signature = spawnSync(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", bundle],
        { encoding: "utf8" },
      );
      expect(signature.status, signature.stderr).toBe(0);
    }
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-packaged-"));
    const workspace = path.join(folder, "独立 中文作品"),
      profile = path.join(folder, "profile"),
      access = path.join(folder, "plugin-access"),
      collaboration = path.join(folder, "collaboration");
    const pluginDir = path.join(folder, "独立插件");
    await cp(path.join(root, "plugins/relationships/dist"), pluginDir, {
      recursive: true,
    });
    const pkg = await PluginPackage.inspect(pluginDir);
    const fixture = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture" + (process.platform === "win32" ? ".exe" : "")),
      [workspace, access, path.join(pluginDir, "plugin.json"), pkg.sha256],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    const context = JSON.parse(fixture.stdout);
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          ![
            "HETU_APP_SERVER",
            "HETU_PLUGIN_NODE",
            "HETU_PLUGIN_CLI",
            "HETU_CLI",
            "ELECTRON_RUN_AS_NODE",
          ].includes(key),
      ),
    ) as Record<string, string>;
    Object.assign(env, {
      HETU_DESKTOP_PROFILE: profile,
      HETU_COLLABORATION_DIR: collaboration,
      HETU_PLUGIN_ACCESS_DIR: access,
    });
    let application: ElectronApplication | undefined;
    async function launch() {
      application = await electron.launch({
        executablePath: executable,
        ...(process.platform === "linux" && process.env.CI ? { args: ["--no-sandbox"] } : {}),
        cwd: folder,
        env,
      });
      const page = await application.firstWindow();
      await page.setViewportSize({ width: 1024, height: 768 });
      await application.evaluate(({ dialog, clipboard }, directory) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        });
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
        dialog.showMessageBoxSync = () => 1;
        let copied = "";
        clipboard.writeText = value => { copied = value; };
        clipboard.readText = () => copied;
      }, workspace);
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      return page;
    }
    const json = (command: string, args: string[], input?: unknown) => {
      const result = spawnSync(command, args, {
        cwd: folder,
        env,
        input: input === undefined ? undefined : JSON.stringify(input),
        encoding: "utf8",
        timeout: 30000,
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      let page = await launch();
      const info = await application!.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        resources: process.resourcesPath,
      }));
      expect(info.packaged).toBe(true);
      const bin = (name: string) =>
        path.join(
          info.resources,
          "bin",
          name + (process.platform === "win32" ? ".exe" : ""),
        );
      await openDirectory(page);
      await page
        .getByRole("button", { name: "第一章 雾港", exact: true })
        .click();
      await expect(
        page.getByText("灯塔在黎明前亮起。", { exact: false }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "参考稿审核", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "当前审阅任务" })
        .selectOption(context.task_ref.task_id);
      await expect(
        page
          .frameLocator('iframe[title="任务候选审阅"]')
          .getByText("旧日记里夹着一张通往雾港的船票。", { exact: true }),
      ).toBeVisible();
      await navigate(page, "Agent 协作");
      await page
        .getByRole("button", { name: "授权当前作品", exact: true })
        .click();
      await page
        .getByRole("button", { name: "复制作品协作请求", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("已复制当前作品");
      const handoff = await application!.evaluate(({ clipboard }) =>
        JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
      );
      expect(handoff.core_cli).toBe(bin("hetu"));
      const docs = json(
        bin("hetu"),
        [
          "--client",
          "codex",
          "--collaboration-dir",
          collaboration,
          "call",
          "hetu.documents.list",
          "--input",
          "-",
        ],
        { management_ref: handoff.management_ref, work_ref: context.work_ref },
      );
      expect(docs.data.documents[0].document_id).toBe(
        context.document.document_id,
      );
      const mcp = new Client(
        { name: "hetu-packaged-check", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await mcp.connect(
          new StdioClientTransport({
            command: bin("hetu-mcp"),
            args: ["--client", "codex", "--collaboration-dir", collaboration],
            cwd: folder,
            env,
            stderr: "pipe",
          }),
        );
        expect(
          (await mcp.listTools()).tools.some(
            (t) => t.name === "hetu_list_documents",
          ),
        ).toBe(true);
        const read = await mcp.callTool({
          name: "hetu_list_documents",
          arguments: {
            management_ref: handoff.management_ref,
            work_ref: context.work_ref,
          },
        });
        expect(
          (read.structuredContent as any).data.documents[0].document_id,
        ).toBe(context.document.document_id);
        const assets = await mcp.callTool({
          name: "hetu_managed_assets_list",
          arguments: {
            management_ref: handoff.management_ref,
            work_ref: context.work_ref,
          },
        });
        expect((assets.structuredContent as any).status).toBe("succeeded");
        expect((assets.structuredContent as any).data.assets).toEqual([]);
      } finally {
        await mcp.close();
      }
      await navigate(page, "素材与线索");
      await expect(
        page.getByText(
          "还没有这类素材。",
        ),
      ).toBeVisible();
      // 媒体样本由随包可信作者进程准备；Agent的固定方案另由media.spec.ts验证。
      const setup = await AppServer.open(bin("hetu-app-server"), workspace);
      try {
        for (const [name, filename, bytes] of [
          ["随包图片", "sample.png", sampleImage()],
          ["随包声音", "sample.wav", sampleAudio()],
          [
            "随包视频",
            "sample.mp4",
            await readFile(
              path.join(import.meta.dirname, "fixtures/preview.mp4"),
            ),
          ],
        ] as const) {
          const inline_source = {
            filename,
            base64: bytes.toString("base64"),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
          const inspect = await setup.request("workspace/request", {
            action: "hetu.assets.inspect",
            contract_revision: "1",
            input: { work_ref: context.work_ref, inline_source },
          });
          expect(inspect.status, JSON.stringify(inspect)).toBe("succeeded");
          const imported = await setup.request("workspace/request", {
            action: "hetu.assets.import",
            contract_revision: "1",
            input: {
              work_ref: context.work_ref,
              inline_source,
              expected_file: {
                sha256: inspect.data.sha256,
                size_bytes: inspect.data.size_bytes,
              },
              title: name,
              source: {
                source_type: "author_supplied",
                creator_statement: "随包播放器测试样本",
              },
              rights_status: "author_owned",
              redistribution_allowed: false,
              rights_statement: "",
              operation_key: name,
            },
          });
          expect(imported.status, JSON.stringify(imported)).toBe("succeeded");
        }
      } finally {
        await setup.close();
      }
      await page.getByRole("button", { name: "刷新素材列表" }).click();
      await page.getByRole("button", { name: "随包图片 作者所有" }).click();
      await expect
        .poll(() =>
          page
            .getByRole("img", { name: "随包图片", exact: true })
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(120);
      for (const [name, tag] of [
        ["随包声音", "audio"],
        ["随包视频", "video"],
      ] as const) {
        await page.getByRole("button", { name: name + " 作者所有" }).click();
        const player = page.locator(tag);
        await expect
          .poll(() =>
            player.evaluate((el: HTMLMediaElement) =>
              Number.isFinite(el.duration) ? el.duration : 0,
            ),
          )
          .toBeCloseTo(4, 1);
        await player.evaluate((el: HTMLMediaElement) => el.play());
        await expect
          .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime))
          .toBeGreaterThan(0.1);
        await player.evaluate((el: HTMLMediaElement) => el.pause());
      }
      await navigate(page, "创作插件");
      await application!.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        });
      }, pluginDir);
      await page
        .getByRole("button", { name: "安装插件包", exact: true })
        .click();
      await page
        .getByRole("button", { name: "人物关系图", exact: true })
        .click();
      await expect
        .poll(() =>
          application!
            .windows()
            .some((p) => p.url().startsWith("hetu-plugin://")),
          { timeout: 30000 },
        )
        .toBe(true);
      let plugin = application!
        .windows()
        .find((p) => p.url().startsWith("hetu-plugin://"))!;
      await plugin
        .getByRole("textbox", { name: "新增条目" })
        .fill("独立应用人物");
      await plugin
        .getByRole("button", { name: "添加并保存", exact: true })
        .click();
      await expect(plugin.getByRole("status")).toContainText("已保存修订 1");
      await plugin
        .getByRole("button", { name: "自动排列", exact: true })
        .click();
      await expect(plugin.getByRole("status")).toContainText("已重新排列");
      const state = JSON.parse(
        await readFile(path.join(profile, "plugin-state.json"), "utf8"),
      );
      const connection = [
        "--workspace",
        workspace,
        "--grant",
        Object.values(state.grants)[0] as string,
        "--package-sha256",
        pkg.sha256,
        "--access-dir",
        access,
      ];
      const listed = json(
        bin("hetu-plugin"),
        [...connection, "call", "hetu.extensions.objects.list", "--input", "-"],
        { work_ref: context.work_ref },
      );
      expect(listed.data.objects).toHaveLength(1);
      const objectId = listed.data.objects[0].object_id;
      const runtime = path.join(info.resources, "app/dist/plugin-runtime.mjs");
      await page.evaluate(() => (window as any).hetuDesktop.handoff("plugin"));
      const pluginHandoff = await application!.evaluate(({ clipboard }) =>
        JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
      );
      expect(pluginHandoff.plugin_connection.node_executable).toBe(bin("node"));
      expect(pluginHandoff.plugin_connection.runtime).toBe(runtime);
      const runtimeArgs = [
        runtime,
        "--package",
        pluginDir,
        ...connection,
        "--core-cli",
        bin("hetu-plugin"),
      ];
      expect(
        json(bin("node"), [...runtimeArgs, "capabilities"]).actions.some(
          (a: any) => a.id === "arrange",
        ),
      ).toBe(true);
      expect(
        json(
          bin("node"),
          [...runtimeArgs, "invoke", "arrange", "--input", "-"],
          { object_id: objectId, operation_key: "packaged-headless" },
        ).status,
      ).toBe("succeeded");
      await application!.close();
      application = undefined;
      // 没有桌面窗口时，随包 CLI 仍可回读同一作品与插件成果。
      const readback = json(
        bin("hetu-plugin"),
        [...connection, "call", "hetu.extensions.objects.get", "--input", "-"],
        { work_ref: context.work_ref, object_id: objectId },
      );
      expect(readback.data.object.revision).toBe(3);
      const cited = json(
        bin("hetu-plugin"),
        [...connection, "call", "hetu.extensions.objects.save", "--input", "-"],
        {
          work_ref: context.work_ref,
          object_id: objectId,
          kind: readback.data.object.kind,
          title: readback.data.object.title,
          schema_version: readback.data.object.schema_version,
          content: readback.data.object.content,
          source_refs: context.source_refs,
          expected_revision: readback.data.object.revision,
          expected_sha256: readback.data.sha256,
          operation_key: "packaged-fixed-source",
        },
      );
      expect(cited.data.object.source_refs).toEqual(context.source_refs);
      page = await launch();
      await page
        .getByRole("button", { name: "人物关系图", exact: true })
        .click();
      await expect
        .poll(() =>
          application!
            .windows()
            .some((p) => p.url().startsWith("hetu-plugin://")),
          { timeout: 30000 },
        )
        .toBe(true);
      plugin = application!
        .windows()
        .find((p) => p.url().startsWith("hetu-plugin://"))!;
      await expect(
        plugin.getByText("独立应用人物", { exact: true }).first(),
      ).toBeVisible();
      await plugin.screenshot({
        path: path.join(
          root,
          "output/plugin-doc-qa/packaged-relationships.png",
        ),
      });
    } finally {
      await application?.close();
    }
  },
);
