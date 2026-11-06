//! 本地技术日志（诊断用）：**只落本机文件、不外发**。
//!
//! 口径（0.7 日志一刀）：
//! - 位置：应用数据目录下的 `logs/`，当前文件 `app.log`；**不进备份包**（备份是用户数据，日志是过程物）。
//! - 轮转：单文件 ≤ 2MB，保留 5 份（`app.log` + `app.log.1..4`），超出就丢最老的。
//! - 内容：时间戳（epoch 毫秒）+ 级别 + 一行文本。**绝不写用户正文**——调用方负责只传 id / 计数 / 错误码。
//! - `panic!` 经钩子进日志（崩溃第一现场），随后照常交给默认钩子。
//!
//! 这里不引日志框架：需要的能力只有「追加一行 + 到量轮转」，一个 `Mutex<File>` 就够，
//! 少一个依赖、也少一处版本跟随。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 单文件上限：2MB。
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 保留份数（含当前文件）：5 份。
pub const KEEP_FILES: usize = 5;

struct Sink {
    dir: PathBuf,
    file: Mutex<Option<File>>,
}

static SINK: OnceLock<Sink> = OnceLock::new();

/// 初始化日志目录（幂等：重复调用只认第一次）。
pub fn init(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let _ = SINK.set(Sink {
        dir: dir.to_path_buf(),
        file: Mutex::new(None),
    });
    Ok(())
}

/// 写一行日志。未初始化时静默丢弃（日志不该反过来影响启动）。
pub fn log(level: &str, message: &str) {
    let Some(sink) = SINK.get() else { return };
    let mut guard = match sink.file.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.is_none() {
        *guard = OpenOptions::new()
            .create(true)
            .append(true)
            .open(sink.dir.join("app.log"))
            .ok();
    }
    if let Some(file) = guard.as_mut() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0);
        // 单行：多行消息里的换行拍平成空格，日志行数因此可数、轮转可判。
        let flat = message.replace(['\n', '\r'], " ");
        let _ = writeln!(file, "{stamp} [{level}] {flat}");
        let _ = file.flush();
    }
    drop(guard);
    rotate(&sink.dir, MAX_BYTES);
}

/// 把 `panic!` 写进日志，再交给默认钩子（终端 / 系统仍能看到）。
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log("ERROR", &format!("panic: {info}"));
        default(info);
    }));
}

/// 到量轮转。`max_bytes` 参数化是为了能测（真跑 2MB 的测试太慢）。
pub fn rotate(dir: &Path, max_bytes: u64) {
    let active = dir.join("app.log");
    let size = fs::metadata(&active).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 || size <= max_bytes {
        return;
    }
    if let Some(sink) = SINK.get() {
        if let Ok(mut guard) = sink.file.lock() {
            *guard = None;
        }
    }
    // 最老的一份先删：`.4` 让位给 `.3`
    let oldest = dir.join(format!("app.log.{}", KEEP_FILES - 1));
    let _ = fs::remove_file(&oldest);
    for index in (1..KEEP_FILES - 1).rev() {
        let from = dir.join(format!("app.log.{index}"));
        let to = dir.join(format!("app.log.{}", index + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
    let _ = fs::rename(&active, dir.join("app.log.1"));
}

/// 把保留的全部日志拼成一份文本（导出用）：**老的在前、当前在后**，读起来是一条时间线。
pub fn read_all(dir: &Path) -> String {
    let mut out = String::new();
    for index in (1..KEEP_FILES).rev() {
        let path = dir.join(format!("app.log.{index}"));
        if let Ok(text) = fs::read_to_string(&path) {
            out.push_str(&text);
            if !text.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    if let Ok(text) = fs::read_to_string(dir.join("app.log")) {
        out.push_str(&text);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("moqi-log-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotation_keeps_five_files_and_drops_the_oldest() {
        let dir = temp_dir("rotate");
        // 手写 6 份不同内容的「当前文件」，各触发一次轮转
        for round in 0..6 {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("app.log"))
                .unwrap();
            writeln!(file, "round-{round} {}", "x".repeat(40)).unwrap();
            drop(file);
            rotate(&dir, 8); // 8 字节门槛：一行必超
        }
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| {
                entry
                    .ok()
                    .map(|item| item.file_name().to_string_lossy().into_owned())
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["app.log.1", "app.log.2", "app.log.3", "app.log.4"],
            "保留 4 份历史 + 当前（当前在最后一轮后已轮转）"
        );
        let all = read_all(&dir);
        // 6 轮写 + 6 次轮转后：保留的是 round-2..round-5（最早两轮已随 .4 → 丢弃）
        assert!(all.contains("round-5"), "最新一轮落进 app.log.1");
        assert!(all.contains("round-2"), "第五老的一份还在 app.log.4");
        assert!(
            !all.contains("round-1") && !all.contains("round-0"),
            "最老的两份被丢掉"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_all_is_chronological_and_tolerates_missing_files() {
        let dir = temp_dir("read");
        fs::write(dir.join("app.log.2"), "old\n").unwrap();
        fs::write(dir.join("app.log"), "new\n").unwrap();
        let all = read_all(&dir);
        assert_eq!(all, "old\nnew\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_creates_directory_and_log_appends_a_single_line() {
        let dir = temp_dir("append").join("logs");
        init(&dir).unwrap();
        log("INFO", "hello\nworld");
        let text = fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(
            text.contains("[INFO] hello world"),
            "多行被拍成一行：{text}"
        );
        assert_eq!(text.lines().count(), 1);
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }
}
