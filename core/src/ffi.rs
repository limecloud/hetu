use crate::{Kernel, domain};
use serde_json::{Value, json};
use std::alloc::{Layout, alloc, dealloc};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::{Arc, Condvar, Mutex, Weak};

const ABI_LIMIT: u64 = 16 * 1024 * 1024;
#[repr(C)]
pub struct HetuBuffer {
    data: *mut u8,
    size: u64,
}
pub struct HetuContext {
    kernel: Arc<Kernel>,
    tasks: Mutex<Vec<Weak<TaskState>>>,
}
pub struct HetuTask {
    state: Arc<TaskState>,
}
struct TaskState {
    id: String,
    scope: String,
    inner: Mutex<TaskInner>,
    done: Condvar,
}
struct TaskInner {
    started: bool,
    cancel_requested: bool,
    result: Option<Value>,
}

unsafe fn read_json(data: *const u8, size: u64) -> domain::Result<Value> {
    domain::ensure(
        size <= ABI_LIMIT && !data.is_null(),
        "invalid_input",
        "ABI 输入为空或超过上限。",
    )?;
    // SAFETY: ABI 调用方必须提供 size 字节的有效可读缓冲；已检查非空与有界长度。
    let bytes = unsafe { std::slice::from_raw_parts(data, size as usize) };
    Ok(serde_json::from_slice(bytes)?)
}
unsafe fn output(out: *mut HetuBuffer, value: Value) -> i32 {
    if out.is_null() {
        return -1;
    }
    // SAFETY: 调用方提供有效输出结构；初始化确保失败时可安全 free。
    unsafe {
        *out = HetuBuffer {
            data: ptr::null_mut(),
            size: 0,
        };
    }
    let Ok(bytes) = serde_json::to_vec(&value) else {
        return -2;
    };
    let Ok(layout) = Layout::array::<u8>(bytes.len()) else {
        return -2;
    };
    // SAFETY: 非零 JSON 表示与有效 Layout，返回空指针时不解引用。
    let pointer = unsafe { alloc(layout) };
    if pointer.is_null() {
        return -2;
    }
    // SAFETY: 独立分配的目标缓冲足够容纳全部 bytes，两个区域不重叠。
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
        *out = HetuBuffer {
            data: pointer,
            size: bytes.len() as u64,
        };
    }
    0
}
fn guard(f: impl FnOnce() -> i32) -> i32 {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(-2)
}
unsafe fn clear_output(out: *mut HetuBuffer) -> bool {
    if out.is_null() {
        return false;
    }
    // SAFETY: 非空输出指针的有效性由 ABI 调用方保证。
    unsafe {
        *out = HetuBuffer {
            data: ptr::null_mut(),
            size: 0,
        };
    }
    true
}

#[unsafe(no_mangle)]
pub extern "C" fn hetu_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_context_open(
    data: *const u8,
    size: u64,
    context: *mut *mut HetuContext,
    out: *mut HetuBuffer,
) -> i32 {
    // SAFETY: 输出缓冲遵循 ABI 合同。
    if !unsafe { clear_output(out) } || context.is_null() {
        return -1;
    }
    // SAFETY: 非空输出参数的有效性由 ABI 调用方保证。
    unsafe {
        *context = ptr::null_mut();
        *out = HetuBuffer {
            data: ptr::null_mut(),
            size: 0,
        };
    }
    guard(|| {
        // SAFETY: 输入遵循此函数的 ABI 缓冲合同。
        let opened = unsafe { read_json(data, size) }.and_then(Kernel::open);
        match opened {
            Ok(kernel) => {
                let receipt = domain::success(
                    "hetu.workspaces.open",
                    kernel.scope(),
                    json!({"abi_version":1}),
                );
                // SAFETY: out/context 均已检查；Box 转交调用方，由 close 回收。
                unsafe {
                    let code = output(out, receipt);
                    if code == 0 {
                        *context = Box::into_raw(Box::new(HetuContext {
                            kernel: Arc::new(kernel),
                            tasks: Mutex::new(Vec::new()),
                        }));
                    }
                    code
                }
            }
            // SAFETY: out 是已检查的有效输出结构。
            Err(error) => unsafe {
                output(
                    out,
                    domain::failure("hetu.workspaces.open", "unbound", &error),
                )
            },
        }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_request(
    context: *mut HetuContext,
    data: *const u8,
    size: u64,
    out: *mut HetuBuffer,
) -> i32 {
    // SAFETY: 输出缓冲遵循 ABI 合同。
    if !unsafe { clear_output(out) } || context.is_null() {
        return -1;
    }
    // SAFETY: out 是有效输出结构，先清零以覆盖 panic 路径。
    unsafe {
        *out = HetuBuffer {
            data: ptr::null_mut(),
            size: 0,
        };
    }
    guard(|| {
        // SAFETY: 上下文由 open 返回，在调用结束前不得 close。
        let context = unsafe { &*context };
        // SAFETY: 输入由调用方按 ABI 提供。
        let value = match unsafe { read_json(data, size) } {
            Ok(request) => context.kernel.request(request),
            Err(error) => domain::failure("hetu.request.invalid", context.kernel.scope(), &error),
        };
        // SAFETY: 输出由调用方按 ABI 提供。
        unsafe { output(out, value) }
    })
}
fn task_receipt(task: &TaskState, action: &str) -> Value {
    let inner = task.inner.lock().unwrap_or_else(|e| e.into_inner());
    domain::success(
        action,
        &task.scope,
        json!({"task_id":task.id,"task_state":if inner.result.is_some() { "completed" } else if inner.started { "running" } else { "queued" },"cancellation_requested":inner.cancel_requested,"original_result":inner.result}),
    )
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_task_start(
    context: *mut HetuContext,
    data: *const u8,
    size: u64,
    out_task: *mut *mut HetuTask,
    out: *mut HetuBuffer,
) -> i32 {
    // SAFETY: 输出缓冲遵循 ABI 合同。
    if !unsafe { clear_output(out) } || context.is_null() || out_task.is_null() {
        return -1;
    }
    // SAFETY: ABI 输出参数有效且不存在并发 close。
    unsafe {
        *out_task = ptr::null_mut();
        *out = HetuBuffer {
            data: ptr::null_mut(),
            size: 0,
        };
    }
    guard(|| {
        // SAFETY: 上下文与输入由 ABI 调用方保证有效。
        let context = unsafe { &*context };
        // SAFETY: 按 ABI 读取有界 JSON 输入。
        let request = match unsafe { read_json(data, size) } {
            Ok(value) => value,
            Err(error) => {
                // SAFETY: out 有效。
                return unsafe {
                    output(
                        out,
                        domain::failure("hetu.tasks.start", context.kernel.scope(), &error),
                    )
                };
            }
        };
        let state = Arc::new(TaskState {
            id: domain::id("task"),
            scope: context.kernel.scope().into(),
            inner: Mutex::new(TaskInner {
                started: false,
                cancel_requested: false,
                result: None,
            }),
            done: Condvar::new(),
        });
        let thread_state = state.clone();
        let kernel = context.kernel.clone();
        let spawned = std::thread::Builder::new()
            .name("hetu-task".into())
            .spawn(move || {
                let cancelled = {
                    let mut inner = thread_state.inner.lock().unwrap_or_else(|e| e.into_inner());
                    inner.started = true;
                    inner.cancel_requested
                };
                let value = if cancelled {
                    let mut cancelled = domain::success(
                        request["action"].as_str().unwrap_or("hetu.request.invalid"),
                        kernel.scope(),
                        json!({"committed":false}),
                    );
                    cancelled["status"] = json!("cancelled");
                    cancelled
                } else {
                    catch_unwind(AssertUnwindSafe(|| kernel.request(request))).unwrap_or_else(
                        |_| {
                            domain::failure(
                                "hetu.request.invalid",
                                kernel.scope(),
                                &domain::Error::new(
                                    "hetu.internal_failure",
                                    "内核任务异常终止，请核对原操作。",
                                ),
                            )
                        },
                    )
                };
                thread_state
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .result = Some(value);
                thread_state.done.notify_all();
            });
        if spawned.is_err() {
            // SAFETY: out 有效。
            return unsafe {
                output(
                    out,
                    domain::failure(
                        "hetu.tasks.start",
                        &state.scope,
                        &domain::Error::new("unavailable", "无法创建内核任务。"),
                    ),
                )
            };
        }
        context
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Arc::downgrade(&state));
        // SAFETY: 有效输出参数，句柄由 task_release 回收。
        unsafe {
            let code = output(out, task_receipt(&state, "hetu.tasks.start"));
            if code == 0 {
                *out_task = Box::into_raw(Box::new(HetuTask { state }));
            }
            code
        }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_task_poll(task: *mut HetuTask, out: *mut HetuBuffer) -> i32 {
    // SAFETY: 输出缓冲遵循 ABI 合同。
    if !unsafe { clear_output(out) } || task.is_null() {
        return -1;
    }
    // SAFETY: task/out 是存活的 ABI 句柄与输出结构。
    guard(|| unsafe { output(out, task_receipt(&(*task).state, "hetu.tasks.get")) })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_task_cancel(task: *mut HetuTask, out: *mut HetuBuffer) -> i32 {
    // SAFETY: 输出缓冲遵循 ABI 合同。
    if !unsafe { clear_output(out) } || task.is_null() {
        return -1;
    }
    guard(|| {
        // SAFETY: task 在调用过程中不会被 release。
        let state = unsafe { &(*task).state };
        {
            let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.result.is_none() {
                inner.cancel_requested = true;
            }
        }
        // SAFETY: out 有效。
        unsafe { output(out, task_receipt(state, "hetu.tasks.cancel")) }
    })
}
fn wait_task(task: &TaskState) {
    let mut inner = task.inner.lock().unwrap_or_else(|e| e.into_inner());
    while inner.result.is_none() {
        inner = task.done.wait(inner).unwrap_or_else(|e| e.into_inner());
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_task_release(task: *mut HetuTask) {
    if !task.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // SAFETY: 有效句柄只回收一次，不与其他 task 调用并发。
            let task = unsafe { Box::from_raw(task) };
            wait_task(&task.state);
        }));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_context_close(context: *mut HetuContext) {
    if !context.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // SAFETY: 有效句柄只回收一次，没有正在启动的新调用。
            let context = unsafe { Box::from_raw(context) };
            for task in context
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter_map(Weak::upgrade)
            {
                wait_task(&task);
            }
        }));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hetu_buffer_free(out: *mut HetuBuffer) {
    if out.is_null() {
        return;
    }
    // SAFETY: out 来自本库输出且未被修改；分配布局按同一长度重建。
    unsafe {
        if !(*out).data.is_null()
            && let Ok(layout) = Layout::array::<u8>((*out).size as usize)
        {
            dealloc((*out).data, layout);
        }
        *out = HetuBuffer {
            data: ptr::null_mut(),
            size: 0,
        };
    }
}
