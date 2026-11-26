/** 叠合纯色祖先表面及opacity；图片／滤镜与未覆盖的视口保留未验证，叠放内容另作像素核对。 */
export function renderedContrast(element: Element) {
  const style = getComputedStyle(element), context = document.createElement("canvas").getContext("2d")!;
  function rgba(value: string) {
    context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  }
  function over(front: number[], back: number[]) {
    const a = front[3] / 255, b = back[3] / 255, alpha = a + b * (1 - a);
    return [...front.slice(0, 3).map((value, index) => alpha ? (value * a + back[index] * b * (1 - a)) / alpha : 0), alpha * 255];
  }
  let foreground = rgba(style.color), background = [0, 0, 0, 0];
  const unresolved = new Set<string>();
  for (let node: Element | null = element; node; node = node.parentElement) {
    const current = getComputedStyle(node), surface = rgba(current.backgroundColor), opacity = Number(current.opacity);
    if (background[3] < 255 && current.backgroundImage !== "none") unresolved.add("background-image");
    if (current.filter !== "none") unresolved.add("filter");
    if (current.mixBlendMode !== "normal") unresolved.add("mix-blend-mode");
    foreground = over(foreground, surface); background = over(background, surface);
    foreground[3] *= opacity; background[3] *= opacity;
  }
  const luminance = (channels: number[]) => channels.slice(0, 3).map(value => {
    const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const [a, b] = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
  return {raw: {background: style.backgroundColor, foreground: style.color}, background, foreground, contrast: (b + .05) / (a + .05), opacity: style.opacity, unresolved: [...unresolved]};
}
