import {matchesFixedContextSource,type FixedContextSource} from "./source-reference.ts";

export type SourceRange={byte_start:number;byte_end:number};
export type TextSourcePage=FixedContextSource&{content:string;range:SourceRange;size_bytes:number;complete:boolean;next_range?:SourceRange|null;source_ref:Record<string,unknown>};
export type TextSourceReading={page:TextSourcePage;pages:SourceRange[];loaded_ranges:SourceRange[];loaded_bytes:number;complete:boolean;percentage:number;page_index:number};
const position=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const range=(value:unknown):value is SourceRange=>!!value&&typeof value==="object"&&position((value as SourceRange).byte_start)&&position((value as SourceRange).byte_end)&&(value as SourceRange).byte_end>=(value as SourceRange).byte_start;
const sameRange=(a:SourceRange,b:SourceRange)=>a.byte_start===b.byte_start&&a.byte_end===b.byte_end;

/** 只保存本面板的分页位置与成功载入范围，不推断作者或Agent已读。 */
export function acceptTextSourcePage(previous:TextSourceReading|undefined,expected:FixedContextSource,value:TextSourcePage,requested?:SourceRange):TextSourceReading{
 const invalid=():never=>{throw Error("固定原文的来源或分页范围不一致，请保留当前内容后重试。");};
 if(!value||!matchesFixedContextSource(value,expected)||!position(value.size_bytes)||!range(value.range)||typeof value.content!=="string")invalid();
 const size=value.size_bytes,start=requested?.byte_start??0,end=requested?.byte_end??size;
 if(!position(start)||!position(end)||start>end||end>size||expected.size_bytes!==undefined&&expected.size_bytes!==size)invalid();
 if(value.range.byte_start!==start||value.range.byte_end>end||value.range.byte_end===start&&end>start)invalid();
 if(new TextEncoder().encode(value.content).length!==value.range.byte_end-start)invalid();
 if(value.source_ref?.byte_start!==start||value.source_ref?.byte_end!==value.range.byte_end||value.source_ref?.quote!==value.content)invalid();
 const finished=value.range.byte_end===end;
 if(value.complete!==finished)invalid();
 if(finished?!!value.next_range:!range(value.next_range)||value.next_range.byte_start!==value.range.byte_end||value.next_range.byte_end!==end)invalid();
 if(previous&&(!matchesFixedContextSource(previous.page,expected)||previous.page.size_bytes!==size))invalid();
 const pages=previous?.pages.map(item=>({...item}))??[],known=pages.find(item=>item.byte_start===start);
 if(known&&!sameRange(known,value.range))invalid();
 if(!known)pages.push({...value.range});
 if(pages.length>4096)throw Error("原文分页超过本次读取预算，请回到原任务重新打开。");
 pages.sort((a,b)=>a.byte_start-b.byte_start);
 const loaded=[...(previous?.loaded_ranges??[]),value.range].map(item=>({...item})).sort((a,b)=>a.byte_start-b.byte_start),merged:SourceRange[]=[];
 for(const item of loaded){
  const last=merged.at(-1);
  if(last&&item.byte_start<=last.byte_end)last.byte_end=Math.max(last.byte_end,item.byte_end);else merged.push(item);
 }
 const loaded_bytes=merged.reduce((sum,item)=>sum+item.byte_end-item.byte_start,0),complete=merged.length===1&&merged[0].byte_start===0&&merged[0].byte_end===size;
 return {page:value,pages,loaded_ranges:merged,loaded_bytes,complete,percentage:complete?100:size?Math.min(99,Math.floor(loaded_bytes/size*100)):0,page_index:pages.findIndex(item=>sameRange(item,value.range))};
}

export function previousTextSourceRange(reading:TextSourceReading){return reading.pages[reading.page_index-1];}
export function nextTextSourceRange(reading:TextSourceReading):SourceRange|undefined{
 const start=reading.page.range.byte_end;
 if(start>=reading.page.size_bytes)return undefined;
 return reading.pages.find(item=>item.byte_start===start)??{byte_start:start,byte_end:reading.page.size_bytes};
}
