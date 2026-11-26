import React from "react";
import {domainText} from "./domain-text.ts";

type Entity=Record<string,any>;
type Props={entity:Entity;kind?:string;name?(reference:string):string|undefined;language?:"zh-CN"|"en"};
const labels={
 "zh-CN":{aliases:"别名",traits:"特征",parent:"所属地点",none:"无",location:"内外景",unknown:"未标明",calendar:"历法",tick:"时间位置",before:"前置关系",after:"后置关系",type:"规则类型",severity:"严重程度",exception:"例外处理",rationale:"说明",packages:"适用作品",entities:"适用设定",documents:"适用文稿",text:"补充说明",terms:"禁止用语",exceptions:"用语例外",earlier:"较早事件",later:"较晚事件",place:"地点限制",capability:"禁止能力",facts:"人物事实",relations:"势力关系",sources:"来源依据",unattached:"所引设定未附加",documentRef:"文稿",revision:"修订",range:"原文位置",bytes:"字节",evidence:"原文依据"},
 en:{aliases:"Aliases",traits:"Traits",parent:"Parent location",none:"None",location:"Interior or exterior",unknown:"Unspecified",calendar:"Calendar",tick:"Time position",before:"Preceding relations",after:"Following relations",type:"Rule type",severity:"Severity",exception:"Exceptions",rationale:"Rationale",packages:"Work types",entities:"Entries in scope",documents:"Documents in scope",text:"Additional notes",terms:"Prohibited terms",exceptions:"Term exceptions",earlier:"Earlier event",later:"Later event",place:"Location constraint",capability:"Prohibited capability",facts:"Character facts",relations:"Faction relations",sources:"Source evidence",unattached:"Referenced entry not attached",documentRef:"Document",revision:"Revision",range:"Source position",bytes:"bytes",evidence:"Source evidence"},
};

export function CanonSourceEvidence({sources,language="zh-CN"}:{sources?:Entity[];language?:"zh-CN"|"en"}){
 if(!sources?.length)return null;
 const t=labels[language];
 return <div className="canon-sources">{sources.map((source,index)=><div key={index}>
  {source.quote&&<blockquote>{source.quote}</blockquote>}
  <details><summary>{t.evidence} {index+1}</summary><dl className="canon-fields">
   <dt>{t.documentRef}</dt><dd><code>{source.document_id}</code></dd>
   <dt>{t.revision}</dt><dd><code>{source.revision_id}</code></dd>
   <dt>{t.range}</dt><dd>{source.byte_start}–{source.byte_end} {t.bytes}</dd>
  </dl></details>
 </div>)}</div>;
}

/** 只呈现调用方已持有的实体及引用，不为补齐名称读取其他对象。 */
export function CanonEntityDetails({entity,kind,name,language="zh-CN"}:Props){
 const t=labels[language],text=(key:string,fallback:string)=>domainText(key,fallback,language);
 const resolve=(reference:string)=>name?.(reference)||t.unattached;
 const references=(values?:string[])=>(values??[]).map(resolve).join(language==="en"?", ":"、");
 const list=(values?:string[])=>(values??[]).join(language==="en"?", ":"、");
 const field=(label:string,value:React.ReactNode)=>value===undefined||value===null||value===""?null:<React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>;
 return <>
  {entity.description&&<p className="canon-description">{entity.description}</p>}
  {["summary","identity","notes","content"].filter(key=>typeof entity[key]==="string"&&entity[key]).map(key=><p key={key} className="canon-description">{entity[key]}</p>)}
  <dl className="canon-fields">
   {field(t.aliases,list(entity.aliases))}{field(t.traits,list(entity.traits))}
   {kind==="location"&&<>{field(t.parent,entity.parent_ref?resolve(entity.parent_ref):t.none)}{field(t.location,text("location."+entity.interior_exterior,t.unknown))}</>}
   {kind==="event"&&<>{field(t.calendar,entity.time_anchor?.calendar)}{field(t.tick,entity.time_anchor?.tick)}{field(text("timeline.before",t.before),references(entity.before_refs))}{field(text("timeline.after",t.after),references(entity.after_refs))}</>}
   {kind==="rule"&&<>
    {field(t.type,text("rule.type."+entity.type,entity.type))}{field(t.severity,text("rule.severity."+entity.severity,entity.severity))}
    {field(t.exception,text("rule.exception."+entity.exception_policy,entity.exception_policy))}{field(t.rationale,entity.rationale)}
    {field(t.packages,(entity.scope?.packages??[]).map((value:string)=>text("package."+value,value)).join(language==="en"?", ":"、"))}
    {field(t.entities,references(entity.scope?.entity_refs))}
    {field(t.documents,entity.scope?.document_ids?.length?<details><summary>{language==="en"?`${entity.scope.document_ids.length} documents`:`${entity.scope.document_ids.length} 篇文稿`}</summary><ul className="canon-reference-ids">{entity.scope.document_ids.map((id:string)=><li key={id}><code>{id}</code></li>)}</ul></details>:undefined)}
    {field(t.text,entity.parameters?.text)}{field(t.terms,list(entity.parameters?.terms))}{field(t.exceptions,list(entity.parameters?.exceptions))}
    {field(t.earlier,entity.parameters?.before_event_id?resolve(entity.parameters.before_event_id):undefined)}
    {field(t.later,entity.parameters?.after_event_id?resolve(entity.parameters.after_event_id):undefined)}
    {field(t.place,entity.parameters?.location_ref?resolve(entity.parameters.location_ref):undefined)}{field(t.capability,entity.parameters?.forbidden_capability)}
   </>}
   {kind!=="rule"&&field(t.rationale,entity.rationale)}
  </dl>
  {!!entity.facts?.length&&<section className="canon-section"><h3>{t.facts}</h3><div className="canon-facts">{entity.facts.map((fact:Entity)=><div key={fact.fact_id}>
   <strong>{text("fact.predicate."+fact.predicate,fact.predicate)}</strong>
   <p>{fact.predicate==="primary_faction"?resolve(fact.value):fact.predicate==="life_state"?text("fact.life."+fact.value,fact.value):String(fact.value??"")}</p>
   <p className="canon-validity">{language==="en"?`Effective from: ${resolve(fact.valid_from)}${fact.valid_to?`; until: ${resolve(fact.valid_to)}`:"; ongoing"}`:`生效事件：${resolve(fact.valid_from)}${fact.valid_to?`；截止事件：${resolve(fact.valid_to)}`:"；持续有效"}`}</p>
   <CanonSourceEvidence sources={fact.source_refs} language={language}/>
  </div>)}</div></section>}
  {!!entity.relations?.length&&<section className="canon-section"><h3>{t.relations}</h3><dl className="canon-fields">{entity.relations.map((relation:Entity,index:number)=><React.Fragment key={index}>
   <dt>{resolve(relation.target_ref)}</dt><dd>{text("faction.relation."+relation.type,relation.type)}</dd>
  </React.Fragment>)}</dl></section>}
  {!!entity.source_refs?.length&&<section className="canon-section"><h3>{t.sources}</h3><CanonSourceEvidence sources={entity.source_refs} language={language}/></section>}
 </>;
}
