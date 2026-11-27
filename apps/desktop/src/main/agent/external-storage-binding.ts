import path from "node:path";
import {homedir} from "node:os";
import {validExternalStorageBinding,type ExternalStorageBinding,type ExternalProfileBinding} from "../../shared/external-storage-binding.ts";
import {externalDirectoryPath as directoryPath,canonicalExternalDirectory as canonicalDirectory} from "./external-storage-paths.ts";
import {defaultHermesHome,resolveHermesProfile} from "./hermes-profile.ts";

const profileDirectories=new Map<string,[string,string[]]>([
 ["codex",["CODEX_HOME",[".codex"]]],["claude-code",["CLAUDE_CONFIG_DIR",[".claude"]]],["claude-agent-teams",["CLAUDE_CONFIG_DIR",[".claude"]]],
 ["pi",["PI_CODING_AGENT_DIR",[".pi","agent"]]],["omp",["PI_CODING_AGENT_DIR",[".omp","agent"]]],["grok",["GROK_HOME",[".grok"]]],
 ["codebuddy",["CODEBUDDY_CONFIG_DIR",[".codebuddy"]]],["kimi",["KIMI_CODE_HOME",[".kimi-code"]]],["copilot",["COPILOT_HOME",[".copilot"]]],
 ["qwen-code",["QWEN_HOME",[".qwen"]]],["aug",["AUGMENT_CACHE_DIR",[".augment"]]],["cline",["CLINE_DIR",[".cline"]]],["kiro",["KIRO_HOME",[".kiro"]]],
 ["droid",["FACTORY_HOME_OVERRIDE",[]]],
]);
const xdgProviders=new Set(["opencode","opencode2","kilo","mimo-code","devin"]);

/** 只观察选择器及目录位置，不读取账户配置、会话、Token或环境中的凭据。 */
export async function resolveExternalStorageBinding(providerId:string,program:string,env:NodeJS.ProcessEnv,pinnedProfile?:ExternalProfileBinding):Promise<ExternalStorageBinding>{
  const home=directoryPath((process.platform==="win32"?env.USERPROFILE:env.HOME)||homedir());
  const directories:ExternalStorageBinding["directories"]=[];
  const add=async(name:string,fallback:string,variable=name)=>{
    const explicit=env[variable];if(explicit!==undefined&&!explicit.trim())throw Error("外部AI配置目录选择器为空，请核对原配置。");
    const selected=directoryPath(explicit??fallback);directories.push({name,selected,canonical:await canonicalDirectory(selected),source:explicit===undefined?"default":"environment"});return selected;
  };
  await add("HOST_HOME",home,process.platform==="win32"?"USERPROFILE":"HOME");
  const profile=profileDirectories.get(providerId);if(profile)await add(profile[0],path.join(home,...profile[1]));
  let activeProfile:ExternalProfileBinding|undefined;
  if(providerId==="hermes"){
    const selected=await add("HERMES_HOME",env.HERMES_HOME??await defaultHermesHome(home,env));activeProfile=await resolveHermesProfile(selected,pinnedProfile);
  }
  if(xdgProviders.has(providerId)){
    const config=await add("XDG_CONFIG_HOME",path.join(home,".config"));await add("XDG_DATA_HOME",path.join(home,".local","share"));await add("XDG_STATE_HOME",path.join(home,".local","state"));
    if(providerId==="opencode"||providerId==="opencode2"){
      await add("OPENCODE_CONFIG_DIR",path.join(config,"opencode"));if(env.OPENCODE_DB!==undefined)await add("OPENCODE_DB",env.OPENCODE_DB);
    }
    if(providerId==="devin"&&process.platform==="win32")await add("APPDATA",path.join(home,"AppData","Roaming"));
  }
  if(providerId==="goose")await add("GOOSE_PATH_ROOT",path.join(home,".config","goose"));
  // 两个客户端的全局默认值受各自宿主平台控制；只固定实际显式选择器。
  if(providerId==="cursor"&&env.CURSOR_CONFIG_DIR!==undefined)await add("CURSOR_CONFIG_DIR",env.CURSOR_CONFIG_DIR);
  if(providerId==="antigravity"&&env.GEMINI_HOME!==undefined)await add("GEMINI_HOME",env.GEMINI_HOME);
  const binding:ExternalStorageBinding={revision:1,provider_id:providerId,location:"local",program:directoryPath(program),directories,...(activeProfile?{profile:activeProfile}:{})};
  if(!validExternalStorageBinding(binding,providerId))throw Error("外部AI存储目录绑定无效或超过预算。");return binding;
}
