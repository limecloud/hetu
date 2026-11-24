export type TerminalProgramState="idle"|"working"|"blocked"|"done"|"error"|"clear";

/** Codex公开OSC生命周期信号仅用于输入就绪，不作为业务完成或保存证据。 */
export class TerminalStatus {
  #buffer="";
  state?:TerminalProgramState;
  write(chunk:string) {
    this.#buffer=(this.#buffer+chunk).slice(-4096);
    const expression=/\u001b\]7501;state=(idle|working|blocked|done|error|clear)(?::app=codex[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
    for(const match of this.#buffer.matchAll(expression))this.state=match[1] as TerminalProgramState;
    // 完整信号已消费，尾部可能是下一条尚未收齐的OSC。
    const last=this.#buffer.lastIndexOf("\u001b]");
    this.#buffer=last>=0?this.#buffer.slice(last):this.#buffer.slice(-1);
  }
}
