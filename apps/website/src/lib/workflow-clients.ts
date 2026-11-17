import codex from '../assets/agents/codex.svg?url';
import claudeCode from '../assets/agents/claude-code.svg?url';
import cursor from '../assets/agents/cursor.svg?url';
import workbuddy from '../assets/agents/workbuddy.svg?url';
import deepseek from '../assets/agents/deepseek.svg?url';
import glm from '../assets/agents/glm.svg?url';
import kimi from '../assets/agents/kimi.svg?url';
import qwen from '../assets/agents/qwen.svg?url';
import openai from '../assets/agents/openai.svg?url';
import anthropic from '../assets/agents/anthropic.svg?url';
import gemini from '../assets/agents/gemini.svg?url';
import doubao from '../assets/agents/doubao.svg?url';
import hunyuan from '../assets/agents/hunyuan.svg?url';

// 保留原始品牌图形；采集来源、版本与摘要见 assets/agents/sources.json。
export const workflowClients = [
  { id: 'codex', name: 'Codex', icon: codex, method: ['Codex Plugin', 'Codex Plugin'] },
  { id: 'claude-code', name: 'Claude Code', icon: claudeCode, method: ['Skills 与 MCP', 'Skills & MCP'] },
  { id: 'cursor', name: 'Cursor', icon: cursor, method: ['Skills 与 MCP', 'Skills & MCP'] },
  { id: 'workbuddy', name: 'WorkBuddy', icon: workbuddy, method: ['Skills 与连接器', 'Skills & connector'] },
] as const;

export type WorkflowClientID = typeof workflowClients[number]['id'];

// 模型品牌与客户端分组展示，不表示河图提供内置模型路由。
export const workflowModels = [
  { name: 'OpenAI', icon: openai },
  { name: 'Anthropic', icon: anthropic },
  { name: 'Gemini', icon: gemini },
  { name: 'DeepSeek', icon: deepseek },
  { name: 'GLM', icon: glm },
  { name: 'Kimi', icon: kimi },
  { name: 'Qwen', icon: qwen },
  { name: 'Doubao', icon: doubao },
  { name: 'Hunyuan', icon: hunyuan },
] as const;
