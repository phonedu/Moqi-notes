//! SAF（Android 存储访问框架）读写：**`content://` 只有 Rust 侧走得通**（T-17 真机修复，台账 `D-088`）。
//!
//! 为什么不能在 JS 里用 `fs` 插件：插件**所有 JS 命令**（`read_file` / `write_file` / `copy_file` /
//! `stat`）在 Rust 侧都先过 `SafeFilePath::into_path()`——`content://` 转不成路径，一律
//! `InvalidPathUrl`（ 真机实测：导入与导出双双失败）。插件里支持内容 URI 的通道只有
//! Rust 的 `Fs::open()`（Android 侧走 `ContentResolver.openAssetFileDescriptor` 拿 fd），
//! 所以「搬缓存 / 拷落点」这两步必须住在 Rust 命令里。
//!
//! 两道口子（与 `03` §12.4 的固定走法一致，只是执行者从 JS 换成 Rust）：
//! - 导入：`stage_saf_document` —— 读出选中文档 → 落进**应用缓存目录** → 返回绝对路径（解析仍走既有通路，不给第二个入口）；
//! - 导出：`write_saf_document` —— 把已经写进 `exports/` 的那一份**拷进用户选的落点**（写入逻辑仍只有一条）。
//!
//! **上限与文案**：单文件 8 MB（与导入页那行同源）。超限时返回哨兵字串 [`TOO_LARGE_SENTINEL`]，
//! 人话文案留在 JS 侧（`check:copy` 扫的是 JS 文案，一处不多写）。

use std::io::{Read, Write};
use std::path::PathBuf;

use serde_json::json;
use tauri::Manager;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// 单文件上限（与 `app/src/adapters/fileChannel.ts` 的 `PICK_LIMIT_BYTES` 同源）。
const IMPORT_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

/// 超限哨兵：JS 侧翻成人话（见文件头注）。用 `?` 直接返回它，文案不在这边拼。
pub const TOO_LARGE_SENTINEL: &str = "__MOQI_TOO_LARGE__";

/// 落点字串 → `FilePath`：**带协议的（`content://` / `file://`）必须走 Url 分支**——
/// `Path` 分支会把它当成普通字符串路径交给 `std::fs`（在 Android 上必然失败）。
fn file_path_of(raw: &str) -> Result<FilePath, String> {
    if raw.contains("://") {
        let url: tauri::Url = raw
            .parse()
            .map_err(|error| format!("落点不是合法 URL：{error}"))?;
        Ok(FilePath::Url(url))
    } else {
        Ok(FilePath::Path(PathBuf::from(raw)))
    }
}

/// `OpenOptions` 的字段是私有的，插件的自测也走 serde（`serde_json::from_str::<OpenOptions>`）；
/// 这里同一套：只开需要的位，别把别的默认位带进去（`read` 默认 true）。
fn options(value: serde_json::Value) -> Result<OpenOptions, String> {
    serde_json::from_value(value).map_err(|error| format!("打开参数不合法：{error}"))
}

/// 导入用的暂存结果：绝对路径 ＋ 字节数 ＋ 是不是 zip（魔数 `PK`）；名字与扩展名由 JS 定。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedSafDocument {
    pub path: String,
    pub size: u64,
    pub is_zip: bool,
}

/// 读出 SAF 选中的文档、落进应用缓存目录，返回缓存里的绝对路径（导入方向）。
#[tauri::command]
pub async fn stage_saf_document(
    app: tauri::AppHandle,
    uri: String,
) -> Result<StagedSafDocument, String> {
    let source = app
        .fs()
        .open(file_path_of(&uri)?, options(json!({ "read": true }))?)
        .map_err(|error| format!("读不了选中的文件：{error}"))?;
    // 按上限 +1 读：超限立刻停（不落盘、不整份拉进内存）。用 `take` 拿走句柄——
    // `by_ref` 在这里会与 `Write::by_ref` 撞名（`File` 同时实现了读写）。
    let mut limited = source.take(IMPORT_LIMIT_BYTES + 1);
    let mut bytes: Vec<u8> = Vec::with_capacity(64 * 1024);
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取选中文件失败：{error}"))?;
    if bytes.len() as u64 > IMPORT_LIMIT_BYTES {
        return Err(TOO_LARGE_SENTINEL.to_owned());
    }
    let is_zip = bytes.len() > 4 && bytes[0] == 0x50 && bytes[1] == 0x4b;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("拿不到缓存目录：{error}"))?
        .join("imports");
    std::fs::create_dir_all(&dir).map_err(|error| format!("建缓存目录失败：{error}"))?;
    let ext = if is_zip { "zip" } else { "md" };
    let path = dir.join(format!(
        "moqi-import-{}-导入的文档.{ext}",
        crate::storage::now_ms()
    ));
    std::fs::write(&path, &bytes).map_err(|error| format!("写缓存失败：{error}"))?;
    Ok(StagedSafDocument {
        path: path.to_string_lossy().into_owned(),
        size: bytes.len() as u64,
        is_zip,
    })
}

/// 把已经写好的本地文件拷进 SAF 落点（导出方向）。返回拷过去的字节数。
#[tauri::command]
pub async fn write_saf_document(
    app: tauri::AppHandle,
    from_path: String,
    uri: String,
) -> Result<u64, String> {
    let mut source =
        std::fs::File::open(&from_path).map_err(|error| format!("打不开源文件：{error}"))?;
    // 不读、只写、截断 ⇒ Android 模式 "wt"（覆盖用户选的新文档）
    let mut target = app
        .fs()
        .open(
            file_path_of(&uri)?,
            options(json!({ "read": false, "write": true, "truncate": true }))?,
        )
        .map_err(|error| format!("写不了目标落点：{error}"))?;
    let copied = std::io::copy(&mut source, &mut target)
        .map_err(|error| format!("拷贝到落点失败：{error}"))?;
    target
        .flush()
        .map_err(|error| format!("落点收尾失败：{error}"))?;
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_uris_take_the_url_branch_and_plain_paths_do_not() {
        assert!(matches!(
            file_path_of("content://com.android.providers.downloads.documents/document/12").unwrap(),
            FilePath::Url(_)
        ));
        assert!(matches!(
            file_path_of("file:///sdcard/Download/a.md").unwrap(),
            FilePath::Url(_)
        ));
        assert!(matches!(
            file_path_of(r"C:\Users\x\a.md").unwrap(),
            FilePath::Path(_)
        ));
        assert!(file_path_of("not a url://").is_err(), "坏 URL 要如实报错");
    }

    #[test]
    fn write_options_do_not_read() {
        // `OpenOptions` 只派生 `Deserialize`（字段私有、没有 Serialize）⇒ 用 `Debug` 断言
        // ——它带 `#[derive(Debug)]`，是我们这边能稳定读到的形状。
        let write = format!("{:?}", options(json!({ "read": false, "write": true, "truncate": true })).unwrap());
        assert!(write.contains("read: false"), "写方向不带读位（Android 模式才会落到 wt）：{write}");
        assert!(write.contains("write: true") && write.contains("truncate: true"), "{write}");
        let read = format!("{:?}", options(json!({ "read": true })).unwrap());
        assert!(read.contains("write: false") && read.contains("truncate: false"), "{read}");
        assert!(options(json!({ "read": "不是布尔" })).is_err(), "坏参数要如实报错");
    }
}
