import type {WorkRef} from "@hetu/plugin-sdk";
export type DocumentResultReference={document_id:string;revision_id:string;sha256:string};
export type VideoResultReference={video_episode_id:string;media_ref:{media_id:string;revision:number;sha256:string}};
export type PluginResultReference={owner_plugin_id:string;object_id:string;revision:number;sha256:string};
export type SessionResult={
 id:string;turn_id:string;kind:"document"|"resource"|"submission"|"bundle"|"work"|"video"|"plugin";
 title:string;reference:Record<string,any>;work_ref:WorkRef;
 state:"verified"|"unavailable";message?:string;
};
export type SessionResults={items:SessionResult[];unread:number};
