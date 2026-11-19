import React, { useEffect, useState } from "react";
import type { WorkRef } from "@hetu/plugin-sdk";
import { desktop, data } from "./bridge.ts";

import { WorkCoverPreview } from "@hetu/workbench-ui";
export { WorkCoverPreview } from "@hetu/workbench-ui";

/** 默认书封只作展示，已选封面始终读取当前作品的固定来源。 */
export function WorkCover({ work, title, author = "", compact = false }: { work: WorkRef; title: string; author?: string; compact?: boolean }) {
  const [value, setValue] = useState<any>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("hetu:cover-changed", refresh);
    return () => window.removeEventListener("hetu:cover-changed", refresh);
  }, []);
  useEffect(() => {
    let active = true;
    setValue(undefined); setError("");
    if (work.kind === "novel") void desktop.read("hetu.covers.get", { work_ref: work })
      .then((result) => { if (active) setValue(data(result)); })
      .catch((error) => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [work.workspace_id, work.object_id, work.kind, revision]);
  return <WorkCoverPreview defaultCovers={(window as any).hetuWorkbenchAssets?.covers} work={work} title={title} author={author} compact={compact} preview={value?.preview} presentation={value?.cover?.presentation} error={error}/>;
}
