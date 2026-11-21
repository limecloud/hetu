import {mappedSourceSelection} from "./source-selection.ts";
import React, {forwardRef,useMemo} from "react";
import {fountainRuns,parseFountain,screenplayBody,type FountainLine,type FountainScript} from "./fountain.ts";

const metadataLabels:Record<string,string>={title:"作品",credit:"说明",author:"作者",authors:"作者",source:"来源",language:"语言",date:"日期","draft date":"稿件日期",contact:"联系信息",copyright:"版权"};
export function ScreenplayMetadata({script}:{script:FountainScript}){
  return script.metadata.length?<details className="screenplay-metadata"><summary>稿件信息与来源</summary><dl>{script.metadata.map((item,index)=><React.Fragment key={index}><dt>{metadataLabels[item.key.toLowerCase()]??item.key}</dt><dd>{item.value}</dd></React.Fragment>)}</dl></details>:null;
}

/** 阅读投影与原稿共享固定范围；不执行HTML，不将显示文本当作保存内容。 */
export const ScreenplayText=forwardRef<HTMLElement,React.HTMLAttributes<HTMLElement>&{text:string;title:string;script?:FountainScript}>(({text,title,script:provided,className="",...props},ref)=>{
  const parsed=useMemo(()=>provided??parseFountain(text),[provided,text]);
  const lines=useMemo(()=>screenplayBody(parsed,text,title),[parsed,text,title]);
  const renderLine=(line:FountainLine)=>{
    const runs=fountainRuns(text,line.textFrom,line.textTo);
    const content=runs.map((run,index)=><span key={index} data-source-from={run.from} data-source-to={run.to} className={run.style?"screenplay-"+run.style:undefined}>{text.slice(run.from,run.to)}</span>);
    const attributes={key:line.from,id:"screenplay-line-"+line.from,"data-source-line":line.from,className:"screenplay-line screenplay-"+line.kind};
    if(line.kind==="scene")return <h2 {...attributes}>{line.number&&<span className="screenplay-scene-number" aria-label={"场号 "+line.number}>{line.number}</span>}{content}</h2>;
    if(line.kind==="blank")return <div {...attributes} aria-hidden="true"/>;
    if(line.kind==="page_break")return <hr {...attributes} aria-label="原稿分页标记"/>;
    if(line.kind==="note"||line.kind==="synopsis")return <aside {...attributes}>{content}</aside>;
    return <div {...attributes}>{content}</div>;
  };
  const rows:{kind:"line"|"dialogue"|"dual";lines:FountainLine[];right?:FountainLine[]}[]=[];
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    if(line.kind!=="character"){rows.push({kind:"line",lines:[line]});continue;}
    const dialogue=[line];
    while(index+1<lines.length&&["dialogue","parenthetical","lyric"].includes(lines[index+1].kind))dialogue.push(lines[++index]);
    let previous=rows.length-1;while(previous>=0&&rows[previous].lines.every(row=>row.kind==="blank"))previous--;
    if(line.dual&&rows[previous]?.kind==="dialogue"){
      const first=rows[previous];rows.splice(previous,rows.length-previous,{kind:"dual",lines:first.lines,right:dialogue});
    }else rows.push({kind:"dialogue",lines:dialogue});
  }
  return <article {...props} ref={ref} className={"screenplay-reader "+className}>{rows.map(row=>row.kind==="dual"?<div className="screenplay-dual" key={row.lines[0].from}><div>{row.lines.map(renderLine)}</div><div>{row.right!.map(renderLine)}</div></div>:row.kind==="dialogue"?<div className="screenplay-dialogue-block" key={row.lines[0].from}>{row.lines.map(renderLine)}</div>:row.lines.map(renderLine))}</article>;
});

/** 排版移除标记后，浏览器选区两端仍映射到同一原稿的UTF-8范围。 */
export const selectedScreenplaySource = mappedSourceSelection;
