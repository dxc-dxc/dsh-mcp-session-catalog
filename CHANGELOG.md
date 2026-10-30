# Changelog

本插件的版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [2.5.0] - 2026-10-30

会话级按需管理扩展到 Magpie Hub，同时保持原有独立 stdio 管理路径不变。

### Added

- **Magpie Hub 兼容**：Library 中分配给 `dsh`、且由 Hub 实际提供的 MCP 作为逻辑服务进入目录，`mcp_load({server: 'obsidian'})` 只向调用会话授予该服务的工具；`mcp_refresh` 更新快照但不授权。
- **Hub 接入初始静默**：启动、`mcp_catalog`、会话恢复都不建立 HTTP 连接，不发送 `initialize` / `tools/list` / `ping` / 健康探测；仅显式 `mcp_load` / `mcp_refresh` 唤醒。
- **Hub 优先与零双启**：同一逻辑服务由 Hub 承接时直连路径被禁止；首次 Hub 请求之前，通过共享归属目录协调所有受管 Host 清退全部 Hub 归属直连；Hub 故障不回退直连，也不自动重放业务调用。
- **跨 Host 迁移屏障**：`ownershipDir` 记录每个 Host 的期望归属、直连令牌与确认代际；未知或未确认的参与者使 Hub 准入保持 blocked，而不是猜测安全。
- **独立 Gate 入口**：新增 `@dxc-dxc/dsh-mcp-session-catalog/hub-gate`，在会话准入时建立持续作用域限制，装配期校验 native 与 PTC 声明，执行前复核租约与来源代际。
- **`v2_5` 运行时导出**：新增 `./v2_5` 入口；`./v2_4` 保留，旧补丁无需改动即可继续工作。
- **可选 Hub 接管片段**：`examples/cordis.hub-takeover.patch.yml` 提供显式接管写法；bundle 默认补丁不再隐式关闭任何官方条目。

### Fixed

- Library 文件不存在或解析失败时，原先会封禁**全部**独立 stdio 服务；现在只封禁本 Library 现在或上次可信快照中出现过的服务名。
- Hub 归属锁或回收失败会连带使 `mcp_catalog` / `mcp_load` / `mcp_refresh` 对独立服务失效；现在 Hub 异常只降级 Hub 路径并在目录中告警。
- Host 崩溃留下的归属锁永不回收，导致后续每次调用阻塞 5 秒且无法恢复；现在锁内记录持有者 pid，超过回收窗口且持有者已消亡时自动回收，等待上限降为 1.5 秒，并给出可直接处置的错误信息。
- 服务从 Library 移除后仍被本 Host 永久封禁；现在成功读取会整体替换可信名单，服务可回到独立流程。
- 单条 Hub 工具名映射歧义会让整次发现失败；现在只阻塞涉及的逻辑服务，其余服务继续可用，并在目录中列出原因。
- Gate 被 HMR 释放后无法恢复，只能重启 Host；现在会重建 Gate，运行中会话不再阻止挂载。
- 进程存活性探测遇到 `EPERM` 等非 `ESRCH` 结果时立即失败；现在重试至截止时间并保留最后一次原因。

### Changed

- 文档补充降级边界表：Library 缺失 / 解析失败 / Hub 关闭 / 锁被占用时，Hub 路径与独立路径各自的预期行为。
- `package.json` 发布清单纳入 `CHANGELOG.md` 与 `examples/*`（含接管补丁片段）。

### Verified

- `node test/run.mjs`：9 个套件、72 项断言全部通过（55 项既有权回归 + 17 项 Hub 契约／跨 Host 互斥／真实 AgentLoop 断言）。
- 专项探针覆盖：Library 四种状态、残留锁自愈、服务移出后的反向迁移、服务级映射阻塞、Gate 重建。

### Known limitations

- Hub 首次 `tools/list` 可能启动分配给它的一整组后端，无法只启动当前选择的服务。
- 只代理 tools，不转发 resources / prompts；Hub 侧工具列表预算约 40 秒、业务调用约 50 秒。
- 会话工具隔离不等于 Hub 后端状态或进程隔离；需要独立后端的服务应继续使用独立 stdio 的 `session` 模式。
- 不保证 Gate 被手动卸载或任意外部插件绕过时仍有隔离效果；会话已被接受的工具快照无法回溯撤回。

## [2.4.0] - 2026-10-27

- 按会话授予工具、同 Host 共享连接池、配置热重载、按轮次与归档回收。
- 原生 DSH Loader 发现：只接管自身 `disabled: true` 的官方 stdio 条目；启用中的官方客户端不重复启动。
- 进程组清理（`SIGTERM` → 2 秒后 `SIGKILL`）、只读调用的有限重试、写调用不重试、结果截断与嵌入资源文本保留。
