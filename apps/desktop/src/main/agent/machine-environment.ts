/** 引擎可清理继承环境；只显式交接河图本机Owner及受管运行时位置。 */
const keys=["HETU_COLLABORATION_DIR","HETU_LOCAL_SETTINGS_DIR","HETU_PLUGIN_STATE_DIR","HETU_PLUGIN_NODE","HETU_PLUGIN_MANAGER","HETU_PLUGIN_CLI","HETU_DESKTOP_PROFILE"] as const;
export function machineEnvironment(environment:Record<string,string|undefined>){
 return Object.fromEntries(keys.flatMap(key=>environment[key]?[ [key,environment[key]!] ]:[]));
}
