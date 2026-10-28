//! 墨契的原生壳。
//!
//! **入口住在这里而不是 `main.rs`**：Tauri 2 的移动端（Android）要求 `lib.rs` 暴露一个带
//! `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 的 `run()`，`main.rs` 退化为一行调用它。
//! 桌面与移动共用这一份壳，平台差异只在窗口配置与 `StoragePort` 的实现里。
//!
//! 存储层（`storage` / `sync_files` / `backup`）不含平台专属代码，所以 Android 交叉编译不需要改它。
mod assets;
mod backup;
mod export;
mod saf;
mod storage;
mod sync_files;

// 造性能采样库的工具（0.6 性能批 ⓐ 的前置）——`#[cfg(test)]` 专用，不进产品二进制。
// 手动跑：`cargo test perf_fixture -- --ignored --nocapture`（详见文件头注）。
#[cfg(test)]
mod perf_fixture;

use std::fs;
use std::path::PathBuf;
use storage::SqliteBlockStore;
use tauri::{AppHandle, Manager};

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    // V2b：`MOQI_DATA_DIR` 可以指定数据目录。同机双实例验收（两个客户端对同一个共享目录）
    // 需要**两个互不干扰的库**——否则两个进程会抢同一个 SQLite 文件，那验的就不是同步了。
    // 不设这个变量时行为与以前完全一致（走 `app_data_dir`）。
    let directory = match std::env::var("MOQI_DATA_DIR") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法取得应用数据目录: {error}"))?,
    };
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    Ok(directory.join("project-b.sqlite3"))
}

/// V2b：把本机这批变更**追加**到共享目录里的 `<deviceId>.jsonl`。
/// 逻辑住在 `sync_files`（那里能直接被单测覆盖：路径、追加语义、坏文件、目录穿越）。
#[tauri::command]
fn sync_append(directory: String, device_id: String, lines: Vec<String>) -> Result<(), String> {
    sync_files::append(&directory, &device_id, &lines)
}

/// V2b：读回共享目录里**其他设备**的变更文件。本机自己的那份跳过。
#[tauri::command]
fn sync_read_others(
    directory: String,
    device_id: String,
) -> Result<Vec<sync_files::SyncFilePayload>, String> {
    sync_files::read_others(&directory, &device_id)
}

/// 资产随同步（`docs/03` §14.2「媒体文件」；13-媒体设计（已归档）§2 第 3 行的裁决， 落地）：
/// 推本机有、共享目录没有的资产，拉本机缺、共享目录有的资产；只增不减，缺失的如实报回。
#[tauri::command]
async fn sync_assets_exchange(
    app: AppHandle,
    directory: String,
    push: Vec<String>,
    want: Vec<String>,
) -> Result<sync_files::SyncAssetsReport, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let assets = assets::assets_dir(&path)?;
        sync_files::assets_exchange(&assets, &directory, &push, &want)
    })
    .await
    .map_err(|error| format!("资产交换任务异常退出: {error}"))?
}

#[tauri::command]
fn data_directory(app: AppHandle) -> Result<String, String> {
    database_path(&app).and_then(|path| {
        path.parent()
            .map(|value| value.to_string_lossy().into_owned())
            .ok_or_else(|| "应用数据目录为空".to_owned())
    })
}

#[tauri::command]
fn load_blocks(app: AppHandle) -> Result<Vec<String>, String> {
    let path = database_path(&app)?;
    let store =
        SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    // 带上回收站里的块（`list_all`）：回收站列表与「30 天到期清理」都从载入的块里找
  // （ 清单 C 实测：只载入存活块会让回收站重启后变空、到期清理永不触发）。
    store
        .list_all_json()
        .map_err(|error| format!("读取 Block 失败: {error}"))
}

#[tauri::command]
async fn save_blocks(app: AppHandle, blocks: Vec<String>) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        let mut refs_changed = false;
        for json in &blocks {
            let incoming = storage::StoredBlock::from_block_json(json)?;
            let previous = store
                .get_block(&incoming.entity_id)
                .map_err(|error| format!("读取待更新 Block 失败: {error}"))?;
            refs_changed |= previous.as_ref().is_none_or(|block| {
                block.block_refs_json != incoming.block_refs_json
                    || block.object_refs_json != incoming.object_refs_json
                    || block.deleted != incoming.deleted
            });
            store.save_block_json(json)?;
        }
        // Ordinary typing changes content only. Rebuilding the whole reverse
        // index for every keystroke would keep the save task alive for the
        // lifetime of a large document. Rebuild only when refs/deletion data
        // actually changed; full saves still rebuild unconditionally.
        if refs_changed {
            store
                .rebuild_reverse_index()
                .map_err(|error| format!("重建反向引用失败: {error}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("保存任务异常退出: {error}"))?
}

/// V2b：「从本机彻底删除」。与 `save_blocks` 分属两条路——它删行，不是存行。
/// 不进 oplog（回收站的彻底删除是本机行为，不参与同步，见 `docs/03` §14.5）。
#[tauri::command]
async fn purge_blocks(app: AppHandle, entity_ids: Vec<String>) -> Result<usize, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        let removed = store
            .purge_blocks(&entity_ids)
            .map_err(|error| format!("删除 Block 失败: {error}"))?;
        if removed > 0 {
            store
                .rebuild_reverse_index()
                .map_err(|error| format!("重建反向引用失败: {error}"))?;
        }
        Ok(removed)
    })
    .await
    .map_err(|error| format!("删除任务异常退出: {error}"))?
}

/// V2b：本机设备身份（`oplog` 按它分区、游标按设备记、冲突定序在时间戳相同时按它比）。
/// 库里有就用库里的；没有才把 `candidate` 落库——候选值由前端 `crypto.randomUUID()` 生成，
/// 这样 Rust 侧不必为生成 UUID 引入新依赖。
#[tauri::command]
async fn resolve_device_id(app: AppHandle, candidate: String) -> Result<String, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        store
            .resolve_device_id(&candidate)
            .map_err(|error| format!("读写设备身份失败: {error}"))
    })
    .await
    .map_err(|error| format!("设备身份任务异常退出: {error}"))?
}

/// V2b：把一次领域事务落进 `transaction_history` + `oplog`（`docs/03` §14.2 的「变更集」来源）。
///
/// 与 `save_blocks` 的区别是它**同时写变更日志**——同步只读这份日志，所以凡是要参与同步的
/// 写入都必须走这里。两者在同一个 SQLite 事务里提交，要么都成、要么都不成。
#[tauri::command]
async fn commit_transaction(
    app: AppHandle,
    transaction: storage::PersistedTransaction,
    blocks: Vec<String>,
) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        let stored = blocks
            .iter()
            .map(|json| storage::StoredBlock::from_block_json(json))
            .collect::<std::result::Result<Vec<_>, String>>()?;
        store
            .commit_transaction(&transaction, &stored)
            .map_err(|error| format!("写入事务失败: {error}"))
    })
    .await
    .map_err(|error| format!("事务任务异常退出: {error}"))?
}

/// Persist one complete editor batch, including its durable retry receipt.
#[tauri::command]
async fn commit_persist_batch(
    app: AppHandle,
    batch_id: String,
    transactions: Vec<storage::PersistedTransaction>,
    blocks: Vec<String>,
    purged: Vec<String>,
) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = SqliteBlockStore::open(path).map_err(|error| error.to_string())?;
        let stored = blocks
            .iter()
            .map(|json| storage::StoredBlock::from_block_json(json))
            .collect::<Result<Vec<_>, String>>()?;
        store
            .commit_batch(&batch_id, &transactions, &stored, &purged)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("批次任务异常退出: {error}"))?
}

/// V2b：只读已落盘的 `seq > from_seq` 日志，不读取内存中的未保存内容。
#[tauri::command]
fn load_oplog(
    app: AppHandle,
    device_id: String,
    from_seq: i64,
) -> Result<Vec<storage::OplogRow>, String> {
    let path = database_path(&app)?;
    let store =
        SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    store
        .load_oplog(&device_id, from_seq)
        .map_err(|error| format!("读取变更日志失败: {error}"))
}

/// V2b：本机 `oplog` 的最大 `seq`——没用它，「还有 N 条待同步」就没法如实显示。
#[tauri::command]
fn max_oplog_seq(app: AppHandle, device_id: String) -> Result<i64, String> {
    let path = database_path(&app)?;
    let store =
        SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    store
        .max_oplog_seq(&device_id)
        .map_err(|error| format!("读取变更日志游标失败: {error}"))
}

#[tauri::command]
fn load_metadata(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = database_path(&app)?;
    let store =
        SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    store
        .get_metadata(&key)
        .map_err(|error| format!("读取元数据失败: {error}"))
}

/// V2c：索引状态（`09` `R09-SEARCH-6` / `R09-SET-13`）——设置里「检索索引」那一行读它。
#[tauri::command]
fn index_status(app: AppHandle) -> Result<storage::IndexStatus, String> {
    let path = database_path(&app)?;
    let store =
        SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    store
        .index_status()
        .map_err(|error| format!("读取索引状态失败: {error}"))
}

/// V2c 路线 B：把前端算好的拼音写进索引（启动回填 / 每批保存后刷新）。
/// 索引是派生数据——这个命令**不碰领域、不进 oplog、不改 Block**。
#[tauri::command]
async fn update_pinyin_index(
    app: AppHandle,
    entries: Vec<storage::PinyinEntry>,
) -> Result<usize, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        let rows: Vec<(String, String, String)> = entries
            .into_iter()
            .map(|entry| (entry.entity_id, entry.full, entry.initials))
            .collect();
        store
            .update_pinyin_index(&rows)
            .map_err(|error| format!("写入拼音索引失败: {error}"))
    })
    .await
    .map_err(|error| format!("写入拼音索引失败: {error}"))?
}

/// V2c：⌘K 全局检索（`docs/03` §15.2 缺口 ①——存储层的 `search_hits` 早就有，一直没给前端的口子）。
///
/// 查询走 SQLite FTS5（`trigram`，见 `storage.rs` 的迁移说明）；**1–2 个字的查询由存储层兜底成扫描**
/// ——中文两字词太常见，而 trigram 索引少于三个字命中不了，这条分界在存储层实现、这里不再判一次。
#[tauri::command]
fn search_blocks(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<storage::SearchHit>, String> {
    let path = database_path(&app)?;
    let store =
        SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    store
        .search_hits(&query, limit.unwrap_or(50))
        .map_err(|error| format!("检索失败: {error}"))
}

#[tauri::command]
async fn save_metadata(app: AppHandle, key: String, json: String) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        store
            .set_metadata(&key, &json)
            .map_err(|error| format!("写入元数据失败: {error}"))
    })
    .await
    .map_err(|error| format!("元数据保存任务异常退出: {error}"))?
}

// ---------- 数据安全：本地快照 / 恢复 / 导出（`docs/03` §15.9）----------

/// 建今天的快照（今天已有则 no-op），顺带按保留策略清理。`day` / `week` 由前端按**本地时间**算好传进来
/// （Rust 不引日历库、不自己算周）。
#[tauri::command]
async fn create_snapshot(
    app: AppHandle,
    day: String,
    week: String,
) -> Result<Option<backup::SnapshotInfo>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup::create_snapshot(&path, &day, &week))
        .await
        .map_err(|error| format!("快照任务异常退出: {error}"))?
}

#[tauri::command]
async fn list_snapshots(app: AppHandle) -> Result<Vec<backup::SnapshotInfo>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup::list_snapshots(&path))
        .await
        .map_err(|error| format!("快照列表任务异常退出: {error}"))?
}

/// 从快照恢复：**先给当前库留一份后悔药**再覆盖（`stamp` 由前端给，文件名安全）。
#[tauri::command]
async fn restore_snapshot(app: AppHandle, name: String, stamp: String) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup::restore_snapshot(&path, &name, &stamp))
        .await
        .map_err(|error| format!("恢复任务异常退出: {error}"))?
}

/// 列出 `exports/` 下的**备份包**（含根级 `project-b.sqlite3` 的 .zip）——「从备份包恢复」列它用。
#[tauri::command]
async fn list_backup_packages(app: AppHandle) -> Result<Vec<backup::PackageInfoOut>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup::list_packages(&path))
        .await
        .map_err(|error| format!("备份包列表任务异常退出: {error}"))?
}

/// 从备份包恢复（场景 B 闭环）：校验包内库 → 先留「恢复前」→ 换库 + 落 assets → 快照滚动。
#[tauri::command]
async fn restore_backup_package(app: AppHandle, name: String, stamp: String) -> Result<backup::PackageRestoreOut, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || backup::restore_from_package(&path, &name, &stamp))
        .await
        .map_err(|error| format!("备份包恢复任务异常退出: {error}"))?
}

/// 一键导出：当前库 → 数据目录下 `exports/<file_name>`（可作恢复源）；返回落点路径给界面显示。
#[tauri::command]
async fn export_backup(app: AppHandle, file_name: String) -> Result<backup::ExportResult, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        backup::export_database(&path, &file_name).map(backup::ExportResult::from)
    })
    .await
    .map_err(|error| format!("导出任务异常退出: {error}"))?
}

/// 导出**某一份快照** → 一个独立文件（把某一天的数据单独拿走）。
#[tauri::command]
async fn export_snapshot(
    app: AppHandle,
    name: String,
    file_name: String,
) -> Result<backup::ExportResult, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        backup::export_snapshot(&path, &name, &file_name).map(backup::ExportResult::from)
    })
    .await
    .map_err(|error| format!("导出任务异常退出: {error}"))?
}

/// 媒体资产（`13-媒体设计` §3）：写进 `<数据目录>/assets/`。
/// 字节走 base64（图片量级够用；将来可换原始字节通道，不预先优化）。磁盘名由界面生成（不透明随机名）。
#[tauri::command]
async fn write_asset(
    app: AppHandle,
    file_name: String,
    base64_data: String,
) -> Result<u64, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|error| format!("资产内容不是合法 base64: {error}"))?;
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || assets::write_asset(&path, &file_name, &bytes))
        .await
        .map_err(|error| format!("写资产任务异常退出: {error}"))?
}

/// 「另存为副本」：资产复制进 `<数据目录>/exports/<显示名>`，返回路径给界面显示。
#[tauri::command]
async fn save_asset_copy(
    app: AppHandle,
    file_name: String,
    display_name: String,
) -> Result<String, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        assets::save_copy(&path, &file_name, &display_name)
    })
    .await
    .map_err(|error| format!("另存副本任务异常退出: {error}"))?
}

/// 从**本机路径**导入资产（桌面拖入：Tauri 的拖放事件给的是路径）。返回原名与字节数。
#[tauri::command]
async fn import_asset(
    app: AppHandle,
    source_path: String,
    disk_name: String,
) -> Result<(String, u64), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        assets::import_asset(&path, &source_path, &disk_name)
    })
    .await
    .map_err(|error| format!("导入资产任务异常退出: {error}"))?
}

/// `<数据目录>/assets/` 的绝对路径——界面要拿它拼 `convertFileSrc` 的显示地址。
#[tauri::command]
fn assets_directory(app: AppHandle) -> Result<String, String> {
    let path = database_path(&app)?;
    assets::assets_dir(&path).map(|dir| dir.to_string_lossy().into_owned())
}

/// 哑读：`assets/` 里已有的磁盘名（界面判「文件缺失」用）。
#[tauri::command]
async fn list_assets(app: AppHandle) -> Result<Vec<String>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || assets::list_asset_names(&path))
        .await
        .map_err(|error| format!("读资产目录异常退出: {error}"))?
}

/// 删资产（幂等）——只给「彻底删除 / 到期清理 / 清空回收站」那条路用。
#[tauri::command]
async fn delete_asset(app: AppHandle, file_name: String) -> Result<bool, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || assets::delete_asset(&path, &file_name))
        .await
        .map_err(|error| format!("删资产任务异常退出: {error}"))?
}

/// Markdown 导出（`13-导出与媒体设计`）：**哑读** `exports/` 里已有的文件名——
/// 界面拿它算「不覆盖」的 ` (2)`（命名规则只在 TS 一处，Rust 不参与起名）。
#[tauri::command]
async fn list_export_files(app: AppHandle) -> Result<Vec<String>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || export::list_export_names(&path))
        .await
        .map_err(|error| format!("读取导出目录异常退出: {error}"))?
}

/// 读一个文本文件（导入 Markdown：拖入给的是路径，正文要读进来解析；闸在 `export::read_text_file`）。
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    export::read_text_file(&path)
}

/// 列一个目录下的 Markdown（设置页「选择文件夹」，T-18）：只喂路径，图片由 `dir` 分支找。
#[tauri::command]
async fn list_markdown_files(dir: String) -> Result<Vec<String>, String> {
    export::list_markdown_files(&dir)
}

/// 读一个导入包（`.zip`，第 13 项「拖入 zip」）：解包 + 逐条 base64；分拣在 TS（`domain/mdPackage.ts`）。
#[tauri::command]
async fn read_zip_entries(path: String) -> Result<export::ZipEntriesOut, String> {
    export::read_zip_entries(&path)
}

/// Markdown 导出：把界面算好的内容落到数据目录 `exports/`（单文件或 zip）；返回落点与大小。
#[tauri::command]
async fn write_markdown_export(
    app: AppHandle,
    plan: export::ExportWriteIn,
) -> Result<export::ExportWriteOut, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || export::write_markdown(&path, plan))
        .await
        .map_err(|error| format!("导出任务异常退出: {error}"))?
}

#[tauri::command]
async fn save_block_changes(app: AppHandle, blocks: Vec<String>) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store =
            SqliteBlockStore::open(path).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
        for json in &blocks {
            store.save_block_json(json)?;
        }
        store
            .rebuild_reverse_index()
            .map_err(|error| format!("重建反向引用失败: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("增量保存任务异常退出: {error}"))?
}

/// 外壳入口。桌面端由 `main.rs` 调它；Android 由 `mobile_entry_point` 调它。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 插件轮（`03` §12.4 / T-16）：dialog（桌面原生对话框 ＋ 移动端 SAF）· fs（落盘）· opener（打开目录 / 外链）。
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // 剪贴板（`D-090`）：Android WebView 拒 `navigator.clipboard` ⇒ 复制 / 剪切 / 粘贴走原生。
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 资产协议（asset protocol）：图片 / 附件在**桌面窗口里**的显示地址是
            // `convertFileSrc(<数据目录>/assets/<磁盘名>)`——协议默认 `enable: false` 且 scope 为空，
      // 不在这里放行，WebView 会把地址拒掉：图块画灰/破图、灯箱显示裂图（用户 实测）。
            // **必须在运行时放行**：数据目录可被 `MOQI_DATA_DIR` 改写，写死在 tauri.conf 的 scope 里盖不住。
            use tauri::Manager;
            if let Ok(db) = database_path(app.handle()) {
                if let Ok(dir) = crate::assets::assets_dir(&db) {
                    app.asset_protocol_scope().allow_directory(&dir, true)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data_directory,
            load_blocks,
            save_blocks,
            save_block_changes,
            purge_blocks,
            resolve_device_id,
            commit_transaction,
            commit_persist_batch,
            sync_append,
            sync_read_others,
            sync_assets_exchange,
            load_oplog,
            max_oplog_seq,
            load_metadata,
            save_metadata,
            search_blocks,
            index_status,
            update_pinyin_index,
            create_snapshot,
            list_snapshots,
            restore_snapshot,
            list_backup_packages,
            restore_backup_package,
            export_backup,
            export_snapshot,
            list_export_files,
            read_text_file,
            list_markdown_files,
            saf::stage_saf_document,
            saf::write_saf_document,
            read_zip_entries,
            write_markdown_export,
            write_asset,
            list_assets,
            delete_asset,
            import_asset,
            assets_directory,
            save_asset_copy
        ])
        .run(tauri::generate_context!())
        .expect("启动墨契项目 B 壳失败");
}
