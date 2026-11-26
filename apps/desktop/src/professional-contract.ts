import type {WorkRef,ActionContribution,SkillContribution,TypeContribution} from "@hetu/plugin-sdk";

export type ProfessionalPlugin={id:string;package_sha256:string;state:string;version:string;display:Record<string,string>;description:Record<string,string>;work_kinds?:WorkRef["kind"][];reason?:string};
export type ProfessionalPackageRef={plugin_id:string;package_sha256:string};
export type ProfessionalRef=ProfessionalPackageRef&{capabilities_sha256:string};
export type ProfessionalSelection={action_id?:string;skill_id?:string;skill_sha256?:string};
export type ProfessionalCapabilities=ProfessionalRef&{work_ref:WorkRef;actions:ActionContribution[];skills:(SkillContribution&{content_sha256:string})[];types:TypeContribution[]};
export type ProfessionalTarget={page:string;object?:Record<string,unknown>};
export type ProfessionalInput={work_ref:WorkRef;plugin?:ProfessionalPackageRef&{capabilities_sha256?:string};selection?:ProfessionalSelection;target?:ProfessionalTarget;goal?:string};
