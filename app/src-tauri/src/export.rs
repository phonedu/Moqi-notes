//! Markdown 导出的**哑写**层（`13-导出与媒体设计` §7；规则 `09-桌面端交互规范` §6.4 `R09-EXPORT-5`）。
//!
//! 边界：**序列化在 TS**（`src/domain/exportMd.ts` 是格式的唯一所有者），Rust 只做两件事——
//! ① 哑读 `exports/` 里已存在的文件名（给 TS 算「不覆盖」的 ` (2)`）；② 把 TS 给的内容落到
//! `exports/<artifact_name>`，多页时打成一个 zip（包内根平铺）。
//! 为什么 zip 在这边：压缩/归档是平台能力，TS 侧不引打包库；依赖只加一个 `zip`。
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::assets;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileIn {
    /// 包内相对路径 / 单文件落盘名（只收**文件名**：不许带分隔符或 `..`）。
    pub path: String,
    pub content: String,
}

/// 资产搬运单（`from` = `assets/` 下的磁盘名；`to` = 包内路径 `assets/<原名>`）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAssetIn {
    pub from: String,
    pub to: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWriteIn {
    /// `file` = 直接落一个文件；`zip` = 打包（包内根平铺）。
    pub kind: String,
    /// 落盘文件名（TS 已按最终名去重）。
    pub artifact_name: String,
    pub files: Vec<ExportFileIn>,
    /// 媒体资产：缺文件的那些界面已排除（正文降级成文件名文字），这里照单复制。
    #[serde(default)]
    pub assets: Vec<ExportAssetIn>,
    /// 「另存为 / 存到文件夹」的落点（`T-18`）：给**绝对路径**就落那儿（资产跟到它的父目录），
    /// 不给就照旧落 `<数据目录>/exports/`——默认分支与老口径逐字一致。
    #[serde(default)]
    pub target_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWriteOut {
    pub path: String,
    pub size_bytes: u64,
    /// 写进包里的条目数（单文件 = 1）。
    pub entries: usize,
}

/// 收一个**文件名**（不许带路径分隔符或 `..`），空则报错。与 `backup.rs` 的同名规矩一致。
fn clean_file_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("导出文件名非法：{name}"));
    }
    Ok(trimmed.to_owned())
}

/// 包内路径：只放行 `assets/<文件名>` 这种形态（不许 `..`、不许绝对路径、不许反斜杠）。
fn clean_archive_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    let rest = trimmed
        .strip_prefix("assets/")
        .ok_or_else(|| format!("包内路径只允许 assets/ 前缀：{path}"))?;
    if rest.is_empty() || rest.contains("/") || rest.contains("\\") || rest.contains("..") {
        return Err(format!("包内路径非法：{path}"));
    }
    Ok(trimmed.to_owned())
}

/// 包内路径的**通用**闸：`assets/<名>` 之外还放行根目录的单个文件——整库备份把库文件放根上。
fn clean_any_archive_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("包内路径非法：{path}"));
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("包内路径非法：{path}"));
    }
    Ok(trimmed.to_owned())
}

/// zip 包的一个条目：**内存内容**（Markdown 文件）或**磁盘文件**（资产 / 整库备份里的库文件）。
///
/// 两族导出（Markdown 打包、整库备份 zip）共用下面这一个写包者——**包格式只有一处实现**，
/// 将来改压缩级别或目录结构也只改这里（`R09-EXPORT-5` 的「单一所有者」口径）。
pub enum ZipEntry {
    Text { path: String, content: String },
    File { path: String, from: PathBuf },
}

/// 往 `target` 写一个 zip（**不覆盖由调用方保证**：Markdown 那边由 TS 算好名字，整库这边自己先删旧文件）。
pub fn write_zip_package(target: &Path, entries: &[ZipEntry]) -> Result<u64, String> {
    let file = fs::File::create(target).map_err(|error| format!("创建导出包失败: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in entries {
        match entry {
            ZipEntry::Text { path, content } => {
                let name = clean_file_name(path)?;
                writer
                    .start_file(name, options)
                    .map_err(|error| format!("写入导出包失败: {error}"))?;
                writer
                    .write_all(content.as_bytes())
                    .map_err(|error| format!("写入导出包失败: {error}"))?;
            }
            ZipEntry::File { path, from } => {
                let name = clean_any_archive_path(path)?;
                let bytes = fs::read(from)
                    .map_err(|error| format!("读取包内文件失败（{path}）: {error}"))?;
                writer
                    .start_file(name, options)
                    .map_err(|error| format!("写入导出包失败: {error}"))?;
                writer
                    .write_all(&bytes)
                    .map_err(|error| format!("写入导出包失败: {error}"))?;
            }
        }
    }
    writer
        .finish()
        .map_err(|error| format!("收尾导出包失败: {error}"))?;
    fs::metadata(target)
        .map(|meta| meta.len())
        .map_err(|error| format!("读取导出包失败: {error}"))
}

/// `exports/` 目录（与整库备份同一个目录，靠扩展名与命名前缀区分；按需创建）。
fn exports_dir(db: &Path) -> Result<PathBuf, String> {
    let dir = db.parent().unwrap_or(Path::new(".")).join("exports");
    fs::create_dir_all(&dir).map_err(|error| format!("创建导出目录失败: {error}"))?;
    Ok(dir)
}

/// 读一个**文本文件**（导入 Markdown 的桌面通路：拖入给的是**路径**，正文要读进来解析）。
///
/// 这不是通用文件读接口：**只放行 `.md` / `.markdown` / `.txt`**，且有体积上限——
/// 误拖一个二进制或几百兆的文件进来时，如实报错比悄悄塞进编辑器强。
/// 列一个**目录**下的 Markdown 文件（设置页「选择文件夹」导入用；桌面专属，`03` §12.4）。
///
/// 口径：**递归**子目录（文件夹型笔记库是常见形态）、只收 `.md` / `.markdown`、按路径排序
/// （顺序稳定，导入出来的页序可预期）、上限 500 篇（越过就如实报错，不悄悄截断）。
/// 图片**不在这里读**：每篇 `.md` 连同它的 `dir` 交给既有的 `importMarkdownDocument`（`dir` 分支按相对名找图）。
pub fn list_markdown_files(dir: &str) -> Result<Vec<String>, String> {
    fn walk(current: &std::path::Path, out: &mut Vec<String>) -> Result<(), String> {
        for entry in std::fs::read_dir(current).map_err(|error| format!("打不开目录：{error}"))? {
            let entry = entry.map_err(|error| format!("读目录失败：{error}"))?;
            let path = entry.path();
            if path.is_dir() {
                // 跳过隐藏目录（.git / .obsidian 这类：进去只会捞到配置，不是笔记）。
                let hidden = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with('.'));
                if !hidden { walk(&path, out)?; }
                continue;
            }
            let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
            if matches!(ext.as_str(), "md" | "markdown") {
                if out.len() >= 500 { return Err("目录里的 .md 超过 500 篇——请分批导入".into()) }
                out.push(path.to_string_lossy().into_owned());
            }
        }
        Ok(())
    }
    let root = std::path::Path::new(dir.trim());
    if !root.is_dir() { return Err("这条路径不是目录".into()) }
    let mut files = Vec::new();
    walk(root, &mut files)?;
    files.sort();
    Ok(files)
}

pub fn read_text_file(path: &str) -> Result<String, String> {
    let clean = Path::new(path.trim());
    let ext = clean
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["md", "markdown", "txt"].contains(&ext.as_str()) {
        return Err(format!(
            "只支持 Markdown / 文本文件（.md / .markdown / .txt）：{path}"
        ));
    }
    let size = fs::metadata(clean)
        .map_err(|error| format!("读不到这个文件：{error}"))?
        .len();
    if size > 8 * 1024 * 1024 {
        return Err("文件太大（超过 8 MB）——导入前请先拆成几份".to_owned());
    }
    fs::read_to_string(clean).map_err(|error| format!("读文件失败（不是文本文件？）：{error}"))
}

/// 导入包的条目（第 13 项「拖入 zip」）：`{ name, base64 }`——**分拣判据不在这一层**
/// （`domain/mdPackage.ts` 说了算：备份包嗅探 / 支持的类型 / 报数）；这里只解包 + 逐条 base64，
/// 单条目 > 8 MB 跳过并计入 `skipped`，整包 > 64 MB 直接拒（保底，别让一个包把内存顶穿）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntryOut {
    pub name: String,
    pub base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntriesOut {
    pub entries: Vec<ZipEntryOut>,
    pub skipped: usize,
}

pub fn read_zip_entries(path: &str) -> Result<ZipEntriesOut, String> {
    use base64::Engine;
    let clean = Path::new(path.trim());
    let ext = clean
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "zip" {
        return Err(format!("只支持 .zip 导入包：{path}"));
    }
    let size = fs::metadata(clean)
        .map_err(|error| format!("读不到这个文件：{error}"))?
        .len();
    if size > 64 * 1024 * 1024 {
        return Err("导入包太大（超过 64 MB）——请先拆成几份".to_owned());
    }
    let file = fs::File::open(clean).map_err(|error| format!("打不开这个文件：{error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("这不是一个能读的 .zip：{error}"))?;
    let mut entries = Vec::new();
    let mut skipped = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读包内条目失败：{error}"))?;
        let name = entry.name().to_owned();
        if entry.is_dir() {
            continue;
        }
        if entry.size() > 8 * 1024 * 1024 {
            skipped += 1;
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        std::io::copy(&mut entry, &mut bytes).map_err(|error| format!("读包内条目失败（{name}）：{error}"))?;
        entries.push(ZipEntryOut {
            name,
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }
    Ok(ZipEntriesOut { entries, skipped })
}

/// 哑读：`exports/` 下已有的**文件名**（TS 用它算「不覆盖」的 ` (2)`；目录不存在 = 空表）。
pub fn list_export_names(db: &Path) -> Result<Vec<String>, String> {
    let dir = db.parent().unwrap_or(Path::new(".")).join("exports");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| format!("读取导出目录失败: {error}"))? {
        let entry = entry.map_err(|error| format!("读取导出目录失败: {error}"))?;
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

/// 落盘：单文件直接写；多页打成 zip（**不覆盖**由 TS 在算名字时保证，这里只认最终名）。
pub fn write_markdown(db: &Path, plan: ExportWriteIn) -> Result<ExportWriteOut, String> {
    let artifact = clean_file_name(&plan.artifact_name)?;
    // 落点两档（`T-18`）：**给了 targetPath** 就落那儿（单文件的图跟到它的父目录；zip 自带图）；
    // 没给 = 老口径 `<数据目录>/exports/`。两档共用下面同一段写入逻辑，不给第二条通路。
    let (dir, target) = match plan.target_path.as_deref().map(str::trim) {
        Some(raw) if !raw.is_empty() => {
            let chosen = Path::new(raw);
            if !chosen.is_absolute() {
                return Err("另存为需要一个绝对路径".to_owned());
            }
            let parent = chosen
                .parent()
                .ok_or_else(|| "落点没有父目录".to_owned())?
                .to_path_buf();
            (parent, chosen.to_path_buf())
        }
        _ => {
            let dir = exports_dir(db)?;
            let target = dir.join(&artifact);
            (dir, target)
        }
    };

    match plan.kind.as_str() {
        "file" => {
            let first = plan
                .files
                .first()
                .ok_or_else(|| "单文件导出没有任何内容".to_owned())?;
            fs::write(&target, first.content.as_bytes())
                .map_err(|error| format!("写入导出文件失败: {error}"))?;
            // 单页导出也要把图带出去：复制到 `exports/assets/`——.md 里的 `assets/<原名>` 相对它成立。
            for item in &plan.assets {
                let name = clean_file_name(&item.from)?;
                let target_path = clean_archive_path(&item.to)?;
                let side = dir.join(&target_path);
                if let Some(parent) = side.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("创建资产目录失败: {error}"))?;
                }
                fs::copy(assets::assets_dir(db)?.join(&name), &side)
                    .map_err(|error| format!("复制资产失败（{name}）: {error}"))?;
            }
            let size_bytes = fs::metadata(&target)
                .map(|meta| meta.len())
                .map_err(|error| format!("读取导出文件失败: {error}"))?;
            Ok(ExportWriteOut {
                path: target.to_string_lossy().into_owned(),
                size_bytes,
                entries: 1,
            })
        }
        "zip" => {
            // 包内条目：Markdown 文件（内存）+ 媒体资产（磁盘，哑复制不解析内容；缺文件在界面侧已降级成文字）。
            let mut entries: Vec<ZipEntry> = plan
                .files
                .iter()
                .map(|item| ZipEntry::Text {
                    path: item.path.clone(),
                    content: item.content.clone(),
                })
                .collect();
            let asset_dir = assets::assets_dir(db)?;
            for item in &plan.assets {
                let name = clean_file_name(&item.from)?;
                let target_path = clean_archive_path(&item.to)?;
                entries.push(ZipEntry::File {
                    path: target_path,
                    from: asset_dir.join(name),
                });
            }
            let entries_count = entries.len();
            let size_bytes = write_zip_package(&target, &entries)?;
            Ok(ExportWriteOut {
                path: target.to_string_lossy().into_owned(),
                size_bytes,
                entries: entries_count,
            })
        }
        other => Err(format!("未知的导出形态：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `backup.rs` 的测试同一个写法：本地临时目录，`Drop` 时清掉（不引 dev-dependency）。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("moqi-export-{tag}-{}", std::process::id()));
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

    /// T-18：目录列举只收 `.md` / `.markdown`、递归、按路径排序、跳过隐藏目录、非目录如实报错。
    #[test]
    fn list_markdown_files_recurses_and_filters() {
        let temp = TempDir::new("listmd");
        fs::write(temp.0.join("b.md"), "# b").expect("写 b.md");
        fs::write(temp.0.join("a.markdown"), "# a").expect("写 a.markdown");
        fs::write(temp.0.join("note.txt"), "不是笔记").expect("写 txt");
        let sub = temp.0.join("sub");
        fs::create_dir_all(&sub).expect("建子目录");
        fs::write(sub.join("c.md"), "# c").expect("写 c.md");
        let hidden = temp.0.join(".obsidian");
        fs::create_dir_all(&hidden).expect("建隐藏目录");
        fs::write(hidden.join("config.md"), "# 不该进来").expect("写隐藏 md");

        let listed = list_markdown_files(temp.0.to_str().expect("路径是 utf8")).expect("列举成功");
        let names: Vec<String> = listed
            .iter()
            .map(|path| Path::new(path).file_name().and_then(|value| value.to_str()).unwrap_or("").to_string())
            .collect();
        assert_eq!(names, vec!["a.markdown", "b.md", "c.md"], "只收 md/markdown、递归、有序、跳过隐藏目录");

        let file_path = temp.0.join("b.md");
        assert!(list_markdown_files(file_path.to_str().expect("utf8")).is_err(), "给的是文件不是目录 ⇒ 如实报错");
    }

    #[test]
    fn single_file_lands_in_exports() {
        let temp = TempDir::new("single");
        let out = write_markdown(
            &temp.db(),
            ExportWriteIn {
                kind: "file".to_owned(),
                artifact_name: "甲页.md".to_owned(),
                files: vec![ExportFileIn {
                    path: "甲页.md".to_owned(),
                    content: "# 甲页\n".to_owned(),
                }],
                assets: Vec::new(),
                target_path: None,
            },
        )
        .expect("写单文件");
        assert!(out.path.ends_with("甲页.md"), "{:?}", out.path);
        assert_eq!(fs::read_to_string(&out.path).expect("读回"), "# 甲页\n");
        assert_eq!(
            list_export_names(&temp.db()).expect("列目录"),
            vec!["甲页.md".to_owned()]
        );
    }

    #[test]
    fn zip_bundles_markdown_at_root() {
        let temp = TempDir::new("zip");
        let out = write_markdown(
            &temp.db(),
            ExportWriteIn {
                kind: "zip".to_owned(),
                artifact_name: "墨契-导出-2026-10-06.zip".to_owned(),
                files: vec![
                    ExportFileIn {
                        path: "甲页.md".to_owned(),
                        content: "# 甲页\n".to_owned(),
                    },
                    ExportFileIn {
                        path: "乙页.md".to_owned(),
                        content: "# 乙页\n".to_owned(),
                    },
                ],
                assets: Vec::new(),
                target_path: None,
            },
        )
        .expect("写 zip");
        assert_eq!(out.entries, 2);
        let reader = fs::File::open(&out.path).expect("打开 zip");
        let mut archive = zip::ZipArchive::new(reader).expect("解析 zip");
        let mut names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).expect("条目").name().to_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["乙页.md".to_owned(), "甲页.md".to_owned()]);
        let mut first = archive.by_name("甲页.md").expect("取甲页");
        let mut content = String::new();
        std::io::Read::read_to_string(&mut first, &mut content).expect("读甲页");
        assert_eq!(content, "# 甲页\n");
    }

    #[test]
    fn zip_carries_assets_and_single_page_copies_them_beside() {
        let temp = TempDir::new("assets");
        let db = temp.db();
        // 先在数据目录的 assets/ 里放一个「图片」
        crate::assets::write_asset(&db, "a1b2c3.png", &[0x89, 0x50, 0x4e, 0x47]).expect("写资产");
        // zip：照单复制进包内 assets/
        let out = write_markdown(
            &db,
            ExportWriteIn {
                kind: "zip".to_owned(),
                artifact_name: "墨契-导出-2026-10-06.zip".to_owned(),
                files: vec![ExportFileIn {
                    path: "甲页.md".to_owned(),
                    content: "![图](assets/截图.png)\n".to_owned(),
                }],
                assets: vec![ExportAssetIn {
                    from: "a1b2c3.png".to_owned(),
                    to: "assets/截图.png".to_owned(),
                }],
                target_path: None,
            },
        )
        .expect("写 zip");
        assert_eq!(out.entries, 2, "一个 .md + 一张图");
        let reader = fs::File::open(&out.path).expect("打开 zip");
        let mut archive = zip::ZipArchive::new(reader).expect("解析 zip");
        let mut image = archive.by_name("assets/截图.png").expect("取图");
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut image, &mut bytes).expect("读图");
        assert_eq!(bytes, vec![0x89, 0x50, 0x4e, 0x47]);

        // 单页导出：资产复制到 exports/assets/（`.md` 里的相对路径靠它成立）
        let single = write_markdown(
            &db,
            ExportWriteIn {
                kind: "file".to_owned(),
                artifact_name: "甲页.md".to_owned(),
                files: vec![ExportFileIn {
                    path: "甲页.md".to_owned(),
                    content: "![图](assets/截图.png)\n".to_owned(),
                }],
                assets: vec![ExportAssetIn {
                    from: "a1b2c3.png".to_owned(),
                    to: "assets/截图.png".to_owned(),
                }],
                target_path: None,
            },
        )
        .expect("写单页");
        let beside = db
            .parent()
            .unwrap_or(Path::new("."))
            .join("exports")
            .join("assets")
            .join("截图.png");
        assert_eq!(
            fs::read(&beside).expect("读旁边的图"),
            vec![0x89, 0x50, 0x4e, 0x47]
        );
        assert!(single.path.ends_with("甲页.md"));
    }

    #[test]
    fn rejects_path_traversal() {
        let temp = TempDir::new("traversal");
        let bad = write_markdown(
            &temp.db(),
            ExportWriteIn {
                kind: "file".to_owned(),
                artifact_name: "../逃逸.md".to_owned(),
                files: vec![ExportFileIn {
                    path: "x.md".to_owned(),
                    content: String::new(),
                }],
                assets: Vec::new(),
                target_path: None,
            },
        );
        assert!(bad.is_err(), "带 .. 的文件名必须被拒");
        let also_bad = write_markdown(
            &temp.db(),
            ExportWriteIn {
                kind: "zip".to_owned(),
                artifact_name: "包.zip".to_owned(),
                files: vec![ExportFileIn {
                    path: "子/目录.md".to_owned(),
                    content: String::new(),
                }],
                assets: Vec::new(),
                target_path: None,
            },
        );
        assert!(also_bad.is_err(), "包内条目也不许带路径分隔符");
    }

    /// 导入的桌面通路：读文本文件**有闸**——只放行三样扩展名、只收文本。
    #[test]
    fn read_text_file_only_accepts_markdown_and_text() {
        let temp = TempDir::new("readtext");
        let md = temp.0.join("导入.md");
        fs::write(&md, "# 标题\n正文\n").expect("写样本");
        assert_eq!(
            read_text_file(md.to_str().unwrap()).expect("读 .md"),
            "# 标题\n正文\n"
        );

        let binary = temp.0.join("图.png");
        fs::write(&binary, [0x89, 0x50, 0x4e, 0x47]).expect("写样本");
        assert!(
            read_text_file(binary.to_str().unwrap()).is_err(),
            "非文本扩展名一律拒"
        );
        assert!(
            read_text_file(temp.0.join("不存在.md").to_str().unwrap()).is_err(),
            "文件不在就如实报错"
        );
    }

  /// IPC 形状（ 审计）：前端 `TauriExportPort.write` 送的是 **camelCase** JSON
    /// （`artifactName` / `assets[].from|to`），命令入参必须按同一套命名反序列化。这类接口此前
    /// 从没被端到端跑过（`05` W1 记着「真窗口的导出 → 拖回导入没跑过」），四个结构体又都缺
    /// `rename_all` ⇒ **桌面端 Markdown 导出必挂**（missing field `artifact_name`）。这条用例把
    /// 「前端送的那个形状」钉成契约——改命名先红。
    #[test]
    fn ipc_payload_uses_camel_case_field_names() {
        let payload = serde_json::json!({
            "kind": "file",
            "artifactName": "甲页.md",
            "files": [{ "path": "甲页.md", "content": "# 甲页\n" }],
            "assets": [{ "from": "a1b2c3.png", "to": "assets/截图.png" }],
        });
        let parsed: ExportWriteIn = serde_json::from_value(payload).expect("前端形状必须能反序列化");
        assert_eq!(parsed.artifact_name, "甲页.md");
        assert_eq!(parsed.assets.len(), 1);

        let out = ExportWriteOut {
            path: "p".to_owned(),
            size_bytes: 1,
            entries: 1,
        };
        let value = serde_json::to_value(out).expect("序列化");
        assert_eq!(value["sizeBytes"], 1, "回执按 camelCase 出（界面读 sizeBytes）");
    }
}
