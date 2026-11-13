import Foundation
import HetuCore

@main
struct HetuCLI {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args.isEmpty || args == ["--help"] {
                print("""
                河图洛书 Hetu Luoshu 本地创作工作台

                hetu --workspace <目录> capabilities
                hetu --workspace <目录> call <hetu.action> --input <JSON 文件或 ->

                call 从文件或 stdin 读取输入，stdout 输出一个 AXI JSON 对象。
                此自动化入口固定为 Agent 权限；作者操作使用原生工作台确认。
                """)
                return
            }
            guard args.count >= 3, args[0] == "--workspace" else { throw CLIError.input }
            let workspace = try await Workspace.open(at: URL(fileURLWithPath: args[1]), mode: .agent)
            let result: JSONValue
            if args.count == 3, args[2] == "capabilities" {
                result = try await workspace.request("hetu.capabilities.get")
            } else {
                guard args.count == 6, args[2] == "call", args[4] == "--input" else { throw CLIError.input }
                let bytes = try readInput(args[5])
                let input = try JSONDecoder().decode(JSONValue.self, from: bytes)
                guard case .object(let fields) = input else { throw CLIError.input }
                result = try await workspace.request(args[3], input: fields)
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
        case "revision_conflict", "idempotency_conflict", "hetu.stale_evidence": 4
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
