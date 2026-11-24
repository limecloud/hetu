import type {WorkRef} from "@hetu/plugin-sdk";

export type CreativeIntent="discuss"|"read"|"develop"|"revise"|"deliver";
export const creativeParticipation="先采用能完成目标的最简单方式。临时构思可直接回答，不自动建作品或任务；只读查询返回固定引用和覆盖后停止。作者明确要求保留或需要持续恢复时才保存必要成果，不复制全部聊天。作品可以从片段开始，不强制完整设定或大纲。有权限、任务需要和保存价值分别判断；auto支持明确范围内连续执行，不代表作者已认可所有生成。已在对话作出的确切决定由机器执行，无需桌面重复点击。";
export function creativeRequest(input:{intent:CreativeIntent;goal:string;preserve?:string;work?:WorkRef;context?:string}){
  const goal=input.goal.trim(),preserve=input.preserve?.trim();
  if(!goal||goal.length>6000||preserve&&preserve.length>3000)throw Error("请填写创作目标，并保留必要的修改要求。");
  const instructions:Record<CreativeIntent,string>={
    discuss:"本次先讨论，不创建作品、章节、任务或正式设定，也不自动保存对话。当前上下文足够时直接回答；需要作品依据时只读取相关内容。作者明确要求保留或需要持续恢复后，再按实际能力保存。",
    read:"本次只读查阅。按需要定位固定原文、设定、来源及已有决定，回答并说明引用和覆盖。不创建任务、参考稿、写入计划或正式内容；查到所需信息后停止。",
    develop:"从当前创作需要开始，不强制补齐完整设定、大纲或空的上游作品。按需读取必要来源；作者要求保留或需要持续恢复时沿已有任务保存参考成果。现实考据、已确定设定与探索方案分别表达。",
    revise:"沿已有稿件和公开意见继续，先固定必要修订、作者决定及修改范围。保留未修改内容，冲突明确提出；不擅自改变正典或登记例外。交回可比较的参考稿并回读，采纳与定稿依据作者的确切决定执行。",
    deliver:"固定作者所选版本和必要依赖，核验实际文件及可取回内容。只包含本次交付所需材料，不默认打包聊天、临时脚本和所有候选；发布另行决定。",
  };
  return [goal,preserve?"需保留的内容与限制："+preserve:undefined,input.work?"当前作品："+JSON.stringify(input.work):undefined,input.context?"以下固定上下文仅用于定位与依据，不扩大本次目标：\n"+input.context:undefined,instructions[input.intent]].filter(Boolean).join("\n\n");
}
