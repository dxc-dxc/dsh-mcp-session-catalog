# 技能按名加载（v2.6）

## 使用目标

模型通过 `skill-router` 的主题、名称与精简描述选中技能，再调用 `skill_load({ name: 'code-review' })`。隐藏技能保持 `disable-model-invocation: true`，不会因为安装或加载而出现在官方模型技能目录。用户仍可使用官方 `/name` 作为兜底。

模型决定加载哪个技能；插件负责通过官方注册表解析并返回该技能。插件不承担自然语言分类，不维护第二份技能索引，也不把完整技能列表放进工具描述。

## 与官方加载的关系

加载使用调用 Agent 的作用域、当前有效工作目录和取消信号，交给 `ctx.skills.list/get` 处理 provider、项目技能覆盖、预设层级与 frontmatter。内容以官方 `renderSkillContent()` 渲染，保留 `name`、`provider`、`resourceBase` 和 `content`。目录、URL、opaque 资源基址和没有基址的技能均遵循官方格式。

与官方 `skill` 的有意差别是：新工具允许模型加载 `modelInvocable: false`、`userInvocable: true` 的技能。两个调用标记均为 false 时拒绝加载。它不改变注册表里的调用标记，不替换官方工具，也不伪造 `/name` 用户消息。

输出路径与官方 `skill` 相同：正文作为普通工具结果进入调用会话，而不是用户斜杠调用产生的 `skill-invocation` 上下文消息。二者共享解析和正文渲染，但日志来源类型不同。

## 安装与升级

包版本为 2.6.0。MCP 保留 `v2_5` / `v2_4` 导出，新技能入口为 `@dxc-dxc/dsh-mcp-session-catalog/skill-loader`。默认 bundle 在原 MCP 管理器旁增加 `skill-name-loader`，不修改 Magpie 配置或现有 MCP 接管片段。

已有 profile 如果有用户层覆盖，安装后应通过运行时 Inspect 确认新条目是否生效。不要重复插入同 id 条目。独立挂载写法：

```yaml
- insert:
    - id: skill-name-loader
      name: '@dxc-dxc/dsh-mcp-session-catalog/skill-loader'
```

当前技能入口只在安装的 DSH 导出官方技能渲染器与工具工厂时注册，实测目标为 0.2.2-rc.2。其他版本上该入口会记录一条警告并保持不注册，MCP 部分继续按原有兼容范围工作；因此不会因为新增入口而收窄整包的 `engines` 声明。但这意味着旧版本上 `skill_load` 不存在，需按[skill-router 迁移](#skill-router-迁移)的回退路径处理。

安装使用 DSH 的插件管理器。替换已安装包可能需要重启加载新模块；以插件管理器返回的 `application` 和 `nextStep` 为准。不要通过直接改写 profile 的包依赖来升级。

## skill-router 迁移

将隐藏技能的默认加载路线改为：

> 按任务类型与意图匹配主索引和主题分册。目录中可见技能优先调用官方 `skill`；隐藏技能或官方工具报告不允许模型调用时，使用 `skill_load`，传入精确名称。若当前会话没有 `skill_load`，再按已知路径直接读取技能文件，并保留资源基址语义。用户 `/skill-name` 始终保留为兜底。

本插件不修改用户的路由文件。分册中的名称和精简描述可继续使用，无须把隐藏技能改为可见。尚未装入新工具的会话继续走已有 read 路线。

## 会话边界

未调用时不读取技能正文，不新增全量目录提示。调用会话获得正文，其他独立会话不会因为本次调用自动获得正文或新的注册。

已加载的正文属于该会话历史；正常 fork、resume、压缩均遵循 DSH 本身的会话行为。本功能不承诺清除已经提交的工具结果，不提供 `skill_unload`，也不套用 MCP 的 20 轮回收语义。技能指令本身可能要求调用工具或修改文件，加载动作不会自动执行那些步骤。

## 验证方式

使用安装中真实 Cordis、Skills、Tools 和 Scope 服务进行针对性测试，并与官方渲染输出比较：`test/skill-loader.mjs` 覆盖隐藏技能加载、与官方 `skill` 的输出逐字段对比、scope 与同名优先级、工作目录、取消、卸载、双禁用拒绝和缺官方 helper 时的降级。完整回归使用 `test/run.mjs`。开发态使用当前 DSH 的 Electron Node 模式访问 ASAR，不下载或复制另一版本运行时。

```bash
ELECTRON_RUN_AS_NODE=1 DSH_TEST_MODULE_ROOT="$DSH_INSTALL_DIR/.." "$DSH_NODE_EXECUTABLE" test/run.mjs
```
