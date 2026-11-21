/** Fountain的显示投影；所有范围指向原始UTF-16字符串，不修改或重新序列化原稿。 */
export type FountainKind = "blank" | "action" | "scene" | "character" | "dialogue" | "parenthetical" | "transition" | "centered" | "section" | "synopsis" | "note" | "page_break" | "lyric";
export type FountainLine = {kind:FountainKind;from:number;to:number;textFrom:number;textTo:number;number?:string;level?:number;dual?:boolean};
export type FountainMetadata = {key:string;value:string};
export type FountainScript = {lines:FountainLine[];metadata:FountainMetadata[]};

const scenePattern=/^(?:INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.)(?:\s|$)/i;
const titleKey=/^([A-Za-z][A-Za-z -]*):[ \t]*(.*)$/;

export function parseFountain(source:string):FountainScript {
  const raw:{from:number;to:number;text:string}[]=[];
  for(const match of source.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)){
    if(!match[0].length)break;
    raw.push({from:match.index!,to:match.index!+match[1].length,text:match[1]});
  }
  const metadata:FountainMetadata[]=[],lines:FountainLine[]=[];
  let index=0;
  // 只有文首的标题页字段参与元数据解析，正文中的冒号不作为字段。
  if(raw[0]&&titleKey.test(raw[0].text)){
    while(index<raw.length){
      const line=raw[index],field=titleKey.exec(line.text);
      if(field){metadata.push({key:field[1],value:field[2]});index++;}
      else if(/^[ \t]+\S/.test(line.text)&&metadata.length){metadata.at(-1)!.value+="\n"+line.text.trim();index++;}
      else break;
    }
  }
  let dialogue=false,omitted=false;
  for(;index<raw.length;index++){
    const row=raw[index],text=row.text.trim(),previousBlank=index===0||!raw[index-1].text.trim();
    const leading=row.text.indexOf(text),line:FountainLine={kind:"action",from:row.from,to:row.to,textFrom:row.from+leading,textTo:row.from+leading+text.length};
    if(!text){line.kind="blank";dialogue=false;}
    else if(omitted||text.startsWith("/*")){
      line.kind="note";omitted=!text.includes("*/");
      if(text.startsWith("/*"))line.textFrom+=2;
      if(text.endsWith("*/"))line.textTo-=2;
      dialogue=false;
    }else if(text.startsWith("[[")&&text.endsWith("]]")){
      line.kind="note";line.textFrom+=2;line.textTo-=2;
    }else if(/^#{1,6}\s+/.test(text)){
      const prefix=/^(#+)\s+/.exec(text)!;line.kind="section";line.level=prefix[1].length;line.textFrom+=prefix[0].length;dialogue=false;
    }else if(/^={3,}$/.test(text)){line.kind="page_break";dialogue=false;}
    else if(/^=(?!=)/.test(text)){line.kind="synopsis";line.textFrom++;dialogue=false;}
    else if(text.startsWith("!")&&!text.startsWith("!!")){line.textFrom++;dialogue=false;}
    else if(text.startsWith(".")&&!text.startsWith("..")||previousBlank&&scenePattern.test(text)){
      line.kind="scene";if(text.startsWith("."))line.textFrom++;
      const number=/\s+#([^#\r\n]+)#\s*$/.exec(text);
      if(number){line.number=number[1];line.textTo=row.from+leading+number.index;}
      dialogue=false;
    }else if(text.startsWith(">")&&text.endsWith("<")){
      line.kind="centered";line.textFrom++;line.textTo--;dialogue=false;
    }else if(text.startsWith(">")||previousBlank&&/^[A-Z][A-Z .'-]*TO:$/.test(text)){
      line.kind="transition";if(text.startsWith(">"))line.textFrom++;dialogue=false;
    }else if(text.startsWith("@")||previousBlank&&text.length<80&&/[A-Z]/.test(text)&&text===text.toUpperCase()&&!/[.!?:]$/.test(text)&&!!raw[index+1]?.text.trim()){
      line.kind="character";if(text.startsWith("@"))line.textFrom++;
      if(/\s*\^$/.test(text)){line.dual=true;line.textTo-=text.length-text.replace(/\s*\^$/,"").length;}
      dialogue=true;
    }else if(dialogue&&/^\(.*\)$/.test(text)){line.kind="parenthetical";}
    else if(text.startsWith("~")){line.kind="lyric";line.textFrom++;}
    else if(dialogue){line.kind="dialogue";}
    line.textTo=Math.max(line.textFrom,line.textTo);
    lines.push(line);
  }
  return {lines,metadata};
}

/** 不把不同段落或未知正文误认为重复标题；只省略首个同名章节标记。 */
export function screenplayBody(script:FountainScript,source:string,title:string){
  const first=script.lines.find(line=>line.kind!=="blank"&&line.kind!=="note"&&line.kind!=="synopsis");
  const lines=script.lines.filter(line=>line!==first||line.kind!=="section"||source.slice(line.textFrom,line.textTo).trim()!==title.trim());
  while(lines[0]?.kind==="blank")lines.shift();
  while(lines.at(-1)?.kind==="blank")lines.pop();
  return lines;
}

export type FountainRun = {from:number;to:number;style?:"bold"|"italic"|"underline"|"bold-italic"};
/** 标记只影响样式，文字仍由React转义；每段保留可核验的原文范围。 */
export function fountainRuns(source:string,from:number,to:number):FountainRun[]{
  const result:FountainRun[]=[],text=source.slice(from,to);
  const pattern=/\\([\\*_])|\*\*\*([^*\r\n]+)\*\*\*|\*\*([^*\r\n]+)\*\*|\*([^*\r\n]+)\*|_([^_\r\n]+)_/g;
  let cursor=0;
  for(const match of text.matchAll(pattern)){
    if(match.index!>cursor)result.push({from:from+cursor,to:from+match.index!});
    const group=match[1]!==undefined?1:match[2]!==undefined?2:match[3]!==undefined?3:match[4]!==undefined?4:5;
    const prefix=group===1?1:group===2?3:group===3?2:1;
    result.push({from:from+match.index!+prefix,to:from+match.index!+prefix+match[group].length,
      style:group===1?undefined:group===2?"bold-italic":group===3?"bold":group===4?"italic":"underline"});
    cursor=match.index!+match[0].length;
  }
  if(cursor<text.length)result.push({from:from+cursor,to});
  return result;
}
