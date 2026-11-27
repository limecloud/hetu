import React,{useState} from "react";
import type {ExternalAnswers,ExternalQuestionRequest} from "../shared/external-session.ts";

/** 原请求的选项与自由回答分别保留；不预选、不代答，提交失败保留输入。 */
export function ExternalQuestionForm({request,answer,error}:{request:ExternalQuestionRequest;answer(answers:ExternalAnswers):Promise<unknown>;error(message:string):void}){
  const [selected,setSelected]=useState<ExternalAnswers>({}),[other,setOther]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false);
  return <form className="external-conversation-question" aria-label={request.title} onSubmit={event=>{
    event.preventDefault();if(busy)return;
    const answers=Object.fromEntries(request.questions.map(question=>[question.id,[...(selected[question.id]??[]),...(other[question.id]?.trim()?[other[question.id]]:[])]]));
    setBusy(true);void answer(answers).catch(cause=>error((cause as Error).message)).finally(()=>setBusy(false));
  }}>
    <strong>{request.title}</strong>
    {request.questions.map(question=><fieldset key={question.id} disabled={busy}>
      <legend>{question.title}</legend><p>{question.prompt}</p>
      {question.options.map(option=><label key={option.id}>
        <input type={question.multiple?"checkbox":"radio"} name={request.id+"-"+question.id} value={option.id} checked={selected[question.id]?.includes(option.id)??false} onChange={event=>{
          const values=question.multiple?event.target.checked?[...(selected[question.id]??[]),option.id]:(selected[question.id]??[]).filter(id=>id!==option.id):[option.id];
          setSelected({...selected,[question.id]:values});if(!question.multiple)setOther({...other,[question.id]:""});
        }}/><span>{option.label}{option.description&&<small>{option.description}</small>}</span>
      </label>)}
      {question.allow_other&&<label><span>{question.options.length?"补充回答":"你的回答"}</span><input aria-label={question.title+"：自由回答"} type={question.secret?"password":"text"} autoComplete="off" maxLength={8000} value={other[question.id]??""} onChange={event=>{
        setOther({...other,[question.id]:event.target.value});if(!question.multiple)setSelected({...selected,[question.id]:[]});
      }}/></label>}
    </fieldset>)}
    <button disabled={busy}>{busy?"正在提交…":"提交回答"}</button>
  </form>;
}
