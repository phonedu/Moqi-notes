//! 媒体资产的**哑写**层（`13-媒体设计` §3）。
//!
//! 边界与导出同款：**命名与内容都在界面侧决定**（不透明磁盘名 = 界面生成、字节 = 三管道拿到的），
//! Rust 只做三件哑事——写进 `<数据目录>/assets/`、列出来（界面判「文件缺失」用）、按名删掉
//! （只给「彻底删除 / 到期清理 / 清空回收站」那条路用；普通删除（回收站）**不动文件**，还原即还原）。
//!
//! 传参：字节走 base64（JSON IPC 的直接路）。图片量级（几 MB）够用；将来若要省那 33%，可以换
//! Tauri 的原始字节载荷通道——**不预先优化**，先把管道跑通（本批判据是「带图周报不切工具」）。
use std::fs;
use std::path::{Path, PathBuf};

/// `<数据目录>/assets/`（按需创建）。与 `exports/` 同级，都在数据目录下。
pub fn assets_dir(db: &Path) -> Result<PathBuf, String> {
    let dir = db.parent().unwrap_or(Path::new(".")).join("assets");
    fs::create_dir_all(&dir).map_err(|error| format!("创建资产目录失败: {error}"))?;
    Ok(dir)
}

/// 磁盘名只收**文件名**（不透明随机名由界面生成）：不许带路径分隔符或 `..`。
fn clean_asset_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("资产文件名非法：{name}"));
    }
    Ok(trimmed.to_owned())
}

/// 写资产（先写文件、后写事务：文件是内容、块是索引；失败 = 孤儿文件，可接受）。返回落盘字节数。
pub fn write_asset(db: &Path, file_name: &str, bytes: &[u8]) -> Result<u64, String> {
    let name = clean_asset_name(file_name)?;
    let target = assets_dir(db)?.join(&name);
    fs::write(&target, bytes).map_err(|error| format!("写入资产失败: {error}"))?;
    fs::metadata(&target)
        .map(|meta| meta.len())
        .map_err(|error| format!("读取资产失败: {error}"))
}

/// 从**本机路径**导入一份资产（OS 文件拖入那条管道：桌面拿到的是路径、不是字节）。
/// 哑复制到 `<数据目录>/assets/<diskName>`，原名 = 源文件名（显示与导出用）。
pub fn import_asset(
    db: &Path,
    source_path: &str,
    disk_name: &str,
) -> Result<(String, u64), String> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Err("源路径为空".to_owned());
    }
    let source = Path::new(trimmed);
    if !source.is_file() {
        return Err(format!("拖进来的不是一个文件：{trimmed}"));
    }
    let original = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("读不出文件名：{trimmed}"))?
        .to_owned();
    let target = assets_dir(db)?.join(clean_asset_name(disk_name)?);
    let size = fs::copy(source, &target).map_err(|error| format!("复制资产失败: {error}"))?;
    Ok((original, size))
}

/// 哑读：`assets/` 下已有的磁盘名（目录不存在 = 空表）。界面用它判每一块是「有图」还是「文件缺失」。
pub fn list_asset_names(db: &Path) -> Result<Vec<String>, String> {
    let dir = db.parent().unwrap_or(Path::new(".")).join("assets");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| format!("读取资产目录失败: {error}"))? {
        let entry = entry.map_err(|error| format!("读取资产目录失败: {error}"))?;
        if !entry.path().is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

///
/// 「另存为副本」（`R09-BLOCK-19/20` 的另存 / 下载）：把资产复制到 `exports/<显示名>` 并**把路径给界面**。
/// 与整库导出同一条诚实做法（`13-数据安全设计`：落在一个认得的目录里、显示路径，等于是给用户的「另存为」）——
/// 真正的「系统另存为」要引 `tauri-plugin-dialog`，留给插件轮（`05` 已登记）。
pub fn save_copy(db: &Path, file_name: &str, display_name: &str) -> Result<String, String> {
    let source = assets_dir(db)?.join(clean_asset_name(file_name)?);
    if !source.is_file() {
        return Err(format!("文件缺失，复制不了：{file_name}"));
    }
    let dir = db.parent().unwrap_or(Path::new(".")).join("exports");
    fs::create_dir_all(&dir).map_err(|error| format!("创建导出目录失败: {error}"))?;
    let target = dir.join(clean_asset_name(display_name)?);
    fs::copy(&source, &target).map_err(|error| format!("复制失败: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 删资产（**幂等**：文件本来就不在也算成功——彻底删除会重复跑到这里）。
pub fn delete_asset(db: &Path, file_name: &str) -> Result<bool, String> {
    let name = clean_asset_name(file_name)?;
    let target = assets_dir(db)?.join(&name);
    if !target.exists() {
        return Ok(false);
    }
    fs::remove_file(&target).map_err(|error| format!("删除资产失败: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `backup.rs` / `export.rs` 的测试同一个写法：本地临时目录，`Drop` 时清掉。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("moqi-assets-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
        fn db(&self) -> PathBuf {
            let db = self.0.join("project-b.sqlite3");
            fs::write(&db, b"not-a-real-db").expect("占位库");
            db
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_list_read_delete_round_trip() {
        let temp = TempDir::new("roundtrip");
        let db = temp.db();
        let size =
            write_asset(&db, "a1b2c3d4.png", &[0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).expect("写资产");
        assert_eq!(size, 7);
        assert_eq!(
            list_asset_names(&db).expect("列资产"),
            vec!["a1b2c3d4.png".to_owned()]
        );
        // 文件真的在 `<数据目录>/assets/` 下，且内容一致（哑写就是哑写）
        let stored = assets_dir(&db).expect("目录").join("a1b2c3d4.png");
        assert_eq!(
            fs::read(&stored).expect("读回"),
            vec![0x89, 0x50, 0x4e, 0x47, 1, 2, 3]
        );
        assert!(delete_asset(&db, "a1b2c3d4.png").expect("删资产"));
        assert!(
            !delete_asset(&db, "a1b2c3d4.png").expect("再删一次幂等"),
            "删不存在的算成功但不报告删除"
        );
        assert!(list_asset_names(&db).expect("列资产").is_empty());
    }

    #[test]
    fn rejects_path_traversal_and_empty_names() {
        let temp = TempDir::new("traversal");
        let db = temp.db();
        assert!(write_asset(&db, "../逃逸.png", b"x").is_err());
        assert!(write_asset(&db, "子/目录.png", b"x").is_err());
        assert!(write_asset(&db, "   ", b"x").is_err());
        assert!(delete_asset(&db, "../逃逸.png").is_err());
    }

    #[test]
    fn import_asset_copies_from_path() {
        let temp = TempDir::new("import");
        let db = temp.db();
        let source = temp.0.join("周报 截图.png");
        fs::write(&source, vec![0x89, 0x50, 0x4e, 0x47, 9]).expect("源文件");
        let (original, size) =
            import_asset(&db, source.to_str().expect("路径"), "opaque1.png").expect("导入");
        assert_eq!(original, "周报 截图.png", "原名来自源文件名");
        assert_eq!(size, 5);
        assert_eq!(
            list_asset_names(&db).expect("列资产"),
            vec!["opaque1.png".to_owned()],
            "落盘用不透明名"
        );
        assert!(import_asset(
            &db,
            temp.0.join("没有这个.png").to_str().expect("路径"),
            "x.png"
        )
        .is_err());
        assert!(import_asset(&db, "  ", "x.png").is_err());
    }

    #[test]
    fn save_copy_lands_in_exports_with_display_name() {
        let temp = TempDir::new("copy");
        let db = temp.db();
        write_asset(&db, "opaque9.png", &[1, 2, 3, 4]).expect("写资产");
        let path = save_copy(&db, "opaque9.png", "周报 配图.png").expect("另存副本");
        assert!(path.ends_with("周报 配图.png"), "{path}");
        assert_eq!(fs::read(&path).expect("读副本"), vec![1, 2, 3, 4]);
        assert!(
            save_copy(&db, "没有这个.png", "x.png").is_err(),
            "缺失要如实报错"
        );
    }

    #[test]
    fn missing_directory_lists_empty() {
        let temp = TempDir::new("missing");
        assert!(
            list_asset_names(&temp.db()).expect("列资产").is_empty(),
            "目录不存在 = 空表（不是错）"
        );
    }
}
