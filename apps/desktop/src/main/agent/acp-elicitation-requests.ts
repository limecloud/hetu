import type {ConversationEvent} from "./external-conversation-driver.ts";
import {externalFormFields} from "./external-form-schema.ts";
import {boundedExternalElicitation,validateExternalElicitationResponse,type ExternalElicitation,type ExternalElicitationResponse} from "../../shared/external-elicitation.ts";

type WireId=string|number;
type Pending={wire:WireId;request:ExternalElicitation;reply(value:ExternalElicitationResponse):unknown};
type Rpc={respond(id:WireId,result:unknown):void};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export const validAcpRequestId=(value:unknown):value is WireId=>typeof value==="string"&&value.length>0&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value)||typeof value==="number"&&Number.isSafeInteger(value);

/** 原JSON-RPC请求与网页通知分别收敛；打开网页和提供方完成不代替用户决定。 */
export class AcpElicitationRequests {
  #pending=new Map<string,Pending>();
  #urls=new Map<string,{id:string;answered:boolean;completed:boolean}>();
  #notice=0;
  private rpc:Rpc;private event:(value:ConversationEvent)=>void;
  constructor(rpc:Rpc,event:(value:ConversationEvent)=>void){this.rpc=rpc;this.event=event;}
  get size(){return this.#pending.size;}
  has(id:string){return this.#pending.has(id);}
  create(wire:WireId,p:unknown,source:string,reply:(value:ExternalElicitationResponse)=>unknown=value=>value,providerItemId?:string){
    const id=String(wire);
    if(this.#pending.has(id)||this.#pending.size>=16||!object(p))throw Error("ACP表单请求重复、格式无效或超过预算。");
    const mode=p.mode===undefined?"form":p.mode,allowed=mode==="url"?["mode","message","url","elicitationId","sessionId","_meta"]:["mode","message","requestedSchema","sessionId","_meta"];
    if(Object.keys(p).some(key=>!allowed.includes(key)))throw Error("ACP表单包含未接通的请求字段。");
    const base={id,revision:0,title:"外部AI需要你的回答",server:source,message:p.message,...(providerItemId!==undefined?{provider_item_id:providerItemId}:{})};
    let request:ExternalElicitation;
    if(mode==="url"){
      request=boundedExternalElicitation({...base,title:"外部AI请求网页操作",mode:"url",url:p.url,elicitation_id:p.elicitationId});
      if(this.#urls.has(p.elicitationId)||this.#urls.size>=16)throw Error("ACP网页请求身份重复或等待目录超过预算。");
      this.#urls.set(p.elicitationId,{id,answered:false,completed:false});
    }else if(mode==="form"&&object(p.requestedSchema)){
      // ACP的对象表单可省略type；回应合同本身固定为字段对象。
      const schema=Object.hasOwn(p.requestedSchema,"type")?p.requestedSchema:{...p.requestedSchema,type:"object"};
      request=boundedExternalElicitation({...base,mode:"form",fields:externalFormFields(schema)});
    }else throw Error("ACP表单模式尚未接通。");
    this.#pending.set(id,{wire,request,reply});this.event({type:"elicitation",request,standalone:true});
  }
  respond(id:string,response:ExternalElicitationResponse){
    const pending=this.#pending.get(id);if(!pending)throw Error("ACP表单已结束或发生变化。");
    const verified=validateExternalElicitationResponse(pending.request,response);
    this.rpc.respond(pending.wire,pending.reply(verified));this.#pending.delete(id);
    if(pending.request.mode==="url"){
      const key=pending.request.elicitation_id,entry=this.#urls.get(key);
      if(entry){entry.answered=true;if(verified.action==="accept")this.event({type:"message",message:{id:"acp-url-notice-"+(++this.#notice),role:"system",text:entry.completed?"网页请求决定已送达，提供方此前已报告操作完成。":"网页请求决定已送达，等待提供方报告操作结果。"}});if(entry.completed||verified.action!=="accept")this.#urls.delete(key);}
    }
  }
  cancel(wire:unknown){
    if(!validAcpRequestId(wire))return false;
    const id=String(wire),pending=this.#pending.get(id);if(!pending||pending.wire!==wire)return false;
    this.rpc.respond(pending.wire,pending.reply({action:"cancel"}));this.#pending.delete(id);
    if(pending.request.mode==="url")this.#urls.delete(pending.request.elicitation_id);
    this.event({type:"interaction_resolved",id});return true;
  }
  complete(value:unknown){
    if(!object(value)||typeof value.elicitationId!=="string")return;
    const entry=this.#urls.get(value.elicitationId);if(!entry||entry.completed)return;
    entry.completed=true;
    this.event({type:"message",message:{id:"acp-url-notice-"+(++this.#notice),role:"system",text:entry.answered?"提供方已报告网页操作完成。":"提供方已报告网页操作完成，请处理原网页请求的决定。"}});
    if(entry.answered)this.#urls.delete(value.elicitationId);
  }
  clear(){this.#pending.clear();this.#urls.clear();}
}
