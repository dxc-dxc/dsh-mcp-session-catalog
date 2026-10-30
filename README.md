# dsh-mcp-session-catalog

DeepSeek Harness（DSH）会话级按需 MCP 管理插件。独立 stdio 服务按需启动、同 Host 复用连接，并按会话轮次回收；v2.5 增加 Magpie Hub 兼容，将 Hub 逻辑服务的工具按需授予当前会话。

> v2.5 已完成实现与集成验收：9 个套件、72 项断言全部通过，覆盖原独立路径回归、Hub 契约、跨 Host 互斥与真实 AgentLoop 装配。变更明细见 [CHANGELOG](CHANGELOG.md)，证据与未验证范围见[验证与发布前事项](docs/验证与发布前事项.md)。

## 两种来源，保持原有管理接口

| 要求 | 独立 stdio 服务 | Magpie Hub 逻辑服务 |
| --- | --- | --- |
| 初始状态 | 不启动受管子进程，不注册业务工具 | 不连接 Hub，不注册业务工具 |
| 目录与恢复 | 查询目录不启动服务；恢复后按需重载 | 启动、`mcp_catalog`、resume 均不发送 initialize、list、ping 或健康检查 |
| 显式加载 | `mcp_load` 冷启动或复用连接，仅向当前会话授权 | `mcp_load` 连接 Hub 并读取按需快照，仅授权所选逻辑服务 |
| 后端共享 | 默认 `sharing: shared`；可显式用 `session` 创建独立进程 | 使用 Magpie 共享后端；会话工具隔离不代表后端状态或进程隔离 |
| 同一服务有重复定义 | 非 Hub 服务沿用原接管规则 | Hub 优先；禁止直连与 Hub 双启、双份工具和自动直连回退 |

旧配置没有 `magpieHub`，或设置 `magpieHub.enabled: false`，仍使用原独立模式。`servers` / `serversFile`、Loader 发现、表达式、`excludedServers`、共享与 session、20 轮及覆盖、归档、取消、只读重试、文本结果与在途保护的接口保留。详细边界见[功能说明](docs/功能说明.md)。

## 独立模式配置

使用 Host 有效 Loader 配置树发现服务时，需由插件接管的官方 stdio 条目必须自身明确设置 `disabled: true`。它保留连接定义，并关闭官方客户端的常驻连接；父级停用或条件式停用不等于这一接管约定。

```yaml
- insert:
    - id: mcp-session-catalog
      name: '@dxc-dxc/dsh-mcp-session-catalog/v2_5'
      config:
        inactiveTurnsThreshold: 20
        scanDshProfile: true
    - id: mcp-example
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        transport: stdio
        serverName: example
        command: node
        args: ['/path/to/example-server.mjs']
        sharing: shared
```

`v2_4` 保留为兼容入口，旧补丁可原样继续工作；新安装使用 `v2_5`。Hub 模式还需要按[可选接管片段](examples/cordis.hub-takeover.patch.yml)显式启停官方 Hub 条目，并核对 Library 中该服务确实分配给 `dsh`。

也可将[独立连接样例](examples/servers.example.json)复制到自己的配置目录，再把管理器配置中的 `serversFile` 指向副本。手动 `servers` / `serversFile` 默认关闭原生扫描，显式组合来源时不得重复定义同一独立服务。示例路径均为占位符，不附带可用服务或凭据。

## Hub 模式配置

冻结的管理器配置样例见[Hub 配置样例](examples/hub.config.example.json)。配置对象的关键部分为：

```json
{
  "magpieHub": {
    "enabled": true,
    "libraryFile": "/path/to/magpie/library.json",
    "ownershipDir": "/path/to/shared/dsh-mcp-ownership"
  }
}
```

`ownershipDir` 必须由所有受管 DSH Host 共同使用。可选字段为 `entryId`、`url`、`headers`、`serverName`；字段语义和入口识别限制见[Hub 兼容性说明](docs/hub-compatibility.md)。不要把 `magpieHub` 放进独立连接文件的 `servers` 数组，也不要为每个 Hub 逻辑服务复制 command、env 或认证信息。

本地 Library 提供服务身份与 DSH 分配，按需 Hub 工具快照提供可用工具；[Library 形状样例](examples/magpie-library.example.json)仅用于理解和隔离测试，不能覆盖真实 Library。新增目录项不自动扩大已有会话权限；目录缓存也不是执行授权。

首次 Hub 网络请求可能启动分配给 DSH 的其他后端。因此，在发送任何 Hub 请求前，必须清退**全部 Hub 归属服务**的受管 DSH 直连，等待在途请求结束、旧工具注销和进程退出，并完成跨 Host 迁移屏障。任何状态不明均保持 `blocked`。迁移前按[迁移预检与步骤](docs/hub-compatibility.md#迁移预检与步骤)执行。

Magpie 全局 Hub 开关保持原样，其他客户端共用同一 Hub 后端属于正常共享。本插件只管理自己的 HTTP 客户端和会话授权；卸载或回收不会停止 Magpie Hub 或强停共享后端。

## 使用

管理工具仍按逻辑服务名调用，无需 `group` 参数。

| 调用 | 作用 |
| --- | --- |
| `mcp_catalog({})` | 查看本地目录、缓存和当前会话状态；不唤醒 Hub |
| `mcp_load({server: 'obsidian'})` | 显式加载该逻辑服务，工具从下一模型步骤起可见 |
| `mcp_refresh({server: 'obsidian'})` | 显式唤醒并更新该服务工具快照，不授予业务工具 |
| `mcp_refresh({})` | 显式刷新已配置服务；可能访问 Hub 及启动其已分配后端 |
| `mcp_load({server: 'obsidian', action: 'unload'})` | 撤销当前会话的工具并释放引用，其他会话不受影响 |

独立示例中的服务名是 `example`；上表中的 `obsidian` 需要真实 Library 已分配给 DSH。不要从公开工具名反推 Hub 原始工具名，映射由适配器保存。Hub 离线、超时或迁移失败应报告原始失败类别并处理，不得自动改走同一服务的直连。

默认连续 20 个完成轮次未调用时回收租约；服务级阈值可覆盖。独立服务的 `sharing: session` 仍创建独立后端进程；Hub 不提供这一隔离承诺。Magpie 的后端空闲约 10 分钟回收由 Hub 自己管理，其他客户端访问和列表访问都可能影响其活动状态。

## 安装与验证

从 GitHub 安装到某个 profile：

```bash
dsh plugin --profile <profile> add github:dxc-dxc/dsh-mcp-session-catalog
```

bundle 默认补丁只插入管理器（`v2_5`，20 轮回收 + Loader 扫描），不改动其他插件的 MCP 条目。要让插件接管 Magpie Hub，把 [examples/cordis.hub-takeover.patch.yml](examples/cordis.hub-takeover.patch.yml) 中的三条语句合并进该 profile 的 patch 层；合并前先确认官方条目 id 在该 profile 的组合配置中确实存在，且没有第二处插入 `mcp-session-catalog`。

安装后按顺序验证：

1. `mcp_catalog` 能列出预期服务；未加载时应显示 `not loaded`，且不产生任何 MCP 子进程。
2. `mcp_load` 任一服务后，仅当前会话出现对应工具；另一会话既看不到也调用不了。
3. Hub 模式下确认官方 Hub 条目已停用、`initialize` 只发生在首次显式加载之后。
4. 阅读[验证与发布前事项](docs/验证与发布前事项.md)，按受控重启与迁移屏障流程完成切换。

Hub 当前能力范围为 tools；本文不承诺 resources / prompts、硬实时通知、逐逻辑服务进程冷启动或任意外部插件绕过后的强隔离。

## License

[MIT](LICENSE)
