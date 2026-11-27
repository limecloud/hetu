import type {ExternalApproval,ExternalMessage,ExternalQuestionRequest,ExternalAnswers,ExternalModel,ExternalContextUsage,ExternalRunOutcome,ExternalConversationCapabilities,ExternalHistoryPage,ExternalForkOrigin,ExternalConfigurationOption,ExternalRewindOrigin} from "../../shared/external-session.ts";
import type {ExternalImageAttachment} from "../../shared/external-attachment.ts";
import type {ExternalElicitation,ExternalElicitationResponse} from "../../shared/external-elicitation.ts";
import type {ExternalBackgroundPage,ExternalBackgroundRef,ExternalBackgroundStopResult} from "../../shared/external-background.ts";
import type {ExternalCommandCatalog} from "../../shared/external-command.ts";
import type {ExternalInstallation} from "../../shared/external-installation.ts";

export type ConversationEvent=
  |{type:"installation";value:ExternalInstallation}
  |{type:"identity";id:string}
  |{type:"turn";id:string}
  |{type:"message";message:ExternalMessage}
  |{type:"history";page:ExternalHistoryPage}
  |{type:"history_changed"}
  |{type:"catalog"}
  |{type:"commands_changed"}
  |{type:"run_failure";turn_id:string;error:string}
  |{type:"background_changed"}
  |{type:"delta";id:string;text:string;turn_id?:string}
  |{type:"approval";approval:ExternalApproval;standalone?:boolean}
  |{type:"question";request:ExternalQuestionRequest}
  |{type:"elicitation";request:ExternalElicitation;standalone?:boolean}
  |{type:"interaction_resolved";id:string}
  |{type:"context";usage:ExternalContextUsage}
  |{type:"complete";outcome?:ExternalRunOutcome;error?:string}
  |{type:"closed";error?:string};
/** 应用用例依赖提供方能力端口；适配器持有协议、请求ID和进程。 */
export interface ExternalConversationDriver {
  readonly connected:boolean;
  readonly processId:number|undefined;
  readonly sessionId:string|undefined;
  readonly models:ExternalModel[];
  readonly capabilities?:ExternalConversationCapabilities;
  readonly configuration?:ExternalConfigurationOption[];
  readonly commandCatalog?:ExternalCommandCatalog;
  open(resumeId?:string,fork?:ExternalForkOrigin):Promise<void>;
  send(text:string,model?:string,effort?:string,images?:ExternalImageAttachment[]):Promise<void>;
  interrupt():Promise<void>;
  approve(id:string,option:string):Promise<void>;
  answer?(id:string,answers:ExternalAnswers):Promise<void>;
  respond?(id:string,response:ExternalElicitationResponse):Promise<void>;
  compact?():Promise<void>;
  history?(cursor?:string):Promise<ExternalHistoryPage>;
  prepareFork?(turnId:string):Promise<Pick<ExternalForkOrigin,"source_directory"|"checkpoint_id"|"checkpoint_token"|"target_provider_session_id">>;
  prepareRewind?(beforeTurnId:string):Promise<ExternalRewindOrigin>;
  rewind?(beforeTurnId:string,origin?:ExternalRewindOrigin):Promise<ExternalHistoryPage>;
  recoverRewind?(origin:ExternalRewindOrigin):Promise<ExternalHistoryPage>;
  configure?(id:string,value:string|boolean):Promise<void>;
  command?(name:string,argument:string,revision:number,model?:string,effort?:string):Promise<void>;
  background?(cursor?:string):Promise<ExternalBackgroundPage>;
  stopBackground?(ref:ExternalBackgroundRef,inspectOnly?:boolean):Promise<ExternalBackgroundStopResult>;
  close():Promise<void>;
}
