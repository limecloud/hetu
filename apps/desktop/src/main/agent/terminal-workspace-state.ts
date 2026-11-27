import {createHash} from "node:crypto";
import path from "node:path";
import type {TerminalBinding} from "../../shared/codex-terminal.ts";

/** 会话位置包含确切WorkRef，名称与显示布局不参与身份。 */
export function terminalScopeKey(binding:TerminalBinding){return createHash("sha256").update(JSON.stringify([binding.workspace,binding.accessDirectory,binding.workRef??null,!!binding.localSettings])).digest("hex");}
export function externalSessionDirectory(profile:string,binding:TerminalBinding,id:string,provider:string){return path.join(profile,"external-sessions",terminalScopeKey(binding),id,provider);}
