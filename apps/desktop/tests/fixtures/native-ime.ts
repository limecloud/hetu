import {execFileSync} from "node:child_process";

export function selectedKeyboardSources() {
  const preferences = execFileSync("defaults", ["export", "com.apple.HIToolbox", "-"]);
  const selected = execFileSync("plutil", ["-extract", "AppleSelectedInputSources", "xml1", "-o", "-", "--", "-"], {input: preferences});
  const sources = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {input: selected, encoding: "utf8"})) as Record<string, string>[];
  // 系统动态登记的Emoji等辅助源不属于本次键盘源核对。
  return sources.filter(source => ["Input Mode", "Keyboard Layout"].includes(source.InputSourceKind));
}

export function nativeImeInput(pid: number, action: string) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error("需要隔离验收应用的确切PID。");
  return execFileSync("osascript", ["-e", `tell application "System Events"
set frontPid to unix id of (first application process whose frontmost is true)
if frontPid is not ${pid} then error "隔离验收应用未在前台，未发送键盘输入；实际PID：" & frontPid
${action}
end tell`], {encoding: "utf8", timeout: 10000});
}

export function inspectImeCandidate(pid: number, expected: string) {
  const helper = process.env.HETU_NATIVE_IME_HELPER;
  if (!helper) throw Error("需编译只读候选探针并指定HETU_NATIVE_IME_HELPER。");
  const diagnostics = process.env.HETU_NATIVE_IME_DIAGNOSTICS;
  return JSON.parse(execFileSync(helper, [String(pid), "com.sogou.inputmethod.sogou", expected, ...(diagnostics ? [diagnostics] : [])], {encoding: "utf8", timeout: 10000})) as {
    frontmost_matches: boolean; candidate_ready: boolean; candidate_index: number | null; captured_candidate_windows: number; read_failures: number;
  };
}

export function selectImeCandidate(pid: number, index: number) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 9) throw Error("未核验可直接选择的候选序号。");
  // 发送物理数字键；keystroke数字可能被当前输入法追加到拼音而非执行选词。
  return nativeImeInput(pid, "key code " + [18, 19, 20, 21, 23, 22, 26, 28, 25][index - 1]);
}
