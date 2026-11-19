import { app, dialog, shell, clipboard } from "electron";

export async function runDialogUtility() {
  try {
    let bytes="";
    for await(const chunk of process.stdin){bytes+=chunk.toString();if(Buffer.byteLength(bytes)>65536)throw new Error("原生交互输入超过预算。");}
    const {kind,options}=JSON.parse(bytes);
    await app.whenReady();
    let value:any;
    if(kind==="confirm")value=(await dialog.showMessageBox({type:"question",buttons:["取消",options.accept??"确认"],defaultId:0,cancelId:0,message:options.message,detail:options.detail})).response===1;
    else if(kind==="choose_file"){const result=await dialog.showOpenDialog(options);value=result.canceled?null:result.filePaths[0];}
    else if(kind==="save_file"){const result=await dialog.showSaveDialog(options);value=result.canceled?null:result.filePath;}
    else if(kind==="copy"){if(typeof options.text!=="string"||options.text.length>100000)throw new Error("复制内容无效。");clipboard.writeText(options.text);value=true;}
    else if(kind==="external"){const url=new URL(options.url);if(url.origin!=="https://hetu.limeai.run"||url.pathname!=="/console/"||url.username||url.password)throw new Error("模型账号地址无效。");await shell.openExternal(url.href);value=true;}
    else if(kind==="reveal"){shell.showItemInFolder(options.directory);value=true;}
    else throw new Error("未知原生交互。");
    process.stdout.write(JSON.stringify({ok:true,value})+"\n");
  }catch(error){process.stdout.write(JSON.stringify({ok:false,message:(error as Error).message})+"\n");}
  app.exit(0);
}
