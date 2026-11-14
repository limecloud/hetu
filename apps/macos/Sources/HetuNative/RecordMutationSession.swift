import Foundation
import Observation
import HetuCore

/// 表单缓冲与提交回执分开；结果未知时只恢复原输入和原操作键。
@MainActor @Observable
public final class RecordMutationSession {
    public private(set) var pending: PendingStructureOperation?
    public var error: String?
    private let model: WorkspaceModel
    private let scopeID: String
    public init(model: WorkspaceModel) { self.model = model; scopeID = model.workspaceID }
    public func save(_ action: String, input: [String: JSONValue]) async -> JSONValue? {
        guard model.workspaceID == scopeID else { error = model.t("creative.error.scopeChanged"); pending = nil; return nil }
        guard !model.busy else { return nil }
        let operation = pending ?? PendingStructureOperation(workspaceID: model.workspaceID, action: action, input: input)
        pending = operation; error = nil
        if let result = await model.workspaceAction(operation.action, input: operation.input, onFailure: { message, terminal in
            self.error = message
            if terminal { self.pending = nil }
        }) {
            pending = nil
            return result
        }
        return nil
    }
}
