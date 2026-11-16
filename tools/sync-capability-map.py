#!/usr/bin/env python3
"""由动作合同、MCP映射、权限路由和Skill源生成同一份人机能力地图。"""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs/40-机器能力地图与Review清单.md"
MAP = ROOT / "contracts/capability-map.json"
SKILL_MAP = ROOT / "tools/hetu-skills/base/references/capability-map.json"

ROUTES = {
    "capabilities": ("能力导航与Review", "hetu-setup"),
    "blueprints": ("设定与规则", "hetu-outline"),
    "documents": ("章节、正文与定稿", "hetu-manage"),
    "drafts": ("参考稿与采纳", "hetu-draft"),
    "reviews": ("审核与返工", "hetu-revise"),
    "plot": ("剧情与一致性", "hetu-drama"),
    "validation": ("剧情与一致性", "hetu-drama"),
    "findings": ("剧情与一致性", "hetu-drama"),
    "reports": ("剧情与一致性", "hetu-drama"),
    "drama": ("剧本与改编", "hetu-drama"),
    "git": ("文稿版本与协作", "hetu-manage"),
    "assets": ("图片与素材", "hetu-artwork"),
    "cues": ("图片与素材", "hetu-artwork"),
    "image_tasks": ("图片与素材", "hetu-artwork"),
    "novels": ("小说资料与目录", "hetu-book-profile"),
    "creation_projects": ("新建与创作库接纳", "hetu-book-create"),
    "creative_tasks": ("创作任务与接续", "hetu-setup"),
    "collaboration": ("连接与精确授权", "hetu-setup"),
    "working_copies": ("持续参考稿与反馈", "hetu-draft"),
    "task_feedback": ("持续参考稿与反馈", "hetu-revise"),
    "task_context": ("按需上下文", "hetu-setup"),
    "models": ("模型计划与费用", "hetu-setup"),
    "model_tasks": ("模型计划与费用", "hetu-setup"),
    "model_settings": ("模型渠道设置", "hetu-manage"),
    "covers": ("封面", "hetu-cover"),
    "bundles": ("导出与交付", "hetu-manage"),
    "resources": ("资料与来源", "hetu-resources"),
    "resource_usages": ("资料与来源", "hetu-resources"),
    "local_settings": ("本机设置与套件安装", "hetu-manage"),
    "plugin_access": ("插件授权", "hetu-manage"),
    "plugins": ("插件安装与生命周期", "hetu-manage"),
    "video": ("视频工程", "hetu-video"),
    "works": ("作品读取与关联", "hetu-manage"),
    "work_links": ("作品读取与关联", "hetu-manage"),
    "import_authorizations": ("整书导入与恢复", "hetu-import"),
    "agent_operations": ("共享固定方案", "hetu-manage"),
    "annotations": ("作者批注", "hetu-revise"),
    "outlines": ("大纲", "hetu-outline"),
    "interactions": ("局部选择", "hetu-setup"),
}

# 只登记已经存在的机器替代合同，宿主内部函数不直接变成Agent权限。
ALTERNATIVES = {
    "hetu.git.approve_snapshot": ["hetu.git.record_snapshot_decision"],
    "hetu.agent_operations.decide": ["hetu.agent_operations.record_decision"],
    "hetu.creative_tasks.inspect_inbox": ["hetu.creative_tasks.submit_result"],
    "hetu.model_tasks.approve": ["hetu.model_tasks.authorize_usage"],
    "hetu.covers.preview_prompt": ["hetu.image_tasks.preview_prompt"],
    "hetu.covers.create_request": ["hetu.image_tasks.prepare"],
    "hetu.covers.list_requests": ["hetu.creative_tasks.list"],
    "hetu.covers.list_candidates": ["hetu.creative_tasks.get", "hetu.assets.list"],
}
HOST_BOUNDARIES = {
    "hetu.annotations.list": "作者私密批注；对外反馈使用hetu.task_feedback.list。",
    "hetu.annotations.save": "作者私密批注；Agent反馈使用hetu.task_feedback.save。",
    "hetu.creative_tasks.mark_copied": "宿主剪贴板状态；机器执行不要求复制提示词。",
    "hetu.collaboration.authorize": "初始任务授权由宿主核验；机器prepare创建的任务自动登记精确task_locator。",
    "hetu.collaboration.revoke": "任务访问撤销属于宿主授权控制；不能从任务内提升权限。",
    "hetu.collaboration.authorize_workspace": "已有作品初始授权由宿主核验；机器新建作品自动接纳精确授权。",
    "hetu.collaboration.workspace_access": "宿主查询初始授权状态；机器以inspect及精确management_ref发现。",
    "hetu.collaboration.revoke_management": "撤销父级管理授权属于宿主授权控制。",
    "hetu.covers.inspect_file": "作者文件选择入口；机器导入固定inline_source后使用hetu.assets.inspect。",
}
WORKFLOWS = [
    {"goal": "导入已有小说", "skill": "hetu-import", "entry": "hetu.import_authorizations.register",
     "path": ["发现能力及精确作品", "核对原稿、完整目录和摘要", "登记真实导入指令", "固定分批方案并执行", "逐篇回读及原键恢复"]},
    {"goal": "整理资料、目录、设定或执行作者取舍", "skill": "hetu-manage", "entry": "hetu.agent_operations.catalog",
     "path": ["读取对象及固定修订", "按领域Schema准备方案", "展示差异并记录真实决定", "原Agent执行", "回读领域结果"]},
    {"goal": "起草、改稿或整理大纲", "skill": "hetu-setup", "entry": "hetu.creative_tasks.list",
     "path": ["恢复已有任务或准备确切新任务", "按任务类型选择写作Skill", "按需读取固定上下文", "提交参考成果", "阅读反馈并沿原任务继续"]},
    {"goal": "设置偏好或安装所选Skills套件", "skill": "hetu-manage", "entry": "hetu.local_settings.get",
     "path": ["读取本机基线", "准备固定设置方案", "记录真实选择", "执行并回读", "分别核对安装和本会话加载状态"]},
    {"goal": "配置模型渠道", "skill": "hetu-manage", "entry": "hetu.model_settings.inspect",
     "path": ["读取非敏感设置及摘要", "按真实指令提交固定设置", "凭据仅进入私密存储", "回读非敏感结果；生成与费用另行授权"]},
    {"goal": "安装、启停或卸载插件", "skill": "hetu-manage", "entry": "hetu.plugins.inspect",
     "path": ["核对包内容及摘要", "核对依赖和状态基线", "提交真实安装选择", "回读原操作", "作品数据权限另行精确授权"]},
    {"goal": "授权插件数据或确认数据迁移", "skill": "hetu-manage", "entry": "hetu.plugin_access.authorize",
     "path": ["固定作品、包摘要和类型Schema", "按真实选择授权", "发现插件专业数据动作", "迁移先准备并展示前后差异", "登记确切迁移决定后执行及回读"]},
    {"goal": "保存文稿版本", "skill": "hetu-manage", "entry": "hetu.git.status",
     "path": ["读取本作品HEAD", "准备固定文稿快照", "审阅完整差异及提交身份", "记录确切snapshot决定", "执行并沿原snapshot和键回读"]},
    {"goal": "导出文稿或交付包", "skill": "hetu-manage", "entry": "hetu.documents.preview_export",
     "path": ["读取确切修订及交付目标", "准备固定交付方案", "记录真实决定", "执行并核验文件和摘要"]},
]


def read(name):
    return (ROOT / name).read_text()


def rust_list(name, constant):
    source = read(name)
    section = source.split(constant + ": &[&str] = &[", 1)[1].split("];", 1)[0]
    return set(re.findall(r'"(hetu\.[\w.]+)"', section))


def build():
    actions = json.loads(read("contracts/actions.json"))["actions"]
    names = {action["name"] for action in actions}
    references = {a for values in ALTERNATIVES.values() for a in values} | {w["entry"] for w in WORKFLOWS}
    if missing := (references | set(ALTERNATIVES) | set(HOST_BOUNDARIES)) - names:
        raise ValueError(f"地图引用了不存在的动作：{sorted(missing)}")
    tools = json.loads(read("contracts/tools/catalog.json"))["tools"]
    proposals = rust_list("core/src/application/agent_operations.rs", "PROPOSABLE")
    management = set().union(*(rust_list("core/src/collaboration/authoring.rs", name)
                              for name in ["PROJECT_ACTIONS", "WORKSPACE_ACTIONS", "REVIEW_ACTIONS"]))
    tasks = rust_list("core/src/application/creative_tasks.rs", "TASK_ACTIONS")
    inputs = ["contracts/actions.json", "contracts/tools/catalog.json", "integrations/catalog.json",
              "core/src/application/agent_operations.rs", "core/src/collaboration/authoring.rs",
              "core/src/application/creative_tasks.rs", "core/src/application/work_scope.rs"]
    evidence_path = "docs/research/evidence/2026-11-16-agent-capabilities.json"
    evidence = json.loads(read(evidence_path)) if (ROOT / evidence_path).exists() else {}
    verified = evidence.get("verified_actions", {})
    installed = set(evidence.get("installed_actions", []))
    entries = []
    for action in actions:
        name = action["name"]
        module = name.split(".")[1]
        group, skill = ROUTES.get(module, ("接入与恢复", "hetu-setup"))
        if ".preview_import" in name or ".import" in name:
            skill = "hetu-import"
        mapped = [t for t in tools if t["action"] == name]
        local = "collaboration" in action.get("scopes", [])
        routes = []
        if local:
            routes.append("client_local")
        if name in management:
            routes.append("exact_management_ref")
        if name in tasks and not action["author_only"]:
            routes.append("exact_task_ref")
        if name in proposals:
            routes.append("fixed_proposal")
        if not routes and not action["author_only"]:
            routes.append("workspace_agent")
        decision = "按任务或读取范围执行"
        recover = "hetu.operations.get"
        if name in proposals:
            decision = "准备固定方案 → 会话或桌面记录作者决定 → 执行"
        if module == "local_settings":
            decision = "独立本机固定方案；record_decision 后 execute"
            recover = "hetu.local_settings.get_operation"
        elif module == "model_settings":
            decision = "真实会话指令＋设置基线；凭据不回显"
            recover = "hetu.model_settings.get_operation"
        elif module == "plugins":
            decision = "固定包摘要＋安装状态基线＋真实安装选择"
            recover = "hetu.plugins.get_operation"
        elif name == "hetu.git.record_snapshot_decision":
            decision = "固定 snapshot_id/SHA 和提交身份；登记不提交"
            recover = "hetu.git.get_snapshot"
        elif module == "import_authorizations":
            decision = "真实导入指令＋完整固定篇目范围"
            recover = "hetu.import_authorizations.get"
        elif module == "model_tasks":
            decision = "独立任务与费用授权；不能用通用方案代替"
            recover = "hetu.model_tasks.get"
        if not routes:
            decision = "仅作者入口；机器路径缺口须逐项处理"
        alternatives = ALTERNATIVES.get(name, [])
        boundary = HOST_BOUNDARIES.get(name)
        if alternatives:
            decision = "机器使用独立合同：" + "、".join(alternatives)
        elif boundary:
            decision = boundary
        skill_path = f"tools/hetu-skills/base/skills/{skill}/SKILL.md"
        if not (ROOT / skill_path).is_file():
            raise ValueError(f"missing skill: {skill_path}")
        inputs.append(skill_path)
        entries.append({"action": name, "purpose": action["purpose"], "group": group,
                        "effect": action["effect"], "routes": routes,
                        "cli": "hetu --client <client> call " + ("hetu.agent_operations.prepare" if name in proposals else name) + " --input -",
                        "proposal_target": name if name in proposals else None,
                        "mcp": [{"name": t["name"], "profiles": t["profiles"]} for t in mapped],
                        "mcp_via_proposal": name in proposals,
                        "skill": skill, "skill_source": skill_path,
                        "input_schema": action.get("input_schema", {"$ref": action.get("input_schema_ref")}),
                        "decision": decision, "recover": recover,
                        "equivalent_machine_actions": alternatives, "host_boundary": boundary,
                        "installed_evidence": name in installed,
                        "verification": verified.get(name, []),
                        "status": "verified" if name in verified else "source_wired" if routes else "machine_alternative" if alternatives else "host_boundary" if boundary else "author_only_gap"})
    skills = []
    for name in json.loads(read("integrations/catalog.json"))["skills"]:
        source = f"tools/hetu-skills/base/skills/{name}/SKILL.md"
        content = read(source)
        inputs.append(source)
        description = re.search(r"^description: (.+)$", content, re.M).group(1).strip('"')
        skills.append({"name": name, "description": description, "source": source,
                       "actions": [a["action"] for a in entries if a["skill"] == name]})
    sources = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(inputs))}
    result = {"schema_version": "1.0.0", "generated_by": "tools/sync-capability-map.py",
              "meaning": "source_wired仅表示源码合同和入口已连线；不证明安装、运行、跨平台或端到端通过。执行时先inspect实际能力。",
              "sources": sources, "verification_evidence": evidence_path if evidence else None,
              "skills": skills,
              "workflows": WORKFLOWS,
              "extension_runtime_discovery": "hetu.plugins.inspect → 固定包contributions.actions → plugin-runtime capabilities／MCP tools/list",
              "actions": entries}
    lines = ["# 机器能力地图与 Review 清单", "",
             "这份地图供产品逐项审阅，也供 AI 按目标定位 Skills、CLI 和 MCP。它由同一组源码合同生成，不依赖打开桌面。", "",
             "- 产品原则：所有业务应有机器操作路径；桌面承担阅读、比较和可选手动编辑。必要的作者决定可以在当前 Agent 会话完成。",
             "- 执行前发现：`hetu --client codex collaboration inspect`，按返回的真实 Schema、精确 `management_ref` 或 `task_ref` 操作。",
             "- 无窗口查询：CLI 使用 `hetu --client codex call hetu.capabilities.map --input -`；MCP 使用 `hetu_get_capability_map`，支持 group、action、skill 筛选与分页。",
             "- AI 完整索引：[contracts/capability-map.json](../contracts/capability-map.json)。其中包含输入 Schema、MCP profile、Skill 源文件和恢复动作。",
             "- 维护边界：本清单只维护宿主能力及插件发现入口；各插件自行维护功能清单和 manifest，AI按安装包继续发现，不在宿主重复登记插件功能。",
             "- 状态解释：**已验证**有专项证据；**源码已连线**需要运行验收；**机器替代入口**指向独立合同；**宿主边界**保留授权或私密性；**作者入口缺口**需继续处理。安装证据与功能验收分别记录。",
             "- 进度由 [38](38-创作工作台重构执行计划.md) 管理；验收要求见 [19](19-测试策略与验收矩阵.md)，构建和实测证据见 [20](20-实施路线与里程碑.md)。", "",
             "## AI 任务路由", "", "| 用户目标 | Skill | 起点 | 可回读流程 |", "| --- | --- | --- | --- |"]
    for workflow in WORKFLOWS:
        lines.append(f"| {workflow['goal']} | `{workflow['skill']}` | `{workflow['entry']}` | {' → '.join(workflow['path'])} |")
    lines += ["", "## 按领域定位", "", "| 功能领域 | Skill | 动作数 | 作者入口缺口 | 专项已验证 |", "| --- | --- | ---: | ---: | ---: |"]
    groups = {}
    for entry in entries:
        groups.setdefault(entry["group"], []).append(entry)
    for group, items in groups.items():
        group_skills = sorted({item["skill"] for item in items})
        lines.append(f"| {group} | {'、'.join(group_skills)} | {len(items)} | {sum(i['status']=='author_only_gap' for i in items)} | {sum(i['status']=='verified' for i in items)} |")
    lines += ["", "## AI 按需查询", "", "先按目标选择Skill，再窄查动作；只有准备执行时才读取输入Schema，避免每次加载全部动作。", "", "```bash",
              "hetu --client codex call hetu.capabilities.map --input - <<'JSON'",
              '{"skill":"hetu-import","limit":8}', "JSON", "```", "",
              "MCP 对应调用 `hetu_get_capability_map`，参数同上。具体动作查询可传 `action` 和 `include_schema: true`，分页沿返回的 `next_offset`。地图不授予作品权限，执行仍使用实际能力发现返回的精确引用。", "",
              "## Skills 方法入口", "", "| Skill | 适用目标 | 源文件 |", "| --- | --- | --- |"]
    for skill in skills:
        lines.append(f"| `{skill['name']}` | {skill['description']} | [SKILL.md](../{skill['source']}) |")
    lines += ["", "## Review 方法", "",
              "每个领域逐项检查：目标是否可从当前对话开始；实际能力是否可发现；作者是否需要重复填表或进入桌面；决定是否固定结果与版本；执行是否仍为 Agent；成功是否可回读；未知结果是否可沿原键恢复；越权、撤权、冲突是否拒绝。", "",
              "表中 MCP 的“固定方案”表示该领域动作通过共享 prepare／record_decision／execute 工具执行，并非直接暴露作者函数。`workspace` profile 不能等同于稳定连接，也不能等同于获权作品。Skills 是方法层，不凭文件存在获得执行权限。", "",
              "纯视图状态（窗口尺寸、滚动位置、浏览器布局）不作为创作领域业务接口。私密批注和凭据不能因机器可操作而成为普通读取内容。仅作者入口行表示实现缺口或受限旧入口，不能由 Agent 自设作者身份绕过。", "",
              "## 完整动作清单", ""]
    states = {"verified": "已验证", "source_wired": "源码已连线", "machine_alternative": "机器替代入口", "host_boundary": "宿主边界", "author_only_gap": "作者入口缺口"}
    for group, items in groups.items():
        lines += [f"### {group}", "", "| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |", "| --- | --- | --- | --- | --- |"]
        for item in items:
            mcp = "<br>".join(f"`{t['name']}` ({'/'.join(t['profiles'])})" for t in item['mcp'])
            if item['mcp_via_proposal']:
                mcp = (mcp + "<br>" if mcp else "") + "固定方案"
            installed_text = "；安装已发现" if item['installed_evidence'] else "；安装待核对"
            lines.append(f"| {item['purpose']}<br>`{item['action']}` | {mcp or '无直接工具映射'} | [{item['skill']}](../{item['skill_source']}) | {item['decision']} | {states[item['status']]}{installed_text} |")
        lines.append("")
    lines += ["## 插件发现入口", "",
              "先用 `hetu.plugins.inspect` 定位已安装的固定包，再读取该插件自己的功能清单及 `manifest.contributions`；按精确授权调用 plugin-runtime 的 `capabilities` 或 MCP `tools/list`。插件维护自己的视图、数据类型、动作与验证信息，宿主不汇总维护其业务功能。共享专业数据协议见[插件合同](plugin/20-首期可执行合同与开发入口.md)。", ""]
    lines += ["", "## 维护与检查", "", "```bash", "python3 tools/sync-capability-map.py", "python3 tools/sync-capability-map.py --check", "```", "",
              "新增或修改领域动作、MCP 映射、权限路由或 Skill 时重新生成。功能测试通过后将确切动作与测试证据写入地图引用的 evidence 文件，再生成；生成器不会把合同声明自动算作验收通过。", ""]
    return json.dumps(result, ensure_ascii=False, indent=2) + "\n", "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    machine, document = build()
    source = json.loads(machine)
    skill_map = json.dumps({"schema_version":source["schema_version"], "meaning":source["meaning"],
        "discovery":"hetu.collaboration.inspect", "map_action":"hetu.capabilities.map",
        "mcp_map_tool":"hetu_get_capability_map",
        "query":{"filters":["group","action","skill"],"pagination":["offset","limit"],"include_schema":False},
        "workflows":source["workflows"],
        "skills":[{**{k:v for k,v in skill.items() if k != "source"},
                   "entry":"../skills/"+skill["name"]+"/SKILL.md"} for skill in source["skills"]],
        "extension_runtime_discovery":source["extension_runtime_discovery"],
        "restricted_actions":[{key:action[key] for key in ("action","status","decision","equivalent_machine_actions")}
                              for action in source["actions"] if action["status"] in ("author_only_gap","machine_alternative","host_boundary")]},ensure_ascii=False,indent=2)+"\n"
    for path, content in [(MAP, machine), (DOC, document), (SKILL_MAP,skill_map)]:
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f"能力地图过期：{path.relative_to(ROOT)}；运行 python3 tools/sync-capability-map.py")
        else:
            path.write_text(content)
    print("能力地图一致" if args.check else "已更新人机能力地图")


if __name__ == "__main__":
    main()
