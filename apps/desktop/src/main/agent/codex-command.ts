import path from "node:path";
import {engineSearchEnvironment,runnableCommand,executableCandidates} from "./command-resolution.ts";

/** Finder启动沿共享Shell寻址，显式覆盖保持唯一，不自动安装程序。 */
export async function resolveCodexCommand(runtimeDirectory?: string): Promise<{ binary: string; env: NodeJS.ProcessEnv }> {
  const override = process.env.HETU_CODEX_BIN;
  const {paths,env} = await engineSearchEnvironment(runtimeDirectory);
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [...executableCandidates(override??name,paths), ...(!override&&process.platform === "darwin" ? ["/Applications/Codex.app/Contents/Resources/codex"] : [])];
  for (const candidate of candidates) {
    if(!await runnableCommand(candidate))continue;
    return {binary:candidate,env:{...env,PATH:[path.dirname(candidate),...paths].join(path.delimiter)}};
  }
  throw new Error("未找到可执行的Codex CLI。请安装Codex，或通过HETU_CODEX_BIN指定已安装的可执行文件；安装和登录后可继续原会话。");
}
