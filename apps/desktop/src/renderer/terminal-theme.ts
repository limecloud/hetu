import type { ITheme } from "@xterm/xterm";

/** Canvas不能直接消费CSS变量，在当前浅暗方案下解析共享Radix语义色。 */
export function terminalTheme(tone: "light" | "dark"): ITheme {
  const probe = document.createElement("span"); probe.style.colorScheme = tone; probe.hidden = true; document.body.append(probe);
  const color = (token: string) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
  try {
    return {
      background: color(tone === "dark" ? "--gray-2" : "--white-a12"), foreground: color("--gray-12"), cursor: color("--gray-12"), selectionBackground: color("--gray-6"),
      black: color("--preview-dark-paper"), red: color("--tomato"), green: color("--jade-11"), yellow: color("--amber-11"), blue: color("--blue-11"), white: color("--preview-light-paper"),
      brightBlack: color("--gray-10"), brightRed: color("--tomato"), brightGreen: color("--jade-9"), brightYellow: color("--amber-9"), brightBlue: color("--blue-9"), brightWhite: color("--preview-light-paper"),
    };
  } finally {probe.remove();}
}
