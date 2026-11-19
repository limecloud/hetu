import React from "react";
export interface VideoFeedbackValue {comment:string;start:string;end:string;ranged:boolean}
/** 固定媒体上的意见输入共用；保存、费用及作者决定留在宿主应用用例。 */
export function VideoFeedbackFields({value,disabled,onChange,onPosition}:{value:VideoFeedbackValue;disabled?:boolean;onChange(change:Partial<VideoFeedbackValue>):void;onPosition?(edge:"start"|"end"):void}) {
  return <fieldset disabled={disabled} className="baseline-editor-fields">
    <label><input type="checkbox" checked={value.ranged} onChange={event=>onChange({ranged:event.target.checked})}/>指定片段</label>
    {value.ranged&&<div className="surface-filters"><label>开始（秒）<input aria-label="意见开始秒数" type="number" min="0" step="0.001" value={value.start} onChange={event=>onChange({start:event.target.value})}/></label>{onPosition&&<button onClick={()=>onPosition("start")}>以当前位置为开始</button>}<label>结束（秒）<input aria-label="意见结束秒数" type="number" min="0" step="0.001" value={value.end} onChange={event=>onChange({end:event.target.value})}/></label>{onPosition&&<button onClick={()=>onPosition("end")}>以当前位置为结束</button>}</div>}
    <textarea aria-label="视频修改意见" placeholder="例如：先听到脚步声，再切到门口。" value={value.comment} onChange={event=>onChange({comment:event.target.value})}/>
  </fieldset>;
}
