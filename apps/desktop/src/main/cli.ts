import { spawn } from "node:child_process";

/** 机器用例继续以 Agent 身份执行；此适配器不提供作者身份参数。 */
export function scopedCli(
  binary: string,
  client: string,
  directory: string | undefined,
  action: string,
  input: unknown,
): Promise<any> {
  const bytes = JSON.stringify(input),
    budget = 8 * 1024 * 1024;
  if (Buffer.byteLength(bytes) > budget)
    return Promise.reject(new Error("请求超过机器入口预算。"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "--client",
        client,
        ...(directory ? ["--collaboration-dir", directory] : []),
        "call",
        action,
        "--input",
        "-",
      ],
      { shell: false, windowsHide: true, stdio: "pipe" },
    );
    let output = Buffer.alloc(0),
      settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail("机器入口结果未知，请沿原操作键回读。"),
      30000,
    );
    child.stdout.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > budget) fail("机器入口输出超过预算。");
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", () => fail("无法启动独立 Rust CLI，请检查当前制品。"));
    child.on("close", () => {
      if (settled) return;
      try {
        const result = JSON.parse(output.toString("utf8"));
        if (typeof result.status !== "string") throw new Error();
        settled = true;
        clearTimeout(timer);
        resolve(result);
      } catch {
        fail("未取得机器入口回执，请保留原操作后查询。");
      }
    });
    child.stdin.end(bytes);
  });
}
