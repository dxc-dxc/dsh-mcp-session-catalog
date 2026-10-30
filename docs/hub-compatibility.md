# Hub 兼容性说明

本文描述 v2.5 的[批准合同](approved-plan-v2.5.md)、配置和迁移要求。当前实施是否完成、哪些验证已执行，以[验证与发布前事项](验证与发布前事项.md)及 Lead 集成结果为准。本文不代表已修改任何用户 profile 或 Magpie 设置。

## 兼容范围

原独立 stdio 模式保留。Hub 模式只为 Library 中分配给 DSH、实际由 Hub 提供的逻辑服务增加会话按需授权与互斥控制，保持原 `mcp_catalog` / `mcp_load` / `mcp_refresh` 调用形状。

Magpie 可以让 DSH 与其他客户端共用同一后端。该共享是正常工作方式，不应停掉其他客户端、改变服务全局分配或关闭 Magpie 全局 Hub 开关来实现本插件迁移。保证范围限于本插件受管 DSH Host；外部客户端通过同一 Hub 使用后端不属于重复直连。

Hub 的首次 tools/list 可能连接分配给 DSH 的多项服务，不能承诺加载一个逻辑服务只启动一个后端。插件控制会话工具授权与受管 DSH 直连互斥，后端启动粒度由 Magpie 管理。

## 冻结的管理器配置

```text
magpieHub: {
  enabled: true,
  libraryFile: '<path>',
  ownershipDir: '<shared path>',
  entryId?: '<effective Loader id>',
  url?: '<manual/test Hub URL>',
  headers?: {...},
  serverName?: 'magpie'
}
```

上段是字段合同示意，不是 JSON。可解析对象见[Hub 配置样例](../examples/hub.config.example.json)。只支持上述 `magpieHub` 表面字段，不自行增加 group、独立后端 session 开关或另一个归属目录字段。

| 字段 | 含义与约束 |
| --- | --- |
| `enabled` | 显式为 `true` 才启用 Hub 适配；缺失整个 `magpieHub` 或 `enabled: false` 保留旧独立模式 |
| `libraryFile` | Magpie Library 本地路径；默认本机 `~/.config/magpie/library.json`。示例显式使用占位路径 |
| `ownershipDir` | 所有受管 DSH Host 共同使用的归属与迁移屏障目录；测试使用隔离临时目录 |
| `entryId` | 可选，显式绑定有效 Loader Hub 条目 ID；须核对合成后的实际条目身份 |
| `url` | 可选，显式手动或测试 Hub 端点来源；同 URL 若已有官方条目，仍须接管并阻止其双开 |
| `headers` | 可选，Hub HTTP 请求头；示例不含凭据，禁止在日志、普通目录缓存或报告中输出实际认证值 |
| `serverName` | 可选，Hub 物理入口名，默认 `magpie`；不是 `mcp_load` 的业务逻辑服务名 |

未指定 `entryId` 时，只识别真实 Magpie `/mcp/magpie/hub/dsh` 入口，不能根据任意 HTTP 条目或服务名相似就接管。普通 HTTP MCP 不因此变成受管 Hub，也不增加原独立模式的通用 HTTP 支持。

`magpieHub` 属于管理器配置；独立连接 JSON 继续只管理 stdio 定义。文档样例不是可直接覆盖用户配置的完整 profile。Loader override 会替换完整 `config`，人工迁移时必须保留该条目需要的其余配置。

## Library 与按需快照

[Library 样例](../examples/magpie-library.example.json)保留实际格式的最小形状：顶层 `mcpHub: true` 和 `mcp` 数组；服务包含 `name`、来源定义、`agents: ['dsh']`、`disabledTools`。样例中的路径和命令均为占位，不含 env 凭据。

插件只提取必要源身份、分配和禁用信息，不把 Library 的后端 command/env 复制为新的直连。仅在明确归属于 Hub 时接管；未知状态只封禁**曾被本 Library 管理过**的服务名，不会被用来整体封禁无关的独立 stdio 服务。

### 降级边界

| 情况 | Hub 路径 | 独立 stdio 路径 |
| --- | --- | --- |
| Library 不存在（从未安装或从未运行 Magpie） | 不认领任何服务，不发起网络 | 正常，`mcp_catalog` 提示 Library 未找到 |
| Library 存在但解析失败 | 保留上次可信归属并停止新授予 | 上次可信名单内仍封锁；其余服务正常 |
| Library 中 `mcpHub` 为 false | 无 Hub 逻辑服务；提示 Hub 已关闭 | 正常 |
| 归属目录锁被其他 Host 占用或残留 | 拒绝准入并说明原因 | 未认领的服务正常；残留锁超过回收窗口后自动回收 |

Hub 侧异常只降级 Hub 路径，不连带让 `mcp_catalog` / `mcp_load` / `mcp_refresh` 对独立服务失效。

启动、catalog、resume 读取本地元数据与已有缓存；只在显式 load / refresh 时取得 Hub 工具快照。监听文件变更并在操作前重读，不进行高频网络轮询。目录新项对现有会话不自动授权；明确删除、取消 DSH 分配或禁用工具时撤权。读取失败、离线、超时或部分工具列表保留最后可信归属，不当作删除。

缓存工具清单不等于当前授权或当前后端活动状态。端点与认证代际变化使旧连接退役；schema 和原始名映射变化使旧租约退役。完整 Hub 原始工具名由适配器保存；不得从公开短名、截断名或 `mcp__...` 格式反向猜测调用目标。

## 会话授权与生命周期

| 场景 | 预期行为 |
| --- | --- |
| 启动、catalog、resume | Hub 网络请求数为零，无 initialize/list/ping/健康检查，无业务工具注册 |
| `mcp_load({server: 'obsidian'})` | 先验证迁移屏障，再按需连接和发现，只授予该会话的 obsidian 工具 |
| `mcp_refresh({server: 'obsidian'})` | 可以唤醒 Hub，更新工具快照，不授予业务工具 |
| 卸载、归档或轮次回收 | 撤销本会话租约、释放本插件引用，不撤销其他会话或客户端的使用 |
| 最后引用和在途请求结束 | 关闭本插件 HTTP 客户端，不停止 Hub/backend，不默认 terminateSession |
| Hub 错误或状态不明 | 报告失败或 blocked，绝不自动创建同一服务的直连 |

`sharing: shared` 仍是独立模式默认。独立模式 `session` 是独立子进程选项；Hub 模式使用共享 backend，不能声称相同选项能实现 Hub 会话、进程或业务状态隔离。Magpie 的约 10 分钟空闲回收由 Hub 管理，列表读取和其他客户端使用均可能影响计时，不等于 DSH 卸载后独立进程已经退出。

Hub 当前转发能力为 tools。本文不宣称 resources / prompts 支持、硬实时工具变更通知，或修改 Magpie 使每项后端单独冷启动。Hub 业务调用不自动重放，避免对已提交写操作重复执行；独立 stdio 原只读重试策略不变。

## 迁移预检与步骤

以下是交付时供人工在隔离环境执行的清单。本次文档任务不执行 profile 写入、安装、发布或真实业务服务启动。

### 预检

- 备份待迁移 profile 的有效配置，并只在本地安全位置保存必要凭据；不要把真实配置复制进公开样例或报告。
- 确认使用已集成验收的 v2.5 包，实际版本、运行时/Gate 导出和打包文件一致，依赖可从声明解析。
- 枚举所有受管 DSH Host 及官方 Hub 条目，包括旧运行进程、预设内条目和手动重复定义。无法确认旧 Host 状态时先停止迁移，保留 blocked。
- 确认所有受管 Host 使用同一个 `ownershipDir`，权限和可见性一致；隔离测试使用独立目录，不与生产混用。
- 核对 Library 的 DSH 分配、Hub 入口及所有 Hub 归属服务，包含本次不准备加载的服务。明确区分共享 Hub 客户端与受管 DSH 直连。
- 核对 Gate 的先行挂载与受控重启方式。既有会话已接受的工具快照不能仅靠 pre-step 回调追溯撤销。

### 执行顺序

1. 暂停受管 Host 的新会话准入和受影响会话推进，完成旧进程、既有会话与工具快照的清点。
2. 在隔离配置中先挂载 Gate，再启用 v2.5 管理器配置；官方 Hub 入口由 Gate/管理器受控接管，不能让官方常驻连接与适配器同时连接。不要仅修改一项服务就视为迁移完成。
3. 发布归属代际，阻止全部 Hub 归属直连的新调用与重试，等待在途请求结束、工具注销和直连进程退出。收齐所有受管 Host 的清退确认；不明状态保持 blocked，不删除未知旧进程记录来绕过屏障。
4. 在受控重启后的新会话读取 catalog，并触发恢复流程；验证仍无 Hub initialize/list/ping/健康检查、无业务工具暴露。此时可读取本地 Library，但不能探测网络来证明静默。
5. 显式 refresh 或 load 一个逻辑服务，确认首次 Hub 请求晚于**全体**清退确认。refresh 不授权；load 只给调用会话授权。检查第二会话和其他逻辑服务均未获得工具。
6. 验证卸载、撤权、目录变更、Hub 离线和未知 Host 场景。错误保持 Hub 归属或 blocked，不启用同一服务直连；确认其他客户端共用 Hub 后端仍可正常工作。
7. 由 Lead 审查时间轨迹和未验证边界后再决定用户 profile 部署。Gate 自身升级同样要暂停准入并受控重启；管理器热重载须保留 Gate。

出现失败时，保留最后可信归属和诊断，暂停相应准入与调用。若要恢复原独立部署，必须作为一次显式人工迁移，先确认受管 Hub 客户端与工具已退出、无冲突后再调整配置；不能把 Hub 故障转化为自动直连回退。

## 验收证据要求

只看最终工具列表不足以证明无双启。需记录直连初始化/退出、Hub 网络请求提交、工具注册/注销、迁移代际与 Host 清退确认的时间轨迹，断言直连与 Hub 活动区间无重叠。新增测试仅用假后端和真实 DSH 基础模块；真实 Magpie 与有状态服务业务另列待验收，不把文档或本地 JSON 解析结果当作运行验证。
