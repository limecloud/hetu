/** 固定方案摘要保留原值；普通界面用具体对象命名，不重复整段机器说明。 */
export function managementTitle(view:any):string{
 if(["hetu.resources.create","hetu.resources.update"].includes(view.action)&&typeof view.preview?.resource?.title==="string")return (view.action.endsWith(".create")?"新建资料":"修改资料")+"「"+view.preview.resource.title+"」";
 return view.summary;
}
