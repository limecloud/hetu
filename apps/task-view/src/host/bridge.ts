import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import {taskDeepLink, type MessageTarget} from "./openai.ts";
import {canDraft,localMessageCapability,messageMetadata} from "./message.ts";

// 同一标准桥接供任务、作品和操作审阅复用；供应商字段不会进入业务视图。
export function createAppHost(name: string) {
  const app = new App({ name, version: "1.0.0" }, {});
  return Object.assign(app, {
    features() {
      const capabilities = app.getHostCapabilities();
      return {
        tools: !!capabilities?.serverTools,
        resources: !!capabilities?.serverResources,
        messages: !!capabilities?.message?.text,
        drafts: canDraft(capabilities),
        directSend: localMessageCapability(capabilities)?.directSend!==false,
        context: !!capabilities?.updateModelContext?.text,
      };
    },
    sendText(text: string, target: MessageTarget = "active", send = true) {
      if (!app.getHostCapabilities()?.message?.text) throw new Error("宿主不支持消息。");
      return app.sendMessage({ role: "user", content: [{ type: "text", text }], ...messageMetadata(app.getHostCapabilities(), target, send) });
    },
    attachText(text: string) {
      if (!app.getHostCapabilities()?.updateModelContext?.text) throw new Error("宿主不支持附加上下文。");
      return app.updateModelContext({ content: [{ type: "text", text }] });
    },
    taskLink(context = app.getHostContext()) { return taskDeepLink(context); },
  });
}

export type AppHost = ReturnType<typeof createAppHost>;
