# 已批准：v2.5 原独立流程不变，Hub 按需兼容并严格互斥

用户批准时间：2026-10-30 21:26（Asia/Shanghai）。当前为执行阶段，不再处于 plan mode。用户指定创造模式，实际 agent_preset=cordis。执行路由经三步确认：provider=magpie-responses；model=codex/gpt-6.1-sol；reasoning_effort=xhigh。

## 不可变合同

1. 未被 Hub 管理的 MCP，独立走原插件全部流程与接口。stdio 配置、Loader disabled 接管约定、servers/serversFile、excludedServers、表达式、共享/session、20轮及覆盖、归档、取消、只读重试、文本结果、在途保护不退化。
2. Library 中且分配给 DSH、实际由 Hub 提供的 MCP 为 Hub 逻辑服务。初始不注册业务工具，显式 mcp_load 后才授予当前会话。
3. DSH Hub 接入启动/catalog/resume 静默：不连接、不 initialize/list/ping/健康检查；只有显式 load/refresh 唤醒。Magpie 全局 Hub 开关保持原样。
4. 同一逻辑服务 Hub 优先；严禁直连与 Hub 并行、双份后端、双重工具暴露、隐式备用及自动直连回退。
5. 首次 Hub 请求前清退【全部】Hub归属服务的受管DSH直连，不只是本次选择项，因为 Hub 首次 list 可启动整组后端。
6. 接受工具级按需、Hub首次发现启动其他已分配后端。不要求 Magpie 改逐服务进程冷启动。保证范围为本插件受管DSH；其他客户端共用同一Hub后端是正常共享。
7. 不部署生效profile、不发布npm/GitHub、不修改Magpie资源库/全局开关、不启动真实业务MCP。自动测试仅假服务和真实DSH基础模块。

## 架构与状态

原index/pool stdio流程保留，新增http-connection.mjs、hub-adapter.mjs、hub-gate.mjs、hub-ownership.mjs等必要小模块。
采用公开@modelcontextprotocol/client@2.2.0 Client/StreamableHTTPClientTransport，不借用官方apply闭包。使用宿主公开createMcpToolDefinition保留structured/image投影；保留原exec对象。
逻辑状态：independent -> retiring-direct -> hub-idle -> hub-connected；未知/冲突为blocked。Hub归属与连接活跃分离，Hub idle也不能开直连。
退役先阻新调用和重试，排空在途，注销旧工具并确认进程退出，才启Hub。失败保持blocked。跨受管Host用共享归属代际/清退确认屏障协调；未知或旧Host不猜测安全，不自动剔除未知旧进程。
只关插件自己的HTTP客户端，绝不停止Magpie Hub/backend或默认terminateSession。
Hub业务调用不自动重放；原stdio重试不改。

## 初期公有配置合同（供并行测试/文档使用）
magpieHub: { enabled: true, libraryFile: '<path>', ownershipDir: '<shared path>', entryId?: '<effective Loader id>', url?: '<manual/test Hub URL>', headers?: {...}, serverName?: 'magpie' }
- 不配置或enabled:false时原独立模式完整工作，不依赖Hub/Gate/SDK。
- entryId用于显式绑定；未指定时只识别真实的Magpie /mcp/magpie/hub/dsh入口，不能误接管普通HTTP MCP。
- url为显式手动/测试连接来源；同URL有官方entry时仍须接管，不能双开。
- libraryFile默认本机~/.config/magpie/library.json；ownershipDir为所有受管DSH Host共享目录，测试必须用隔离临时目录。
- 实际Library JSON: {mcpHub:true,mcp:[{name:'obsidian',transport:'stdio',command:...,args:[],env:{},agents:['dsh'],disabledTools:[]}]}; 仅提取必要源身份/分配，绝不输出凭据。
- 新bundle可通过配置显式enabled:true；旧配置无magpieHub仍保持独立行为。新增runtime-v2.5与gate独立导出，保留v2_4兼容入口。
- 若实现发现此表面合同必须调整，先报告Lead协调测试/文档，禁止各自猜测不同接口。

## 发现、API与缓存

mcp_catalog、mcp_load({server:'obsidian'})、mcp_refresh({server:'obsidian'})、mcp_load({server:'obsidian',action:'unload'})均保持逻辑服务调用，不强制group参数。
独立来源扫描不变。Hub从本地Library最小元数据+按需Hub工具快照动态发现服务与工具，监听文件变更并操作前重读；不高频网络轮询。缓存目录不授予执行权。
目录只保留一个可加载逻辑身份。冲突Hub优先，直连不启动；同名确为不同服务需明确不同逻辑身份，不能自动双启。
新增入目录不自动给现有会话扩权；明确删除/取消DSH分配/禁用工具撤授权。Schema/映射变更退役租约，端点/认证变更退役物理代际。
读取失败、Hub离线、超时和部分列表不能当删除，保留最后可信归属且不能退回直连；不确定潜在冲突来源阻止新启动。
完整原始Hub工具名映射，禁止从公开名反解。合法短名尽量保持；截断/冲突明确处理。

## Gate与宿主事实（已经独立审查）
- AgentLoop先systemPrompt.assemble(:907)才pre-step(:909)，最终请求用assembly.tools(:1075)。pre-step不能修改已接受快照，只能reject。
- Tools.restrict仅精确allow/deny，unknown名称安装会报错，限制继承面不限制own。Tools.guard单调拒绝。tools/change可监听但不可当原子否决。
- agent/created是等待准入钩子；既有会话迁移须暂停/受控重启。
- system-prompt/assemble authoritative waterfall兜底检查；PTC还在tools:sdk section中生成定义，不能只滤assembly.tools。
- gate仅控制明确Hub来源（含被Hub收编而必须清退的重复直连），不得新增屏蔽所有非Hub MCP。管理器HMR保持Gate；Gate自身升级暂停准入受控重启。
- wrapper执行时再次检查agent/lease/source generation，即便排队或审批阶段撤授权也不能fallback。
- public API不足以承诺任意外部插件绕过或Gate被手动卸载时仍无窗口。不能伪造证据；若批准合同在公共API下有阻塞必须报告。

## 验收

原test/run.mjs五组回归全通过。新增静默零网络/native+PTC隔离、A/B组隔离、refresh不授予、动态增删、不扩权、Hub优先无回退、首次Hub前全体直连清退、跨Host屏障、排队/审批撤销、同步重启/重建竞态、旧异步回灌、取消互不影响、最后引用关闭、JSON/SSE/分页/超时/写不重放、structured/image、名称映射、凭据不落日志/缓存。
对初始化/子进程/请求提交/工具注册/关闭记录时间轨迹，断言无直连/Hub活动区间重叠，不只看最终快照。

## 实施派发与写范围

A核心实现（串行链）：index.mjs、pool.mjs、http-connection.mjs、hub-adapter.mjs、hub-gate.mjs、hub-ownership.mjs、必要新核心模块、runtime-v2.5.mjs、package.json/package-lock.json、cordis.patch.yml；报告analysis/core-implementation.md。独占这些文件，测试仅自测不编辑test/。
B验证（并行准备，依赖A后运行收束）：test/**，报告analysis/test-implementation.md。只编辑test/，原测试不得削弱；通过公有apply配置合同测试。
C文档（并行）：README.md、docs/功能说明.md、docs/验证与发布前事项.md、docs/hub-compatibility.md、examples/**；报告analysis/docs-implementation.md。不得改本批准合同、task_plan/findings/progress或package文件，不提前声称已实测。
Lead：协调接口、审查完整diff、运行最终检查、更新task_plan/findings/progress、合并报告和交付。所有子代理cordis，同一路由xhigh。新源文件依赖必须加入npm打包清单。

## 环境

workspace=/Users/dxc/AI/dsh插件开发/mcp资源回收插件。
真实DSH测试DSH_TEST_MODULE_ROOT=/Users/dxc/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai。
宿主@modelcontextprotocol/client=2.2.0可只读参考，但发布依赖须正确声明，禁止依赖绝对本机路径。
工作树原有untracked diagnostics/、findings.md、progress.md、task_plan.md均为本会话研究工件，禁止删除。不得git reset/clean、提交、发布或改生效profile。
