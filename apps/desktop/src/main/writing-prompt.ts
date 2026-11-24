import { sameWork, type WorkRef } from "@hetu/plugin-sdk";
import { toolsForWork, type WritingPromptRequest } from "../writing-prompts.ts";
import { workHandoff, type WorkHandoffContext } from "./workbench-handoff.ts";

export function validateWritingPrompt(input: WritingPromptRequest, work: WorkRef) {
  if (!input || Object.keys(input).some(key => !["work_ref", "tool_id", "object_ref"].includes(key)) || !input.work_ref || !sameWork(input.work_ref, work))
    throw new Error("作品已变化，请重新生成提示词。");
  const tool = toolsForWork(work.kind).find(tool => tool.id === input.tool_id);
  if (!tool) throw new Error("当前作品不支持此写作工具。");
  const ref = input.object_ref;
  if (!ref || Object.keys(ref).some(key => !["document_id", "revision_id", "byte_start", "byte_end", "quote"].includes(key)) || typeof ref.document_id !== "string" || !ref.document_id || typeof ref.revision_id !== "string" || !ref.revision_id)
    throw new Error("请选择已保存的文稿及修订。");
  if (["byte_start", "byte_end", "quote"].some(key => key in ref) &&
    (!Number.isSafeInteger(ref.byte_start) || !Number.isSafeInteger(ref.byte_end) || ref.byte_start! < 0 || ref.byte_end! <= ref.byte_start! || typeof ref.quote !== "string" || !ref.quote))
    throw new Error("请选择完整的原文范围。");
  return tool;
}

/** 任务意图只进入提示词，固定对象仍交给共享 Core 核验。 */
export async function writingPrompt(input: WritingPromptRequest, context: WorkHandoffContext) {
  const tool = validateWritingPrompt(input, context.work);
  const fixed = await workHandoff(context.work.kind, input.object_ref, context);
  return { prompt: `请协助我完成${tool.label}任务。${tool.goal}\n${input.object_ref.quote ? "仅处理下方固定选区，其他内容只作上下文。" : "处理下方固定文稿，先读取完整内容。"}按当前目标发现必要的 Skills 和 CLI/MCP 能力，沿已有任务接续；只提供解释或建议时可以直接回答，不建立空任务。需要持久返工时按实际 Schema 保存参考稿，保留原文、明确约束及未改范围。现实考据、已确定设定和探索方向分别表达，有意差异不能擅自修正。采纳和定稿按我的确切决定执行，已在对话作出的选择不重复要求桌面确认。保存后回读真实结果并给出引用。\n\n${fixed}` };
}
