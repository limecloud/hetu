import React from "react";
import {ManuscriptSearch as SharedSearch} from "@hetu/workbench-ui/manuscript-search";
import {WorkTextSearch, type WorkTextMatch} from "./work-text-search.tsx";

/** 作品读取留在宿主；当前稿查找不接触机器权限或业务桥接。 */
export function ManuscriptSearch({documents, openWorkMatch, ...props}: Omit<React.ComponentProps<typeof SharedSearch>, "workSearch"> & {
  documents: {document_id: string; title: string}[]; openWorkMatch: (match: WorkTextMatch) => Promise<void>;
}) {
  return <SharedSearch {...props} workSearch={options => <WorkTextSearch options={options} documents={documents} language={props.language} open={openWorkMatch}/>}/>;
}
