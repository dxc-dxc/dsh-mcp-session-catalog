# @dxc-dxc/dsh-mcp-session-catalog

DeepSeek Harness (DSH) 会话级共享 MCP 管理插件。提供跨会话共享连接池、会话级工具隔离授权、原生配置自动发现与按需懒加载、以及基于空闲轮次的自动资源回收。

---

## 🌟 功能说明

- **按需冷启动**：默认不常驻启动任何外部 MCP 服务，仅在会话显式调用时才拉起对应后台进程。
- **共享连接池与会话隔离**：同一 DSH 实例中，相同服务复用同一个物理进程与连接，显著节省系统资源；原生工具仅向显式加载该服务的会话注册，其他会话无感知、不干扰。
- **DSH 原生发现与生命周期联动**：自动扫描当前 Profile 配置树中的 MCP 服务定义；在配置中新增、禁用或移除服务时，自动同步可用目录并安全释放后台进程。
- **事件驱动空闲回收**：依据会话完成轮次（默认连续 20 轮未使用）自动释放会话工具租约；无活跃引用的后台进程自动退出，彻底避免后台僵尸进程堆积。

---

## 🚀 安装与配置方式

### 1. 安装方式

在终端中执行 DSH CLI 命令（以目标 profile 如 `desktop` 为例，将 `<username>` 替换为实际仓库所属的 GitHub 用户名或组织名）：

```sh
dsh plugin --profile desktop add github:<username>/dsh-mcp-session-catalog
```

> **本地开发调试**：若在本地源码目录下，可通过软链接形式挂载：
> ```sh
> dsh plugin --profile desktop add "link:$(pwd)"
> ```

### 2. 配置方式

插件支持两种配置管理方式，按需选用：

#### 方式 A：直接使用 DSH Profile 原生配置（推荐，零外部文件）

在 profile 的 `cordis.patch.yml` 中声明本插件，并将需要按需管理的官方 MCP 条目保持 `disabled: true`（即保留服务启动命令，但关闭官方常驻启动），本插件即可自动扫描接管：

```yaml
- insert:
    # 挂载本管理插件
    - id: mcp-session-catalog
      name: '@dxc-dxc/dsh-mcp-session-catalog/v2_4'
      config:
        inactiveTurnsThreshold: 20  # 连续空闲回收轮数（默认 20）

    # 声明 MCP 服务（disabled: true 交由本插件按需启动）
    - id: mcp-filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        transport: stdio
        serverName: filesystem
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir']
```

#### 方式 B：使用独立 JSON 配置文件

如需在统一外部文件中管理连接或跨设备共享，可通过 `serversFile` 指定 JSON 文件（支持 `~` 用户家目录路径）：

```yaml
- insert:
    - id: mcp-session-catalog
      name: '@dxc-dxc/dsh-mcp-session-catalog/v2_4'
      config:
        serversFile: '~/.dsh/mcp-connections/servers.json'
        inactiveTurnsThreshold: 20
```

`~/.dsh/mcp-connections/servers.json` 格式示例（参考 `examples/servers.example.json`）：

```json
{
  "inactiveTurnsThreshold": 20,
  "servers": [
    {
      "serverName": "filesystem",
      "purpose": "本地文件系统读写能力",
      "command": "node",
      "args": ["./filesystem-server.mjs"],
      "cwd": "~",
      "sharing": "shared"
    },
    {
      "serverName": "browser",
      "purpose": "重型浏览器自动化服务",
      "command": "node",
      "args": ["./browser-mcp.mjs"],
      "sharing": "shared",
      "inactiveTurnsThreshold": 5
    }
  ]
}
```

---

## 🛠️ 使用方式

插件为模型注入全局管理工具与系统提示词，整个交互过程无需人工干预：

### 1. 发现服务：`mcp_catalog`

查看当前可用服务列表及其加载状态（仅读取元数据，不启动进程）：

```json
{}
```

### 2. 加载服务：`mcp_load`

当智能体任务需要某项能力时发起加载，工具将在下一个模型步骤向当前会话注入：

```json
{
  "server": "filesystem"
}
```

加载成功后，即可直接调用形如 `mcp__filesystem__read_file` 的原生 MCP 工具。

### 3. 主动卸载：`mcp_load` (action: "unload")

会话任务完成后，可主动释放该服务的工具租约：

```json
{
  "server": "filesystem",
  "action": "unload"
}
```

### 4. 刷新元数据：`mcp_refresh`

临时借用连接拉取所有工具的名称和描述并更新本地元数据缓存：

```json
{
  "server": "filesystem"
}
```

---

## 📄 开源协议

本项目基于 [MIT 许可证](LICENSE) 开源。
