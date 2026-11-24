import type { Terminal } from "@xterm/xterm";

type Renderer = {
  _canvas?: HTMLCanvasElement; _gl?: { canvas?: HTMLCanvasElement }; _devicePixelRatio?: number;
  dimensions?: { device?: { canvas?: { width: number; height: number } } };
  handleDevicePixelRatioChange?: () => void; handleResize?: (cols: number, rows: number) => void;
};
/** 参考Orca的DPR核验方式，许可见assets/licenses/orca-MIT.txt；隔离固定xterm版本的内部适配。 */
export function repairTerminalScale(terminal: Terminal) {
  const renderer = (terminal as unknown as { _core?: { _renderService?: { _renderer?: { value?: Renderer } } } })._core?._renderService?._renderer?.value;
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas;
  const expected = renderer?.dimensions?.device?.canvas;
  const dpr = terminal.element?.ownerDocument.defaultView?.devicePixelRatio;
  if (!renderer || !canvas?.isConnected || !expected?.width || !dpr) return;
  const tolerance = Math.max(1, Math.ceil(dpr / 2));
  if (renderer._devicePixelRatio === dpr && Math.abs(canvas.width - expected.width) <= tolerance && Math.abs(canvas.height - expected.height) <= tolerance) return;
  renderer.handleDevicePixelRatioChange?.(); renderer.handleResize?.(terminal.cols, terminal.rows);
  terminal.clearTextureAtlas(); terminal.refresh(0, terminal.rows - 1);
}
