import Foundation
import HetuCore

/// 只交接已保存对象与实际能力，不导出编辑器缓冲或私密配置。
public enum PageHandoff {
    public static func sourceObject(_ value: JSONValue) -> JSONValue {
        var object: [String: JSONValue] = [:]
        for key in ["document_id", "revision_id"] { if value[key].string != nil { object[key] = value[key] } }
        if value["byte_start"].integer != nil && value["byte_end"].integer != nil && value["quote"].string != nil {
            for key in ["byte_start", "byte_end", "quote"] { object[key] = value[key] }
        }
        return .object(object)
    }
    public static func prompt(context: JSONValue, workspace: URL, executable: URL, locale: String, suite: String, clientAdapter: String, managementRef: JSONValue, authorInstruction: String? = nil) throws -> String {
        guard workspace.isFileURL, executable.isFileURL,
              context["scope_ref"]["kind"].string == "workspace", context["scope_ref"]["id"].string?.hasPrefix("workspace_") == true else { throw CoreError.invalidResponse }
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        guard ["codex", "claude-code", "workbuddy", "generic"].contains(clientAdapter), managementRef["scope_ref"] == context["scope_ref"], managementRef["grant_id"].string != nil else { throw CoreError.invalidResponse }
        let command = quote(executable.path) + " --client " + clientAdapter
        let scope: JSONValue = .object(["scope_ref": context["scope_ref"], "management_ref": managementRef, "view_kind": context["view_kind"], "object_ref": context["object_ref"], "fixed_refs": context["fixed_refs"]])
        let fixed = String(decoding: try scope.encoded(pretty: true), as: UTF8.self)
        let instruction = authorInstruction.map { locale == "en" ? "Author's explicitly shared instruction: \($0)" : "作者本次明确分享的意见：\($0)" } ?? ""
        let actions = context["direct_actions"].array.compactMap { $0["name"].string }.joined(separator: ", ")
        let proposals = context["proposal_actions"].array.compactMap { $0["name"].string }.joined(separator: ", ")
        if locale == "en" {
            return """
            Help me with the current page in Hetu Luoshu. Use the selected \(suite) skills and CLI/MCP, without operating the GUI. Ask what I want to do if I have not specified a goal; do not invent changes.
            \(instruction)
            Explicit workspace: \(workspace.path)
            Discover the actual schemas: \(command) capabilities
            Then call hetu.handoffs.get with management_ref, view_kind and object_ref below. Include management_ref in each workspace request through this stable connection. Recheck scope and fixed versions. This handoff authorizes reading this saved work and preparing proposals, not executing unapproved changes. Keep changed inputs separate and compare when the saved version has advanced.
            Direct actions: \(actions)
            Proposal actions: \(proposals)
            For a management change, fill the complete domain input and call hetu.agent_operations.prepare. Return the proposal_id and digest and let me review it in the app. Only after approval, execute that exact proposal via hetu.agent_operations.execute and read it back. Never impersonate the author, self-approve, adopt, finalize, unlock the story bible or authorize fees. Each proposal is one fixed transaction, not ongoing editing permission.
            To create a creative task, preview the request and propose the complete prepare_input. Approved execution registers the task for this client. Open the returned task_locator through hetu.collaboration.open and use its exact task_ref for writing/image/resource actions on the same stable connection.
            Limitations: \(context["limitations"].array.compactMap(\.string).joined(separator: ", ")). Discover supported actions; report gaps precisely and never substitute GUI automation or direct writes to managed files. Recover unknown outcomes with the original operation key. Unsaved buffers and private notes are excluded.
            Fixed page context:
            \(fixed)
            """
        }
        return """
        请协助我处理河图洛书当前页面，使用所选 \(suite) 套件中的 Skills 和 CLI/MCP，不操作 GUI。若我还没说目标，先询问本次想做什么，不自行修改作品。
        \(instruction)
        明确作品目录：\(workspace.path)
        先读取实际 Schema：\(command) capabilities
        再以以下 management_ref、view_kind 和 object_ref 调用 hetu.handoffs.get。沿同一稳定连接，每项作品请求携带 management_ref，核对作品身份和固定修订。此授权仅允许读取本作品已保存资料、准备方案，不代表批准具体变更；已保存版本前进时先比较，不静默更换基线。
        可直接调用：\(actions)
        可准备管理方案：\(proposals)
        管理变更由你填好完整领域参数，再调用 hetu.agent_operations.prepare。给出 proposal_id 和摘要，等我在软件审阅批准后，才调用 hetu.agent_operations.execute 执行该确切方案并回读结果。不得冒充作者、自报批准、采纳、定稿、解锁设定或批准费用。每个方案只授权一次固定事务，不获得持续编辑权。
        创建协作任务时，先预览任务，把完整 prepare_input 交给管理方案。批准执行后会登记本客户端任务授权；以返回 task_locator 调用 hetu.collaboration.open，之后携带其完整 task_ref，由对应写作、生图或资料 Skill 沿同一稳定连接继续。
        当前限制：\(context["limitations"].array.compactMap(\.string).joined(separator: ", "))。能力缺失要说明具体缺口，不用 Computer Use 或直写受管文件补链路。未知结果沿原操作键查询。未保存稿与私密批注不在交接范围。
        固定页面上下文：
        \(fixed)
        """
    }
}
