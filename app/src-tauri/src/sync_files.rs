//! V2b：共享目录的文件读写（`docs/03` §14.2 的 `DirectorySyncPort` 的那一半）。
//!
//! 单独成模块是为了**能直接被 Rust 单测覆盖**——真实文件路径、追加语义、坏文件跳过、
//! 目录穿越这些是第一层的同机双端用例（跑在内存实现上）**碰不到**的部分。
//!
//! 形状约定：每台设备一个 `<deviceId>.jsonl`，**只追加自己的**，绝不改写别人的。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 一台设备交上来的变更文件。`lines` 是原样的 JSONL 行，解析归调用方。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFilePayload {
    pub device_id: String,
    pub lines: Vec<String>,
}

/// 某台设备的变更文件路径：`<directory>/<deviceId>.jsonl`。
///
/// `device_id` 由本机生成（UUID），但**从磁盘读回来的文件 stem 是不可信的**，
/// 所以这里做一次拒绝式校验：带路径分隔符或 `..` 的一律拒绝，避免把文件写到共享目录之外。
pub fn file_path(directory: &str, device_id: &str) -> Result<PathBuf, String> {
    if device_id.is_empty()
        || device_id.contains('/')
        || device_id.contains('\\')
        || device_id.contains("..")
        || device_id.contains(':')
    {
        return Err(format!("非法的设备标识: {device_id}"));
    }
    Ok(Path::new(directory).join(format!("{device_id}.jsonl")))
}

/// 把本机这批变更**追加**到自己的文件。空批次直接返回——不产生空文件。
pub fn append(directory: &str, device_id: &str, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    // **先校验再建目录**：非法的设备标识不该在任何地方留下痕迹（先 create_dir_all 的话，
    // 一次被拒绝的写入会凭空造出一个目录）。
    let path = file_path(directory, device_id)?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建同步目录: {error}"))?;
    let mut payload = lines.join("\n");
    payload.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("无法写入同步文件: {error}"))?;
    file.write_all(payload.as_bytes())
        .map_err(|error| format!("写入同步文件失败: {error}"))
}

/// 读回**其他设备**的变更文件。本机自己的那份跳过——它的内容我已经有了。
///
/// 目录不存在时返回**空数组而不是报错**：「还没配对过」不是错误（`docs/03` §14.4
/// 「不可用 ≠ 错误」），调用方据此显示「未配置 / 无对端」。
/// 单个文件读不动也跳过——一个坏文件不该拖垮整台设备的同步。
pub fn read_others(directory: &str, device_id: &str) -> Result<Vec<SyncFilePayload>, String> {
    let dir = Path::new(directory);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| format!("无法读取同步目录: {error}"))? {
        let entry = entry.map_err(|error| format!("读取同步目录条目失败: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if stem == device_id {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        files.push(SyncFilePayload {
            device_id: stem.to_owned(),
            lines: text
                .lines()
                .map(str::to_owned)
                .filter(|line| !line.trim().is_empty())
                .collect(),
        });
    }
    Ok(files)
}

/// 一次资产交换的回执（`docs/03` §14.2「资产随同步」）：推上去的、拉回来的、两边都没有的。
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAssetsReport {
    pub pushed: Vec<String>,
    pub pulled: Vec<String>,
    pub missing: Vec<String>,
}

/// 资产磁盘名的闸：与 `assets.rs` 的 `clean_asset_name` 同一条规矩（只收文件名，不许分隔符 / `..` / `:`）。
/// 非法名**跳过**而不是整批报错——一个坏名字不该挡住别人的文件（调用方拿不到它想要的名字时会在
/// `missing` 里如实看到）。
fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.contains(':')
}

/// **资产随同步**（`13-媒体设计（已归档）` §2 第 3 行的裁决「最小形态」， 落地）：
/// 媒体块的文件本体此前只住本机——块（含 `fileName` 指针）随 oplog 同步过去了，对端却只能显示
/// 「文件缺失」（双机场景直接残废）。最小形态：
/// - **推**：`push` 里本机有、共享目录 `<同步目录>/assets/` 里没有的文件 → 复制过去；
/// - **拉**：`want` 里本机缺、共享目录里有的文件 → 复制回来（应用远端变更后「本机缺文件即补」）；
/// - **只增不减**：不覆盖已存在的共享文件、共享端永不广播删除（避免跨端竞态）；孤儿不进这条通路
///   （本机侧由「彻底删除后清理不再被引用的资产」负责，共享端的孤儿留给用户手动清）。
///   两处目录都不可写时如实报错；单个文件读不动**跳过并继续**（与坏行跳过的口径一致）。
pub fn assets_exchange(
    assets_dir: &Path,
    directory: &str,
    push: &[String],
    want: &[String],
) -> Result<SyncAssetsReport, String> {
    let mut report = SyncAssetsReport::default();
    if directory.trim().is_empty() {
        // 未配置同步位置不是错误（§14.4）——原样返回空回执，由调用方显示「未配置」。
        return Ok(report);
    }
    let shared = Path::new(directory).join("assets");
    for name in push {
        if !valid_asset_name(name) {
            continue;
        }
        let from = assets_dir.join(name);
        let to = shared.join(name);
        if !from.is_file() || to.is_file() {
            // 「只增不减」：共享端已有同名文件就不动它（后写者胜的语义在资产上没有意义——
            // 磁盘名是不透明随机名，同名 = 同一份内容）。
            continue;
        }
        fs::create_dir_all(&shared).map_err(|error| format!("无法创建共享资产目录: {error}"))?;
        match fs::copy(&from, &to) {
            Ok(_) => report.pushed.push(name.clone()),
            Err(_) => continue, // 单个文件复制失败不拖垮整批（下轮还会重试）
        }
    }
    for name in want {
        if !valid_asset_name(name) {
            continue;
        }
        let from = shared.join(name);
        let to = assets_dir.join(name);
        if to.is_file() {
            continue;
        }
        if from.is_file() {
            fs::create_dir_all(assets_dir).map_err(|error| format!("无法创建资产目录: {error}"))?;
            match fs::copy(&from, &to) {
                Ok(_) => report.pulled.push(name.clone()),
                Err(_) => continue,
            }
        } else {
            report.missing.push(name.clone());
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("moqi-sync-files-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn append_is_append_only_and_read_others_skips_self() {
        let dir = temp_dir("append");
        let path = dir.to_string_lossy().into_owned();
        append(&path, "dev-a", &["a1".to_owned(), "a2".to_owned()]).unwrap();
        append(&path, "dev-a", &["a3".to_owned()]).unwrap();
        append(&path, "dev-b", &["b1".to_owned()]).unwrap();

        let mine = read_others(&path, "dev-a").unwrap();
        assert_eq!(mine.len(), 1, "只看到别人的那份文件");
        assert_eq!(mine[0].device_id, "dev-b");
        assert_eq!(mine[0].lines, vec!["b1".to_owned()]);

        // 追加不是覆盖：自己的文件里三行都在
        let all = fs::read_to_string(file_path(&path, "dev-a").unwrap()).unwrap();
        assert_eq!(all.lines().count(), 3);
    }

    #[test]
    fn read_others_on_missing_directory_is_empty_not_error() {
        let path = temp_dir("missing").to_string_lossy().into_owned();
        assert!(
            read_others(&path, "dev-a").unwrap().is_empty(),
            "没配过同步不是错误"
        );
    }

    #[test]
    fn append_creates_the_directory_on_first_use() {
        let dir = temp_dir("create");
        let nested = dir.join("a").join("b").to_string_lossy().into_owned();
        append(&nested, "dev-a", &["x".to_owned()]).unwrap();
        assert!(
            file_path(&nested, "dev-a").unwrap().is_file(),
            "首次写入把目录建出来"
        );
    }

    #[test]
    fn append_with_no_lines_writes_nothing() {
        let dir = temp_dir("empty");
        let path = dir.to_string_lossy().into_owned();
        append(&path, "dev-a", &[]).unwrap();
        assert!(!dir.exists(), "空批次不该建出一个空目录/空文件");
    }

    #[test]
    fn bad_lines_are_skipped_by_the_caller_but_files_still_readable() {
        let dir = temp_dir("badline");
        let path = dir.to_string_lossy().into_owned();
        append(
            &path,
            "dev-b",
            &["{ 这不是 JSON".to_owned(), "合法行".to_owned()],
        )
        .unwrap();
        let files = read_others(&path, "dev-a").unwrap();
        assert_eq!(
            files[0].lines.len(),
            2,
            "读文件这一层不做解析——坏行原样交出去，由协议层跳过"
        );
    }

    #[test]
    fn device_id_cannot_escape_the_shared_directory() {
        let dir = temp_dir("traversal");
        let path = dir.to_string_lossy().into_owned();
        for bad in ["../evil", "a/b", "a\\b", "..", "C:evil", ""] {
            assert!(file_path(&path, bad).is_err(), "{bad} 必须被拒绝");
            assert!(append(&path, bad, &["x".to_owned()]).is_err());
        }
        assert!(!dir.exists(), "被拒绝的写入不该留下任何东西");
    }

    #[test]
    fn non_jsonl_files_are_ignored() {
        let dir = temp_dir("otherfiles");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap();
        fs::write(dir.join("dev-b.jsonl"), "line\n").unwrap();
        let files = read_others(&dir.to_string_lossy(), "dev-a").unwrap();
        assert_eq!(files.len(), 1, "只看 .jsonl");
        assert_eq!(files[0].device_id, "dev-b");
    }

    /// 资产随同步（）：推 / 拉 / 缺 / 只增不减 / 非法名跳过，五条一起钉住。
    #[test]
    fn assets_exchange_pushes_pulls_and_reports_missing() {
        let dir = temp_dir("assets");
        let local = dir.join("local");
        let shared = dir.join("shared");
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("mine.png"), [1u8, 2, 3]).unwrap();

        // 推：本机有 → 共享目录出现；只增不减：共享端已有则不动
        fs::create_dir_all(shared.join("assets")).unwrap();
        fs::write(shared.join("assets").join("theirs.png"), [9u8]).unwrap();
        fs::write(local.join("theirs.png"), [7u8]).unwrap(); // 本机这份内容不同，但不许覆盖共享端
        let report = assets_exchange(
            &local,
            &shared.to_string_lossy(),
            &["mine.png".to_owned(), "theirs.png".to_owned()],
            &[],
        )
        .unwrap();
        assert_eq!(report.pushed, vec!["mine.png".to_owned()]);
        assert_eq!(
            fs::read(shared.join("assets").join("mine.png")).unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(
            fs::read(shared.join("assets").join("theirs.png")).unwrap(),
            vec![9]
        );

        // 拉：共享有、本机缺 → 复制回来；两处都没有 → missing
        let local2 = dir.join("local2");
        fs::create_dir_all(&local2).unwrap();
        let report = assets_exchange(
            &local2,
            &shared.to_string_lossy(),
            &[],
            &["mine.png".to_owned(), "gone.png".to_owned()],
        )
        .unwrap();
        assert_eq!(report.pulled, vec!["mine.png".to_owned()]);
        assert_eq!(report.missing, vec!["gone.png".to_owned()]);
        assert_eq!(fs::read(local2.join("mine.png")).unwrap(), vec![1, 2, 3]);

        // 本机已有 → 既不拉也不缺
        let report = assets_exchange(
            &local,
            &shared.to_string_lossy(),
            &[],
            &["mine.png".to_owned()],
        )
        .unwrap();
        assert!(report.pulled.is_empty() && report.missing.is_empty());

        // 非法名一律跳过（不写文件、不报错）；空目录 = 未配置，返回空回执
        let report = assets_exchange(
            &local,
            &shared.to_string_lossy(),
            &["../escape.png".to_owned(), "a/b.png".to_owned()],
            &["C:evil.png".to_owned()],
        )
        .unwrap();
        assert!(report.pushed.is_empty() && report.missing.is_empty());
        assert!(!dir.parent().unwrap().join("escape.png").exists());
        let empty = assets_exchange(&local, "  ", &["mine.png".to_owned()], &[]).unwrap();
        assert_eq!(empty, SyncAssetsReport::default());
    }
}
