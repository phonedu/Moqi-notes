# AI 逻辑测试报告（L4，自动生成）

> 由 `app/tests/logic/ai.contract.test.ts` 自动生成，请勿手工编辑。命令：`pnpm test` 或 `UPDATE_AI_SNAPSHOT=1 pnpm test`。

## 当前行为

| 样本 | 场景 | 输入 Blocks | 总结条数 | 行动项条数 | 状态 |
|---|---|---|---|---|---|
| 01_short | 正常路径：单段短文本 | 1 | 1 | 1 | complete |
| 02_medium | 正常路径：多段结构化内容 | 3 | 1 | 3 | complete |
| 03_conflict | 困难场景：同一主题存在互相矛盾的陈述，必须保留而不能静默择一 | 2 | 1 | 2 | complete |
| 04_timespan | 困难场景：内容跨度较长，来源需逐段可追踪 | 3 | 1 | 3 | complete |
| 05_isolated | 边界样本：单条孤立内容，模型未给出置信度时应降级而非伪装确定 | 1 | 1 | 1 | complete |
| 06_overlong | 边界样本：超长文本，验证不截断来源且来源标注完整 | 5 | 1 | 5 | complete |
| 07_missing | 边界样本：没有可用来源内容，AI 调用必须是安全 no-op | 0 | 1 | 0 | complete |

## 契约检查表

- [x] 每段结果可溯源到来源素材（`aiMeta.sourceBlockIds` 非空且属于输入来源）
- [x] 不发明素材之外的内容（结果文本是来源文本的子串）
- [x] 原文与根级结构保持不变
- [x] 总结 = 单个 `text`；行动项 = 多个连续 `todo` 且 `checked=false`
- [x] 矛盾样本保留两种陈述
- [x] 低置信度 / 来源不足降级为 `needs-confirmation`
- [x] 失败或来源缺失时不产生结果、不改原文

## 快照

`app/fixtures/snapshots/ai_golden.snapshot.json` 与本次运行输出一致。

## 变更历史

- 2026-09-24：首次建立，覆盖 7 条黄金样本与上述契约。
