export type ExternalBackgroundRef={process_id:string;item_id:string;token:string};
export type ExternalBackgroundProcess=ExternalBackgroundRef&{command:string;cwd:string;cpu_percent?:number;rss_kb?:number};
export type ExternalBackgroundPage={processes:ExternalBackgroundProcess[];next_cursor?:string};
export type ExternalBackgroundStopResult={stopped:boolean;already_gone:boolean;exit_confirmed:boolean};

export function validExternalBackgroundRef(value:unknown):value is ExternalBackgroundRef {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="item_id,process_id,token")return false;
  const v=value as ExternalBackgroundRef;
  return [v.process_id,v.item_id].every(value=>typeof value==="string"&&/^[a-zA-Z0-9_.:-]{1,255}$/.test(value))&&typeof v.token==="string"&&/^[a-f0-9]{64}$/.test(v.token);
}

export function validExternalBackgroundStops(value:unknown):value is ExternalBackgroundRef[] {
  return Array.isArray(value)&&value.length<=16&&value.every(validExternalBackgroundRef)&&new Set(value.map(row=>row.process_id)).size===value.length;
}
