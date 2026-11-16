# 人物关系图功能清单

| 功能 | 入口 | 数据 |
| --- | --- | --- |
| 阅读、编辑人物及关系 | 视图 main | relationships |
| 自动排列人物 | 动作 arrange | 固定对象 ID 与原操作键 |
| 保存、历史、检索及导出 | 当前授权的共享专业数据动作 | 本插件、本作品的固定修订 |

机器合同见本包 `plugin.json`。河图安装及作品授权后，经稳定 `hetu.plugin_access.capabilities/invoke` 发现和调用；独立插件运行时也提供 `capabilities` 与 MCP。数据权限为 `objects.read`、`objects.write`，不获得正文修改或其他作品权限。

变更功能时同步更新本文件和包清单。运行验证由本插件维护，宿主清单只提供发现入口。
