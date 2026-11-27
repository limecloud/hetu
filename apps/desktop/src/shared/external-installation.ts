export type ExternalInstallation = {
  status:"supported"|"too_old"|"unknown"|"missing";
  installed_version?:string;
  minimum_versions:string[];
  minimum_version?:string;
  reason?:"timeout"|"output_limit"|"exit"|"unrecognized";
};

type Version={core:string[];pre:string[]};
const versionPattern=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const parse=(value:string):Version=>{const match=versionPattern.exec(value);if(!match)throw Error("CLI版本格式无效。");return {core:match.slice(1,4),pre:match[4]?.split(".")??[]};};
const ascii=(a:string,b:string)=>a===b?0:a<b?-1:1;
const digits=(a:string,b:string)=>{a=a.replace(/^0+(?=\d)/,"");b=b.replace(/^0+(?=\d)/,"");return a.length-b.length||ascii(a,b);};

/** 数字段不转为浮点数；日期版本、预发布和构建标识保留各自语义。 */
export function compareExternalVersions(left:string,right:string){
  const a=parse(left),b=parse(right);
  for(let at=0;at<3;at++){const result=digits(a.core[at],b.core[at]);if(result)return result;}
  if(!a.pre.length||!b.pre.length)return a.pre.length?-1:b.pre.length?1:0;
  for(let at=0;at<Math.max(a.pre.length,b.pre.length);at++){
    const l=a.pre[at],r=b.pre[at];if(l===undefined)return -1;if(r===undefined)return 1;
    const ln=/^\d+$/.test(l),rn=/^\d+$/.test(r),result=ln&&rn?digits(l,r):ln!==rn?ln?-1:1:ascii(l,r);if(result)return result;
  }
  return 0;
}

/** 输出歧义保留unknown，不把多个程序的版本任选为提供方版本。 */
export function externalCliVersion(output:string){
  const values=[...output.matchAll(/(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![\w+-]|\.\w)/g)].map(match=>match[1]);
  const versions=[...new Set(values)];return versions.length===1&&versions[0].length<=128?versions[0]:undefined;
}

/** 每条已核验发布线使用自己的最低版本，不能拿1.x门槛放行过早的2.x。 */
export function externalMinimumVersion(version:string,floors:readonly string[]){
  const major=parse(version).core[0];let selected:string|undefined,earliest:string|undefined;
  for(const floor of floors){
    if(!earliest||compareExternalVersions(floor,earliest)<0)earliest=floor;
    if(digits(parse(floor).core[0],major)<=0&&(!selected||compareExternalVersions(floor,selected)>0))selected=floor;
  }
  return selected??earliest;
}
