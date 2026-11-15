# 小说导入工作法

## 先理解原稿

TXT、Markdown 检查 UTF-8、带 BOM 的 UTF-16 或 GB18030；自动判断有歧义时指定编码，不用忽略错误的解码。Word 与 EPUB 先提取阅读顺序，保留原始文件，报告格式损失。EPUB 按 spine 读取，不按 ZIP 文件名排序。PDF、扫描件与其他格式由 Agent 选择已获授权的转换能力，转换后仍保留原文件和对应关系，不能假装纯文本提取能够还原图片文字。

检查书名、作者、简介、目录、前言、番外和正文。多个卷都从第一章开始很常见；保留原始标题，以顺序和范围区分，不能按章号或同名标题去重。正文中的“第三回合”不是第三回。默认规则只提出目录候选，最终按样本和异常决定是否使用；不把规则匹配说成理解整书。

## 脚本与固定方案

下面的脚本路径相对于本 Skill 目录；CLI 路径使用当前河图安装实际公布的位置。所有参数均走结构化文件，不在 shell 拼接作品内容。

```bash
python3 scripts/import_novel.py plan --source "作者指定的原稿" --output "持久的导入记录目录"
python3 scripts/import_novel.py status --plan "导入记录目录/plan.json"
python3 scripts/import_novel.py prepare --plan "导入记录目录/plan.json" --cli "河图CLI路径" --management-ref "精确作品引用.json" --collaboration-dir "当前连接目录"
python3 scripts/import_novel.py execute --plan "导入记录目录/plan.json" --cli "河图CLI路径" --management-ref "精确作品引用.json" --collaboration-dir "当前连接目录"
```

`plan` 支持 TXT、Markdown、DOCX、EPUB 和 HTML，输出原文件快照、UTF-8 阅读文本、逐章范围、摘要和警告。格式解析会损失 Word/HTML 的富文本样式，EPUB 不包含未列入 spine 的封面和附件；这些文件保留在原始快照，不伪装成正文。`--encoding`、`--chapter-pattern` 和 `--layout` 供 Agent 核对特殊排版。layout 为 `{"units":[{"title":"章节标题","start":0,"end":100,"volume":"第一卷"}]}`，start/end 是阅读文本的 Python Unicode 字符边界，必须从0连续覆盖全文。未识别可靠标题时仅保留一篇完整原稿并提示核对，不能丢弃正文。

新作品通过公开筹备入口建立；已有作品必须有精确授权。作品和导入记录放在持久目录，不能放进 build、output、临时目录或编译缓存。`prepare` 首先准备分卷，再按有界字节与至多32章准备 `hetu.documents.import_batch`。每批原子保存正文、逐章原字节、转换报告和目录修订，维持 Agent 执行身份。原始文件快照保存在导入记录中；章节原字节由 Core 另行固定。

作者在可信入口批准固定方案后 `execute`。MCP 使用同一 `hetu_prepare_management_operation` 与 `hetu_execute_management_operation` 合同；脚本只是 CLI 编排，不是新的业务事实源。缺动作时报告实际版本，修复并更新河图后沿原记录继续，不改为直接写 .hetu 或通过 GUI 填表。

## 接续与验收

journal 固定作品身份、源摘要、准确输入、方案和执行键。网络或进程中断后先回读原操作；不要换键重发、根据相同章名跳过或覆盖已有正文。已执行批次逐章核对实际修订摘要后推进游标，资料变化、撤权、输入变化均停止并保留原记录。

最终 `status` 显示已核对章节数和剩余数；另回读小说目录核对分卷与顺序。TXT 转为 Markdown 编辑表示时会转义标点，原字节摘要与内部正文修订摘要分别核验，不能要求两种表示的摘要相等。原字节由导入来源和报告固定，内部正文按已执行方案的修订摘要回读。导入不改变定稿状态，来源的出版信息、历史背景和版权声明只按原稿记载，不替作者确认真实性。继续改编时使用固定原文引用，先提交人物、场景和分集取舍，台词、动作保存为独立参考稿。
