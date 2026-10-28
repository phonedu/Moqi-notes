use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
use std::path::Path;

#[path = "storage_model.rs"]
mod storage_model;
pub use storage_model::{PersistedOperation, PersistedTransaction, StoredBlock};

/// v7（V2c）：检索索引加拼音两列（全拼 + 首字母，见 `migrate()` 里的说明）。
const SCHEMA_VERSION: i64 = 10;

/// V2c：⌘K 的一条检索命中（`docs/03` §15.2）。字段是按**界面需要**定的（`09` §6.3）：
/// 分组要 `is_object`（页面 / 块）、跳转要 `entity_id` 与 `parent_id`、高亮要 `text`。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entity_id: String,
    pub block_type: String,
    pub is_object: bool,
    pub object_name: Option<String>,
    pub parent_id: Option<String>,
    /// 命中文本：页面给名字，其余给正文（没有正文时给空串）。
    pub text: String,
    /// 标签 id（⌘K 的 chips 按它筛选；名字到 id 的换算在界面侧用 registry 做）。
    pub tags: Vec<String>,
    pub modified: i64,
}

/// V2c 路线 B：前端算好的拼音（一条 = 一个块）。命令入参就是它的数组。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinyinEntry {
    pub entity_id: String,
    pub full: String,
    pub initials: String,
}

/// V2c：索引状态（`09` `R09-SEARCH-6`）。`engine` 让界面能如实说出用的是哪条通路。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// 引擎标识：`fts5-trigram`（桌面 / Android 的 SQLite 索引）或 `memory-scan`（浏览器通道）。
    pub engine: String,
    /// 已索引的块数（`blocks_fts` 的行数 = 存活块数）。
    pub indexed: i64,
    /// 整份索引上次从头建起来的时间（毫秒）；读不到时是 None，界面显示「未知」。
    pub rebuilt_at: Option<i64>,
    /// 已写入拼音的块数（路线 B）；老库升级后由前端回填，回填前它小于 `indexed`。
    pub pinyin_indexed: i64,
    /// 写入失败条数。FTS 与 blocks 同事务写，因此恒为 0——见 `index_status` 的注释。
    pub failures: i64,
}

/// V2b：`oplog` 交给同步的一行（`docs/03` §14.2 的 `SyncChange`，`deviceId` 由调用方补）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OplogRow {
    pub seq: i64,
    pub op_id: String,
    pub created: i64,
    pub op_json: String,
}

// Transaction, search, and in-memory helpers are intentionally retained as
// the V1 storage API for upcoming slices.
pub struct SqliteBlockStore {
    conn: Connection,
}

#[allow(dead_code)]
impl SqliteBlockStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    pub fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )?;

        let current: Option<i64> =
            self.conn
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get(0)
                })?;
        if current.unwrap_or(0) >= SCHEMA_VERSION {
            return Ok(());
        }

        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS blocks (
                id INTEGER PRIMARY KEY,
                entity_id TEXT NOT NULL UNIQUE,
                block_uid TEXT NOT NULL UNIQUE,
                block_type TEXT NOT NULL,
                json TEXT NOT NULL,
                parent TEXT,
                children TEXT NOT NULL DEFAULT '[]',
                position INTEGER NOT NULL DEFAULT 0,
                collapsed INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at INTEGER,
                prev_parent TEXT,
                prev_index INTEGER,
                block_refs TEXT NOT NULL DEFAULT '[]',
                block_backrefs TEXT NOT NULL DEFAULT '[]',
                object_refs TEXT NOT NULL DEFAULT '[]',
                object_backrefs TEXT NOT NULL DEFAULT '[]',
                is_object INTEGER NOT NULL DEFAULT 0,
                object_name TEXT,
                content_text TEXT NOT NULL DEFAULT '',
                tags_text TEXT NOT NULL DEFAULT '',
                properties_text TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                properties TEXT NOT NULL DEFAULT '[]',
                created INTEGER NOT NULL,
                modified INTEGER NOT NULL,
                FOREIGN KEY (parent) REFERENCES blocks(entity_id)
            );
            -- 页面名**允许重复**（docs/04 §3.1）：链接靠 targetId 指向，名字不再需要唯一。
            -- 先掉掉历史版本的 UNIQUE 索引（旧库升到 v5 时执行一次），再建普通索引——
            -- 否则新建两个同名页面会报 `UNIQUE constraint failed: blocks.object_name`（2026-09-28 用户实测）。
            DROP INDEX IF EXISTS idx_blocks_object_name;
            CREATE INDEX IF NOT EXISTS idx_blocks_object_name ON blocks(object_name);
            CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent);
            CREATE INDEX IF NOT EXISTS idx_blocks_deleted_modified ON blocks(deleted, modified);
            CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
                entity_id UNINDEXED,
                content_text,
                tags,
                properties_text,
                page_name,
                pinyin_full,
                pinyin_initials,
                pinyin_at UNINDEXED,
                tokenize = 'trigram'
            );
            CREATE TABLE IF NOT EXISTS property_defs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                options TEXT,
                color TEXT,
                created INTEGER NOT NULL,
                modified INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY,
                json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS transaction_history (
                transaction_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                device_id TEXT NOT NULL,
                operations_json TEXT NOT NULL,
                inverse_json TEXT NOT NULL,
                created INTEGER NOT NULL,
                undone INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS oplog (
                op_id TEXT PRIMARY KEY,
                transaction_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                op_json TEXT NOT NULL,
                created INTEGER NOT NULL,
                UNIQUE(device_id, seq),
                FOREIGN KEY(transaction_id) REFERENCES transaction_history(transaction_id)
            );
            CREATE INDEX IF NOT EXISTS idx_oplog_device_seq ON oplog(device_id, seq);
            CREATE INDEX IF NOT EXISTS idx_history_created ON transaction_history(created);",
        )?;
        if current.unwrap_or(0) == 1 {
            tx.execute_batch(
                "ALTER TABLE blocks ADD COLUMN content_text TEXT NOT NULL DEFAULT '';
                 ALTER TABLE blocks ADD COLUMN tags_text TEXT NOT NULL DEFAULT '';
                 ALTER TABLE blocks ADD COLUMN properties_text TEXT NOT NULL DEFAULT '';",
            )?;
        }
        // T15: existing databases predate the explicit sibling order key.
        if !column_exists(&tx, "blocks", "position")? {
            tx.execute_batch(
                "ALTER TABLE blocks ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
                 UPDATE blocks SET position = created;",
            )?;
        }
        // V2c（`docs/03` §15.2 缺口 ②）：检索索引换成 `trigram` 分词器，并把**页面名**也收进索引。
        //
        // 为什么必须换：FTS5 默认的 `unicode61` 按空白切词，中文没有空格 ⇒ 整句变成一个 token，
        // 中文子串**搜不到**（`09` `R09-SEARCH-5`）。`trigram` 按三字一组建索引，任意子串都能命中。
        // 为什么要 `page_name`：⌘K 的结果按「页面 / 块 / 标签」分组（`R09-SEARCH-2`），而页面名
        // 不在 `content_text` 里（那是正文片段的拼接）——不补这一列，按页面名搜不到页面。
        // 索引是**派生数据**：这里直接 drop + 按 `blocks` 重建，不涉及任何数据迁移。
        if current.unwrap_or(0) < 6 {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks_fts'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let needs_rebuild = existing
                .as_deref()
                .is_none_or(|sql| !sql.contains("trigram") || !sql.contains("page_name"));
            if needs_rebuild {
                tx.execute_batch(
                    "DROP TABLE IF EXISTS blocks_fts;
                     CREATE VIRTUAL TABLE blocks_fts USING fts5(
                         entity_id UNINDEXED,
                         content_text,
                         tags,
                         properties_text,
                         page_name,
                         tokenize = 'trigram'
                     );
                     INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text, page_name)
                        SELECT entity_id, content_text, tags_text, properties_text, COALESCE(object_name, '')
                        FROM blocks WHERE deleted = 0;",
                )?;
            }
        }
        // V2c（路线 B）：FTS 加**拼音两列**（全拼 + 首字母）。拼音在 TS 侧算（`pinyin-pro` 有词库，
        // Rust 的 pinyin crate 只有逐字转换、多音字全错——见 `03` §15.2 的 spike 结论表），
        // 随保存交给这里写进索引；老库升级后这两列先是空的，由前端在启动时**回填**。
        if current.unwrap_or(0) < 7 {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks_fts'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let needs_rebuild = existing
                .as_deref()
                .is_none_or(|sql| !sql.contains("pinyin_full") || !sql.contains("pinyin_initials"));
            if needs_rebuild {
                tx.execute_batch(
                    "DROP TABLE IF EXISTS blocks_fts;
                     CREATE VIRTUAL TABLE blocks_fts USING fts5(
                         entity_id UNINDEXED,
                         content_text,
                         tags,
                         properties_text,
                         page_name,
                         pinyin_full,
                         pinyin_initials,
                         tokenize = 'trigram'
                     );
                     INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text, page_name, pinyin_full, pinyin_initials)
                        SELECT entity_id, content_text, tags_text, properties_text, COALESCE(object_name, ''), '', ''
                        FROM blocks WHERE deleted = 0;",
                )?;
            }
        }
        // V2c 补丁（2026-10-04 真机验收暴露）：加 `pinyin_at` 标记列——**拼音覆盖不能再拿「拼音列非空」当判据**。
        //
        // 缺口长什么样：空块（以及只含标点/表情的块）的拼音天生是空串，而覆盖数原来数的是
        // `pinyin_full <> ''` ⇒ 这类块永远算「还没建」：设置页长期停在 3 / 4 块（像坏了），
        // 启动回填的门禁 `pinyinIndexed >= indexed` 永远不成立 ⇒ **每次开机都把全库重算重写一遍**。
        // 而空块在大纲里是常态（新页面、正文末尾的落点行）——这是一个会天天触发的坑。
        //
        // 修法：让库里能分开「算过、结果是空」和「根本没算过」。FTS5 是虚拟表，**不支持 ALTER TABLE
        // ADD COLUMN**（SQLite 虚拟表限制），所以照 v6/v7 的手法重建索引表——索引是派生数据，
        // 重建不碰领域、不进 oplog；重建后拼音两列归零，由前端启动回填补一次（判据就是下面这个标记）。
        if current.unwrap_or(0) < 8 {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks_fts'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let needs_rebuild = existing
                .as_deref()
                .is_none_or(|sql| !sql.contains("pinyin_at"));
            if needs_rebuild {
                tx.execute_batch(
                    "DROP TABLE IF EXISTS blocks_fts;
                     CREATE VIRTUAL TABLE blocks_fts USING fts5(
                         entity_id UNINDEXED,
                         content_text,
                         tags,
                         properties_text,
                         page_name,
                         pinyin_full,
                         pinyin_initials,
                         pinyin_at UNINDEXED,
                         tokenize = 'trigram'
                     );
                     INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text, page_name, pinyin_full, pinyin_initials, pinyin_at)
                        SELECT entity_id, content_text, tags_text, properties_text, COALESCE(object_name, ''), '', '', 0
                        FROM blocks WHERE deleted = 0;",
                )?;
            }
        }
        // V2c：把「索引上次是什么时候建/重建的」记下来（`09` `R09-SET-13` 要在设置里显示它）。
        // 增量写入不算重建：这个时间戳只回答「整份索引上一次从头建起来是什么时候」——
        // 老库迁移、或新库第一次建表，各写一次。
        let indexed_at: Option<String> = tx
            .query_row(
                "SELECT json FROM app_metadata WHERE key = 'fts-rebuilt-at'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if indexed_at.is_none() {
            tx.execute(
                "INSERT INTO app_metadata(key, json) VALUES ('fts-rebuilt-at', ?1)",
                params![now_ms().to_string()],
            )?;
        }
        // A2（`13-属性区重规划` §7.1-A2）：检索文本从"原始 JSON"换成「属性名: 显示值」/ 标签名——
        // 存量块的这两列要重算一遍（新写法从这次迁移之后才生效）。判据用 `app_metadata` 的版本位：
        // `schema_migrations` 只在整份迁移第一次跑时写一次，标记不了"这一步单独跑过没有"。
        let search_text_version: Option<String> = tx
            .query_row(
                "SELECT json FROM app_metadata WHERE key = 'search-text-v'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if search_text_version.as_deref() != Some("2") {
            let registry: Option<serde_json::Value> = tx
                .query_row(
                    "SELECT json FROM app_metadata WHERE key = 'registry'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .and_then(|raw| serde_json::from_str(&raw).ok());
            let rows: Vec<String> = {
                let mut statement = tx.prepare("SELECT json FROM blocks")?;
                let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
                mapped.filter_map(|row| row.ok()).collect()
            };
            for json in rows {
                let Ok(mut block) = StoredBlock::from_block_json(&json) else {
                    continue;
                };
                block.apply_search_text(registry.as_ref());
                upsert_block_tx(&tx, &block)?;
            }
            tx.execute(
                "INSERT INTO app_metadata(key, json) VALUES ('search-text-v', '2')
                 ON CONFLICT(key) DO UPDATE SET json = excluded.json",
                [],
            )?;
        }
        tx.execute_batch("CREATE TABLE IF NOT EXISTS persist_batches (batch_id TEXT PRIMARY KEY, payload TEXT NOT NULL);")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![SCHEMA_VERSION, now_ms()],
        )?;
        tx.commit()
    }

    /// A2：写库前把检索文本改写成可读形态（「属性名: 显示值」/ 标签名）——注册表只读一次。
    fn rewrite_search_texts(&self, blocks: &mut [StoredBlock]) -> Result<()> {
        let registry = self.registry_value()?;
        for block in blocks.iter_mut() {
            block.apply_search_text(registry.as_ref());
        }
        Ok(())
    }

    pub fn upsert_block(&mut self, block: &StoredBlock) -> Result<()> {
        let mut block = block.clone();
        self.rewrite_search_texts(std::slice::from_mut(&mut block))?;
        let tx = self.conn.transaction()?;
        upsert_block_tx(&tx, &block)?;
        tx.commit()
    }

    pub fn commit_transaction(
        &mut self,
        transaction: &PersistedTransaction,
        blocks: &[StoredBlock],
    ) -> Result<()> {
        let mut stored = blocks.to_vec();
        self.rewrite_search_texts(&mut stored)?;
        let tx = self.conn.transaction()?;
        Self::insert_transaction(&tx, transaction)?;
        for block in &stored {
            upsert_block_tx(&tx, block)?;
        }
        tx.commit()
    }

    /// A durable receipt makes retries safe even when the caller lost the commit response.
    pub fn commit_batch(
        &mut self,
        batch_id: &str,
        transactions: &[PersistedTransaction],
        blocks: &[StoredBlock],
        purged: &[String],
    ) -> Result<()> {
        if batch_id.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "empty batch ID".into(),
            ));
        }
        // A2：改写要在**落盘回执之前**——回执（`payload`）存的就是写进去的那份内容，
        // 重放时必须与原样一致，否则「同批号不同内容」会误报。
        let mut blocks = blocks.to_vec();
        self.rewrite_search_texts(&mut blocks)?;
        let payload = serde_json::to_string(&(transactions, &blocks, purged))
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT payload FROM persist_batches WHERE batch_id=?1",
                [batch_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            return if existing == payload {
                Ok(())
            } else {
                Err(rusqlite::Error::InvalidParameterName(
                    "batch ID reused with different content".into(),
                ))
            };
        }
        for transaction in transactions {
            Self::insert_transaction(&tx, transaction)?;
        }
        for block in &blocks {
            upsert_block_tx(&tx, block)?;
        }
        if !purged.is_empty() {
            // 彻底删除必须按数据库里的 `parent` 链展开，不能只信内存里的 `children`：
            // 页面进回收站前删掉的子块仍留着 `parent` 指向页面根，但已经不在父块的
            // `children` 里。只删可见子树会撞 `FOREIGN KEY constraint failed`（D-091）。
            let purge_ids = Self::expand_purge_ids(&tx, purged)?;
            let placeholders = vec!["?"; purge_ids.len()].join(",");
            tx.execute(
                &format!("DELETE FROM blocks_fts WHERE entity_id IN ({placeholders})"),
                rusqlite::params_from_iter(purge_ids.iter()),
            )?;
            tx.execute(
                &format!("DELETE FROM blocks WHERE entity_id IN ({placeholders})"),
                rusqlite::params_from_iter(purge_ids.iter()),
            )?;
        }
        tx.execute(
            "INSERT INTO persist_batches(batch_id,payload) VALUES (?1,?2)",
            params![batch_id, payload],
        )?;
        tx.commit()
    }

    fn insert_transaction(tx: &Transaction<'_>, transaction: &PersistedTransaction) -> Result<()> {
        let operations_json = serde_json::to_string(&transaction.operations)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        tx.execute(
            "INSERT INTO transaction_history(transaction_id, source, device_id, operations_json, inverse_json, created, undone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![transaction.transaction_id, transaction.source, transaction.device_id, operations_json, transaction.inverse_json, transaction.created],
        )?;
        let next_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM oplog WHERE device_id = ?1",
            params![transaction.device_id],
            |row| row.get(0),
        )?;
        for (offset, operation) in transaction.operations.iter().enumerate() {
            tx.execute(
                "INSERT INTO oplog(op_id, transaction_id, device_id, seq, op_json, created)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    operation.op_id,
                    transaction.transaction_id,
                    transaction.device_id,
                    next_seq + offset as i64,
                    operation.json,
                    transaction.created
                ],
            )?;
        }
        Ok(())
    }

    pub fn mark_transaction_undone(&mut self, transaction_id: &str, undone: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE transaction_history SET undone = ?2 WHERE transaction_id = ?1",
            params![transaction_id, bool_to_int(undone)],
        )?;
        Ok(())
    }

    pub fn last_transaction(&self, undone: bool) -> Result<Option<PersistedTransaction>> {
        self.conn
            .query_row(
                "SELECT transaction_id, source, device_id, operations_json, inverse_json, created
                 FROM transaction_history WHERE undone = ?1 ORDER BY created DESC LIMIT 1",
                params![bool_to_int(undone)],
                |row| {
                    let device_id: String = row.get(2)?;
                    let operations_json: String = row.get(3)?;
                    let operations = serde_json::from_str::<Vec<PersistedOperation>>(
                        &operations_json,
                    )
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    Ok(PersistedTransaction {
                        transaction_id: row.get(0)?,
                        source: row.get(1)?,
                        device_id,
                        operations,
                        inverse_json: row.get(4)?,
                        created: row.get(5)?,
                    })
                },
            )
            .optional()
    }

    pub fn transaction_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM transaction_history", [], |row| {
                row.get(0)
            })
    }

    /// V2b：把本机 `oplog` 里 `seq > from_seq` 的那段交出来——**同步只读已落盘的日志**
    /// （`docs/03` §14.1 的时序约束：不抢保存队列、不改内存里未落盘的块）。
    pub fn load_oplog(&self, device_id: &str, from_seq: i64) -> Result<Vec<OplogRow>> {
        let mut statement = self.conn.prepare(
            "SELECT seq, op_id, created, op_json FROM oplog
             WHERE device_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![device_id, from_seq], |row| {
            Ok(OplogRow {
                seq: row.get(0)?,
                op_id: row.get(1)?,
                created: row.get(2)?,
                op_json: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// V2b：本机 `oplog` 里最大的 `seq`——「还有多少条没交出去」用它算。
    pub fn max_oplog_seq(&self, device_id: &str) -> Result<i64> {
        self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM oplog WHERE device_id = ?1",
            params![device_id],
            |row| row.get(0),
        )
    }

    pub fn oplog_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM oplog", [], |row| row.get(0))
    }

    pub fn upsert_block_in_transaction(tx: &Transaction<'_>, block: &StoredBlock) -> Result<()> {
        upsert_block_tx(tx, block)
    }

    pub fn get_block(&self, entity_id: &str) -> Result<Option<StoredBlock>> {
        self.conn
            .query_row(
                "SELECT entity_id, block_uid, block_type, json, parent, deleted, deleted_at,
                        prev_parent, prev_index, is_object, object_name, created, modified,
                        content_text, tags_text, properties_text, block_refs, block_backrefs, object_refs, object_backrefs, position
                 FROM blocks WHERE entity_id = ?1",
                params![entity_id],
                row_to_block,
            )
            .optional()
    }

    pub fn list_active(&self) -> Result<Vec<StoredBlock>> {
        let mut statement = self.conn.prepare(
            "SELECT entity_id, block_uid, block_type, json, parent, deleted, deleted_at,
                    prev_parent, prev_index, is_object, object_name, created, modified,
                    content_text, tags_text, properties_text, block_refs, block_backrefs, object_refs, object_backrefs, position
             FROM blocks WHERE deleted = 0 ORDER BY position, created, id",
        )?;
        let rows = statement.query_map([], row_to_block)?;
        rows.collect()
    }

    /// 全部块，**含回收站里的**（`load_blocks` 用它）。
    ///
    /// 为什么必须带上已删除的：`deletedRoots()` 就是回收站列表的来源，而「30 天到期自动清理」
    /// 也是遍历载入的块来判定的——只载入存活块会让回收站在重启后凭空变空、到期清理永远空转
    /// （2026-10-03 清单 C 在真实窗口实测到）。领域层与界面早就按「块图里同时有存活与已删除的块」
    /// 写（内存 / localStorage 两个端口一直如此），这里只是把 SQLite 端口对齐。
    pub fn list_all(&self) -> Result<Vec<StoredBlock>> {
        let mut statement = self.conn.prepare(
            "SELECT entity_id, block_uid, block_type, json, parent, deleted, deleted_at,
                    prev_parent, prev_index, is_object, object_name, created, modified,
                    content_text, tags_text, properties_text, block_refs, block_backrefs, object_refs, object_backrefs, position
             FROM blocks ORDER BY position, created, id",
        )?;
        let rows = statement.query_map([], row_to_block)?;
        rows.collect()
    }

    pub fn list_all_json(&self) -> Result<Vec<String>> {
        self.list_all()
            .map(|blocks| blocks.into_iter().map(|block| block.json).collect())
    }

    pub fn list_active_json(&self) -> Result<Vec<String>> {
        self.list_active()
            .map(|blocks| blocks.into_iter().map(|block| block.json).collect())
    }

    pub fn save_block_json(&mut self, json: &str) -> std::result::Result<(), String> {
        let block = StoredBlock::from_block_json(json)?;
        self.upsert_block(&block).map_err(|error| error.to_string())
    }

    pub fn search(&self, query: &str) -> Result<Vec<StoredBlock>> {
        let mut statement = self.conn.prepare(
            "SELECT b.entity_id, b.block_uid, b.block_type, b.json, b.parent, b.deleted,
                    b.deleted_at, b.prev_parent, b.prev_index, b.is_object, b.object_name,
                    b.created, b.modified, b.content_text, b.tags_text, b.properties_text,
                    b.block_refs, b.block_backrefs, b.object_refs, b.object_backrefs, b.position
             FROM blocks_fts f JOIN blocks b ON b.entity_id = f.entity_id
             WHERE blocks_fts MATCH ?1 AND b.deleted = 0
             ORDER BY b.modified DESC",
        )?;
        let rows = statement.query_map(params![query], row_to_block)?;
        rows.collect()
    }

    /// V2c：⌘K 全局检索（`docs/03` §15.2 缺口 ①，行为见 `11` `SEARCH-GLOBAL-1`）。
    ///
    /// **两条通路，按查询长度分**——`trigram` 索引按三字一组，**少于 3 个字符的查询命中不了任何东西**
    /// （SQLite trigram 分词器的硬约束），而中文里两字词极其常见（「检索」「同步」「笔记」）。
    /// 所以：≥ 3 字走 FTS（有索引、按 `modified` 排序），1–2 字退回 `instr` 全表扫（几千块量级代价可忽略，
    /// 且 `instr` 不用为 `%` / `_` 做转义——`LIKE` 才要）。这条分界是**实测出来的**，不是保险起见。
    ///
    /// 命中的范围：正文、标签、属性、**页面名**（`page_name` 列，⌘K 要按页面名找到页面）。
    /// 已删的块不进结果（软删时 FTS 行已删，这里再按 `deleted = 0` 收一道）。
    pub fn search_hits(&self, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
        let text = query.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let columns = "b.entity_id, b.block_type, b.is_object, b.object_name, b.parent, b.modified,
                       CASE WHEN b.is_object = 1 THEN COALESCE(b.object_name, '') ELSE b.content_text END,
                       b.tags";
        let order = "ORDER BY b.is_object DESC, b.modified DESC LIMIT ?2";
        // UNION 那条通路要在**外层**排序，键是子查询里的别名（见下面 FTS 分支）
        let order_union = "ORDER BY sort_object DESC, sort_modified DESC LIMIT ?2";
        // V2c 路线 B：拼音子句**常驻**（中文查询时 `instr` 自然为 0，不影响结果），参数个数因此固定。
        // 全拼列任意长度都匹配；首字母列只在查询是 ≥2 位纯字母时才启用（一位字母太吵），
        // 不启用时给一个永远匹配不上的哨兵——不能用空串：`instr(x, '')` 恒真。
        let pinyin_full = text.to_ascii_lowercase();
        let pinyin_initials =
            if text.chars().count() >= 2 && text.chars().all(|c| c.is_ascii_alphabetic()) {
                text.to_ascii_lowercase()
            } else {
                "\u{0}".to_owned()
            };
        let mut statement = if text.chars().count() >= 3 {
            // 短语查询：整串当成一个词（转义内部引号），得到的就是**子串匹配**语义。
            //
            // **MATCH 不能与别的条件 OR 在一起**（SQLite 报「unable to use function MATCH in the
            // requested context」）——所以原文通路与拼音通路写成两条 SELECT 再 UNION：
            // UNION 天然去重（两边都命中的块只出一条），排序放在外层子查询上；
            // 排序键以别名（`sort_*`）进了输出，行映射只读前几列，多出来的列不影响。
            self.conn.prepare(&format!(
                "SELECT * FROM (
                     SELECT {columns}, b.is_object AS sort_object, b.modified AS sort_modified
                       FROM blocks_fts f JOIN blocks b ON b.entity_id = f.entity_id
                      WHERE blocks_fts MATCH ?1 AND b.deleted = 0
                     UNION
                     SELECT {columns}, b.is_object AS sort_object, b.modified AS sort_modified
                       FROM blocks_fts f JOIN blocks b ON b.entity_id = f.entity_id
                      WHERE (instr(f.pinyin_full, ?3) > 0 OR instr(f.pinyin_initials, ?4) > 0) AND b.deleted = 0
                 ) {order_union}"
            ))?
        } else {
            self.conn.prepare(&format!(
                "SELECT {columns} FROM blocks b
                 LEFT JOIN blocks_fts f ON f.entity_id = b.entity_id
                 WHERE b.deleted = 0
                   AND (instr(b.content_text, ?1) > 0 OR instr(COALESCE(b.object_name, ''), ?1) > 0
                        OR instr(b.tags_text, ?1) > 0 OR instr(b.properties_text, ?1) > 0
                        OR instr(f.pinyin_full, ?3) > 0 OR instr(f.pinyin_initials, ?4) > 0)
                 {order}"
            ))?
        };
        let match_arg = if text.chars().count() >= 3 {
            format!("\"{}\"", text.replace('"', "\"\""))
        } else {
            text.to_string()
        };
        let rows = statement.query_map(
            params![match_arg, limit, pinyin_full, pinyin_initials],
            |row| {
                Ok(SearchHit {
                    entity_id: row.get(0)?,
                    block_type: row.get(1)?,
                    is_object: row.get::<_, i64>(2)? != 0,
                    object_name: row.get(3)?,
                    parent_id: row.get(4)?,
                    modified: row.get(5)?,
                    text: row.get(6)?,
                    tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                })
            },
        )?;
        rows.collect()
    }

    /// V2c 路线 B：写入 / 刷新若干块的拼音两列（TS 侧算好传来；索引是派生数据，不碰领域、不进 oplog）。
    ///
    /// 调用点两处：① 启动回填（老库升级后这两列是空的）；② 每批保存之后刷新刚改过的块。
    /// 顺带盖上 `pinyin_at` 时间戳：**「这一块算过了」是独立的事实**，不能从「拼音非空」反推
    /// （空块与纯标点块的拼音合法地就是空串，见 `SCHEMA_VERSION = 8` 的迁移注释）。
    /// 返回实际更新的行数（调用方可以据此判断有没有漏块——比如块已删，索引行不在）。
    pub fn update_pinyin_index(&mut self, entries: &[(String, String, String)]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let stamped_at = now_ms();
        let mut updated = 0usize;
        {
            let mut statement = tx.prepare(
                "UPDATE blocks_fts SET pinyin_full = ?2, pinyin_initials = ?3, pinyin_at = ?4 WHERE entity_id = ?1",
            )?;
            for (entity_id, full, initials) in entries {
                updated += statement.execute(params![entity_id, full, initials, stamped_at])?;
            }
        }
        tx.commit()?;
        Ok(updated)
    }

    /// V2c：索引状态（`09` `R09-SEARCH-6` / `R09-SET-13`）。**降级要看得见**，不是静默少一块能力。
    ///
    /// `failures` 恒为 0 且是**如实**的：FTS 索引与 `blocks` 在**同一条 SQLite 事务**里写，
    /// 没有独立的异步索引队列，因此不存在「块存进去了、索引写失败」这种中间态
    /// （那条风险属于后段的嵌入索引，见 `03` §15.3）。字段保留是为了让界面结构稳定。
    pub fn index_status(&self) -> Result<IndexStatus> {
        let indexed: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM blocks_fts", [], |row| row.get(0))?;
        let rebuilt_at: Option<i64> = self
            .get_metadata("fts-rebuilt-at")?
            .and_then(|json| json.parse::<i64>().ok());
        // V2c 路线 B：拼音覆盖了多少块——判据是 `pinyin_at` 标记，**不是**「拼音列非空」：
        // 空块/纯标点块的拼音合法地为空串，用非空当判据会让覆盖率永远差几块（见 `SCHEMA_VERSION = 8`）。
        let pinyin_indexed: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM blocks_fts WHERE pinyin_at > 0",
            [],
            |row| row.get(0),
        )?;
        Ok(IndexStatus {
            engine: "fts5-trigram".to_owned(),
            indexed,
            rebuilt_at,
            pinyin_indexed,
            failures: 0,
        })
    }

    pub fn soft_delete(&mut self, entity_id: &str, deleted_at: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE blocks SET deleted = 1, deleted_at = ?2, modified = ?2 WHERE entity_id = ?1",
            params![entity_id, deleted_at],
        )?;
        tx.execute(
            "DELETE FROM blocks_fts WHERE entity_id = ?1",
            params![entity_id],
        )?;
        tx.commit()
    }

    /// V2b：「从本机彻底删除」（回收站里的那个动作）。**物理移除，不是一次变更**——
    /// 不进 oplog、不产生 transaction（`docs/03` §14.5 层 2：本机行为，不参与同步）。
    ///
    /// **整批必须在同一条语句里删完**：`PRAGMA foreign_keys = ON` 的即时外键在
    /// **语句结束时**校验，逐行删会先删到父块、`parent` 外键当场违约。
    pub fn purge_blocks(&mut self, entity_ids: &[String]) -> Result<usize> {
        if entity_ids.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.transaction()?;
        // 与 `commit_batch` 同一条展开规则：按 `parent` 链把软删除的后代也删掉，
        // 否则整批会被自引用外键拦下（D-091）。
        let purge_ids = Self::expand_purge_ids(&tx, entity_ids)?;
        let placeholders = vec!["?"; purge_ids.len()].join(",");
        tx.execute(
            &format!("DELETE FROM blocks_fts WHERE entity_id IN ({placeholders})"),
            rusqlite::params_from_iter(purge_ids.iter()),
        )?;
        let removed = tx.execute(
            &format!("DELETE FROM blocks WHERE entity_id IN ({placeholders})"),
            rusqlite::params_from_iter(purge_ids.iter()),
        )?;
        tx.commit()?;
        Ok(removed)
    }

    /// 把彻底删除的种子 ID 按 `parent` 链展开成整棵子树。
    ///
    /// **不看 `children` 列**：软删除会把子块从父块的 `children` 里摘掉，但 `parent` 仍然
    /// 指向父块；只删可见子树就会留下引用已删父块的行，SQLite 的即时外键会让整批回滚
    /// （D-091；2026-10-24 手机回收站实测）。
    ///
    /// 分块查询是为了避开 SQLite 的变量上限（默认 999）：一个页面可能有几百个块。
    fn expand_purge_ids(conn: &Connection, entity_ids: &[String]) -> Result<Vec<String>> {
        let mut seen = std::collections::HashSet::new();
        let mut all = Vec::new();
        let mut frontier = Vec::new();
        for id in entity_ids {
            if seen.insert(id.clone()) {
                all.push(id.clone());
                frontier.push(id.clone());
            }
        }
        while !frontier.is_empty() {
            let mut next = Vec::new();
            for chunk in frontier.chunks(900) {
                let placeholders = vec!["?"; chunk.len()].join(",");
                let mut statement = conn.prepare(&format!(
                    "SELECT entity_id FROM blocks WHERE parent IN ({placeholders})"
                ))?;
                let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                    row.get::<_, String>(0)
                })?;
                for row in rows {
                    let id = row?;
                    if seen.insert(id.clone()) {
                        next.push(id);
                    }
                }
            }
            all.extend(next.iter().cloned());
            frontier = next;
        }
        Ok(all)
    }

    pub fn restore(&mut self, entity_id: &str, modified: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE blocks SET deleted = 0, deleted_at = NULL, modified = ?2 WHERE entity_id = ?1",
            params![entity_id, modified],
        )?;
        let block: StoredBlock = tx.query_row(
            "SELECT entity_id, block_uid, block_type, json, parent, deleted, deleted_at,
                    prev_parent, prev_index, is_object, object_name, created, modified,
                    content_text, tags_text, properties_text, block_refs, block_backrefs, object_refs, object_backrefs, position
             FROM blocks WHERE entity_id = ?1",
            params![entity_id],
            row_to_block,
        )?;
        tx.execute(
            "INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text, page_name) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![block.entity_id, block.content_text, block.tags_text, block.properties_text, block.object_name.as_deref().unwrap_or("")],
        )?;
        tx.commit()
    }

    pub fn rebuild_reverse_index(&mut self) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut backrefs: std::collections::HashMap<String, (Vec<serde_json::Value>, Vec<String>)> =
            std::collections::HashMap::new();
        let mut statement =
            tx.prepare("SELECT entity_id, block_refs, object_refs, deleted FROM blocks")?;
        let rows = statement.query_map([], |row| {
            let entity_id: String = row.get(0)?;
            let block_refs: String = row.get(1)?;
            let object_refs: String = row.get(2)?;
            let deleted: i64 = row.get(3)?;
            Ok((entity_id, block_refs, object_refs, deleted != 0))
        })?;
        let mut sources = Vec::new();
        for row in rows {
            sources.push(row?);
        }
        drop(statement);
        let active: std::collections::HashSet<String> = sources
            .iter()
            .filter(|(_, _, _, deleted)| !deleted)
            .map(|(id, _, _, _)| id.clone())
            .collect();
        for (source_id, block_refs_json, object_refs_json, deleted) in sources {
            if deleted {
                continue;
            }
            let block_refs: Vec<serde_json::Value> =
                serde_json::from_str(&block_refs_json).unwrap_or_default();
            let object_refs: Vec<String> =
                serde_json::from_str(&object_refs_json).unwrap_or_default();
            for reference in block_refs {
                let target_id = reference
                    .get("targetBlockId")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                if active.contains(target_id) {
                    backrefs.entry(target_id.to_owned()).or_default().0.push(serde_json::json!({
                        "targetBlockId": target_id,
                        "fromBlockId": source_id,
                        "type": reference.get("type").and_then(|value| value.as_str()).unwrap_or("link"),
                        "context": reference.get("context").and_then(|value| value.as_str()),
                    }));
                }
            }
            for target_id in object_refs {
                if active.contains(&target_id) {
                    backrefs
                        .entry(target_id)
                        .or_default()
                        .1
                        .push(source_id.clone());
                }
            }
        }
        let mut update = tx.prepare(
            "UPDATE blocks SET block_backrefs = ?2, object_backrefs = ?3 WHERE entity_id = ?1",
        )?;
        let mut updated = 0;
        for id in active {
            let (block_refs, object_refs) = backrefs.remove(&id).unwrap_or_default();
            update.execute(params![
                id,
                serde_json::to_string(&block_refs).unwrap_or_else(|_| "[]".to_owned()),
                serde_json::to_string(&object_refs).unwrap_or_else(|_| "[]".to_owned())
            ])?;
            updated += 1;
        }
        drop(update);
        tx.commit()?;
        Ok(updated)
    }

    pub fn reverse_index_consistent(&self) -> Result<bool> {
        let mut statement = self.conn.prepare("SELECT entity_id, block_refs, block_backrefs, object_refs, object_backrefs, deleted FROM blocks")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)? != 0,
            ))
        })?;
        let mut forward: std::collections::HashMap<String, (Vec<serde_json::Value>, Vec<String>)> =
            std::collections::HashMap::new();
        let mut actual: std::collections::HashMap<String, (Vec<serde_json::Value>, Vec<String>)> =
            std::collections::HashMap::new();
        for row in rows {
            let (id, refs, backs, object_refs, object_backs, deleted) = row?;
            if deleted {
                continue;
            }
            forward.insert(
                id.clone(),
                (
                    serde_json::from_str(&refs).unwrap_or_default(),
                    serde_json::from_str(&object_refs).unwrap_or_default(),
                ),
            );
            actual.insert(
                id,
                (
                    serde_json::from_str(&backs).unwrap_or_default(),
                    serde_json::from_str(&object_backs).unwrap_or_default(),
                ),
            );
        }
        let mut expected: std::collections::HashMap<String, (Vec<serde_json::Value>, Vec<String>)> =
            std::collections::HashMap::new();
        for (source_id, (refs, object_refs)) in forward {
            for reference in refs {
                if let Some(target_id) = reference
                    .get("targetBlockId")
                    .and_then(|value| value.as_str())
                {
                    expected.entry(target_id.to_owned()).or_default().0.push(serde_json::json!({
                        "targetBlockId": target_id,
                        "fromBlockId": source_id,
                        "type": reference.get("type").and_then(|value| value.as_str()).unwrap_or("link"),
                        "context": reference.get("context").and_then(|value| value.as_str()),
                    }));
                }
            }
            for target_id in object_refs {
                expected
                    .entry(target_id)
                    .or_default()
                    .1
                    .push(source_id.clone());
            }
        }
        for (id, (mut expected_blocks, mut expected_objects)) in expected {
            let Some((mut actual_blocks, mut actual_objects)) = actual.remove(&id) else {
                return Ok(false);
            };
            expected_blocks.sort_by_key(|item| item.to_string());
            actual_blocks.sort_by_key(|item| item.to_string());
            expected_objects.sort();
            actual_objects.sort();
            if expected_blocks != actual_blocks || expected_objects != actual_objects {
                return Ok(false);
            }
        }
        Ok(actual
            .values()
            .all(|(blocks, objects)| blocks.is_empty() && objects.is_empty()))
    }

    /// T15: global metadata registry (property/tag definitions) stored as one JSON blob.
    ///
    /// **A2**：注册表一变就要**重算受影响的检索文本**——否则属性改名之后，新名字搜不到、旧名字还搜得到。
    /// 做法 = 读出旧注册表、diff 出变动的定义 id，再把引用到这些 id 的块重写一遍
    /// （`refresh_search_text_for`；注册表编辑是低频动作，全表扫一次可以接受）。
    pub fn set_metadata(&mut self, key: &str, json: &str) -> Result<()> {
        let previous = if key == "registry" {
            self.get_metadata(key)?
        } else {
            None
        };
        self.conn.execute(
            "INSERT INTO app_metadata(key, json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET json = excluded.json",
            params![key, json],
        )?;
        if key == "registry" {
            let touched = changed_registry_ids(previous.as_deref(), json);
            if !touched.is_empty() {
                self.refresh_search_text_for(&touched)?;
            }
        }
        Ok(())
    }

    /// A2：读注册表（`app_metadata('registry')`）——属性 / 标签的定义都在这一份里。
    fn registry_value(&self) -> Result<Option<serde_json::Value>> {
        Ok(self
            .get_metadata("registry")?
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok()))
    }

    /// A2：把"引用了这些定义 id"的块的检索文本重算一遍（改名 / 加选项 / 定义被移除之后要跟上）。
    ///
    /// 预筛用**子串**（id 是 uuid，块 JSON 里出现即引用），不做全量 JSON 解析；
    /// 真正改写的走 `upsert_block_tx` 同一条写路径（`blocks` 列与 FTS 行一起刷新、拼音列保住）。
    fn refresh_search_text_for(&mut self, ids: &[String]) -> Result<()> {
        let registry = self.registry_value()?;
        let candidates: Vec<String> = {
            let mut statement = self.conn.prepare("SELECT json FROM blocks")?;
            let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
            mapped
                .filter_map(|row| row.ok())
                .filter(|json| ids.iter().any(|id| json.contains(id.as_str())))
                .collect()
        };
        if candidates.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        for json in candidates {
            let Ok(mut block) = StoredBlock::from_block_json(&json) else {
                continue;
            };
            block.apply_search_text(registry.as_ref());
            upsert_block_tx(&tx, &block)?;
        }
        tx.commit()
    }

    /// V2b：本机设备身份。**同步的地基之一**——`oplog` 按 `device_id` 分区、游标按设备记、
    /// 冲突定序在时间戳相同时按 `deviceId` 字典序（`docs/03` §14.2 / §14.3）。
    ///
    /// 库里有就返回库里的（**身份只认库里的这一份**）；没有才把 `candidate` 落库。
    /// 候选值由调用方生成（前端用 `crypto.randomUUID()`）——这样 Rust 侧不必引入新依赖。
    /// 值是裸字符串不是 JSON（这个键值表只要求读写对称）。
    pub fn resolve_device_id(&mut self, candidate: &str) -> Result<String> {
        if let Some(existing) = self.get_metadata("device_id")? {
            if !existing.is_empty() {
                return Ok(existing);
            }
        }
        self.set_metadata("device_id", candidate)?;
        Ok(candidate.to_owned())
    }

    pub fn get_metadata(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT json FROM app_metadata WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn count_all(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))
    }

    pub fn count_active(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM blocks WHERE deleted = 0", [], |row| {
                row.get(0)
            })
    }
}

/// A2：两份注册表之间**变动的定义 id**（新增 / 改名 / 选项增删 / 被移除的都算）。
/// tags 与 properties 一起比：名字变了，引用它的块就得重算检索文本。
fn changed_registry_ids(previous: Option<&str>, next: &str) -> Vec<String> {
    let parse = |raw: &str| serde_json::from_str::<serde_json::Value>(raw).ok();
    let Some(next_value) = parse(next) else {
        return Vec::new();
    };
    let previous_value = previous.and_then(parse);
    let read = |value: Option<&serde_json::Value>, group: &str| {
        value
            .and_then(|item| item.get(group))
            .and_then(serde_json::Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|item| {
                        Some((item.get("id")?.as_str()?.to_owned(), item.to_string()))
                    })
                    .collect::<std::collections::HashMap<String, String>>()
            })
            .unwrap_or_default()
    };
    let mut touched = Vec::new();
    for group in ["properties", "tags"] {
        let before = read(previous_value.as_ref(), group);
        let after = read(Some(&next_value), group);
        for (id, json) in &after {
            if before.get(id) != Some(json) {
                touched.push(id.clone());
            }
        }
        for id in before.keys() {
            if !after.contains_key(id) {
                touched.push(id.clone());
            }
        }
    }
    touched
}

fn upsert_block_tx(tx: &Transaction<'_>, block: &StoredBlock) -> Result<()> {
    tx.execute(
        "INSERT INTO blocks (
            entity_id, block_uid, block_type, json, parent, deleted, deleted_at,
            prev_parent, prev_index, is_object, object_name, content_text, tags_text,
            properties_text, block_refs, block_backrefs, object_refs, object_backrefs, created, modified, position
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
        ON CONFLICT(entity_id) DO UPDATE SET
            block_uid = excluded.block_uid,
            block_type = excluded.block_type,
            json = excluded.json,
            parent = excluded.parent,
            deleted = excluded.deleted,
            deleted_at = excluded.deleted_at,
            prev_parent = excluded.prev_parent,
            prev_index = excluded.prev_index,
            is_object = excluded.is_object,
            object_name = excluded.object_name,
            content_text = excluded.content_text,
            tags_text = excluded.tags_text,
            properties_text = excluded.properties_text,
            block_refs = excluded.block_refs,
            block_backrefs = excluded.block_backrefs,
            object_refs = excluded.object_refs,
            object_backrefs = excluded.object_backrefs,
            created = excluded.created,
            modified = excluded.modified,
            position = excluded.position",
        params![
            block.entity_id,
            block.block_uid,
            block.block_type,
            block.json,
            block.parent_id,
            bool_to_int(block.deleted),
            block.deleted_at,
            block.prev_parent,
            block.prev_index,
            bool_to_int(block.is_object),
            block.object_name,
            block.content_text,
            block.tags_text,
            block.properties_text,
            block.block_refs_json,
            block.block_backrefs_json,
            block.object_refs_json,
            block.object_backrefs_json,
            block.created,
            block.modified,
            block.position,
        ],
    )?;
    // **保住拼音列**：FTS 行的更新是「删了重插」，而拼音是前端另算后写进来的派生数据——
    // 不先读出来带回去，每次保存都会把拼音抹成空（路线 B 的隐形坑，2026-10-04 设计时先堵掉）。
    // `pinyin_at` 标记同进同出：丢掉它，每次保存都会让这个块重新被算成「没建过」。
    let previous_pinyin: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT pinyin_full, pinyin_initials, pinyin_at FROM blocks_fts WHERE entity_id = ?1",
            params![block.entity_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    tx.execute(
        "DELETE FROM blocks_fts WHERE entity_id = ?1",
        params![block.entity_id],
    )?;
    if !block.deleted {
        let (full, initials, pinyin_at) = previous_pinyin.unwrap_or_default();
        tx.execute(
            "INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text, page_name, pinyin_full, pinyin_initials, pinyin_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![block.entity_id, block.content_text, block.tags_text, block.properties_text, block.object_name.as_deref().unwrap_or(""), full, initials, pinyin_at],
        )?;
    }
    Ok(())
}

fn row_to_block(row: &rusqlite::Row<'_>) -> Result<StoredBlock> {
    Ok(StoredBlock {
        entity_id: row.get(0)?,
        block_uid: row.get(1)?,
        block_type: row.get(2)?,
        json: row.get(3)?,
        parent_id: row.get(4)?,
        deleted: row.get::<_, i64>(5)? != 0,
        deleted_at: row.get(6)?,
        prev_parent: row.get(7)?,
        prev_index: row.get(8)?,
        is_object: row.get::<_, i64>(9)? != 0,
        object_name: row.get(10)?,
        created: row.get(11)?,
        modified: row.get(12)?,
        content_text: row.get(13)?,
        tags_text: row.get(14)?,
        properties_text: row.get(15)?,
        block_refs_json: row.get(16)?,
        block_backrefs_json: row.get(17)?,
        object_refs_json: row.get(18)?,
        object_backrefs_json: row.get(19)?,
        position: row.get(20)?,
    })
}

fn column_exists(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    let mut statement = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, uid: &str, text: &str) -> StoredBlock {
        StoredBlock {
            entity_id: id.to_owned(),
            block_uid: uid.to_owned(),
            block_type: "text".to_owned(),
            json: format!(r#"{{"entityId":"{id}","blockUid":"{uid}"}}"#),
            parent_id: None,
            position: 0,
            deleted: false,
            deleted_at: None,
            prev_parent: None,
            prev_index: None,
            is_object: id == "root",
            object_name: (id == "root").then(|| "项目 B".to_owned()),
            created: 1,
            modified: 1,
            content_text: text.to_owned(),
            tags_text: "工程,v1".to_owned(),
            properties_text: "状态:进行中".to_owned(),
            block_refs_json: "[]".to_owned(),
            block_backrefs_json: "[]".to_owned(),
            object_refs_json: "[]".to_owned(),
            object_backrefs_json: "[]".to_owned(),
        }
    }

    #[test]
    fn block_json_projection_preserves_native_index_fields() {
        let json = r#"{
          "entityId":"json-root","blockUid":"json00001","type":"text",
          "content":[{"t":"text","v":"原文"}],"parent":null,"children":[],
          "deleted":false,"isObject":true,"objectName":"项目 B",
          "blockRefs":[],"blockBackRefs":[],"objectRefs":[],"objectBackRefs":[],
          "tags":["工程","v1"],"properties":[{"defId":"status","value":"进行中"}],
          "created":10,"modified":11
        }"#;
        let block = StoredBlock::from_block_json(json).expect("valid block json");
        assert_eq!(block.entity_id, "json-root");
        assert_eq!(block.content_text, "原文");
        assert_eq!(block.tags_text, "工程,v1");
        assert!(block.is_object);
        let mut store = SqliteBlockStore::open_in_memory().expect("sqlite");
        store.save_block_json(json).expect("save json");
        assert_eq!(
            store.list_active_json().expect("load json"),
            vec![json.to_owned()]
        );
    }

    #[test]
    fn duplicate_object_names_are_allowed() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let mut a = sample("a", "a0000001", "page-a");
        a.is_object = true;
        a.object_name = Some("未命名页面".to_owned());
        let mut b = sample("b", "b0000001", "page-b");
        b.is_object = true;
        b.object_name = Some("未命名页面".to_owned());
        store.upsert_block(&a)?;
        store.upsert_block(&b)?; // 页面名允许重复：同名页面可以共存（docs/04 §3.1）
        assert_eq!(store.list_active()?.len(), 2);
        Ok(())
    }

    #[test]
    fn migration_is_idempotent_and_crud_round_trips_json() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.migrate()?;
        store.upsert_block(&sample("root", "root00001", "SQLite 数据核心"))?;
        assert_eq!(store.count_all()?, 1);
        assert_eq!(store.count_active()?, 1);
        assert_eq!(
            store.get_block("root")?.unwrap().json,
            r#"{"entityId":"root","blockUid":"root00001"}"#
        );
        assert_eq!(store.search("SQLite")?.len(), 1);
        Ok(())
    }

    #[test]
    fn soft_delete_removes_search_result_and_restore_readds_it() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("root", "root00002", "可恢复 Block"))?;
        store.soft_delete("root", 10)?;
        assert_eq!(store.count_all()?, 1);
        assert_eq!(store.count_active()?, 0);
        assert!(store.search("可恢复")?.is_empty());
        store.restore("root", 20)?;
        assert_eq!(store.count_active()?, 1);
        assert_eq!(store.search("可恢复")?.len(), 1);
        Ok(())
    }

    // ---------- V2c 检索（docs/03 §15.2，行为 SEARCH-GLOBAL-1）----------

    #[test]
    fn search_hits_finds_chinese_substring_inside_a_sentence() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let mut note = sample("n1", "n1000001", "墨契是本地优先的双链笔记");
        note.object_name = None;
        store.upsert_block(&note)?;

        // 子串**不在词边界上**，默认 unicode61 分词器搜不到——trigram 才命中（R09-SEARCH-5 的判据）。
        let hits = store.search_hits("双链笔记", 20)?;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_id, "n1");
        assert_eq!(hits[0].text, "墨契是本地优先的双链笔记");
        assert!(!hits[0].is_object);
        Ok(())
    }

    #[test]
    fn search_hits_falls_back_to_scan_for_short_queries() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("n2", "n2000001", "墨契是本地优先的双链笔记"))?;

        // 两个字：trigram 索引按三字一组，**命中不了**——必须走 instr 兜底（中文两字词太常见）。
        let two = store.search_hits("双链", 20)?;
        assert_eq!(two.len(), 1, "两字查询必须靠兜底通路命中");
        // 一个字也一样（中文单字搜索同样是真实用法）。
        assert_eq!(store.search_hits("墨", 20)?.len(), 1);
        // 空查询不返回任何东西（界面在输入框空着时不该显示一堆结果）。
        assert!(store.search_hits("   ", 20)?.is_empty());
        Ok(())
    }

    #[test]
    fn search_hits_finds_pages_by_name_and_ranks_them_first() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let mut page = sample("p1", "p1000001", "");
        page.is_object = true;
        page.object_name = Some("读书笔记".to_owned());
        page.modified = 5;
        store.upsert_block(&page)?;
        let mut body = sample("b1", "b1000001", "读书笔记里的一条正文");
        body.parent_id = Some("p1".to_owned());
        body.modified = 99; // 更晚修改，但页面命中要排在前面
        store.upsert_block(&body)?;

        let hits = store.search_hits("读书", 20)?;
        assert_eq!(hits.len(), 2);
        assert!(hits[0].is_object, "页面结果排在块前面（界面按它分组）");
        assert_eq!(hits[0].object_name.as_deref(), Some("读书笔记"));
        assert_eq!(hits[0].text, "读书笔记", "页面命中给名字，不给空正文");
        assert_eq!(hits[1].entity_id, "b1");
        Ok(())
    }

    #[test]
    fn search_hits_skips_soft_deleted_blocks() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("d1", "d1000001", "待删除的双链笔记"))?;
        assert_eq!(store.search_hits("双链笔记", 20)?.len(), 1);
        store.soft_delete("d1", 10)?;
        assert!(store.search_hits("双链笔记", 20)?.is_empty());
        Ok(())
    }

    // ---------- V2c 路线 B：拼音（docs/03 §15.2）----------

    #[test]
    fn search_hits_matches_pinyin_and_initials() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("py1", "py100001", "银行里的钱"))?;
        store.upsert_block(&sample("py2", "py200002", "音乐与快乐"))?;
        // 拼音由前端算好写进来（这里模拟「前端回填」这一步）
        store.update_pinyin_index(&[
            ("py1".to_owned(), "yinhang".to_owned(), "yh".to_owned()),
            (
                "py2".to_owned(),
                "yinyueyukuaile".to_owned(),
                "yyykl".to_owned(),
            ),
        ])?;

        // 全拼命中（多音字：银行 → yinhang，不是 yinxing）
        let full = store.search_hits("yinhang", 20)?;
        assert_eq!(full.len(), 1);
        assert_eq!(full[0].entity_id, "py1");
        // 首字母命中
        assert_eq!(store.search_hits("yh", 20)?.len(), 1);
        assert_eq!(
            store
                .search_hits("yyykl", 20)?
                .first()
                .map(|hit| hit.entity_id.clone()),
            Some("py2".to_owned())
        );
        // 中文原文通路不受影响，两者可以同时命中
        assert_eq!(store.search_hits("银行", 20)?.len(), 1);
        // 不相关的拼音不许命中
        assert!(store.search_hits("zhongguo", 20)?.is_empty());
        Ok(())
    }

    /// A2（`13-属性区重规划` §7.1-A2）：检索文本按注册表写成「属性名: 显示值」/ 标签名；
    /// 定义改名之后**立刻**跟上（`set_metadata` 里那条重算）——旧名字不再命中、新名字命中。
    #[test]
    fn search_text_uses_registry_names() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.set_metadata(
            "registry",
            r#"{"properties":[{"id":"status","name":"状态","type":"select","options":[{"id":"o1","label":"进行中"}]}],"tags":[{"id":"tg1","name":"工作"}]}"#,
        )?;
        let json = r#"{"entityId":"p1","blockUid":"p1000001","type":"text","content":[{"t":"text","v":"正文里没有那两个词"}],"properties":[{"defId":"status","type":"select","optionId":"o1"}],"tags":["tg1"]}"#;
        store.save_block_json(json).expect("save json");

        assert_eq!(
            store.search_hits("进行中", 20)?.len(),
            1,
            "选项名可搜——此前索引里只有 optionId，搜不到"
        );
        assert_eq!(store.search_hits("状态", 20)?.len(), 1, "属性名也可搜");
        assert_eq!(store.search_hits("工作", 20)?.len(), 1, "标签按名字命中");

        // 改名：属性名一变，引用它的块要当场重算检索文本
        store.set_metadata(
            "registry",
            r#"{"properties":[{"id":"status","name":"进度","type":"select","options":[{"id":"o1","label":"进行中"}]}],"tags":[{"id":"tg1","name":"工作"}]}"#,
        )?;
        assert_eq!(store.search_hits("进度", 20)?.len(), 1, "改名后新名字命中");
        assert_eq!(
            store.search_hits("状态: 进行中", 20)?.len(),
            0,
            "旧属性名不再命中"
        );
        assert_eq!(store.search_hits("进行中", 20)?.len(), 1, "选项名不受影响");
        Ok(())
    }

    #[test]
    fn upsert_keeps_the_pinyin_columns() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let mut block = sample("py3", "py300003", "银行");
        store.upsert_block(&block)?;
        store.update_pinyin_index(&[("py3".to_owned(), "yinhang".to_owned(), "yh".to_owned())])?;
        assert_eq!(store.search_hits("yinhang", 20)?.len(), 1);

        // 再保存一次（改正文）——FTS 行是「删了重插」，拼音必须活下来（2026-10-04 专门堵的坑）
        block.content_text = "银行与保险".to_owned();
        block.modified = 200;
        store.upsert_block(&block)?;
        assert_eq!(
            store.search_hits("yinhang", 20)?.len(),
            1,
            "保存之后拼音还在（否则每次编辑都会静默失去拼音检索）"
        );
        assert_eq!(
            store.index_status()?.pinyin_indexed,
            1,
            "保存之后「已建拼音」的标记也要还在（否则这个块每次编辑都变成待回填）"
        );
        assert_eq!(store.count_all()?, 1);

        // 软删之后拼音行也一起走（软删会删 FTS 行）
        store.soft_delete("py3", 300)?;
        assert!(store.search_hits("yinhang", 20)?.is_empty());
        Ok(())
    }

    #[test]
    fn index_status_counts_pinyin_coverage() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("py4", "py400004", "银行"))?;
        // 没写过拼音的块不算「覆盖」：回填前 0，回填后跟上 indexed
        assert_eq!(store.index_status()?.pinyin_indexed, 0);
        store.update_pinyin_index(&[("py4".to_owned(), "yinhang".to_owned(), "yh".to_owned())])?;
        let status = store.index_status()?;
        assert_eq!(status.indexed, 1);
        assert_eq!(
            status.pinyin_indexed, 1,
            "拼音覆盖率要如实报（降级要看得见）"
        );
        Ok(())
    }

    /// 2026-10-04 真机验收暴露的坑：**空块（和纯标点块）不是拼音缺口**。
    ///
    /// 旧判据数的是 `pinyin_full <> ''`，于是空块永远算「没建」：设置页长期 3 / 4 像坏了，
    /// 而启动回填的门禁 `pinyinIndexed >= indexed` 永远不成立 ⇒ 每次开机全库重算重写一遍。
    /// 现在判据是「算过没有」（`pinyin_at`），空块照样算覆盖。
    #[test]
    fn empty_blocks_are_covered_not_gaps() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("gap1", "gap10001", "银行"))?;
        store.upsert_block(&sample("gap2", "gap20002", ""))?; // 空块：新页面、正文末尾的落点行
        store.upsert_block(&sample("gap3", "gap30003", "！！！"))?; // 纯标点：拼音算完就是空串
        assert_eq!(store.index_status()?.indexed, 3);

        // 前端回填：三块都送过来（空块的拼音合法地为空串）
        store.update_pinyin_index(&[
            ("gap1".to_owned(), "yinhang".to_owned(), "yh".to_owned()),
            ("gap2".to_owned(), String::new(), String::new()),
            ("gap3".to_owned(), String::new(), String::new()),
        ])?;

        let status = store.index_status()?;
        assert_eq!(
            status.pinyin_indexed, status.indexed,
            "空块/纯标点块也算「算过了」——否则覆盖率永远差几块，启动回填每次开机重跑全库"
        );
        Ok(())
    }

    /// v7 库（有拼音两列、没有 `pinyin_at`）升级：重建索引表后标记列就位，全部算「待回填」。
    #[test]
    fn migration_adds_the_pinyin_mark_column() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("mark", "mark0001", "银行"))?;
        store.update_pinyin_index(&[("mark".to_owned(), "yinhang".to_owned(), "yh".to_owned())])?;

        // 造一个「v7 库」：索引表有拼音列但没有 pinyin_at，版本倒退。
        store.conn.execute_batch(
            "DROP TABLE blocks_fts;
             CREATE VIRTUAL TABLE blocks_fts USING fts5(
                 entity_id UNINDEXED, content_text, tags, properties_text, page_name,
                 pinyin_full, pinyin_initials, tokenize = 'trigram');
             INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text, page_name, pinyin_full, pinyin_initials)
                SELECT entity_id, content_text, tags_text, properties_text, COALESCE(object_name, ''), '', ''
                FROM blocks WHERE deleted = 0;
             DELETE FROM schema_migrations WHERE version >= 8;",
        )?;

        store.migrate()?;

        let status = store.index_status()?;
        assert_eq!(status.indexed, 1, "重建后索引行数不变");
        assert_eq!(
            status.pinyin_indexed, 0,
            "旧库的拼音两列随重建归零，标记为待回填（前端启动时补一次）——不假装已经建好"
        );
        // 回填一次之后就齐了
        store.update_pinyin_index(&[("mark".to_owned(), "yinhang".to_owned(), "yh".to_owned())])?;
        let after = store.index_status()?;
        assert_eq!(
            after.pinyin_indexed, after.indexed,
            "回填之后覆盖率到齐，门禁不会再让全库白跑一遍"
        );
        assert_eq!(store.search_hits("yinhang", 20)?.len(), 1);
        Ok(())
    }

    #[test]
    fn index_status_reports_scale_and_rebuild_time() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("i1", "i1000001", "第一条"))?;
        store.upsert_block(&sample("i2", "i2000002", "第二条"))?;
        let mut gone = sample("i3", "i3000003", "第三条");
        gone.deleted = true;
        store.upsert_block(&gone)?;

        let status = store.index_status()?;
        assert_eq!(status.engine, "fts5-trigram");
        assert_eq!(status.indexed, 2, "已删块不进索引（行数 = 存活块数）");
        assert!(
            status.rebuilt_at.is_some(),
            "迁移时写下重建时间（R09-SET-13 要显示它）"
        );
        assert_eq!(
            status.failures, 0,
            "FTS 与 blocks 同事务写，没有独立失败队列"
        );

        store.soft_delete("i2", 10)?;
        assert_eq!(store.index_status()?.indexed, 1, "软删之后索引规模跟着降");
        Ok(())
    }

    #[test]
    fn migration_rebuilds_index_when_the_old_tokenizer_is_in_place() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("old", "old00001", "墨契是本地优先的双链笔记"))?;

        // 造一个「v5 老库」：把索引换回默认分词器、没有 page_name 列、版本倒退。
        store.conn.execute_batch(
            "DROP TABLE blocks_fts;
             CREATE VIRTUAL TABLE blocks_fts USING fts5(entity_id UNINDEXED, content_text, tags, properties_text);
             INSERT INTO blocks_fts(entity_id, content_text, tags, properties_text)
                SELECT entity_id, content_text, tags_text, properties_text FROM blocks WHERE deleted = 0;
             DELETE FROM schema_migrations WHERE version >= 6;",
        )?;
        // 老索引（unicode61）确实搜不到中文子串——**直接对老表做 MATCH**：这时它连拼音列都没有，
        // 不能走 search_hits（那条 SQL 常驻引用了 f.pinyin_full）
        let legacy_hits: i64 = store.conn.query_row(
            "SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH ?1",
            params!["\"双链笔记\""],
            |row| row.get(0),
        )?;
        assert_eq!(legacy_hits, 0, "老索引确实搜不到中文子串");

        store.migrate()?;

        let hits = store.search_hits("双链笔记", 20)?;
        assert_eq!(hits.len(), 1, "迁移后按 blocks 重建，中文子串能搜到");
        let indexed: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM blocks_fts", [], |row| row.get(0))?;
        assert_eq!(indexed, 1, "重建不重复插入（索引行数 = 存活块数）");
        Ok(())
    }

    #[test]
    fn batch_retry_does_not_overwrite_newer_blocks() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let old = sample("root", "root00003", "old");
        store.commit_batch("batch-1", &[], std::slice::from_ref(&old), &[])?;
        let newer = sample("root", "root00003", "new");
        store.commit_batch("batch-2", &[], std::slice::from_ref(&newer), &[])?;
        store.commit_batch("batch-1", &[], std::slice::from_ref(&old), &[])?;
        let text: String = store.conn.query_row(
            "SELECT content_text FROM blocks WHERE entity_id='root'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(text, "new");
        assert!(store.commit_batch("batch-1", &[], &[newer], &[]).is_err());
        Ok(())
    }

    #[test]
    fn batch_purge_expands_to_children_missing_from_visible_tree() -> Result<()> {
        // D-091：页面进回收站前删掉的子块已经从父块 `children` 里摘掉，但 `parent` 仍指向
        // 页面根。只传根也必须把这类后代一起删，否则自引用外键会让整批回滚。
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("root", "root00003", "original"))?;
        let mut child = sample("child", "child0001", "child");
        child.parent_id = Some("root".into());
        child.deleted = true;
        child.deleted_at = Some(2);
        store.upsert_block(&child)?;
        store.commit_batch("purge", &[], &[], &["root".into()])?;
        assert_eq!(store.count_all()?, 0);
        Ok(())
    }

    #[test]
    fn purge_blocks_expands_soft_deleted_descendants() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("root", "root00003", "original"))?;
        let mut child = sample("child", "child0001", "child");
        child.parent_id = Some("root".into());
        child.deleted = true;
        store.upsert_block(&child)?;
        let removed = store.purge_blocks(&["root".into()])?;
        assert_eq!(removed, 2, "根与软删除子块一起删");
        assert_eq!(store.count_all()?, 0);
        Ok(())
    }

    #[test]
    fn batch_failure_rolls_back_logs_blocks_deletes_and_receipt() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("root", "root00003", "original"))?;
        let log = PersistedTransaction {
            transaction_id: "batch-tx".into(),
            source: "user".into(),
            device_id: "device-a".into(),
            operations: vec![PersistedOperation {
                op_id: "batch-op".into(),
                json: "{}".into(),
            }],
            inverse_json: "[]".into(),
            created: 10,
        };
        assert!(store
            .commit_batch(
                "failed",
                &[log.clone(), log.clone()],
                &[sample("other", "other0001", "new")],
                &["root".into()]
            )
            .is_err());
        assert_eq!(store.count_all()?, 1);
        assert_eq!(store.transaction_count()?, 0);
        assert_eq!(store.oplog_count()?, 0);
        assert!(store
            .commit_batch(
                "failed",
                std::slice::from_ref(&log),
                &[sample("other", "root00003", "conflict")],
                &["root".into()]
            )
            .is_err());
        store.commit_batch(
            "failed",
            &[log],
            &[sample("other", "other0001", "new")],
            &["root".into()],
        )?;
        assert_eq!(store.count_all()?, 1);
        assert_eq!(store.transaction_count()?, 1);
        assert_eq!(store.oplog_count()?, 1);
        let indexed: i64 = store.conn.query_row(
            "SELECT COUNT(*) FROM blocks_fts WHERE entity_id='root'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(indexed, 0);
        Ok(())
    }

    #[test]
    fn transaction_commits_blocks_history_and_oplog_atomically() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let transaction = PersistedTransaction {
            transaction_id: "tx-1".to_owned(),
            source: "user".to_owned(),
            device_id: "device-a".to_owned(),
            operations: vec![PersistedOperation {
                op_id: "op-1".to_owned(),
                json: r#"{"type":"insert"}"#.to_owned(),
            }],
            inverse_json: "[]".to_owned(),
            created: 10,
        };
        store.commit_transaction(&transaction, &[sample("root", "root00003", "原子事务")])?;
        assert_eq!(store.count_all()?, 1);
        assert_eq!(store.transaction_count()?, 1);
        assert_eq!(store.oplog_count()?, 1);
        assert_eq!(
            store.last_transaction(false)?.unwrap().transaction_id,
            "tx-1"
        );

        let failed = PersistedTransaction {
            transaction_id: "tx-failed".to_owned(),
            source: "user".to_owned(),
            device_id: "device-a".to_owned(),
            operations: vec![PersistedOperation {
                op_id: "op-failed".to_owned(),
                json: r#"{"type":"insert"}"#.to_owned(),
            }],
            inverse_json: "[]".to_owned(),
            created: 11,
        };
        assert!(store
            .commit_transaction(&failed, &[sample("other", "root00003", "冲突")])
            .is_err());
        assert_eq!(store.count_all()?, 1);
        assert_eq!(store.transaction_count()?, 1);
        assert_eq!(store.oplog_count()?, 1);

        store.mark_transaction_undone("tx-1", true)?;
        assert!(store.last_transaction(false)?.is_none());
        assert_eq!(store.last_transaction(true)?.unwrap().device_id, "device-a");
        Ok(())
    }

    #[test]
    fn reverse_index_rebuilds_from_forward_refs_and_ignores_deleted_sources() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let mut source = sample("source", "source001", "source");
        source.block_refs_json =
            r#"[{"targetBlockId":"target","fromBlockId":"source","type":"link","context":"ctx"}]"#
                .to_owned();
        source.object_refs_json = r#"["object"]"#.to_owned();
        let mut target = sample("target", "target001", "target");
        target.block_backrefs_json =
            r#"[{"targetBlockId":"wrong","fromBlockId":"wrong","type":"link"}]"#.to_owned();
        let mut object = sample("object", "object001", "object");
        object.is_object = true;
        object.object_name = Some("对象".to_owned());
        object.object_backrefs_json = r#"["wrong"]"#.to_owned();
        store.upsert_block(&source)?;
        store.upsert_block(&target)?;
        store.upsert_block(&object)?;
        assert!(!store.reverse_index_consistent()?);
        assert_eq!(store.rebuild_reverse_index()?, 3);
        assert!(store.reverse_index_consistent()?);
        let rebuilt_target = store.get_block("target")?.unwrap();
        assert!(rebuilt_target.block_backrefs_json.contains("source"));
        let rebuilt_object = store.get_block("object")?.unwrap();
        assert!(rebuilt_object.object_backrefs_json.contains("source"));
        store.soft_delete("source", 100)?;
        store.rebuild_reverse_index()?;
        assert!(store.get_block("target")?.unwrap().block_backrefs_json == "[]");
        assert!(store.get_block("object")?.unwrap().object_backrefs_json == "[]");
        Ok(())
    }

    #[test]
    fn list_active_orders_by_position_then_created() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        let mut second = sample("second", "second001", "second");
        second.position = 2;
        second.created = 1;
        let mut first = sample("first", "first001", "first");
        first.position = 1;
        first.created = 100;
        store.upsert_block(&second)?;
        store.upsert_block(&first)?;
        let ids: Vec<String> = store
            .list_active()?
            .into_iter()
            .map(|block| block.entity_id)
            .collect();
        assert_eq!(ids, vec!["first".to_owned(), "second".to_owned()]);
        Ok(())
    }

    #[test]
    fn list_all_keeps_deleted_blocks_so_the_trash_survives_restart() -> Result<()> {
        // `load_blocks` 走 `list_all`：只回存活块的话，回收站重启后变空、30 天到期清理永远空转
        // （2026-10-03 清单 C 在真实窗口逮到）。这条把「带着已删除的块一起载入」钉住。
        let mut store = SqliteBlockStore::open_in_memory()?;
        store.upsert_block(&sample("alive", "alive001", "活着"))?;
        let mut trashed = sample("trashed", "trash001", "在回收站");
        trashed.deleted = true;
        trashed.deleted_at = Some(123);
        store.upsert_block(&trashed)?;
        assert_eq!(
            store.list_active()?.len(),
            1,
            "存活查询不许把回收站里的带出来"
        );
        let all = store.list_all()?;
        assert_eq!(all.len(), 2, "载入必须带上回收站里的块");
        assert!(all
            .iter()
            .any(|block| block.entity_id == "trashed" && block.deleted));
        assert_eq!(store.list_all_json()?.len(), 2);
        Ok(())
    }

    #[test]
    fn metadata_registry_round_trips_by_key() -> Result<()> {
        let mut store = SqliteBlockStore::open_in_memory()?;
        assert!(store.get_metadata("registry")?.is_none());
        store.set_metadata("registry", r#"{"properties":[],"tags":[]}"#)?;
        store.set_metadata("registry", r#"{"properties":[{"id":"p"}],"tags":[]}"#)?;
        assert_eq!(
            store.get_metadata("registry")?.unwrap(),
            r#"{"properties":[{"id":"p"}],"tags":[]}"#
        );
        Ok(())
    }

    // ---------- 边界电池（2026-10-11，「坏库」这一类；用户问「坏库极端测试写完整了吗」的答卷）----------

    /// 临时目录（照 `sync_files.rs` / `backup.rs` 的写法：同一进程内唯一、开头先清）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("moqi-storage-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 边界电池①：**v1 老库整链升到当前版本**——没有 content_text/tags_text/properties_text、没有 position 列、
    /// 也没有索引表。`open` 之后必须：版本到顶、position 回填为 created、老块的正文**能搜到**
    /// （这一条同时证明 v4 补列 → v6/v7/v8 重建索引 → A2 的 search-text 回填整条链都跑到了）。
    #[test]
    fn migrates_a_v1_style_library_all_the_way_to_current() -> Result<()> {
        let dir = temp_dir("migrate-v1");
        let path = dir.join("project-b.sqlite3");
        {
            let conn = Connection::open(&path)?;
            conn.execute_batch(
                "CREATE TABLE blocks (
                    id INTEGER PRIMARY KEY,
                    entity_id TEXT NOT NULL UNIQUE,
                    block_uid TEXT NOT NULL UNIQUE,
                    block_type TEXT NOT NULL,
                    json TEXT NOT NULL,
                    parent TEXT,
                    children TEXT NOT NULL DEFAULT '[]',
                    collapsed INTEGER NOT NULL DEFAULT 0,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    deleted_at INTEGER,
                    prev_parent TEXT,
                    prev_index INTEGER,
                    block_refs TEXT NOT NULL DEFAULT '[]',
                    block_backrefs TEXT NOT NULL DEFAULT '[]',
                    object_refs TEXT NOT NULL DEFAULT '[]',
                    object_backrefs TEXT NOT NULL DEFAULT '[]',
                    is_object INTEGER NOT NULL DEFAULT 0,
                    object_name TEXT,
                    tags TEXT NOT NULL DEFAULT '[]',
                    properties TEXT NOT NULL DEFAULT '[]',
                    created INTEGER NOT NULL,
                    modified INTEGER NOT NULL
                );
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations(version, applied_at) VALUES (1, 0);
                INSERT INTO blocks(entity_id, block_uid, block_type, json, children, created, modified)
                    VALUES ('old1', 'old00001', 'text',
                        '{\"entityId\":\"old1\",\"blockUid\":\"old00001\",\"type\":\"text\",\"content\":[{\"t\":\"text\",\"v\":\"墨契是本地优先的双链笔记\"}],\"parent\":null,\"children\":[],\"collapsed\":false,\"checked\":false,\"deleted\":false,\"properties\":[],\"tags\":[],\"created\":7,\"modified\":7}',
                        '[]', 7, 7);",
            )?;
        }

        let store = SqliteBlockStore::open(&path)?;
        let version: i64 =
            store
                .conn
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get(0)
                })?;
        assert_eq!(version, SCHEMA_VERSION, "整链升到当前版本");
        // 迁移链实测得到一个**已知瑕疵**（台账 `D-060`）：A2 的 search-text 回填会用
        // `from_block_json` 重写每一行，而 v1 时代的 JSON 里没有 `position` 键 ⇒ serde 默认 0 会把
        // 「position 回填为 created」覆盖成 0。**实际影响 ≈ 0**：排序退到 created 兜底键，而回填的
        // 目标值本来就是 created；且 1.0 前没有已发布的老库（用户 2026-10-11：老库走廊 1.0 前不做）
        // ⇒ 不动迁移代码，只把真实行为钉在这里。
        assert_eq!(store.get_block("old1")?.expect("老块还在").position, 0, "A2 回填覆盖了 position 那一步（D-060 已记录，不改代码）");
        assert_eq!(store.list_active()?.len(), 1, "老块照常在活跃列表里（顺序由 created 兜底）");
        // 用 **4 字查询**（走 FTS 主路）：2 字短查询的 `instr` 降级是 `search_hits` 那条路的专门用例
        // （`search_hits_falls_back_to_scan_for_short_queries`），不在本电池的射程里。
        assert_eq!(
            store.search("双链笔记")?.len(),
            1,
            "升完就能按正文搜到（v6/v7/v8 索引重建 ＋ A2 search-text 回填整条链都跑到了）"
        );
        assert_eq!(
            store.get_block("old1")?.expect("老块还在").content_text,
            "墨契是本地优先的双链笔记",
            "content_text 由 A2 回填"
        );
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    /// 边界电池②：库文件**不是 SQLite**（或截断）时，`open` 干净报错——不许 panic、不许半开。
    /// 这正是桌面「载入失败屏」（`LOAD-RECOVER-1`）接住的那种输入。
    #[test]
    fn opening_a_garbage_or_truncated_file_fails_cleanly() -> Result<()> {
        let dir = temp_dir("garbage");
        let garbage = dir.join("garbage.sqlite3");
        std::fs::write(&garbage, b"not a database at all, just some bytes").expect("写垃圾文件");
        assert!(
            SqliteBlockStore::open(&garbage).is_err(),
            "非 SQLite 文件 → Err（界面进失败屏，不许崩）"
        );

        let truncated = dir.join("truncated.sqlite3");
        {
            let mut store = SqliteBlockStore::open(&truncated)?;
            store.upsert_block(&sample("a", "a0000001", "正文"))?;
        }
        let bytes = std::fs::read(&truncated).expect("读库");
        std::fs::write(&truncated, &bytes[..512]).expect("截断到 512 字节（不足一页）");
        assert!(
            SqliteBlockStore::open(&truncated).is_err(),
            "截断的库 → Err，不 panic"
        );
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    /// 边界电池③：blocks 表里混入**解析不了的 JSON 行**——存储侧原样读出、不崩；
    /// 「怎么处置」归界面：TS 侧 fail-closed（`test:LOAD-TOLERANT-1` 的坏行那半条）→ 失败屏给恢复出路。
    #[test]
    fn list_all_returns_broken_json_rows_verbatim() -> Result<()> {
        let store = SqliteBlockStore::open_in_memory()?;
        store.conn.execute(
            "INSERT INTO blocks(entity_id, block_uid, block_type, json, children, created, modified)
             VALUES ('bad', 'bad00001', 'text', '{oops', '[]', 1, 1)",
            [],
        )?;
        let rows = store.list_all()?;
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].json, "{oops",
            "坏行原样交出去——存储层不替界面做决定"
        );
        Ok(())
    }
}
