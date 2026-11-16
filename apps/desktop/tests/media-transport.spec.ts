import { test, expect } from "@playwright/test";
import { MediaAccess } from "../src/main/media.ts";

function setup() {
  const bytes = Buffer.alloc(1024 * 1024 + 11, 73),
    calls: { method: string; input: any }[] = [];
  let active = true;
  const server = {
    async request(method: string, input: any) {
      calls.push({ method, input });
      if (method === "media/open")
        return {
          token: "rust-token",
          media_type: "video/mp4",
          size_bytes: bytes.length,
        };
      if (method === "media/read") {
        const slice = bytes.subarray(input.offset, input.offset + input.length);
        return {
          base64: slice.toString("base64"),
          offset: input.offset,
          size_bytes: slice.length,
        };
      }
      return null;
    },
  };
  const media = new MediaAccess(
    { workspace_id: "workspace-test", kind: "novel", object_id: "novel-test" },
    server as any,
    () => active,
  );
  return {
    media,
    bytes,
    calls,
    deactivate: () => {
      active = false;
    },
  };
}

test("媒体HTTP范围与分块预算、HEAD及错误范围", async () => {
  const { media, bytes, calls } = setup();
  const { url } = await media.open({
    asset_id: "asset-test",
    revision: 1,
    sha256: "a".repeat(64),
  });
  const full = await media.handle(new Request(url));
  expect(full.status).toBe(200);
  expect(full.headers.get("cache-control")).toBe("no-store");
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  expect(
    calls.filter((c) => c.method === "media/read").map((c) => c.input.length),
  ).toEqual([524288, 524288, 11]);
  for (const [range, start, end] of [
    ["bytes=5-9", 5, 9],
    ["bytes=-11", bytes.length - 11, bytes.length - 1],
    ["bytes=1048576-", 1048576, bytes.length - 1],
  ] as const) {
    const r = await media.handle(new Request(url, { headers: { range } }));
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(
      `bytes ${start}-${end}/${bytes.length}`,
    );
    expect(Buffer.from(await r.arrayBuffer())).toEqual(
      bytes.subarray(start, end + 1),
    );
  }
  const count = calls.length;
  const head = await media.handle(new Request(url, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(calls).toHaveLength(count);
  for (const range of [
    "bytes=-0",
    "bytes=12-5",
    "bytes=999999999-",
    "bytes=0-1,3-4",
    "bytes=1.5-2",
    "bytes=9007199254740993-",
  ]) {
    expect(
      (await media.handle(new Request(url, { headers: { range } }))).status,
    ).toBe(416);
  }
  expect(
    (await media.handle(new Request(url, { method: "POST" }))).status,
  ).toBe(405);
  await media.dispose();
});

test("媒体取消、释放、作品切换和在途打开均不继续交付旧字节", async () => {
  const { media, calls, deactivate } = setup();
  const { url } = await media.open({
    asset_id: "asset-test",
    revision: 1,
    sha256: "a".repeat(64),
  });
  const r = await media.handle(new Request(url));
  const reader = r.body!.getReader();
  await reader.read();
  await reader.cancel();
  const reads = calls.filter((c) => c.method === "media/read").length;
  await Promise.resolve();
  expect(calls.filter((c) => c.method === "media/read")).toHaveLength(reads);
  await media.release(url);
  expect((await media.handle(new Request(url))).status).toBe(404);
  expect(calls.some((c) => c.method === "media/close")).toBe(true);
  await expect(media.open({ file_path: "/arbitrary" })).rejects.toThrow(
    "固定素材",
  );
  const old = await media.open({
    asset_id: "asset-test",
    revision: 1,
    sha256: "a".repeat(64),
  });
  deactivate();
  expect((await media.handle(new Request(old.url))).status).toBe(410);
  await media.dispose();

  let resolve!: (value: any) => void;
  const closed: string[] = [];
  const pending = new MediaAccess(
    { workspace_id: "w", kind: "novel", object_id: "n" },
    {
      request: (method: string, input: any) =>
        method === "media/open"
          ? new Promise((r) => {
              resolve = r;
            })
          : (closed.push(input.token), Promise.resolve(null)),
    } as any,
    () => true,
  );
  const open = pending.open({
    asset_id: "asset-test",
    revision: 1,
    sha256: "a".repeat(64),
  });
  await pending.dispose();
  resolve({ token: "old-token" });
  await expect(open).rejects.toThrow("已关闭");
  expect(closed).toEqual(["old-token"]);
});
