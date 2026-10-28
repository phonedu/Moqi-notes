# Tauri 原生层

这里是墨契的桌面壳和 SQLite 适配层。前端通过 Port 和 Tauri command 访问它，业务规则仍由 TypeScript domain 层负责。

## 负责的事情

- 在系统应用数据目录创建和打开 `project-b.sqlite3`。
- 执行 schema 迁移，目前版本为 4。
- 保存 Block JSON、同级 position、软删除状态和 metadata 注册表。
- 处理批量快照、事务历史、oplog 和反向引用所需的数据读写。
- 暴露 `load_blocks`、`save_blocks`、`data_directory` 等 command。

## 不负责的事情

Rust 层不解析 Lexical EditorState，不决定 Enter 如何拆分，不实现 Tab 的产品语义，也不直接决定 AI 结果。它只保存领域层已经校验过的数据，并保证迁移和写入的原子性。

## 数据约束

Block JSON 是跨前端和桌面端的共同格式。历史数据在 TypeScript 解析边界补默认值；Rust 保持未知 JSON 字段的兼容性。删除采用软删除，恢复由领域层给出原父级和位置。

## 测试

`cargo test` 覆盖迁移幂等、Block CRUD、position 排序、metadata 往返、软删除/恢复、transaction 原子性和 refs 重建。
