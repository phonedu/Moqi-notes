# 架构一览

墨契是 Tauri 2 + React 19 + SQLite 的桌面 / Android 应用。编辑器内核已抽成独立 workspace 包。

```
apps 布局
├─ app/                     # 产品壳（Tauri 应用；UI / 平台适配 / AI 适配器）
│  ├─ src/application/      # 领域店（事务、撤销栈、同步引擎调度）
│  ├─ src/adapters/         # 平台端口实现（Tauri 命令 / 浏览器降级双通道）
│  ├─ src/ui/               # 产品 UI（页面库 / 设置 / 编辑区装配 / 触控层已入包）
│  └─ src-tauri/            # Rust：SQLite 存储 / 备份快照 / SAF 导入导出 / 同步文件交换
├─ packages/editor/         # @moqi/editor —— 编辑器包（可复用）
│  ├─ src/domain/           # 纯 TS 领域层：Block 模型 / 树操作 / 校验自愈 / Markdown 双向 / 双链
│  ├─ src/editor/           # Lexical 装配：输入规则 / 名字行接缝 / 格式状态 / 宿主契约 / MoqiEditor
│  ├─ src/touch/            # 触控交互层：手势路由 / 格式栏 / 块胶囊 / 选择栏 / 放置线 / 键盘高度
│  └─ tests/                # 包内测试
├─ docs/                    # 公开文档（本目录）
└─ website/                 # 官网静态页
```

## 分层规则（有测试看门）

- **domain 不碰内核**：`domain/` 是纯 TypeScript，无 React、无 Lexical、无平台 API
- **ui 不直连 Lexical**：所有内核访问经 `packages/editor` 的公开出口；边界测试扫描强制
- **编辑器只认宿主契约**：`EditorHost.storage`（load/save 块快照）是唯一必需端口；内存宿主开箱即用
- **平台双通道**：每个平台能力（剪贴板 / 文件对话框 / 资产存储）都有「Tauri 原生 + 浏览器降级」两条实现，界面按能力如实启用

## 关键契约

- **页面名 = 正文第一行**：无独立标题控件，名字是派生索引（改名 = 改那一行）
- **一切写入走事务**：领域店 applyTransaction 统一重算派生索引；撤销 = 事务回退
- **落盘 = 快照**：编辑器只读写整份块快照（200ms 防抖 + 串行队列），存储层负责合批与外键一致性
- **同步 = 块级合并**：本地目录 oplog 交换，后写者胜，批次整体失败回滚

## 数据模型速览

`Block = { entityId, blockUid, type, content(片段), parent, children, position, checked, deleted, properties, tags, blockRefs, objectRefs, aiMeta, ... }`——单一结构承载全部块类型；给 Block 加可选字段不需要存储迁移（整行 JSON 存储）。

详见 `packages/editor/src/domain/README.md` 与各模块头注释（代码即真相）。
