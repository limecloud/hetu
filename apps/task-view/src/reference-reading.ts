import type {FeedbackTarget} from "./feedback-target.ts";
import type {FixedContextSource} from "./source-reference.ts";
import type {SourceRange} from "./source-text.ts";

/** 候选与工作稿共享的固定正文读取合同；各 Owner 验证自己的引用。 */
export type ReferenceText={key:string;title:string;kind:string;target:FeedbackTarget;expected:FixedContextSource;read:(range?:SourceRange)=>Promise<{content:string;sha256:string;range:SourceRange;size_bytes:number;complete:boolean;next_range?:SourceRange|null}>};
