import type {ExternalProtocol} from "../../shared/external-ai.ts";
import type {ConversationEvent,ExternalConversationDriver} from "./external-conversation-driver.ts";
import {AcpConversationDriver} from "./acp-conversation-driver.ts";
import {ClaudeConversationDriver} from "./claude-conversation-driver.ts";
import {PiConversationDriver} from "./pi-conversation-driver.ts";
import type {AcpLaunchPreparation} from "./acp-launch-preparation.ts";

type Options={binary:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;mcpServer:{command:string;args:string[]};instructions?:string;acp?:AcpLaunchPreparation;event(value:ConversationEvent):void};
const factories:Partial<Record<ExternalProtocol,(options:Options)=>ExternalConversationDriver>>={
  acp:options=>new AcpConversationDriver(options),
  "claude-stream-json":options=>new ClaudeConversationDriver(options),
  "pi-rpc":options=>new PiConversationDriver(options),
};
export function hasExternalProtocol(protocol:ExternalProtocol|undefined){return !!protocol&&Object.hasOwn(factories,protocol);}
export function createConversationDriver(protocol:ExternalProtocol,options:Options){const factory=factories[protocol];if(!factory)throw Error("结构化协议适配尚未接通。");return factory(options);}
