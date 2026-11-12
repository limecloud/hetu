# IP Bundle 与素材交付

Bundle 是可核验的文件包，包含固定内容、版本、诊断与来源声明。

## 1. 交付内容

```text
hetu-bundle-<bundle_id>.zip
  manifest.json
  shared/blueprint.json
  novel/                         # 选定章节的确切修订
  drama/skeletons/
  drama/scripts/                 # 默认仅批准剧本
  reports/                       # 一致性、影视化与改编差异
  cues/music/
  cues/visual/
  assets/                        # 明确选择且允许交付的媒体
  provenance/version-log.json
  provenance/reviews.json
  DELIVERY.md                    # 包内阅读说明，由 manifest 投影
```

Bundle 的 `DELIVERY.md` 属于用户导出产物，不是软件仓库新增的根级文档。它描述所选内容、版本、未覆盖项及权利说明，不能宣称未经验证的行业统一标准。

## 2. 导出配置

默认 profile 为 `production_delivery`：选择完整设定集、选定原著、选定骨架与已定稿剧本、相关报告、线索和版本记录。草稿、被驳回版本、内部批注、Token、系统路径、缓存、Git 对象库、恢复日志一律不默认导出。

可选 `review_delivery` 允许待审内容，但必须显著标记状态并由作者额外确认。默认导出不依赖 Git 仓库存在、远端在线或 Agent 已安装。

媒体文件权利状态为 `author_owned|licensed|reference_only|unknown`。默认只嵌入作者拥有或有明确授权且可再分发的文件；未知／仅参考内容导出元数据和排除原因。作者可在明确说明用途与权利风险后选择其他材料，不把软件校验当法律授权。

## 3. manifest 合同

| 字段 | 内容 |
| --- | --- |
| `schema_version, bundle_id, profile, created_at` | 包格式、身份和导出信息 |
| `workspace_id, title` | 内容项目身份 |
| `inputs` | 设定集、文档、骨架、报告、审核的确切版本和摘要 |
| `files` | 相对路径、字节数、SHA-256、媒体类型、来源对象及审核／权利状态 |
| `provenance` | 软件构建标识、规则版本、可选 Git commit、dirty 状态 |
| `coverage, warnings, exclusions` | 缺失、过期、未确认项与未嵌入材料 |

`files` 只列 payload，不包含 manifest 自身，避免自摘要循环。完成后另返回 ZIP 的字节数与摘要；如需外部校验文件，作为同目录 sidecar 创建，不嵌入自身引用。

## 4. 导出执行

1. 作者选择章节、骨架、剧本、报告、线索和素材，系统显示导出预览。
2. 校验定稿资格、证据新鲜度、来源存在性和媒体权利状态，说明阻断／警告／排除。
3. 冻结输入清单和摘要，取得一致性快照；长时间压缩不持续阻塞编辑写锁。
4. 从固定修订读取数据，在 `exports/` 的本次临时目标生成包；任何输入摘要不符立即失败。
5. 重新读包校验路径、数量、长度及各文件摘要，完成后原子重命名为新文件。
6. 返回导出结果与排除清单，不覆盖同名历史包，不自动上传或发送给他人。

源文变化后旧报告不得伪装为最新。需要的报告缺失时先执行或要求选择作者批准的带缺口交付；完整性损坏不能通过“忽略警告”导出。

## 5. 素材与线索

乐律线索保存情绪、场次、节拍／风格说明及音乐文件引用；视觉线索保存人物、场景、造型、构图说明及图片引用。线索描述是作者／Agent 提供的内容，核心只组织和校验引用。

素材元数据包括 `asset_id, sha256, media_type, size_bytes, source_type, source_uri?, creator_statement?, rights_status, narrative_refs`。外部服务来源可以保留供应商任务 ID 与安全参数投影，生成来源由供应商／调用方声明，不能伪装为河图验证过的事实。

大文件导入先复制到受管 staging、核对类型与摘要，再登记；不自动跟随 URL 下载，不接收可执行文件作为媒体。外部链接导出前清除凭据、私有签名查询参数和本机绝对路径。

## 6. 接收方核验

接收方无需安装河图即可解压阅读 Markdown／Fountain／JSON 和常规媒体。`bundle verify` 提供本地摘要、引用和清单检查，但不证明来源声明真实或材料具有版权。

剧本源格式为 Fountain，并随交付 profile 提供 DOCX／PDF 阅读稿；小说可提供 TXT／DOCX。转换版本、profile、损失报告与产物摘要进入 manifest。格式约束以[25](25-小说与剧本标准格式.md)为准，不能只给制片方一份私有 JSON 就宣称标准剧本交付。

相同输入可生成相同的 payload 摘要集合；ZIP 时间戳、导出 ID 和 manifest 创建时刻可能不同，V1 不声称整个压缩包逐字节可复现。导入 ZIP 回写工作区不属于 V1 必需能力，未来启用前必须增加解压限额、路径与覆盖保护。
