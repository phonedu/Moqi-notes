//! 数据安全：本地快照与整库导出（`docs/03` §15.9；用户 裁决排 0.5 第一项）。
//!
//! **快照与导出都用 SQLite 自带的 `VACUUM INTO`**：产出一份一致的、整理过的单文件副本——
//! 不停写、不用管 WAL、体积就是真实大小。恢复是「先给当前库留一份、再覆盖」。
//!
//! 时间与名字的关系（有意为之）：**日期由调用方给**（前端算好本地的 `YYYY-MM-DD` / ISO 周），
//! Rust 不引时钟库、也不自己算日历；保留策略只看**文件名里的日期**，因此是纯函数、可注入样例单测。

use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

/// 保留策略（用户 拍：7 日 + 4 周，最多 11 份）。
pub const KEEP_DAILY: usize = 7;
pub const KEEP_WEEKLY: usize = 4;
/// 恢复前自动留的那些（`restore-backup-<时间>.sqlite3`）最多留几份。
pub const KEEP_RESTORE_BACKUPS: usize = 3;

/// 导出的结果：落点路径 + 大小（界面要显示路径，让用户找得到）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub size_bytes: u64,
}

impl From<(std::path::PathBuf, u64)> for ExportResult {
    fn from((path, size_bytes): (std::path::PathBuf, u64)) -> Self {
        Self {
            path: path.to_string_lossy().to_string(),
            size_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub name: String,
    /// `daily` / `weekly` / `restore`——界面按这个分组显示。
    pub kind: String,
    pub size_bytes: u64,
    /// 文件的修改时间（毫秒）——排序与显示只看它，不从名字反推。
    pub modified_ms: u64,
}

fn snapshots_dir(db: &Path) -> PathBuf {
    db.parent().unwrap_or(Path::new(".")).join("snapshots")
}

/// `VACUUM INTO`：把 `from` 库导成 `target` 这个**独立文件**（目标已存在会报错 ⇒ 先删）。
fn vacuum_into(from: &Path, target: &Path) -> Result<u64, String> {
    if target.exists() {
        fs::remove_file(target).map_err(|error| format!("删除旧文件失败: {error}"))?;
    }
    let conn = Connection::open(from).map_err(|error| format!("打开源库失败: {error}"))?;
    // 目标路径用**绑定参数**传（`VACUUM INTO` 的参数是表达式）——不手写转义，避免路径里的引号翻车。
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])
        .map_err(|error| format!("导出失败: {error}"))?;
    drop(conn);
    fs::metadata(target)
        .map(|meta| meta.len())
        .map_err(|error| format!("读取导出文件失败: {error}"))
}

/// 建今天的快照；今天已有就是 no-op（返回 `Ok(None)`）。顺带按保留策略清理。
/// `day` = `YYYY-MM-DD`，`week` = `YYYY-Www`（两者的“今天 / 本周”都由调用方给）。
pub fn create_snapshot(db: &Path, day: &str, week: &str) -> Result<Option<SnapshotInfo>, String> {
    if !db.exists() {
        return Ok(None);
    }
    let dir = snapshots_dir(db);
    fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;

    let daily = dir.join(format!("{day}.sqlite3"));
    let weekly = dir.join(format!("{week}.sqlite3"));
    let mut created: Option<PathBuf> = None;
    if !daily.exists() {
        vacuum_into(db, &daily)?;
        created = Some(daily);
    }
    // 每周一份：本周还没有就补（同一次启动里可能同时产出日快照与周快照）
    if !weekly.exists() {
        vacuum_into(db, &weekly)?;
        if created.is_none() {
            created = Some(weekly);
        }
    }
    prune_snapshots(&dir)?;
    match created {
        Some(path) => Ok(Some(info_of(&path)?)),
        None => Ok(None),
    }
}

fn info_of(path: &Path) -> Result<SnapshotInfo, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "快照文件名异常".to_owned())?;
    let meta = fs::metadata(path).map_err(|error| format!("读取快照失败: {error}"))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let kind = if name.starts_with("restore-backup-") {
        "restore"
    } else if name.contains("-W") {
        "weekly"
    } else {
        "daily"
    };
    Ok(SnapshotInfo {
        name,
        kind: kind.to_owned(),
        size_bytes: meta.len(),
        modified_ms,
    })
}

/// 列出快照（新的在前）。`restore-backup-*` 也列出来——它是恢复的后悔药，用户看得到才好。
pub fn list_snapshots(db: &Path) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshots_dir(db);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| format!("读取快照目录失败: {error}"))? {
        let path = entry
            .map_err(|error| format!("读取快照目录失败: {error}"))?
            .path();
        if path
            .extension()
            .map(|ext| ext == "sqlite3")
            .unwrap_or(false)
        {
            out.push(info_of(&path)?);
        }
    }
    out.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| right.name.cmp(&left.name))
    });
    Ok(out)
}

/// 保留策略（**纯函数**，只吃文件名）：日快照留最新 `KEEP_DAILY` 份、周快照留最新
/// `KEEP_WEEKLY` 份、恢复前的后悔药留最新 `KEEP_RESTORE_BACKUPS` 份；其余列出待删。
/// 名字里的日期是 `YYYY-MM-DD` / `YYYY-Www` ⇒ 按名字排序即按时间排序。
pub fn prune_plan(names: &[String]) -> Vec<String> {
    let mut daily: Vec<&String> = names
        .iter()
        .filter(|name| !name.starts_with("restore-backup-") && !name.contains("-W"))
        .collect();
    let mut weekly: Vec<&String> = names
        .iter()
        .filter(|name| name.contains("-W") && !name.starts_with("restore-backup-"))
        .collect();
    let mut restores: Vec<&String> = names
        .iter()
        .filter(|name| name.starts_with("restore-backup-"))
        .collect();
    daily.sort();
    weekly.sort();
    restores.sort();
    let mut doomed: Vec<String> = Vec::new();
    for group in [
        (&mut daily, KEEP_DAILY),
        (&mut weekly, KEEP_WEEKLY),
        (&mut restores, KEEP_RESTORE_BACKUPS),
    ] {
        let (list, keep) = group;
        if list.len() > keep {
            let cut = list.len() - keep;
            for name in list.drain(..cut) {
                doomed.push(name.clone());
            }
        }
    }
    doomed.sort();
    doomed
}

fn prune_snapshots(dir: &Path) -> Result<usize, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| format!("读取快照目录失败: {error}"))? {
        let path = entry
            .map_err(|error| format!("读取快照目录失败: {error}"))?
            .path();
        if path
            .extension()
            .map(|ext| ext == "sqlite3")
            .unwrap_or(false)
        {
            names.push(
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
            );
        }
    }
    let doomed = prune_plan(&names);
    for name in &doomed {
        let _ = fs::remove_file(dir.join(name));
    }
    Ok(doomed.len())
}

/// 从快照恢复：**先给当前库留一份后悔药**（`restore-backup-<stamp>.sqlite3`），再覆盖主库。
/// `stamp` 由调用方给（形如 `2026-10-05T0912`，用文件名安全的字符）。
/// 覆盖前会 checkpoint 并清掉主库旁的 `-wal` / `-shm`——`VACUUM INTO` 产物是自包含的，
/// 留着旧的 WAL 会让 SQLite 拿它去“补”新库（这是恢复这类操作最经典的翻车点）。
pub fn restore_snapshot(db: &Path, name: &str, stamp: &str) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("快照名非法".to_owned());
    }
    let dir = snapshots_dir(db);
    let source = dir.join(name);
    if !source.exists() {
        return Err(format!("快照不存在：{name}"));
    }
    let _ = stash_regret(db, stamp)?;
    swap_in_database(db, &source)?;
    let _ = prune_snapshots(&dir);
    Ok(())
}

/// 恢复前自动留的后悔药（当前库 → `snapshots/restore-backup-<stamp>.sqlite3`）；返回文件名。
/// 快照恢复与备份包恢复共用——这段顺序（VACUUM INTO 出一致副本）错一步就丢后悔药。
fn stash_regret(db: &Path, stamp: &str) -> Result<String, String> {
    let dir = snapshots_dir(db);
    fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;
    let name = format!("restore-backup-{stamp}.sqlite3");
    vacuum_into(db, &dir.join(&name))?;
    Ok(name)
}

/// 把 `source` 换进主库：先 checkpoint 再清 `-wal` / `-shm`，最后拷回来。
/// `VACUUM INTO` 产物是自包含的，留着旧的 WAL 会让 SQLite 拿它去"补"新库（恢复这类操作最经典的翻车点）。
fn swap_in_database(db: &Path, source: &Path) -> Result<(), String> {
    if let Ok(conn) = Connection::open(db) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db.to_string_lossy()));
        if side.exists() {
            let _ = fs::remove_file(side);
        }
    }
    fs::copy(source, db).map_err(|error| format!("恢复失败: {error}"))?;
    Ok(())
}

/// 一键导出：把**当前库**连同资产导成 `exports/<file_name>.zip`（`project-b.sqlite3` + `assets/`）。
///
/// `13-媒体设计` §6 / `13-数据安全设计` §4.3 的 修订：**整库导出必须是 zip**——
/// 只带 sqlite 的话图片与附件还留在数据目录里，「一键带走」名不副实；恢复流程不受影响
/// （应用内恢复走快照列表，不选文件；这个包是留给「换机器 / 留档」的）。
/// 库文件先 `VACUUM INTO` 出一份独立副本（一致、不停写），打完包就把中转文件删掉。
///
/// 为什么不是「系统另存为」：那要引 `tauri-plugin-dialog`，而它会连带升级 `tauri` / `wry`
/// （锁在 V2c 验证过的版本上）——**为一次导出动 WebView 版本不划算**。落在一个认得的目录里、
/// 把路径显示给用户，是同等诚实的做法；「另存为」留给下一版单独一轮（锁版本 + 重验双端）。
pub fn export_database(db: &Path, file_name: &str) -> Result<(PathBuf, u64), String> {
    if !db.exists() {
        return Err("当前还没有数据库".to_owned());
    }
    let target = exports_path(db, file_name, "zip")?;
    if target.exists() {
        fs::remove_file(&target).map_err(|error| format!("删除旧文件失败: {error}"))?;
    }
    // 中转文件放在 exports/ 里、与包同名：打包中途失败时也认得它属于谁（成功路径上必删）。
    let staging = target.with_extension("sqlite3.tmp");
    vacuum_into(db, &staging)?;

    let mut entries = vec![crate::export::ZipEntry::File {
        path: "project-b.sqlite3".to_owned(),
        from: staging.clone(),
    }];
    let asset_dir = crate::assets::assets_dir(db)?;
    for name in crate::assets::list_asset_names(db)? {
        entries.push(crate::export::ZipEntry::File {
            path: format!("assets/{name}"),
            from: asset_dir.join(&name),
        });
    }
    let packed = crate::export::write_zip_package(&target, &entries);
    let _ = fs::remove_file(&staging);
    Ok((target, packed?))
}

/// 把**某一份快照**导出成 `exports/<file_name>.sqlite3`（把某一天的数据单独拿走）。返回落点路径与大小。
///
/// 快照**只含库文件**（设计如此：每日快照不复制资产，缺口见 `13-媒体设计` §6）——
/// 要连图片附件一起带走，用「导出整库」。
pub fn export_snapshot(db: &Path, name: &str, file_name: &str) -> Result<(PathBuf, u64), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("快照名非法".to_owned());
    }
    let source = snapshots_dir(db).join(name);
    if !source.exists() {
        return Err(format!("快照不存在：{name}"));
    }
    let target = exports_path(db, file_name, "sqlite3")?;
    if target.exists() {
        fs::remove_file(&target).map_err(|error| format!("删除旧文件失败: {error}"))?;
    }
    fs::copy(&source, &target).map_err(|error| format!("导出失败: {error}"))?;
    let size = fs::metadata(&target)
        .map(|meta| meta.len())
        .map_err(|error| format!("读取导出文件失败: {error}"))?;
    Ok((target, size))
}

/// `exports/<file_name>.<ext>`：只收**文件名**（不许带路径分隔符），按需补后缀与建目录。
fn exports_path(db: &Path, file_name: &str, ext: &str) -> Result<PathBuf, String> {
    let clean = file_name.trim();
    if clean.is_empty() || clean.contains('/') || clean.contains('\\') || clean.contains("..") {
        return Err("导出文件名非法".to_owned());
    }
    let dir = db.parent().unwrap_or(Path::new(".")).join("exports");
    fs::create_dir_all(&dir).map_err(|error| format!("创建导出目录失败: {error}"))?;
    let suffix = format!(".{ext}");
    let name = if clean.ends_with(&suffix) {
        clean.to_owned()
    } else {
        format!("{clean}{suffix}")
    };
    Ok(dir.join(name))
}

/// 备份包的一条（`exports/` 下含根级 `project-b.sqlite3` 的 `.zip`）——「从备份包恢复」列它用。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfoOut {
    pub name: String,
    pub size_bytes: u64,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRestoreOut {
    /// 恢复前的后悔药快照名（`restore-backup-<stamp>.sqlite3`）。
    pub regret: String,
    /// 从包里落回数据目录的资产数。
    pub assets: usize,
}

/// `exports/` 目录（与快照目录同族；不存在 = 空表，不建）。
fn exports_dir(db: &Path) -> PathBuf {
    db.parent().unwrap_or(Path::new(".")).join("exports")
}

/// 列出 `exports/` 下的**备份包**：能打开、且包里含根级 `project-b.sqlite3` 的 `.zip`。
/// Markdown 导出物与快照单文件不在这一列（「两种 zip 分不清」在**列表这一层**就分开，场景 G）。
pub fn list_packages(db: &Path) -> Result<Vec<PackageInfoOut>, String> {
    let dir = exports_dir(db);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| format!("读导出目录失败: {error}"))? {
        let entry = entry.map_err(|error| format!("读导出目录失败: {error}"))?;
        let path = entry.path();
        if !path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("zip")).unwrap_or(false) {
            continue;
        }
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let archive = match zip::ZipArchive::new(file) {
            Ok(archive) => archive,
            Err(_) => continue,
        };
        if !archive.file_names().flatten().any(|name| name == "project-b.sqlite3") {
            continue;
        }
        let meta = entry.metadata().map_err(|error| format!("读文件信息失败: {error}"))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        out.push(PackageInfoOut {
            name: path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default(),
            size_bytes: meta.len(),
            modified_ms,
        });
    }
    out.sort_by_key(|left| std::cmp::Reverse(left.modified_ms));
    Ok(out)
}

/// 从备份包恢复（场景 B「换机器」闭环）：**校验** → 先留「恢复前」→ 换库 → `assets/` 落回 → 快照滚动。
/// 校验三条：包内有根级库、库是 SQLite（魔数）、库里有 `blocks` 表——错一条都拒（宁可不恢复）。
pub fn restore_from_package(db: &Path, name: &str, stamp: &str) -> Result<PackageRestoreOut, String> {
    let clean = name.trim();
    if clean.is_empty() || clean.contains('/') || clean.contains('\\') || clean.contains("..") {
        return Err("备份包名非法".to_owned());
    }
    let package = exports_dir(db).join(clean);
    if !package.exists() {
        return Err(format!("备份包不存在：{clean}"));
    }
    let staging = exports_dir(db).join(format!(".restore-{stamp}.sqlite3"));
    let mut assets_landed = 0usize;
    {
        let file = fs::File::open(&package).map_err(|error| format!("打不开备份包：{error}"))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("这不是一个能读的 .zip：{error}"))?;
        {
            let mut entry = archive
                .by_name("project-b.sqlite3")
                .map_err(|_| "包里没有根级 project-b.sqlite3——不像整库备份包（Markdown 包请走「导入」）".to_owned())?;
            let mut out = fs::File::create(&staging).map_err(|error| format!("写临时文件失败：{error}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|error| format!("解出库文件失败：{error}"))?;
        }
        if let Err(error) = validate_package_database(&staging) {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
        let asset_dir = crate::assets::assets_dir(db)?;
        let names: Vec<String> = archive.file_names().flatten().filter(|name| name.starts_with("assets/")).map(|name| name.to_string()).collect();
        for entry_name in names {
            let remainder = entry_name.trim_start_matches("assets/").to_owned();
            if remainder.is_empty() || remainder.contains('/') || remainder.contains('\\') || remainder.contains("..") {
                continue;
            }
            let mut entry = archive.by_name(&entry_name).map_err(|error| format!("读包内资产失败：{error}"))?;
            let mut bytes = Vec::new();
            std::io::copy(&mut entry, &mut bytes).map_err(|error| format!("读包内资产失败：{error}"))?;
            fs::write(asset_dir.join(&remainder), &bytes).map_err(|error| format!("落资产失败：{error}"))?;
            assets_landed += 1;
        }
    }
    let regret = stash_regret(db, stamp)?;
    swap_in_database(db, &staging)?;
    let _ = fs::remove_file(&staging);
    let _ = prune_snapshots(&snapshots_dir(db));
    Ok(PackageRestoreOut { regret, assets: assets_landed })
}

/// 校验包内库：SQLite 魔数 + 有 `blocks` 表（形状对不上宁可拒——恢复是覆盖性动作）。
fn validate_package_database(path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|error| format!("读临时库失败：{error}"))?;
    if bytes.len() < 16 || &bytes[..16] != b"SQLite format 3\0" {
        return Err("包内的 project-b.sqlite3 不是 SQLite 文件——包可能损坏".to_owned());
    }
    let conn = Connection::open(path).map_err(|error| format!("打开包内库失败：{error}"))?;
    let count: i64 = conn
        .query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='blocks'", [], |row| row.get(0))
        .map_err(|error| format!("检查包内库失败：{error}"))?;
    if count != 1 {
        return Err("包内库的形状不对（没有 blocks 表）——不是本应用的整库备份".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteBlockStore;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("moqi-backup-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
        fn db(&self) -> PathBuf {
            self.0.join("project-b.sqlite3")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seed(db: &Path, count: usize) {
        let mut store = SqliteBlockStore::open(db).expect("开库");
        for index in 0..count {
            let json = format!(
                r#"{{"entityId":"b{index}","blockUid":"u{index}","type":"text","content":[{{"t":"text","v":"第 {index} 块"}}],"parent":null,"children":[],"position":{index},"collapsed":false,"checked":false,"deleted":false,"deletedAt":null,"prevParent":null,"prevIndex":null,"isObject":false,"objectName":null,"properties":[],"tags":[],"blockRefs":[],"blockBackRefs":[],"objectRefs":[],"objectBackRefs":[],"aiMeta":null,"created":1,"modified":1}}"#
            );
            store
                .upsert_block(
                    &crate::storage::StoredBlock::from_block_json(&json).expect("块 JSON"),
                )
                .expect("写块");
        }
    }

    fn count(db: &Path) -> i64 {
        let conn = Connection::open(db).expect("开库");
        conn.query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))
            .expect("数块")
    }

    #[test]
    fn snapshot_is_a_real_standalone_database() {
        let temp = TempDir::new("snap");
        seed(&temp.db(), 3);
        let made = create_snapshot(&temp.db(), "2026-10-05", "2026-W40")
            .expect("建快照")
            .expect("应产出");
        assert_eq!(made.kind, "daily");
        let snap = snapshots_dir(&temp.db()).join("2026-10-05.sqlite3");
        assert!(snap.exists(), "日快照要落盘");
        assert!(
            snapshots_dir(&temp.db()).join("2026-W40.sqlite3").exists(),
            "同一次启动补周快照"
        );
        // 快照本身是一个能直接打开的库，且块数一致——这就是「可恢复」的判据
        assert_eq!(count(&snap), 3);
        // 同一天再建是 no-op
        assert!(create_snapshot(&temp.db(), "2026-10-05", "2026-W40")
            .expect("再建")
            .is_none());
    }

    #[test]
    fn retention_keeps_seven_daily_and_four_weekly_by_name() {
        let mut names: Vec<String> = (1..=12)
            .map(|day| format!("2026-09-{day:02}.sqlite3"))
            .collect();
        names.extend((30..=35).map(|week| format!("2026-W{week}.sqlite3")));
        names.push("restore-backup-2026-10-05T0912.sqlite3".to_owned());
        let doomed = prune_plan(&names);
        assert_eq!(doomed.len(), (12 - KEEP_DAILY) + (6 - KEEP_WEEKLY));
        assert!(
            doomed.contains(&"2026-09-01.sqlite3".to_owned()),
            "最老的日快照该删"
        );
        assert!(
            !doomed.contains(&"2026-09-12.sqlite3".to_owned()),
            "最新的日快照要留"
        );
        assert!(!doomed.contains(&"2026-W35.sqlite3".to_owned()));
        assert!(
            !doomed.contains(&"restore-backup-2026-10-05T0912.sqlite3".to_owned()),
            "后悔药不在日/周策略里"
        );
    }

    #[test]
    fn prune_only_keeps_the_newest_restore_backups() {
        let names: Vec<String> = (1..=5)
            .map(|n| format!("restore-backup-2026-10-0{n}T0900.sqlite3"))
            .collect();
        let doomed = prune_plan(&names);
        assert_eq!(doomed.len(), 2);
        assert!(doomed.contains(&"restore-backup-2026-10-01T0900.sqlite3".to_owned()));
    }

    #[test]
    fn restore_keeps_a_regret_copy_and_brings_the_data_back() {
        let temp = TempDir::new("restore");
        seed(&temp.db(), 3);
        create_snapshot(&temp.db(), "2026-10-05", "2026-W40").expect("建快照");
        // 快照之后又写了两块（这些改动在恢复后会丢）
        {
            let mut store = SqliteBlockStore::open(temp.db()).expect("开库");
            for index in 3..5 {
                let json = format!(
                    r#"{{"entityId":"b{index}","blockUid":"u{index}","type":"text","content":[],"parent":null,"children":[],"position":{index},"collapsed":false,"checked":false,"deleted":false,"deletedAt":null,"prevParent":null,"prevIndex":null,"isObject":false,"objectName":null,"properties":[],"tags":[],"blockRefs":[],"blockBackRefs":[],"objectRefs":[],"objectBackRefs":[],"aiMeta":null,"created":1,"modified":1}}"#
                );
                store
                    .upsert_block(
                        &crate::storage::StoredBlock::from_block_json(&json).expect("块 JSON"),
                    )
                    .expect("写块");
            }
        }
        assert_eq!(count(&temp.db()), 5);

        restore_snapshot(&temp.db(), "2026-10-05.sqlite3", "2026-10-05T1000").expect("恢复");
        assert_eq!(count(&temp.db()), 3, "恢复后回到快照那一刻");
        let regret = snapshots_dir(&temp.db()).join("restore-backup-2026-10-05T1000.sqlite3");
        assert!(regret.exists(), "恢复前必须先留后悔药");
        assert_eq!(count(&regret), 5, "后悔药里是恢复前的样子");
    }

    #[test]
    fn restore_refuses_paths_outside_the_folder() {
        let temp = TempDir::new("escape");
        seed(&temp.db(), 1);
        assert!(restore_snapshot(&temp.db(), "../project-b.sqlite3", "x").is_err());
        assert!(export_snapshot(&temp.db(), "..\\evil.sqlite3", "out").is_err());
        assert!(
            export_database(&temp.db(), "../逃逸").is_err(),
            "导出只收文件名，不许带路径"
        );
        assert!(export_database(&temp.db(), "a/b").is_err());
    }

    #[test]
    fn export_database_and_snapshot_produce_openable_files() {
        let temp = TempDir::new("export");
        seed(&temp.db(), 2);
    // 整库导出是 **zip 包**（ 修订）：库文件 + assets/ 一起走，否则「一键带走」丢图。
        crate::assets::write_asset(&temp.db(), "a1b2c3.png", &[0x89, 0x50, 0x4e, 0x47])
            .expect("写资产");
        create_snapshot(&temp.db(), "2026-10-04", "2026-W40").expect("建快照");
        let (whole, size) = export_database(&temp.db(), "墨契-备份-2026-10-05").expect("导出整库");
        assert!(size > 0);
        assert!(
            whole.starts_with(temp.0.join("exports")),
            "落在数据目录下的 exports/ 里：{whole:?}"
        );
        assert_eq!(
            whole.file_name().unwrap().to_string_lossy(),
            "墨契-备份-2026-10-05.zip",
            "自动补后缀"
        );
        assert!(
            !whole.with_extension("sqlite3.tmp").exists(),
            "中转的库文件打完包要删掉"
        );

        // 包内：根上是库文件、assets/ 下是资产；库文件解出来仍然是能打开、块数对得上的 SQLite。
        let file = fs::File::open(&whole).expect("打开导出包");
        let mut archive = zip::ZipArchive::new(file).expect("读出包结构");
        let mut names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).expect("取条目").name().expect("条目名").to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "assets/a1b2c3.png".to_owned(),
                "project-b.sqlite3".to_owned()
            ]
        );
        let mut unpacked = fs::File::create(temp.0.join("unpacked.sqlite3")).expect("落盘中转");
        std::io::copy(
            &mut archive.by_name("project-b.sqlite3").expect("包内有库文件"),
            &mut unpacked,
        )
        .expect("解出库文件");
        drop(unpacked);
        assert_eq!(
            count(&temp.0.join("unpacked.sqlite3")),
            2,
            "包里的库能打开且块数一致"
        );

        // 单份快照导出照旧是**裸 sqlite**（快照本来就不含资产，见 `13-媒体设计` §6）。
        let (one, _) =
            export_snapshot(&temp.db(), "2026-10-04.sqlite3", "某一天").expect("导出快照");
        assert_eq!(one.file_name().unwrap().to_string_lossy(), "某一天.sqlite3");
        assert_eq!(count(&one), 2);
    }

  /// 边界电池④（）：恢复前必须清掉主库旁的 `-wal` / `-shm`——`VACUUM INTO` 产物是
    /// 自包含的，留着旧 WAL 会让 SQLite 拿它去「补」新库。这里塞两个**垃圾旁文件**模拟崩溃残留：
    /// 恢复要照常成功、旁文件被清掉、回来的是快照那一刻的内容。
    #[test]
    fn restore_clears_stale_wal_sidecars() {
        let temp = TempDir::new("wal");
        seed(&temp.db(), 2);
        create_snapshot(&temp.db(), "2026-10-05", "2026-W40").expect("建快照");
        // 快照之后又写一块（恢复后会丢）
        {
            let mut store = SqliteBlockStore::open(temp.db()).expect("开库");
            let json = r#"{"entityId":"b2","blockUid":"u2","type":"text","content":[],"parent":null,"children":[],"position":2,"collapsed":false,"checked":false,"deleted":false,"deletedAt":null,"prevParent":null,"prevIndex":null,"isObject":false,"objectName":null,"properties":[],"tags":[],"blockRefs":[],"blockBackRefs":[],"objectRefs":[],"objectBackRefs":[],"aiMeta":null,"created":1,"modified":1}"#;
            store
                .upsert_block(&crate::storage::StoredBlock::from_block_json(json).expect("块 JSON"))
                .expect("写块");
        }
        // 崩溃残留：两个垃圾旁文件（内容读不动，但存在本身就是风险）
        let wal = PathBuf::from(format!("{}-wal", temp.db().to_string_lossy()));
        let shm = PathBuf::from(format!("{}-shm", temp.db().to_string_lossy()));
        fs::write(&wal, b"stale wal garbage").expect("塞 -wal");
        fs::write(&shm, b"stale shm garbage").expect("塞 -shm");

        restore_snapshot(&temp.db(), "2026-10-05.sqlite3", "2026-10-05T1100").expect("恢复");
        assert!(!wal.exists() && !shm.exists(), "恢复必须清掉旁文件");
        assert_eq!(count(&temp.db()), 2, "回来的是快照那一刻");
    }

    #[test]
    fn restore_from_package_roundtrip_and_refusals() {
        let temp = TempDir::new("package");
        seed(&temp.db(), 3);
        crate::assets::write_asset(&temp.db(), "pic-1.png", &[0x89, 0x50, 0x4e, 0x47]).expect("写资产");
        let (package, _) = export_database(&temp.db(), "墨契-备份-x").expect("导出整库");
        let name = package.file_name().unwrap().to_string_lossy().to_string();

        // 列表：只列备份包（含根级库的 zip）。
        let listed = list_packages(&temp.db()).expect("列包");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, name);
        let stray = exports_dir(&temp.db()).join("随手包.zip");
        let plain = exports_dir(&temp.db()).join("plain.md");
        fs::write(&plain, b"# hi").expect("写 md");
        crate::export::write_zip_package(
            &stray,
            &[crate::export::ZipEntry::File { path: "a.md".to_owned(), from: plain }],
        )
        .expect("打一个普通 zip");
        assert_eq!(list_packages(&temp.db()).expect("再列").len(), 1, "没有根级库的 zip 不算备份包");

        // 恢复：库里先多写两块 → 恢复回包里那一刻（3 块）+ 后悔药（5 块）+ 资产落回。
        seed(&temp.db(), 5);
        let report = restore_from_package(&temp.db(), &name, "2026-10-12T0900").expect("从包恢复");
        assert_eq!(count(&temp.db()), 3, "回来的是包里那一刻");
        assert_eq!(report.assets, 1, "包内 assets/ 落回数据目录");
        assert!(report.regret.starts_with("restore-backup-"));
        let regret = snapshots_dir(&temp.db()).join(&report.regret);
        assert!(regret.exists(), "恢复前必须先留后悔药");
        assert_eq!(count(&regret), 5, "后悔药里是恢复前的样子");
        assert!(crate::assets::assets_dir(&temp.db()).expect("资产目录").join("pic-1.png").exists());

        // 拒绝面：不存在的包 / 普通 zip（无库）/ 坏 zip / 逃逸名。
        assert!(restore_from_package(&temp.db(), "没有这个.zip", "s").is_err());
        assert!(restore_from_package(&temp.db(), "随手包.zip", "s").is_err(), "Markdown 包不算备份包");
        let garbage = exports_dir(&temp.db()).join("garbage.zip");
        fs::write(&garbage, b"not a zip at all").expect("写垃圾");
        assert!(restore_from_package(&temp.db(), "garbage.zip", "s").is_err());
        assert!(restore_from_package(&temp.db(), "../逃逸.zip", "s").is_err());
        assert!(list_packages(&temp.db()).expect("名单").iter().all(|entry| entry.name != "garbage.zip"));
    }
}
