import React, {useState} from "react";
import {VideoFeedbackFields,type VideoFeedbackValue} from "@hetu/workbench-ui";
import {object,type RecordValue} from "./gateway.ts";

/** 面板准备确切意见；宿主对话执行原管理方案，受理不冒充已保存。 */
export function VideoFeedback({media,mediaRef,onPrepare,onDirty}:{media:RecordValue;mediaRef:RecordValue;onPrepare(intent:string,references:RecordValue):void;onDirty(value:boolean):void}) {
  const base=object(media.time_base),scale=Number(base.numerator)/Number(base.denominator);
  const [value,setValue]=useState<VideoFeedbackValue>({comment:"",start:"0",end:String(Number(media.duration_ticks)*scale),ranged:false});
  const [error,setError]=useState("");
  function prepare() {
    const start=Number(value.start),end=Number(value.end);
    if(!value.comment.trim())return;
    if(value.ranged&&(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(scale)||scale<=0||start<0||start>=end||end>Number(media.duration_ticks)*scale)){setError("意见区间须在此固定视频时长内。");return;}
    const range=value.ranged?{start_tick:Math.round(start/scale),end_tick:Math.round(end/scale)}:null;
    const fixed={media_ref:mediaRef,time_base:media.time_base,stream_index:media.stream_index,range,public_comment:value.comment.trim()};
    onPrepare("将这条公开视频意见保存到指定固定媒体。先准备包含hetu.video.feedback.save的固定管理方案；按当前对话真实决定执行并回读原记录。意见内容："+value.comment.trim(),fixed);
    onDirty(false);
  }
  return <section className="video-feedback" aria-label="视频修改意见"><h3>修改意见</h3><VideoFeedbackFields value={value} onChange={change=>{const next={...value,...change};setValue(next);onDirty(!!next.comment.trim());setError("");}}/>
    {error&&<p role="alert">{error}</p>}<div className="actions"><button disabled={!value.comment.trim()} onClick={prepare}>交给 Agent 保存意见</button><button onClick={()=>{setValue({...value,comment:""});onDirty(false);setError("");}}>清除草稿</button></div>
  </section>;
}
