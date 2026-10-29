//! 性能采样库生成器（0.6 性能批 ⓐ 的**前置**；`#[cfg(test)]` 专用，不进产品二进制）。
//!
//! **规模** = `03` §11.1 的规模条件：**5000 块 / 200 页**——性能门槛只在这个规模下成立。
//!
//! **形状不手写**：从入库的实验库（`fixtures/library/project-b.sqlite3`）取**真块 JSON** 当模板，
//! 只换 id / 文本 / 父子关系 / 时间；写入走真 store 的 `save_block_json`（与产品同一条落库路径，
//! `blocks` 派生列与 `blocks_fts` 都由它维护）——避免 JSON 契约漂移，也避免手搓 FTS。
//!
//! **跑法**：`cd app/src-tauri && cargo test perf_fixture -- --ignored --nocapture`
//! **产物**：`app/fixtures/perf/project-b.sqlite3`（根 `.gitignore` 的 `*.sqlite3` 默认忽略——
//! 生成物不入库是有意的；要复现就跑这个测试）。可用 `MOQI_PERF_FIXTURE_OUT` 改落点。
//!
//! **怎么用**：把产物拷到临时目录、`MOQI_DATA_DIR` 指过去起实例（见 `fixtures/library/README.md`
//! 的同一套跑法；真库永不做实验台，`06` §7.0）。
//!
//! **出库后先「热」一次再量性能**：老 schema 首次打开要跑 A2 检索文本重算（**同步挡在启动路径上**，
//! 5000 块桌面 ~12s / 真机 ~20-30s，台账 `D-084`）——起一次应用，轮询等 `app_metadata` 出
//! `search-text-v` 且 `pinyin_at > 0` 覆盖满这两个判据（任一台 sqlite 读取器即可）。

use crate::storage::{SqliteBlockStore, StoredBlock};
use serde_json::{json, Value};
use std::path::PathBuf;

const PAGES: usize = 200;
/// 每页 25 块 = 1 容器 + 23 直接子块 + 1 孙块（有嵌套深度，不是平铺假数据）。
const PER_PAGE: usize = 25;
/// 固定基准时间戳（ 前后）：采样库要**可复现**，不用 `now()`。
const BASE_TIME: i64 = 1_760_000_000_000;

const BODIES: [&str; 6] = [
    "这一段是采样正文，用来把块撑到日常写作的长度区间里。",
    "启动全量载入是已知的架构墙：反链与页面名派生都要全局视图。",
    "检索走 FTS5 的 trigram 分词器，两字词由存储层兜底成扫描。",
    "保存不阻塞输入：新快照永远不许被旧写入覆盖。",
    "移动端的键盘上方格式栏分两段，每段一屏，放不下不横滚。",
    "块引用在导出时降级成目标页链接，不写任何块 ID。",
];

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
}

fn out_path() -> PathBuf {
    match std::env::var("MOQI_PERF_FIXTURE_OUT") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => fixtures_dir().join("perf").join("project-b.sqlite3"),
    }
}

/// 确定性 UUID（形状照 v4，内容来自计数器）：采样库要可复现，且 entityId 全局唯一即可。
fn uuid(seed: u64) -> String {
    let a = (seed & 0xffff) as u32;
    let b = ((seed >> 16) & 0xffff) as u32;
    let c = ((seed >> 32) & 0x0fff) as u32;
    let d = ((seed >> 44) & 0x0fff) as u32;
    format!(
        "9f1e{a:04x}-{b:04x}-4{c:03x}-8{d:03x}-{e:012x}",
        e = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) & 0xffff_ffff_ffff
    )
}

/// 新建一个「干净」块：模板克隆 + 只填必要的字段，其余一律归零（采样库不要引用/标签/属性）。
fn clean_block(
    template: &Value,
    id: &str,
    uid: &str,
    parent: Option<&str>,
    position: i64,
    created: i64,
) -> Value {
    let mut block = template.clone();
    block["entityId"] = json!(id);
    block["blockUid"] = json!(uid);
    block["parent"] = match parent {
        Some(value) => json!(value),
        None => Value::Null,
    };
    block["children"] = json!([]);
    block["position"] = json!(position);
    block["collapsed"] = json!(false);
    block["checked"] = json!(false);
    block["deleted"] = json!(false);
    block["deletedAt"] = Value::Null;
    block["prevParent"] = Value::Null;
    block["prevIndex"] = Value::Null;
    block["blockRefs"] = json!([]);
    block["blockBackRefs"] = json!([]);
    block["objectRefs"] = json!([]);
    block["objectBackRefs"] = json!([]);
    block["isObject"] = json!(false);
    block["objectName"] = Value::Null;
    block["pinned"] = json!(false);
    block["starred"] = json!(false);
    block["tags"] = json!([]);
    block["properties"] = json!([]);
    block["asset"] = Value::Null;
    block["aiMeta"] = Value::Null;
    block["created"] = json!(created);
    block["modified"] = json!(created);
    block
}

#[test]
#[ignore = "手动跑：造性能采样库（5000 块 / 200 页）"]
fn make_perf_fixture() {
    let source = fixtures_dir().join("library").join("project-b.sqlite3");
    // **只读**打开模板库：`SqliteBlockStore::open` 会写（PRAGMA / 迁移），而实验库是
    // 入库资产、永不做实验台（`06` §7.0）——首版用 store 读，git 当场报它被改了。
    let templates: Vec<Value> = {
        let conn = rusqlite::Connection::open_with_flags(
            &source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("先要有实验库当模板：app/fixtures/library/project-b.sqlite3");
        let mut statement = conn
            .prepare("SELECT json FROM blocks WHERE deleted = 0")
            .expect("读模板块");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("查询模板块");
        rows.map(|row| serde_json::from_str(&row.expect("块 JSON")).expect("模板块 JSON 可解析"))
            .collect()
    };
    let page_template = templates
        .iter()
        .find(|block| block["isObject"] == json!(true))
        .expect("实验库里没有页面容器可当模板")
        .clone();
    let text_template = templates
        .iter()
        .find(|block| block["type"] == json!("text") && block["isObject"] == json!(false))
        .expect("实验库里没有普通文本块可当模板")
        .clone();

    let out = out_path();
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).expect("建产物目录");
    }
    if out.exists() {
        std::fs::remove_file(&out).expect("清旧产物");
    }
    let mut target = SqliteBlockStore::open(&out).expect("建采样库");
    target.migrate().expect("建 schema");

    let started = std::time::Instant::now();
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next_seed = move || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        seed >> 11 | 1
    };
    let kinds = [
        "text", "text", "heading2", "text", "todo", "text", "bullet", "text",
    ];

    for page in 0..PAGES {
        let page_created = BASE_TIME + (page as i64) * 60_000;
        let page_id = uuid(next_seed());

        let mut children = Vec::with_capacity(PER_PAGE - 2);
        let mut blocks: Vec<Value> = Vec::with_capacity(PER_PAGE - 2);
        for i in 0..(PER_PAGE - 2) {
            let id = uuid(next_seed());
            let created = page_created + (i as i64) * 1_000;
            let kind = kinds[i % kinds.len()];
            let body = format!(
                "采样块 {}-{} · {}",
                page + 1,
                i + 1,
                BODIES[i % BODIES.len()]
            );
            let mut block = clean_block(
                &text_template,
                &id,
                &uuid(next_seed()),
                Some(&page_id),
                i as i64,
                created,
            );
            block["type"] = json!(kind);
            block["content"] = json!([{ "t": "text", "v": body }]);
            if kind == "todo" {
                block["checked"] = json!(i % 16 == 6);
            }
            children.push(id.clone());
            blocks.push(block);
        }
        // 孙块：挂在第 3 个子块下——给「嵌套 + 折叠 + 装饰层对齐」一点真实深度。
        let grandchild_id = uuid(next_seed());
        let grandchild = clean_block(
            &text_template,
            &grandchild_id,
            &uuid(next_seed()),
            Some(&children[2]),
            (PER_PAGE - 2) as i64,
            page_created + (PER_PAGE as i64) * 1_000,
        );
        {
            let parent = &mut blocks[2];
            parent["children"] = json!([grandchild_id]);
        }

        let mut container = clean_block(
            &page_template,
            &page_id,
            &uuid(next_seed()),
            None,
            page as i64,
            page_created,
        );
        let name = format!("采样页 {}", page + 1);
        container["content"] = json!([{ "t": "text", "v": name }]);
        container["children"] = json!(children);
        container["isObject"] = json!(true);
        container["objectName"] = json!(name);

        // **每页一批**：走产品自己的批量落库路径（`commit_batch`）——单块逐条提交各带一次
        // fsync，5000 块在 Windows 上要 ~18 分钟（ 首跑实测），批量后是分钟级。
        let mut batch: Vec<StoredBlock> = Vec::with_capacity(PER_PAGE);
        batch.push(StoredBlock::from_block_json(&container.to_string()).expect("容器入库形状"));
        for block in &blocks {
            batch.push(StoredBlock::from_block_json(&block.to_string()).expect("子块入库形状"));
        }
        batch.push(StoredBlock::from_block_json(&grandchild.to_string()).expect("孙块入库形状"));
        target
            .commit_batch(&format!("perf-page-{page}"), &[], &batch, &[])
            .expect("整页落库");
    }
    target.rebuild_reverse_index().expect("重建反向索引");
    drop(target);

    // 清掉批量回执：`persist_batches` 是产品侧的「重试收据」，200 份完整 payload 会白占 ~7 MB。
    // 这里用**裸连接**删（`storage.rs` 有自己的体量棘轮，不为测试工具加公开口）+ VACUUM 回收。
    {
        let conn = rusqlite::Connection::open(&out).expect("清回执：开库");
        conn.execute("DELETE FROM persist_batches", [])
            .expect("清回执");
        conn.execute_batch("VACUUM").expect("回收空间");
    }

    // 自检：块数 / 页数 / FTS 检索 / 反向索引一致性（读回一份独立实例，不复用写句柄）。
    let check = SqliteBlockStore::open(&out).expect("重开采样库");
    let loaded: Vec<Value> = check
        .list_all_json()
        .expect("读回")
        .iter()
        .map(|raw| serde_json::from_str(raw).expect("读回的 JSON 可解析"))
        .collect();
    let total = loaded.len();
    let pages = loaded
        .iter()
        .filter(|block| block["isObject"] == json!(true))
        .count();
    let hits = check.search("采样块").expect("FTS 检索").len();
    let consistent = check.reverse_index_consistent().expect("反向索引一致性");
    let bytes = std::fs::metadata(&out).expect("产物元信息").len();

    println!(
        "采样库：{total} 块 / {pages} 页 / 检索命中 {hits} / 反向索引一致 {consistent} / {:.1} MB / 用时 {:.1}s\n         → {}",
        bytes as f64 / 1_000_000.0,
        started.elapsed().as_secs_f64(),
        out.display()
    );
    assert_eq!(total, PAGES * PER_PAGE, "块数要等于 200 × 25");
    assert_eq!(pages, PAGES, "页数要等于 200");
    assert!(hits > 0, "FTS 检索要能命中采样文本");
    assert!(consistent, "反向索引要一致");
}

/// 中文检索规模抽测（`05` 性能条收编的两个抽测项；判据与来由见 `13-候选实现路径` 的 J 节）：
/// **两字词检索耗时**（`search_hits` 的 1–2 字通路 = `instr` 全表扫，无索引）+ **trigram 索引体积**。
///
/// **跑法**：`cd app/src-tauri && cargo test --release search_scale_spotcheck -- --ignored --nocapture`
/// —— **带 `--release`**：debug 下 bundled SQLite 以 -O0 编译，毫秒数会失真数倍，数字不可入账。
///
/// 两条纪律：① 只碰**副本**（`%TEMP%`；夹具本体与真库都不做实验台，`06` §7.0）；
/// ② 计时先做、量体积后做（丢表会动库）。
#[test]
#[ignore = "手动跑：检索规模抽测（两字词 instr 扫耗时 ＋ trigram 索引体积）"]
fn search_scale_spotcheck() {
    let source = out_path();
    if !source.exists() {
        panic!(
            "先造采样库：cargo test perf_fixture -- --ignored\n         缺 {}",
            source.display()
        );
    }
    let work = std::env::temp_dir().join("moqi-perf-spotcheck");
    std::fs::create_dir_all(&work).expect("建临时目录");
    let copy = work.join("project-b.sqlite3");
    std::fs::copy(&source, &copy).expect("拷副本");

    let store = SqliteBlockStore::open(&copy).expect("开副本");
    let live = store.list_all_json().expect("读全员").len();

    // 词条选择：两字词一密一疏——「检索」在采样正文里约 1/6 命中（密命中）；
    // 「银行」零命中（**最坏扫描形态**：没有提前停，扫满全表）。三字词作 FTS(trigram) 通路对照。
    const ROUNDS: usize = 20;
    let measure = |label: &str, query: &str| {
        let mut hits = 0usize;
        for _ in 0..2 {
            hits = store.search_hits(query, 50).expect("预热检索").len();
        }
        let mut samples: Vec<f64> = Vec::with_capacity(ROUNDS);
        for _ in 0..ROUNDS {
            let started = std::time::Instant::now();
            store.search_hits(query, 50).expect("计时检索");
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).expect("无 NaN"));
        println!(
            "  {label}「{query}」：首轮 {:>7.1} ms · 中位 {:>6.1} ms · 最大 {:>6.1} ms（命中 {hits} 条 · {ROUNDS} 轮）",
            samples[0],
            samples[samples.len() / 2],
            samples[samples.len() - 1],
        );
    };
    println!("检索抽测：{live} 活块（采样库副本）");
    println!("① 两字词 = instr 全表扫（无索引，中文最常用形态）");
    measure("密命中", "检索");
    measure("零命中", "银行");
    println!("② 三字词 = FTS(trigram) 通路（对照）");
    measure("密命中", "分词器");
    drop(store);

    // 体积：`VACUUM INTO` 两份（整库 / 丢 `blocks_fts` 后），差 = FTS 家族占用。
    // 先试 `dbstat`（编译期开了就有，精确到表）；没有就走差法（估口径，已标注）。
    let conn = rusqlite::Connection::open(&copy).expect("体积：开副本");
    let dbstat: Option<i64> = conn
        .query_row(
            "SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'blocks_fts%'",
            [],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let full = work.join("vacuum-full.sqlite3");
    let without = work.join("vacuum-nofts.sqlite3");
    for path in [&full, &without] {
        if path.exists() {
            std::fs::remove_file(path).expect("清旧 VACUUM 产物");
        }
    }
    let quote = |path: &std::path::Path| path.display().to_string().replace('\\', "/");
    conn.execute_batch(&format!("VACUUM INTO '{}'", quote(&full)))
        .expect("VACUUM 整库");
    conn.execute_batch("DROP TABLE blocks_fts")
        .expect("丢 FTS 表（只在副本上）");
    conn.execute_batch(&format!("VACUUM INTO '{}'", quote(&without)))
        .expect("VACUUM 去 FTS");
    drop(conn);
    let size = |path: &std::path::Path| std::fs::metadata(path).expect("体积元信息").len();
    let (full_bytes, without_bytes) = (size(&full), size(&without));
    let fts_bytes = full_bytes - without_bytes;
    println!(
        "③ trigram 索引体积：整库 {:.2} MB · 去 FTS {:.2} MB · **FTS 家族 ≈ {:.2} MB（占 {:.1}%）**",
        full_bytes as f64 / 1_048_576.0,
        without_bytes as f64 / 1_048_576.0,
        fts_bytes as f64 / 1_048_576.0,
        fts_bytes as f64 * 100.0 / full_bytes as f64,
    );
    match dbstat {
        Some(bytes) => println!(
            "   旁证（dbstat 逐表求和，含 shadow）：{:.2} MB",
            bytes as f64 / 1_048_576.0
        ),
        None => println!("   旁证：dbstat 编译期未开，只见 VACUUM 差法（估口径）"),
    }
    assert!(live > 0 && fts_bytes > 0, "抽测要有非零读数");
}
