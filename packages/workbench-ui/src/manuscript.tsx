import React, { forwardRef } from "react";

/** 同一文稿阅读表现；选区和交接由宿主提供，组件不保存作者内容。 */
export const ManuscriptText = forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & {text:string;novel?:boolean}>(({text,novel,className="",...props},ref) =>
  <article {...props} ref={ref} className={"reader"+(novel?" novel-reader":"")+(className?" "+className:"")}>{text}</article>);
