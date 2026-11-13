#ifndef HETU_H
#define HETU_H
#include <stdint.h>
#if defined(_WIN32)
#define HETU_API __declspec(dllexport)
#define HETU_CALL __cdecl
#else
#define HETU_API __attribute__((visibility("default")))
#define HETU_CALL
#endif
#ifdef __cplusplus
extern "C" {
#endif
typedef struct HetuContext HetuContext;
typedef struct HetuTask HetuTask;
typedef struct { uint8_t *data; uint64_t size; } HetuBuffer;

/* UTF-8 JSON 缓冲无终止符。交换成功返回 0，业务结果读取 AXI status。
 * -1 表示无效 ABI 参数，-2 表示输出分配或被隔离的内部 panic。
 * 有效的输出结构在处理输入前初始化为空；Rust 分配器整体耗尽仍可能终止进程。
 * config 是可信入口配置：workspace_path、mode(author/agent)、create 可选。
 * 身份只在上下文建立时选择，业务 JSON 永远不能提升权限。
 * 同一上下文的请求串行化；不同上下文通过 OS 文件锁协调。
 * close 等待该上下文已启动任务。不得与使用该句柄的新调用并发。
 * start/poll/cancel 的 AXI receipt 描述任务句柄生命周期，original_result 承载业务结果。
 * poll/cancel 可并发；release 等待任务退出，不能与其他句柄调用并发。
 * 已释放的非空句柄不得再次使用；调用方负责使 close/release 与新调用互斥。
 * 当前有界操作仅在进入业务执行前接受取消，进入持久事务后返回真实执行结果。
 * nullptr close/release/free 无操作；非空句柄只能释放一次。
 * 调用方持有的结果缓冲不依赖上下文寿命，用 buffer_free 释放并清零。
 */
HETU_API uint32_t HETU_CALL hetu_abi_version(void);
HETU_API int32_t HETU_CALL hetu_context_open(const uint8_t *, uint64_t, HetuContext **, HetuBuffer *);
HETU_API int32_t HETU_CALL hetu_request(HetuContext *, const uint8_t *, uint64_t, HetuBuffer *);
HETU_API int32_t HETU_CALL hetu_task_start(HetuContext *, const uint8_t *, uint64_t, HetuTask **, HetuBuffer *);
HETU_API int32_t HETU_CALL hetu_task_poll(HetuTask *, HetuBuffer *);
HETU_API int32_t HETU_CALL hetu_task_cancel(HetuTask *, HetuBuffer *);
HETU_API void HETU_CALL hetu_task_release(HetuTask *);
HETU_API void HETU_CALL hetu_context_close(HetuContext *);
HETU_API void HETU_CALL hetu_buffer_free(HetuBuffer *);
#ifdef __cplusplus
}
#endif
#endif
