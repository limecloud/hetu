import test from "node:test";
import assert from "node:assert/strict";
import {parseFountain,screenplayBody,fountainRuns} from "../../../packages/workbench-ui/src/fountain.ts";

test("Fountain元素、中文显式人物和原始混合换行范围",()=>{
 const source="Title: 雾港\r\nSource: 固定原著\nLanguage: zh-CN\r\n\r\n# 第一集\r\n\r\n.EXT. 渡口 - NIGHT #1-1#\r\n\r\n江岚走进雨中。\r\n\r\n@江岚 (O.S.)\r\n(压低声音)\r\n船来了吗？🌿\r\n\r\n> CUT TO:\r\n\r\n.未知地点 #1-2#\r\n\r\n> 尾声 <\r\n\r\n= 场景概要\r\n\r\n[[作者备注]]\r\n\r\n===\r\n";
 const parsed=parseFountain(source);
 assert.deepEqual(parsed.metadata,[{key:"Title",value:"雾港"},{key:"Source",value:"固定原著"},{key:"Language",value:"zh-CN"}]);
 const meaningful=parsed.lines.filter(line=>line.kind!=="blank");
 assert.deepEqual(meaningful.map(line=>line.kind),["section","scene","action","character","parenthetical","dialogue","transition","scene","centered","synopsis","note","page_break"]);
 for(const line of parsed.lines)assert(source.slice(line.from,line.to).includes(source.slice(line.textFrom,line.textTo)));
 assert.equal(meaningful[1].number,"1-1");
 assert.equal(source.slice(meaningful[1].textFrom,meaningful[1].textTo),"EXT. 渡口 - NIGHT");
 assert.equal(source.slice(meaningful[3].textFrom,meaningful[3].textTo),"江岚 (O.S.)");
 assert.equal(screenplayBody(parsed,source,"第一集").filter(line=>line.kind==="section").length,0);
 assert.equal(screenplayBody(parsed,source,"另一集").filter(line=>line.kind==="section").length,1);
});

test("未知正文及非标题页冒号保持、同时对白和转义强调保留原文坐标",()=>{
 const source="未知说明：保持原文。\n\n@甲\n左侧对白\n\n@乙 ^\n右侧对白\n\n<script>alert('不得执行')</script>\n\n!INT. 这行是动作\n";
 const parsed=parseFountain(source);
 assert.equal(parsed.metadata.length,0);
 assert.equal(parsed.lines.find(line=>source.slice(line.from,line.to).includes("<script>"))?.kind,"action");
 assert.equal(parsed.lines.find(line=>line.dual)?.kind,"character");
 assert.equal(parsed.lines.at(-1)?.kind,"action");
 const text="甲 **加粗** *斜体* _下划线_ ***加粗斜体*** \\*原样";
 const runs=fountainRuns(text,0,text.length);
 assert.equal(runs.map(run=>text.slice(run.from,run.to)).join(""),"甲 加粗 斜体 下划线 加粗斜体 *原样");
 assert.deepEqual(runs.filter(run=>run.style).map(run=>run.style),["bold","italic","underline","bold-italic"]);
});
