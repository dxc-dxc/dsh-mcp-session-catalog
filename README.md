# @dxc-dxc/dsh-mcp-session-catalog

DeepSeek Harness（DSH）的按需 MCP stdio 管理插件。GitHub 维护账户为 [dxc-dxc](https://github.com/dxc-dxc)。本地包名已固定，当前尚未发布 GitHub 仓库或 npm 包；GitHub 身份不代表已验证同名 npm scope 的发布权限。

插件从 DSH Host 的实际 Loader 配置树发现 MCP 定义，按需建立连接，只向明确加载服务的会话注册工具。默认连续 20 个完成轮次未调用某服务后，释放该会话的租约；最后一个租约及在途请求结束后关闭进程。

## 运行范围

- 验证平台：macOS / Apple Silicon，Node.js 22；包的 `os` 限制为 `darwin`。
- DSH 声明兼容范围：`>=0.2.1-rc.2 <0.2.2`。测试使用本机已安装的 DSH 内部模块，不代表该范围内每个版本均已验收。
- 仅支持 stdio。HTTP、SSE、Streamable HTTP 条目可在目录中显示状态，但不由此插件启动。
- Linux 尚未独立验收，Windows 暂不支持。进程回收依赖 POSIX 进程组。

## DSH 原生发现与连接所有权

默认安装不需要额外维护连接文件。插件读取 `ctx.loader.entries()`，使用 DSH 已合并的 Host 配置树，包含该树实际枚举到的 include 子树。它不自行解析 YAML，不猜测 profile 路径，也不把 `!!js` 表达式误当作字符串传给服务。

**接管约定：将要按需管理的官方 `@deepseek-ai/dsh-mcp-client` 条目设为 `disabled: true`，保留它的连接定义。** 这里的停用表示关闭官方客户端的常驻启动方式，让本插件按需使用定义。已启用的官方客户端由 DSH 自行管理，本插件只在目录中显示其状态，不会再启动第二份连接，也不会修改它的配置或终止它的进程。

例如，在 DSH 的现有 MCP 条目上修改 `disabled`，不必复制一份连接配置：

```yaml
- id: mcp-filesystem
  disabled: true
```

若原来没有此条目，完整声明可以是：

```yaml
- insert:
    - id: mcp-filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        transport: stdio
        serverName: filesystem
        command: node
        args: ['./filesystem-server.mjs']
```

命令对应的服务程序需要在本机存在；相对路径以 Host 工作目录为基准。`env` 中的 DSH `!!js` 表达式由条目自身的 Loader 上下文求值，插件不保存其原始值到元数据缓存。

目录会列出 Host 树内的官方 MCP 条目及状态：按需管理、官方客户端已启用、被排除，或传输/父级状态不支持接管。条件式 `disabled` 的条目不自动接管；已停用的父级条目中的服务也不自动复活。未挂载预设中的 MCP 定义及其他插件自定义的按需 MCP 协议不在当前接管范围内，不会被提升为所有会话可用。

## 安装

当前交付为本地源码。在项目根目录执行：

```sh
dsh plugin --profile desktop add "link:$(pwd)"
```

将 `desktop` 替换为目标 profile。安装只添加本管理器，不会改写现有 MCP 条目的启停状态。首次安装后的 MCP 接管状态可通过 `mcp_catalog` 查看。

仓库将来发布到该账户下的 `dsh-mcp-session-catalog` 仓库后，可使用：

```sh
dsh plugin --profile desktop add github:dxc-dxc/dsh-mcp-session-catalog
```

只有 npm 包实际发布、且维护者拥有对应 scope 权限后，以下安装方式才可用：

```sh
dsh plugin --profile desktop add @dxc-dxc/dsh-mcp-session-catalog
```

包内的安装补丁默认如下：

```yaml
- insert:
    - id: mcp-session-catalog
      name: '@dxc-dxc/dsh-mcp-session-catalog/v2_4'
      config:
        scanDshProfile: true
        inactiveTurnsThreshold: 20
```

## 管理工具与调用示例

`mcp_catalog` 查看服务和当前会话加载状态。只读配置与缓存，不主动建立 MCP 连接：

```json
{}
```

`mcp_load` 为调用方会话加载服务。工具从下一模型步骤开始可用：

```json
{ "server": "filesystem" }
```

之后直接调用服务提供的 `mcp__filesystem__read_file` 等原生工具。具体名称和参数由服务器提供，目录缓存未必反映服务器最新工具集。

`mcp_load` 同时支持卸载当前会话的工具和租约：

```json
{ "server": "filesystem", "action": "unload" }
```

其他会话仍有引用时，其工具和共享进程保持可用。当前会话有在途调用时，显式卸载会被拒绝，需等待调用结束。

`mcp_refresh` 更新工具名与描述缓存，不给调用方注册原生工具。可能临时启动服务：

```json
{ "server": "filesystem" }
```

省略 `server` 会顺序刷新全部可按需管理的服务。

## 删除服务与释放

从 DSH 实际配置树移除 MCP 条目后，本插件在 Loader 配置变更/条目移除事件处理时自动重读；管理工具和原生调用入口也会重读。服务从可加载目录移除，旧租约标记为退役，**不能再通过旧工具发起新请求**。已提交的请求可以完成，工具注册在安全空闲边界撤销，引用清零后关闭本插件的连接。重新启用官方客户端也会退役本插件的对应连接。

如要保留连接定义但禁止本插件加载，使用管理器配置的 `excludedServers`：

```yaml
- id: mcp-session-catalog
  config:
    scanDshProfile: true
    inactiveTurnsThreshold: 20
    excludedServers: ['filesystem']
```

修改管理器配置由 DSH 自身的配置重载生命周期应用。**再次把官方条目设为 `disabled: true` 不是卸载按需服务的方法**，因为它本来就是本插件的接管约定。需删除条目、排除服务，或停用整个管理器。

不支持热应用的 Host/profile 需要重启才能让 DSH 配置树更新；插件不能看到尚未由 DSH 应用的磁盘编辑。移除条目不等于卸载对应 npm 软件包。

## 回收阈值与隔离方式

默认阈值为 20 个已完成轮次。同一轮调用过某 MCP 则重置其连续未使用计数；重复或倒序的 `turn/end` 不重复计数。时间经过本身不回收连接。归档、Agent 销毁、显式卸载和管理器停用也会释放对应引用。

修改默认阈值，例如 10 轮：

```yaml
- id: mcp-session-catalog
  config:
    scanDshProfile: true
    inactiveTurnsThreshold: 10
```

默认 `sharing: shared` 会复用同一 Host 中的服务进程，**服务端页面、认证及可变状态也共享**。会话工具可见性隔离不构成后端状态隔离或操作系统沙箱。需要独立进程时可在手动连接定义中设 `sharing: session`。不同 Host 进程之间不共享连接池。

进程关闭时向本插件启动的 POSIX 进程组发 `SIGTERM`，约两秒后以 `SIGKILL` 兜底。另建会话/进程组的服务子进程不在该组内，不能承诺清理任意第三方程序脱离进程组的后台守护进程。

## 可选手动连接配置

无 DSH Loader 的测试环境或需要自定义 `sharing`、回收阈值时，可以使用独立 JSON 文件；`examples/servers.example.json` 提供格式示例。手动模式默认不再扫描原生条目，避免重复来源。

```yaml
- id: mcp-session-catalog
  config:
    scanDshProfile: false
    serversFile: '~/.dsh/mcp-connections/servers.json'
    inactiveTurnsThreshold: 20
```

文件格式：

```json
{
  "inactiveTurnsThreshold": 30,
  "servers": [
    {
      "serverName": "filesystem",
      "purpose": "项目文件读写",
      "command": "node",
      "args": ["./filesystem-server.mjs"],
      "cwd": "~/projects",
      "sharing": "shared"
    },
    {
      "serverName": "browser",
      "command": "node",
      "args": ["./browser-server.mjs"],
      "sharing": "session",
      "inactiveTurnsThreshold": 5
    }
  ]
}
```

上述示例中普通服务继承 30 轮，浏览器独立进程在 5 轮未使用后回收。阈值优先级为服务定义、JSON 顶层、管理器配置、默认 20。修改 JSON 后，下一次工具入口调用时生效。设 `servers: []` 可移除最后一个服务；JSON 损坏或文件不可读时保留上一版有效配置并报告警告。

也可直接提供 `config.servers` 数组，优先于 `serversFile`。若显式启用 `scanDshProfile: true` 合并来源，服务名必须唯一，重复会被拒绝，不会静默覆盖。手动配置不能与已启用官方客户端重复配置同一后端。

`serversFile`、`cacheFile` 和服务 `cwd` 支持 `~` 展开；`command`、`args` 中的路径及 JSON 内的环境变量字符串不会自动替换。可执行程序、MCP 软件包和凭据仍需在每台机器准备，不能只靠路径展开完成迁移。子进程继承 Host 环境并叠加连接 `env`。

## 其他参数与限制

- `scanDshProfile`：未配置手动来源时默认 `true`；原生模式要求 `ctx.loader.entries()`。
- `excludedServers`：不接管的原生服务名数组，默认空。
- `cacheFile`：默认 `~/.dsh/cache/mcp-session-catalog.json`，保存工具名、描述摘要、服务信息和时间；不保存调用参数、结果或配置凭据。
- `maxResultChars`：默认 60000，限制目录和工具结果长度。
- 服务字段 `connectTimeoutMs` / `toolCallTimeoutMs`：正整数毫秒，默认 30000 / 120000。
- 服务字段 `readOnlyTools`：明确标记只读工具名；只读调用对匹配的暂时性连接错误最多尝试三次，写操作不自动重试。服务器只读声明也会影响重试判断。

当前返回文本、嵌入资源文本和结构化结果；图像等非文本块以省略提示表示。服务器主动请求除 `ping` 外未实现，通知式工具更新需重新加载/刷新。不同 Host 默认缓存位置相同，跨进程同时写缓存的协调未实现，可为不同 Host 设置不同 `cacheFile`。同进程热升级和真实有状态 MCP 的多会话业务仍需独立验收。

## 测试与审查

源码测试使用真实 DSH Cordis、Loader、Tools 和 Scope 模块及本地假 MCP 服务，不下载外部 MCP。

```sh
export DSH_TEST_MODULE_ROOT="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai"
npm test
```

如果 DSH 安装在其他位置，请把变量设为对应的 `@deepseek-ai` 模块目录。测试包含会话授权、共享池、归档/轮次回收、JSON 重载、退役租约以及真实 Loader 原生发现和条目移除事件。详细结果和剩余边界见 [验证与发布前事项](docs/验证与发布前事项.md)，实现说明见 [功能说明](docs/功能说明.md)。

## 许可证

[MIT](LICENSE)。
