import React, {useEffect, useState} from "react";
import {readingText} from "@hetu/workbench-ui";
import {interfaceScales} from "../interface-scale.ts";
import {desktop} from "./bridge.ts";

/** 界面比例仅作用当前原生窗口，不写入正文或跨窗口偏好。 */
export function InterfaceScale({language = "zh-CN"}: {language?: string}) {
  const supported = desktop.windowControls?.interfaceScale !== false;
  const [value, setValue] = useState(100), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const t = (key: Parameters<typeof readingText>[0]) => readingText(key, language);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void desktop.interfaceScale("get").then(value => {if (active) setValue(value);}).catch(() => {if (active) setError(t("reading.ui_scale_error"));});
    const dispose = desktop.onInterfaceScale(value => {if (active) setValue(value);});
    return () => {active = false; dispose();};
  }, [supported]);
  async function apply(value: number) {
    setBusy(true); setError(""); window.dispatchEvent(new Event("hetu:before-interface-scale"));
    try {setValue(await desktop.interfaceScale("set", {value}));}
    catch {setError(t("reading.ui_scale_error"));}
    finally {setBusy(false);}
  }
  if (!supported) return <p className="interface-scale-host">{t("reading.ui_scale_host")}</p>;
  return <div className="interface-scale"><label>{t("reading.ui_scale")}<select aria-label={t("reading.ui_scale")} value={value} disabled={busy} onChange={event => void apply(Number(event.target.value))}>
    {interfaceScales.map(value => <option key={value} value={value}>{value}%</option>)}
  </select></label>{value !== 100 && <button type="button" disabled={busy} onClick={() => void apply(100)}>{t("reading.ui_scale_reset")}</button>}{error && <p role="alert">{error}</p>}</div>;
}
