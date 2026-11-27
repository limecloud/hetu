export type ExternalTeamPane={team_id:string;leader_session_id:string;pane_id:string;role:"leader"|"member"};

export function validExternalTeamPane(value:unknown):value is ExternalTeamPane {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="leader_session_id,pane_id,role,team_id")return false;
  const v=value as ExternalTeamPane,id=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  return id(v.team_id)&&id(v.leader_session_id)&&typeof v.pane_id==="string"&&/^%[1-9]\d{0,5}$/.test(v.pane_id)&&(v.role==="leader"?v.pane_id==="%1":v.role==="member"&&v.pane_id!=="%1");
}
