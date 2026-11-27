export type ExternalImageAttachment={name:string;mime_type:"image/png"|"image/jpeg"|"image/webp"|"image/gif";data:string};
export const externalAttachmentBudget=512*1024;

/** 会话图片按字节交接，不接受任意路径或URL，不借附件读取宿主文件。 */
export function validateExternalImages(value:unknown):ExternalImageAttachment[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>4)throw Error("每次最多发送4张图片。");
  let total=0;
  return value.map(image=>{
    if(!image||typeof image!=="object"||Object.keys(image).some(key=>!["name","mime_type","data"].includes(key))||typeof image.name!=="string"||!image.name||image.name.length>255||/[\x00-\x1f\x7f]/.test(image.name)||typeof image.data!=="string"||image.data.length>Math.ceil(externalAttachmentBudget/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))throw Error("会话图片格式无效或超过预算。");
    const bytes=atob(image.data);total+=bytes.length;
    if(!bytes.length||total>externalAttachmentBudget)throw Error("会话图片总计不能超过512KiB。");
    const mime=bytes.startsWith("\x89PNG\r\n\x1a\n")?"image/png":bytes.startsWith("\xff\xd8\xff")?"image/jpeg":bytes.startsWith("GIF87a")||bytes.startsWith("GIF89a")?"image/gif":bytes.startsWith("RIFF")&&bytes.slice(8,12)==="WEBP"?"image/webp":undefined;
    if(!mime||mime!==image.mime_type||btoa(bytes)!==image.data)throw Error("会话图片内容与声明格式不符。");
    return {name:image.name,mime_type:mime,data:image.data};
  });
}
