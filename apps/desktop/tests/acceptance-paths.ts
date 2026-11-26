import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const suffix = process.platform === "win32" ? ".exe" : "";

export function fixtureBinary(name: string) {
  return path.join(process.env.HETU_ACCEPT_FIXTURE_DIRECTORY ?? path.join(root, "target/debug/examples"), name + suffix);
}

export function machineBinary(name: string) {
  const directory = process.env.HETU_ACCEPT_MCP_BINARY
    ? path.dirname(process.env.HETU_ACCEPT_MCP_BINARY)
    : process.env.HETU_PACKAGED_APP
      ? process.platform === "darwin"
        ? path.resolve(process.env.HETU_PACKAGED_APP, "../../Resources/bin")
        : path.join(path.dirname(process.env.HETU_PACKAGED_APP), "resources/bin")
    : path.join(root, "target/debug");
  return path.join(directory, name + suffix);
}
