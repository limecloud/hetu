import Foundation
import HetuCore
#if os(macOS)
import HetuNative
#endif

@main
struct HetuCLI {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            #if os(macOS)
            if args.first == "--local" {
                guard args.count == 8, args[1] == "--client", args[3] == "call", args[5] == "--input", args[6] == "-", args[7] == "--json" else { throw CLIError.input }
                let input = try JSONDecoder().decode(JSONValue.self, from: readInput("-"))
                guard case .object(let fields) = input else { throw CLIError.input }
                let result = await LocalAutomation().request(args[4], input: fields, client: args[2])
                FileHandle.standardOutput.write(try result.encoded() + Data([10]))
                if result["status"].string != "succeeded" { exit(exitCode(result)) }; return
            }
            #endif
            if args.isEmpty || args == ["--help"] {
                print("""
                河图洛书 Hetu Luoshu 本地创作工作台

                hetu --client <codex|claude-code|workbuddy|generic> collaboration inspect
                hetu --client <客户端> collaboration open --input <JSON 文件或 ->
                hetu --client <客户端> call <hetu.action> --input <JSON 文件或 ->
                hetu --client <客户端> --collaboration-dir <绝对目录> collaboration inspect
                hetu --client <客户端> --collaboration-dir <绝对目录> call <hetu.action> --input <JSON 文件或 ->
                hetu model-service status
                hetu model-service login
                hetu model-service poll
                hetu --workspace <目录> capabilities
                hetu --workspace <目录> --task <任务 ID> call <hetu.action> --input <JSON 文件或 ->
                hetu --creation-project <目录> --task <任务 ID> call <hetu.action> --input <JSON 文件或 ->
                hetu --workspace <目录> call <hetu.action> --input <JSON 文件或 ->
                hetu --workspace <目录> bundle verify <bundle_id>

                call 从文件或 stdin 读取输入，stdout 输出一个 AXI JSON 对象。
                从零开始无需 --workspace 或 --task：先 inspect，再调用已发现的
                hetu.creation_projects.create，输入 brief、locale、operation_key。
                保留返回的 management_ref 和 target_path，按能力目录继续筹备与创建。
                此自动化入口固定为 Agent 权限；作者操作使用原生工作台确认。
                """)
                return
            }
            if args == ["--version"] {
                let catalog = try await CollaborationClient(clientAdapter: "generic").request("hetu.collaboration.inspect")
                guard catalog["status"].string == "succeeded" else { throw CoreError.business(catalog) }
                guard let version = catalog["data"]["version"].string else { throw CoreError.invalidResponse }
                print("hetu \(version)")
                return
            }
            if args.first == "model-service" {
                let result = try await ModelServiceCommand.run(Array(args.dropFirst()))
                FileHandle.standardOutput.write(try result.encoded() + Data([10]))
                return
            }
            if args.first == "--client" {
                try await collaboration(args)
                return
            }
            guard args.count >= 3, ["--workspace", "--creation-project"].contains(args[0]), args[1].hasPrefix("/") else { throw CLIError.input }
            var command = Array(args.dropFirst(2))
            var taskID: String?
            if command.first == "--task" {
                guard command.count >= 3 else { throw CLIError.input }
                taskID = command[1]; command.removeFirst(2)
            }
            let workspace: Workspace
            if args[0] == "--creation-project" {
                guard taskID != nil else { throw CLIError.input }
                workspace = try await Workspace.openCreationProject(at: URL(fileURLWithPath: args[1]), mode: .agent, taskID: taskID)
            } else {
                workspace = try await Workspace.open(at: URL(fileURLWithPath: args[1]), mode: .agent, taskID: taskID)
            }
            let result: JSONValue
            if command == ["capabilities"] {
                result = try await workspace.request("hetu.capabilities.get")
            } else if command.count == 3, command[0] == "bundle", command[1] == "verify" {
                result = try await workspace.request("hetu.bundles.verify", input: ["bundle_id": .string(command[2])])
            } else {
                guard command.count == 4, command[0] == "call", command[2] == "--input" else { throw CLIError.input }
                let bytes = try readInput(command[3])
                let input = try JSONDecoder().decode(JSONValue.self, from: bytes)
                guard case .object(let fields) = input else { throw CLIError.input }
                result = try await workspace.request(command[1], input: fields)
            }
            FileHandle.standardOutput.write(try result.encoded() + Data([10]))
            if result["status"].string != "succeeded" { exit(exitCode(result)) }
        } catch CoreError.business(let result) {
            if let bytes = try? result.encoded() { FileHandle.standardOutput.write(bytes + Data([10])) }
            exit(exitCode(result))
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            exit(2)
        }
    }
    static func collaboration(_ args: [String]) async throws {
        guard args.count >= 3 else { throw CLIError.input }
        let client = args[1]
        var command = Array(args.dropFirst(2))
        var directory: URL?
        if command.first == "--collaboration-dir" {
            guard command.count >= 3, command[1].hasPrefix("/") else { throw CLIError.input }
            directory = URL(fileURLWithPath: command[1]); command.removeFirst(2)
        }
        let bridge = CollaborationClient(clientAdapter: client, directory: directory)
        let result: JSONValue
        if command == ["collaboration", "inspect"] || command == ["capabilities"] {
            result = try await bridge.request("hetu.collaboration.inspect")
        } else {
            guard command.count == 4, command[2] == "--input" else { throw CLIError.input }
            let action: String
            if command[0] == "collaboration", command[1] == "open" { action = "hetu.collaboration.open" }
            else if command[0] == "call" { action = command[1] }
            else { throw CLIError.input }
            let input = try JSONDecoder().decode(JSONValue.self, from: readInput(command[3]))
            guard case .object(let fields) = input else { throw CLIError.input }
            result = try await bridge.request(action, input: fields)
        }
        FileHandle.standardOutput.write(try result.encoded() + Data([10]))
        if result["status"].string != "succeeded" { exit(exitCode(result)) }
    }
    static func readInput(_ path: String) throws -> Data {
        let handle = try path == "-" ? FileHandle.standardInput : FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        defer { if path != "-" { try? handle.close() } }
        let limit = 16 * 1024 * 1024
        var bytes = Data()
        while let chunk = try handle.read(upToCount: min(64 * 1024, limit + 1 - bytes.count)), !chunk.isEmpty {
            bytes.append(chunk)
            guard bytes.count <= limit else { throw CLIError.input }
        }
        return bytes
    }
    static func exitCode(_ result: JSONValue) -> Int32 {
        if result["status"].string == "partial" { return 6 }
        return switch result["error"]["code"].string {
        case "invalid_input": 2
        case "forbidden", "hetu.author_confirmation_required": 3
        case "revision_conflict", "idempotency_conflict", "hetu.stale_evidence", "hetu.stale_request": 4
        case "result_unknown": 7
        case "unsupported_version", "hetu.capability_unavailable": 8
        default: 5
        }
    }
    enum CLIError: Error, LocalizedError {
        case input
        var errorDescription: String? { "参数无效，请运行 hetu --help。" }
    }
}
