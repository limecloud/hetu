//! 固定期限覆盖输入、进程退出和输出排空；进程退出不等于后代关闭管道。
use crate::{Error, Result};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Family {
    child: Child,
    stopped: bool,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}
impl Family {
    fn spawn(command: &mut Command) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        #[cfg(windows)]
        {
            let mut child = child;
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::*;
            // SAFETY: 句柄由OwnedHandle唯一拥有；结构体长度与信息类匹配，子进程句柄来自std。
            let job = unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(std::io::Error::last_os_error().into());
                }
                let job = OwnedHandle::from_raw_handle(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) == 0
                {
                    let error = std::io::Error::last_os_error();
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.into());
                }
                job
            };
            // 受管manager收到输入后才启动插件，分配Job成功前不发送输入。
            return Ok(Self {
                child,
                job,
                stopped: false,
            });
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child,
                stopped: false,
            })
        }
    }
    fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        #[cfg(unix)]
        {
            use rustix::process::{Pid, Signal, kill_process_group, test_kill_process_group};
            let pid = Pid::from_raw(self.child.id() as i32)
                .ok_or_else(|| Error::new("hetu.cleanup_failed", "受管进程身份无效。"))?;
            if let Err(error) = kill_process_group(pid, Signal::KILL) {
                // macOS在最后一个组成员因SIGPIPE退出、尚未回收时可能返回EPERM。
                // 只在回收父进程并确认整个组已不存在时视为清理完成。
                let gone=if error==rustix::io::Errno::PERM {
                    let deadline=Instant::now()+Duration::from_secs(2);
                    while self.child.try_wait()?.is_none() && Instant::now()<deadline {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    test_kill_process_group(pid)==Err(rustix::io::Errno::SRCH)
                } else {error==rustix::io::Errno::SRCH};
                if !gone {
                    return Err(Error::new(
                        "hetu.cleanup_failed",
                        format!("无法清理插件进程族（{error}）；保留原操作回读。"),
                    ));
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: job在Family生命周期内有效，终止范围限于本次受管进程族。
            if unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.job.as_raw_handle(),
                    1,
                )
            } == 0
            {
                return Err(Error::new(
                    "hetu.cleanup_failed",
                    "无法清理插件Job；保留原操作回读。",
                ));
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            self.child.kill()?;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if self.child.try_wait()?.is_some() {
                self.stopped = true;
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Error::new(
                    "hetu.cleanup_failed",
                    "插件进程未按期退出；保留原键，勿重复提交。",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Family {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub(crate) fn run(
    command: &mut Command,
    input: Vec<u8>,
    deadline: Duration,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>> {
    if cancelled() {
        return Err(Error::new("cancelled", "插件尚未启动，本次请求已取消。"));
    }
    let started = Instant::now();
    let mut family = Family::spawn(command)?;
    let mut stdin = family.child.stdin.take().unwrap();
    let mut stdout = family.child.stdout.take().unwrap();
    let (write_tx, write_rx) = mpsc::sync_channel(1);
    let writer = std::thread::spawn(move || {
        let result = stdin.write_all(&input);
        drop(stdin);
        let _ = write_tx.send(result);
    });
    let (read_tx, read_rx) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0u8; 8192];
        let result = loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break Ok(output),
                Ok(count) => {
                    if output.len().saturating_add(count) > limit {
                        break Err(Error::new(
                            "hetu.output_budget_exceeded",
                            "插件输出超过预算；写入保留原键查询。",
                        ));
                    }
                    output.extend_from_slice(&chunk[..count]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => break Err(error.into()),
            }
        };
        drop(stdout);
        let _ = read_tx.send(result);
    });
    let mut output = None;
    let mut written = false;
    let mut write_observed = false;
    let mut read_observed = false;
    let outcome = loop {
        if cancelled() {
            break Err(Error::new(
                "hetu.outcome_unknown",
                "插件执行期间取消；结果未知，须沿原键回读。",
            ));
        }
        if started.elapsed() >= deadline {
            break Err(Error::new(
                "hetu.outcome_unknown",
                "插件执行或输出排空超时；结果未知，须沿原键回读。",
            ));
        }
        if !written {
            match write_rx.try_recv() {
                Ok(Ok(())) => {
                    written = true;
                    write_observed = true;
                }
                Ok(Err(_)) => {
                    write_observed = true;
                    break Err(Error::new(
                        "hetu.outcome_unknown",
                        "插件输入未完成，须沿原键回读。",
                    ));
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    break Err(Error::new("hetu.outcome_unknown", "插件输入通道已断开。"));
                }
                Err(_) => {}
            }
        }
        if output.is_none() {
            match read_rx.try_recv() {
                Ok(Ok(bytes)) => {
                    read_observed = true;
                    output = Some(bytes)
                }
                Ok(Err(error)) => {
                    read_observed = true;
                    break Err(error);
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    break Err(Error::new("hetu.outcome_unknown", "插件输出通道已断开。"));
                }
                Err(_) => {}
            }
        }
        if let Some(status) = family.child.try_wait()? {
            if written && output.is_some() {
                break if status.success() {
                    Ok(output.take().unwrap())
                } else {
                    Err(Error::new(
                        "hetu.outcome_unknown",
                        "插件进程异常退出；保留原操作查询。",
                    ))
                };
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    family.stop()?;
    // 清理后只作有界排空，不因逃逸管道持有者无限等待reader.join。
    let drain = Duration::from_secs(2);
    let read_done = read_observed || reader.is_finished() || read_rx.recv_timeout(drain).is_ok();
    let write_done = write_observed || writer.is_finished() || write_rx.recv_timeout(drain).is_ok();
    if read_done {
        let _ = reader.join();
    }
    if write_done {
        let _ = writer.join();
    }
    if !read_done || !write_done {
        return Err(Error::new(
            "hetu.cleanup_failed",
            "插件管道未按期关闭；保留原键，勿重复提交。",
        ));
    }
    outcome
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }
    #[test]
    fn parent_exit_does_not_bypass_drain_deadline_and_descendant_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let pid = root.path().join("descendant.pid");
        let mut command = shell("sleep 30 & echo $! > \"$1\"; printf '{}'; exit 0");
        command.arg("fixture").arg(&pid);
        let started = Instant::now();
        let result = run(
            &mut command,
            vec![],
            Duration::from_millis(150),
            4096,
            &|| false,
        )
        .unwrap_err();
        assert_eq!(result.code, "hetu.outcome_unknown");
        assert!(started.elapsed() < Duration::from_secs(2));
        let child = std::fs::read_to_string(pid).unwrap().trim().to_owned();
        let status = Command::new("ps")
            .args(["-o", "stat=", "-p", &child])
            .output()
            .unwrap();
        assert!(
            status.stdout.is_empty()
                || String::from_utf8_lossy(&status.stdout)
                    .trim()
                    .starts_with('Z')
        );
    }
    #[test]
    fn input_output_cancel_and_exit_share_the_same_bounded_lifecycle() {
        assert_eq!(
            run(
                &mut shell("cat"),
                b"fixed result".to_vec(),
                Duration::from_secs(2),
                4096,
                &|| false
            )
            .unwrap(),
            b"fixed result"
        );
        let started = Instant::now();
        assert_eq!(
            run(
                &mut shell("sleep 30"),
                vec![b'a'; 2 * 1024 * 1024],
                Duration::from_millis(120),
                4096,
                &|| false
            )
            .unwrap_err()
            .code,
            "hetu.outcome_unknown"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let output_error=run(
                &mut shell("yes data"),
                vec![],
                Duration::from_secs(2),
                4096,
                &|| false
            ).unwrap_err();
        assert_eq!(output_error.code,"hetu.output_budget_exceeded","{output_error:?}");
        let started = Instant::now();
        assert_eq!(
            run(
                &mut shell("sleep 30"),
                vec![],
                Duration::from_secs(2),
                4096,
                &|| started.elapsed() > Duration::from_millis(50)
            )
            .unwrap_err()
            .code,
            "hetu.outcome_unknown"
        );
        assert_eq!(
            run(
                &mut shell("printf '{}'; exit 1"),
                vec![],
                Duration::from_secs(2),
                4096,
                &|| false
            )
            .unwrap_err()
            .code,
            "hetu.outcome_unknown"
        );
    }
}
