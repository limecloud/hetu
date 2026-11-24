import type { WorkRef } from "@hetu/plugin-sdk";

export const writingTools = [
  { id: "write", label: "写作", description: "围绕当前章节继续创作", goal: "围绕当前章节继续写作，先读取当前正文、卷章结构和固定设定，再准备可继续编辑的参考稿。" },
  { id: "polish", label: "扩写润色", description: "扩展细节并保持原有语气", goal: "对当前选区或章节进行扩写润色，保留人物、视角、时态和原有语气；先展示差异，不覆盖作者稿。" },
  { id: "continue", label: "续写", description: "接续当前段落或场次", goal: "接续当前章节或分集，先核对上一段的固定上下文、设定和未解决线索，再准备续写参考稿。" },
  { id: "outline", label: "章纲", description: "梳理本章目标和节拍", goal: "整理当前章节的章纲、目标、冲突、节拍和收束，引用当前卷纲与设定，不直接改写正文。" },
  { id: "review", label: "审稿纠错", description: "检查逻辑、表达和一致性", goal: "审阅当前章节的逻辑、表达、人物和设定一致性，返回带固定依据的检查结果和可选修改建议。" },
  { id: "adapt", label: "剧本改编", description: "从当前内容准备分集场次", goal: "将当前内容准备为剧本改编方案，先确认原文版本、人物、场景和时序，再生成分集与场次参考稿。" },
] as const;

export type WritingTool = typeof writingTools[number];
export type WritingPromptRequest = {
  work_ref: WorkRef;
  tool_id: WritingTool["id"];
  object_ref: { document_id: string; revision_id: string; byte_start?: number; byte_end?: number; quote?: string };
};
export const toolsForWork = (kind: WorkRef["kind"]) => writingTools.filter(tool => kind === "novel" || (kind === "drama" && tool.id !== "adapt"));
