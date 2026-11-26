import React,{useState} from "react";

type Language="zh-CN"|"en";
const labels={
 "zh-CN":{description:"说明",summary:"摘要",title:"标题",note:"说明",content:"内容",checks:"核对项"},
 en:{description:"Description",summary:"Summary",title:"Title",note:"Note",content:"Content",checks:"Checks"},
};

function SourceValue({value,language}:{value:unknown;language:Language}){
 const [expanded,setExpanded]=useState(false);
 if(value===null)return <span className="muted">null</span>;
 if(typeof value!=="object")return <p className="source-field-text">{String(value)}</p>;
 const entries=Object.entries(value),array=Array.isArray(value),record=value as Record<string,unknown>;
 const title=!array&&(typeof record.title==="string"?record.title:typeof record.name==="string"?record.name:undefined);
 return <details className="source-field-group" onToggle={event=>{if(event.currentTarget.open)setExpanded(true);}}>
  <summary>{title||(language==="en"?`${entries.length} ${array?"items":"fields"}`:`${entries.length} ${array?"项":"个字段"}`)}</summary>
  {expanded&&<SourceFields value={value} language={language}/>}
 </details>;
}

function SourceFields({value,language}:{value:object;language:Language}){
 const array=Array.isArray(value),text=labels[language];
 return <dl className="source-fields">{Object.entries(value).map(([key,item])=><React.Fragment key={key}>
  <dt>{array?String(Number(key)+1):Object.hasOwn(text,key)?text[key as keyof typeof text]:key}</dt>
  <dd><SourceValue value={item} language={language}/></dd>
 </React.Fragment>)}</dl>;
}

/** 未知Schema按原字段阅读，不执行插件代码或推断专业结论。 */
export function ProfessionalSourceDetails({record,language}:{record:Record<string,unknown>;language:Language}){
 const [raw,setRaw]=useState(false),content=record.content;
 return <>
  <div className="professional-source-content">{content&&typeof content==="object"&&!Array.isArray(content)
   ?<SourceFields value={content} language={language}/>:<SourceValue value={content} language={language}/>}</div>
  <details className="professional-source-raw" onToggle={event=>{if(event.currentTarget.open)setRaw(true);}}>
   <summary>{language==="en"?"Full source data":"完整来源数据"}</summary>
   {raw&&<pre tabIndex={0}>{JSON.stringify(record,null,2)}</pre>}
  </details>
 </>;
}
