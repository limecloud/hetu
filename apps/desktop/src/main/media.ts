import { randomUUID } from "node:crypto";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { AppServer } from "./rpc.ts";

const CHUNK = 512 * 1024;
type Entry = { token: string; media_type: string; size_bytes: number };

function byteRange(
  header: string | null,
  size: number,
): [number, number] | null {
  if (header === null) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const a = Number(match[1]),
    b = Number(match[2]);
  if (![a, b].every(Number.isSafeInteger)) return null;
  const start = match[1] ? a : Math.max(0, size - b),
    end = match[1] && match[2] ? Math.min(b, size - 1) : size - 1;
  return start >= 0 && start < size && end >= start ? [start, end] : null;
}

/** 可信工作台的流式适配器；临时地址与当前作品绑定，不接收文件路径。 */
export class MediaAccess {
  #entries = new Map<string, Entry>();
  #closed = false;
  constructor(
    private work: WorkRef,
    private server: AppServer,
    private active: () => boolean,
  ) {}
  #check(entry?: Entry) {
    if (
      this.#closed ||
      !this.active() ||
      (entry && ![...this.#entries.values()].includes(entry))
    )
      throw new Error("媒体预览已关闭或作品已切换，请重新加载。");
  }
  async open(input: Record<string, unknown>) {
    this.#check();
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["asset_id", "revision", "sha256"].includes(k),
      )
    )
      throw new Error("请提供固定素材版本。");
    const value = await this.server.request("media/open", {
      ...input,
      work_ref: this.work,
    });
    try {
      this.#check();
    } catch (error) {
      await this.server
        .request("media/close", { token: value.token })
        .catch(() => {});
      throw error;
    }
    const key = randomUUID();
    this.#entries.set(key, value);
    return {
      url: `hetu-media://${key}/source`,
      media_type: value.media_type,
      size_bytes: value.size_bytes,
    };
  }
  async release(address: string) {
    if (typeof address !== "string") return;
    const key = [...this.#entries.keys()].find(
      (k) => address === `hetu-media://${k}/source`,
    );
    if (!key) return;
    const entry = this.#entries.get(key)!;
    this.#entries.delete(key);
    await this.server
      .request("media/close", { token: entry.token })
      .catch(() => {});
  }
  async dispose() {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(
      entries.map((entry) =>
        this.server.request("media/close", { token: entry.token }),
      ),
    );
  }
  async handle(request: Request): Promise<Response> {
    try {
      this.#check();
      const url = new URL(request.url),
        entry = this.#entries.get(url.host);
      if (!entry || url.href !== `hetu-media://${url.host}/source`)
        return new Response(null, { status: 404 });
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      const rangeHeader = request.headers.get("range"),
        range = byteRange(rangeHeader, entry.size_bytes);
      if (!range)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${entry.size_bytes}` },
        });
      const [start, end] = range;
      const headers: Record<string, string> = {
        "Content-Type": entry.media_type,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      };
      if (rangeHeader !== null)
        headers["Content-Range"] = `bytes ${start}-${end}/${entry.size_bytes}`;
      if (request.method === "HEAD")
        return new Response(null, {
          status: rangeHeader === null ? 200 : 206,
          headers,
        });
      let offset = start,
        cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            if (cancelled) return;
            this.#check(entry);
            const length = Math.min(CHUNK, end - offset + 1);
            const value = await this.server.request("media/read", {
              token: entry.token,
              offset,
              length,
            });
            if (cancelled) return;
            this.#check(entry);
            const bytes = Buffer.from(value.base64, "base64");
            if (
              value.offset !== offset ||
              value.size_bytes !== length ||
              bytes.length !== length
            )
              throw new Error("媒体分块与固定范围不一致。");
            offset += bytes.length;
            controller.enqueue(new Uint8Array(bytes));
            if (offset > end) controller.close();
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel: () => {
          cancelled = true;
        },
      });
      return new Response(stream, {
        status: rangeHeader === null ? 200 : 206,
        headers,
      });
    } catch {
      return new Response(null, { status: 410 });
    }
  }
}
