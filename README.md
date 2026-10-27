# dsh-mcp-session-catalog

> DeepSeek Harness (DSH) 会话级按需 MCP 管理插件：连接复用、作用域隔离与空闲进程回收。

DSH 原生的 MCP 客户端会在启动时拉起所有已配置的服务器，并向全部会话暴露全部工具。本插件将这一行为改造为按需模式：服务常态休眠，仅在会话显式请求时冷启动；相同服务跨会话复用同一底层连接，工具仅注入调用方上下文，并在持续空闲后自动释放。

## Features

- **按需冷启动**：服务默认不启动，会话调用 `mcp_load` 时才拉起子进程。
- **连接池复用**：同 Host 内多个会话共享单个 MCP 进程，避免重复开销。
- **会话作用域隔离**：原生工具仅向调用方会话注册，未加载的会话对工具无感。
- **DSH 原生发现**：直接读取 DSH Loader 配置树，自动识别已声明的 MCP 服务。
- **自动资源回收**：基于会话轮次（默认连续 20 轮未调用）自动释放工具并退出无用进程。

## Install

```sh
dsh plugin --profile desktop add github:<username>/dsh-mcp-session-catalog
```

本地调试挂载：

```sh
dsh plugin --profile desktop add "link:$(pwd)"
```

## Configuration

将需由本插件按需托管的 MCP 条目保持 `disabled: true`（关闭官方客户端常开，保留连接定义）：

```yaml
- insert:
    # 启用按需管理器
    - id: mcp-session-catalog
      name: '@dxc-dxc/dsh-mcp-session-catalog/v2_4'
      config:
        inactiveTurnsThreshold: 20  # 空闲回收轮数（默认 20）

    # 声明 MCP 服务（disabled: true 交由本插件按需托管）
    - id: mcp-filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        transport: stdio
        serverName: filesystem
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir']
```

也可以通过 `serversFile` 使用独立 JSON 文件维护连接：

```yaml
- id: mcp-session-catalog
  config:
    serversFile: '~/.dsh/mcp-connections/servers.json'
```

## Usage

插件自动为模型注册管理工具与系统提示：

### 查询目录

`mcp_catalog` 查看所有可用服务及当前会话的加载状态（不启动服务）：

```json
{}
```

### 按需加载

`mcp_load` 为当前会话挂载指定服务，工具在下一模型步骤生效：

```json
{
  "server": "filesystem"
}
```

挂载后，会话即可直接调用 `mcp__filesystem__read_file` 等原生工具。

### 主动卸载

任务结束后可提前释放租约：

```json
{
  "server": "filesystem",
  "action": "unload"
}
```

## License

[MIT](LICENSE)
