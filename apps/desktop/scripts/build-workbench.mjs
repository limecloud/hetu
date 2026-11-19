import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import path from "node:path";
export async function buildWorkbench(){
 await build({absWorkingDir:fileURLToPath(new URL("../",import.meta.url)),entryPoints:["src/main/mcp-workbench.ts"],outfile:"dist/mcp-workbench.mjs",bundle:true,platform:"node",target:"node24",format:"esm",banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'}});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))await buildWorkbench();
