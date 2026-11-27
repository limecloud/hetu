import providerCatalog from "../../../../contracts/external-ai/providers.json" with {type:"json"};

export type ExternalSessionMode = "tui" | "structured";
export type ExternalProtocol = "codex-app-server" | "claude-stream-json" | "pi-rpc" | "acp";
export type ExternalProvider = {
  id:string; label:string; commands:readonly string[]; args?:readonly string[];
  requiredCommands?:readonly string[];modelArgs?:readonly string[];
  structured?:{protocol:ExternalProtocol;args:readonly string[];minimumVersions?:readonly string[];versionArgs?:readonly string[]};
  context:"codex"|"claude"|"opencode"|"gemini"|"instructions";
  historyArgs?:readonly string[]; pendingReason?:string;
};

/** 启动合同只描述提供方事实；本机安装、协议握手与实际验收分别报告。 */
export const externalProviders = providerCatalog as readonly ExternalProvider[];
export function externalProvider(id:unknown):ExternalProvider {
  const value=externalProviders.find(provider=>provider.id===id);
  if(!value)throw Error("未知外部AI提供方。");
  return value;
}
export type ExternalProviderAvailability={id:string;label:string;installed:boolean;tui:boolean;structured:boolean;protocol?:ExternalProtocol;structured_minimum_versions?:string[];reason?:string;context:ExternalProvider["context"]};
