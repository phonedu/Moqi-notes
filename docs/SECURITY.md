# 安全策略

## 威胁模型与边界

墨契是**本地优先**应用：数据只存你自己的机器与你自己配置的同步目录，无账号、无遥测、无服务器。

- AI 功能需要你自己填 API key（OpenAI 兼容接口），key 存本机配置，不经过任何第三方
- 导入的包 / Markdown 按文本解析，不执行代码
- 外部链接经系统浏览器打开

## 已知加固项（公开 v0.6.1 现状）

- Tauri 已配置构建态最小 CSP（脚本 self / 连接限 IPC 与 https 及本地端口 / 图片限 asset 协议；见 `app/src-tauri/tauri.conf.json`）
- 桌面构建未做代码签名（Windows SmartScreen 会提示）

## 报告漏洞

**请勿公开提交安全漏洞。** 用 GitHub 的 [Private vulnerability reporting](../../security/advisories/new) 私密报告；48 小时内确认，修复后署名致谢（可匿名）。

## 支持范围

只支持最新发布 tag 的安全修复。
