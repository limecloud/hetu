type Node = {id:string;label:string;x:number;y:number};
type Edge = {source:string;target:string;label:string};

/** 只组织显示，不修改专业对象的坐标或关系。完整标签仍由title与列表呈现。 */
export function labelLines(value:string,width:number,limit=2):string[] {
  const characters=[...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(value)].map(item=>item.segment);
  const lines=[];
  for(let index=0;index<characters.length&&lines.length<limit;index+=width)
    lines.push(characters.slice(index,index+width).join(""));
  if(characters.length>width*limit)lines[limit-1]=characters.slice(width*(limit-1),width*limit-1).join("")+"…";
  return lines.length?lines:[""];
}

export function relationshipGeometry(content:{nodes:Node[];edges:Edge[]}) {
  const nodes=new Map(content.nodes.map(node=>[node.id,node])),lanes=new Map<string,number>();
  const bounds=content.nodes.flatMap(node=>[{x:node.x-70,y:node.y-25},{x:node.x+70,y:node.y+25}]);
  const edges=content.edges.flatMap(edge=>{
    const from=nodes.get(edge.source),to=nodes.get(edge.target);
    if(!from||!to)return [];
    const key=JSON.stringify([edge.source,edge.target].sort()),lane=lanes.get(key)??0;lanes.set(key,lane+1);
    const dx=to.x-from.x,dy=to.y-from.y,distance=Math.hypot(dx,dy);
    const lift=48+Math.max(0,distance/240-1)*36+lane*44;
    const sign=dx<0?-1:1,nx=distance?dy/distance*sign:0,ny=distance?-dx/distance*sign:-1;
    const middle={x:(from.x+to.x)/2,y:(from.y+to.y)/2};
    const control={x:middle.x+nx*lift*2,y:middle.y+ny*lift*2};
    const label={x:middle.x+nx*(lift+12),y:middle.y+ny*(lift+12)};
    const lines=labelLines(edge.label,14);
    const path=distance?`M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`:
      `M ${from.x-30} ${from.y-20} C ${from.x-110-lane*40} ${from.y-lift*3} ${from.x+110+lane*40} ${from.y-lift*3} ${from.x+30} ${from.y-20}`;
    if(!distance){label.y=from.y-lift*2-12;bounds.push({x:from.x-110-lane*40,y:from.y-lift*3},{x:from.x+110+lane*40,y:from.y});}
    bounds.push(control,{x:label.x-96,y:label.y-lines.length*8-4},{x:label.x+96,y:label.y+lines.length*8+4});
    return [{...edge,path,position:label,lines}];
  });
  const left=Math.min(0,...bounds.map(point=>point.x))-32,top=Math.min(0,...bounds.map(point=>point.y))-32;
  const right=Math.max(288,...bounds.map(point=>point.x))+32,bottom=Math.max(128,...bounds.map(point=>point.y))+32;
  return {edges,viewBox:`${left} ${top} ${right-left} ${bottom-top}`};
}
