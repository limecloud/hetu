import {test} from "node:test";
import assert from "node:assert/strict";
import {labelLines,relationshipGeometry} from "../../../plugins/relationships/src/geometry.mts";

test("等距人物的跨节点关系与长标签保持可见，显示不改原坐标",()=>{
 const content={nodes:[{id:"a",label:"江岚",x:150,y:110},{id:"b",label:"父亲",x:390,y:110},{id:"c",label:"母亲",x:630,y:110}],
  edges:[{source:"a",target:"b",label:"父女：灯塔嘱托"},{source:"a",target:"c",label:"母女：船上现身，身份仍需继续核对"}]};
 const before=structuredClone(content),view=relationshipGeometry(content);
 assert.deepEqual(content,before);
 assert.ok(view.edges.every(edge=>edge.position.y<85));
 assert.ok(view.edges[1].position.y<view.edges[0].position.y-32);
 assert.equal(view.edges[1].label,content.edges[1].label);
 assert.equal(view.edges[1].lines.length,2);
 const [left,top,width,height]=view.viewBox.split(" ").map(Number);
 assert.ok(left<=80&&left+width>=700);assert.ok(top<view.edges[1].position.y-16&&top+height>=135);
});

test("平行、反向、零距离与远端人物的关系不产生非法路径，长标签按字素截断",()=>{
 const nodes=[{id:"a",label:"同位人物甲",x:0,y:0},{id:"b",label:"同位人物乙",x:0,y:0},{id:"c",label:"远端人物",x:10000,y:10000}];
 const view=relationshipGeometry({nodes,edges:[{source:"a",target:"b",label:"线索"},{source:"b",target:"a",label:"回应"},{source:"c",target:"a",label:"回忆"},{source:"a",target:"missing",label:"未建立人物"}]});
 assert.equal(view.edges.length,3);assert.notEqual(view.edges[0].position.y,view.edges[1].position.y);
 assert.ok(view.edges.every(edge=>!/(NaN|Infinity)/.test(edge.path)));
 const [left,top,width,height]=view.viewBox.split(" ").map(Number);assert.ok(left<0&&top<0&&left+width>=10070&&top+height>=10025);
 assert.deepEqual(labelLines("👨‍👩‍👧‍👦江岚🌿母亲灯塔",3),["👨‍👩‍👧‍👦江岚","🌿母…"]);
});
