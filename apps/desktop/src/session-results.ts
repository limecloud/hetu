import type {WorkRef} from "@hetu/plugin-sdk";
export type SessionResult={
 id:string;turn_id:string;kind:"document"|"resource"|"submission"|"bundle"|"work";
 title:string;reference:Record<string,any>;work_ref:WorkRef;
 state:"verified"|"unavailable";message?:string;
};
export type SessionResults={items:SessionResult[];unread:number};
