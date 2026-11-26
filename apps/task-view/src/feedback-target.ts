import type {MappedSelection,TaskFeedbackTarget} from "@hetu/workbench-ui";

export type FeedbackTarget=TaskFeedbackTarget;

/** 可见选区相对当前片段；公开反馈固定原对象的UTF-8范围。 */
export function feedbackTextSelection(target:FeedbackTarget,content:string,selection:MappedSelection,offset=0):FeedbackTarget{
 const {byte_start:start,byte_end:end,quote}=selection;
 const invalid=():never=>{throw Error("所选文字与原文不一致，请重新选择。");};
 if(target.kind==="candidate"&&target.image_region)invalid();
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||!Number.isSafeInteger(offset)||start<0||end<=start||offset<0||!Number.isSafeInteger(offset+end))invalid();
 const bytes=new TextEncoder().encode(content),quoted=new TextEncoder().encode(quote);
 if(end>bytes.length||end-start!==quoted.length)invalid();
 if(quoted.length>16*1024)throw Error("所选内容过长，请缩小范围后提意见。");
 try{if(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(start,end))!==quote)invalid();}catch{invalid();}
 return {...target,range:{byte_start:offset+start,byte_end:offset+end,quote}};
}
