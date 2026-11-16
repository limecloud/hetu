import { test, expect } from "@playwright/test";
import { readArtworkPage, mergeArtwork, type Artwork } from "../src/renderer/artwork-model.ts";

test("文字任务排在前面时图片库仍能发现后页图片，更多结果保留固定批次", async () => {
  const calls: string[] = [];
  const page = await readArtworkPage(async (method, input) => {
    if (method === "list") {
      calls.push(input.cursor ?? "first");
      return input.cursor ? { tasks: [{ task_kind: "artwork", submission_count: 1, task_ref: { task_id: "image-task" } }], next_cursor: "more" }
        : { tasks: [{ task_kind: "chapter_draft", submission_count: 1 }], next_cursor: "images" };
    }
    return { submission: { submission_id: "old", received_at: "2026-11-15", candidates: [{ kind: "image", candidate_id: "portrait" }] } };
  });
  expect(calls).toEqual(["first", "images"]);
  expect(page?.cursor).toBe("more");
  expect(page?.items).toHaveLength(1);
  const old = page!.items[0]!;
  const latest: Artwork = { ...old, submission_id: "new", received_at: "2026-11-16" };
  const merged = mergeArtwork([old], [old, latest]);
  expect(merged.map(item => item.submission_id)).toEqual(["new", "old"]);
});

test("部分图片无权读取时不把错误当空作品，也不丢弃同页可读成果", async () => {
  const page = await readArtworkPage(async (method, input) => {
    if (method === "list") return { tasks: ["denied", "allowed"].map(task_id => ({ task_kind: "artwork", submission_count: 1, task_ref: { task_id }, brief: task_id })) };
    if (input.task_id === "denied") throw new Error("当前作品授权已撤销");
    return { submission: { submission_id: "batch", received_at: "2026-11-16", candidates: [{ kind: "image", candidate_id: "readable" }] } };
  });
  expect(page?.errors).toEqual(["denied：当前作品授权已撤销"]);
  expect(page?.items.map(item => item.candidate.candidate_id)).toEqual(["readable"]);
});

test("切换作品后迟到的目录响应不继续读取旧作品图片", async () => {
  let active = true;
  const calls: string[] = [];
  const page = await readArtworkPage(async method => {
    calls.push(method); active = false;
    return { tasks: [{ task_kind: "artwork", submission_count: 1 }] };
  }, undefined, () => active);
  expect(page).toBeUndefined();
  expect(calls).toEqual(["list"]);
});
