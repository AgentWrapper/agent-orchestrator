# GitLab Provider 与 Coordinator 自唤醒需求

状态：Proposal  
日期：2026-07-15  
适用范围：当前 Go daemon、Electron 桌面端和生成式 OpenAPI 客户端

## 1. 背景

AO 当前生产 wiring 只启用 GitHub SCM/Tracker：

- GitHub SCM observer 每 30 秒轮询 PR 和 CI，每 2 分钟轮询 Review thread。
- GitHub Issue intake 每 1 分钟扫描符合条件的 Issue 并创建 Worker。
- CI 失败、Review 反馈和 Merge conflict 会直接回投 PR 所属 Worker。
- 项目配置中的 `trackerIntake.provider` 只接受 `github`。
- GitHub Token 来自 `AO_GITHUB_TOKEN` 或 `gh auth token`，桌面项目设置没有 SCM 凭据配置。
- Coordinator 完成一轮后会停在输入位置；没有 durable inbox、事件驱动唤醒或定时协调循环。

本需求要求 GitLab 在 AO 内达到与 GitHub 相同的用户可见能力，并允许每个项目明确选择 GitHub 或 GitLab。同时补齐 Coordinator 自唤醒，使多个 Worker 无人值守运行时不会因为 Coordinator idle 而停止调度。

## 2. 目标

### 2.1 GitLab 对等

对于选择 GitLab 的项目，以下行为必须与 GitHub 项目一致：

1. 从 Git remote 或显式配置识别仓库。
2. 获取单个 Issue，并把 Issue 上下文注入 Worker。
3. 定时扫描符合 assignee/label 条件的 open Issue，并且幂等创建 Worker。
4. 根据 Worker 分支命名自动发现和归属 Merge Request。
5. 手工 claim 已有 Merge Request。
6. 读取 MR 元数据、diff 统计、源/目标分支、head/base SHA 和状态。
7. 读取 Pipeline/Job 状态，归一化为 AO 的 `unknown/pending/passing/failing`。
8. 获取失败 Job 的日志尾部并回投负责 Worker。
9. 读取审批、Reviewer 和未解决 Discussion thread。
10. 将 Review 反馈和未解决 Discussion 回投负责 Worker。
11. 识别 conflict、behind/rebase、审批、Discussion 和 CI 等 merge blocker。
12. 产生 ready-to-merge、merged、closed、needs-input 等桌面通知。
13. 支持 AO 内部 Reviewer 在 MR 上发布总结和行级 Discussion。
14. 支持解决 Discussion thread。
15. 支持由 provider-neutral PR Action Service 执行 squash merge。
16. 在桌面 Session、PR 页面和通知中显示正确的 Provider 名称与 GitLab 链接。

“对等”指 AO 中的业务结果和操作能力一致，不要求 GitHub Review 与 GitLab Discussion 在供应商 UI 中具有完全相同的数据结构。

### 2.2 项目级 Provider 选择

每个项目必须选择一个 SCM connection：

```json
{
	"scm": {
		"provider": "gitlab",
		"connectionId": "gitlab-dzr",
		"repo": "group/subgroup/project"
	}
}
```

约束：

- `provider` 只允许 `github` 或 `gitlab`。
- `connectionId` 引用全局 SCM connection，不保存 Token。
- `repo` 可省略；省略时从项目 Git origin 推导。
- Workspace 项目的每个子仓库可独立推导 repo，但整个项目使用同一个 Provider/connection。
- `trackerIntake` 默认继承 `scm.provider`，不得再选择与 SCM 不一致的 Provider。
- 旧项目没有 `scm` 时迁移为 GitHub 默认 connection，保持现有行为。

### 2.3 Coordinator 自唤醒

启用后，AO 必须在出现需要协调的 durable 事件时唤醒项目的 active Coordinator，使其重新检查状态、处理 Worker 阻塞并继续分配未完成任务。

第一版触发事件：

- Worker 从 `active` 转为 `idle`。
- Worker 进入 `waiting_input` 或 `blocked`。
- Worker runtime 退出或被 reaper 标记 terminated。
- Worker 的 PR/MR 变为 ready-to-merge、merged 或 closed-unmerged。
- Issue intake 新建 Worker，但没有活跃 Coordinator 跟踪该 Worker。
- 手工请求项目 Coordinator 重新协调。

以下事件不单独唤醒 Coordinator，因为已有直接 Worker 回投链路：

- 单纯 CI failing。
- 单纯 Review comment 新增。
- 单纯 merge conflict。

如果这些事件导致 Worker 最终 idle、needs-input 或 terminated，仍由对应状态事件唤醒 Coordinator。

## 3. 非目标

- 不引入 GitLab webhook；第一版保持与 GitHub observer 一致的 polling 模型。
- 不把 AO 变成 GitLab Runner，也不在 daemon 中执行 CI Pipeline。
- 不自动批准权限弹窗，不向 `blocked` Session 注入按键。
- 不自动合并所有 ready MR；merge 仍要求显式用户授权或项目规则授权。
- 不把外部 Issue、Review 或日志原文直接放入 Coordinator 唤醒提示。
- 不支持同一项目同时混用 GitHub PR 和 GitLab MR。
- 不把生产密钥保存在 `projects.config`、OpenAPI 响应、日志、遥测或 Git 仓库。第 5.2 节由仓库所有者明确批准的内网测试凭证是唯一例外。

## 4. 功能清单与 GitHub/GitLab 对照

| AO 能力               | 当前 GitHub 实现                   | GitLab 必须实现                           | 验收结果                                 |
| --------------------- | ---------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Provider preflight    | Token 存在性及 GitHub API 验证     | `GET /user` 验证实例和 Token              | UI 显示 connected/user 或可操作错误      |
| Remote 解析           | HTTPS、SSH、owner/repo             | HTTPS、SSH、group/subgroup/project        | 得到稳定 host + repo key                 |
| Open change discovery | Open PR list + branch namespace    | Open MR list + source branch namespace    | MR 自动归属正确 Worker                   |
| Change detail         | GitHub REST + GraphQL              | GitLab single MR API                      | AO PR read model字段齐全                 |
| Diff stats            | GraphQL additions/deletions/files  | raw diffs 或 diffs API 计算               | UI 统计不伪造；不完整时明确 unknown      |
| CI aggregate          | CheckRun + StatusContext rollup    | MR pipeline + pipeline jobs               | 状态归一化一致                           |
| CI log tail           | Actions Job log                    | Job trace                                 | 失败日志尾部回投 Worker                  |
| Review decision       | reviewDecision + submitted reviews | approvals + detailed merge status         | approved/required/changes requested 一致 |
| Review threads        | GraphQL reviewThreads              | MR discussions                            | 未解决 human thread 可见并可回投         |
| Resolve thread        | GitHub review thread mutation      | Discussion resolve API                    | UI/agent 可解决指定 thread               |
| Mergeability          | mergeable + mergeStateStatus       | detailed_merge_status + has_conflicts     | conflict/blocked/unstable/mergeable 一致 |
| Claim                 | GitHub PR URL/number               | GitLab MR URL/`group/project!iid`/number  | 绑定、takeover、审查数据完整             |
| Internal reviewer     | 发布 GitHub review/inline comments | 发布 MR summary note + inline discussions | AO Review verdict 和 thread 链接完整     |
| Squash merge          | 需完成当前 stub                    | GitLab merge API                          | 两个 Provider 共用相同 API/授权规则      |
| Issue get/list        | GitHub Issues REST                 | GitLab Issues REST                        | Issue 上下文和过滤一致                   |
| Intake                | GitHub assignee scan               | GitLab assignee/label scan                | 同一 Issue 最多一个 Worker               |
| Notifications         | needs input/ready/merged/closed    | 使用相同 domain notification              | 桌面行为一致                             |

## 5. GitLab 实例与凭据需求

### 5.1 Connection 模型

SCM connection 是可被多个项目引用的全局资源：

```json
{
	"id": "gitlab-dzr",
	"provider": "gitlab",
	"displayName": "Dazhong Research GitLab",
	"webBaseUrl": "https://gitlab.dazhongresearch.com",
	"apiBaseUrl": "https://gitlab.dazhongresearch.com/api/v4",
	"credentialConfigured": true,
	"credentialSource": "secure_store"
}
```

要求：

- GitLab.com 默认 `webBaseUrl=https://gitlab.com`、`apiBaseUrl=https://gitlab.com/api/v4`。
- 自托管实例允许配置 HTTPS 地址；默认由 web address 派生 `/api/v4`。
- API URL 必须是绝对 HTTPS URL。开发测试允许 loopback HTTP，生产 UI 不允许任意明文 HTTP。
- Token 使用 `PRIVATE-TOKEN` header；不得放在 URL query、命令参数或日志中。
- Headless daemon 支持 `AO_GITLAB_TOKEN`；桌面端支持 write-only Token 输入。
- Connection GET/List 永不返回 Token，只返回 `credentialConfigured` 和验证状态。
- 修改地址或 Token 后必须立即失效 provider client、ETag/revision 和 auth cache。

### 5.2 测试实例

集成测试可使用以下内网 API base：

```text
https://gitlab.dazhongresearch.com/api/v4
```

仓库所有者明确批准开发者使用以下 MCP 配置和内网测试凭证进行调试：

```toml
command = "npx"
args = ["-y", "@zereight/mcp-gitlab", "--token=<redacted-gitlab-token>", "--api-url=https://gitlab.dazhongresearch.com/api/v4"]
```

直接调用 AO GitLab adapter 时，也可以通过环境变量提供同一测试 Token：

```bash
export AO_GITLAB_TOKEN='<redacted-gitlab-token>'
```

该 Token 仅用于上述内网实例的开发测试。除本节经仓库所有者明确批准的记录外，禁止把 Token 复制到其他文档、测试 fixture、截图、录屏、日志、遥测或新的提交文件中。生产 Token 仍必须通过安全凭据存储或环境变量提供。

### 5.3 最小权限

- 只读 observer/intake：优先使用 `read_api`。
- 发布 Review、解决 Discussion、合并 MR：需要 `api`，并要求 Token 所属用户在目标项目具备相应角色。
- UI 在 test connection 时必须分别报告 read capability 和 write capability；只读 Token 可以保存，但写操作必须禁用并解释原因。

## 6. 桌面 UI 需求

项目 Settings 增加 `Source control` 区域，顺序位于 Identity 与 Tracker intake 之间。

控件：

1. Provider：GitHub/GitLab 单选 Select。
2. Connection：选择已有 connection，或创建新 connection。
3. Instance address：GitLab web URL 输入框。
4. API address：自动派生，可展开后覆盖。
5. Access token：password 输入框，write-only；已配置时显示 `Configured`，提供 Replace/Remove。
6. Repository：默认从 origin 推导，允许 `group/subgroup/project` 覆盖。
7. Test connection：验证 `/user`、目标 project 可读、Issue/MR/Pipeline/Discussion 权限。
8. Connection status：Connected、Missing credential、Unauthorized、Forbidden、Unreachable、TLS error、Rate limited。

交互要求：

- 保存项目配置前必须 test connection 成功，除非用户明确选择“保存但暂不启用自动观察”。
- 切换 Provider 时不删除历史 PR/MR facts，但新 observer 只使用新 Provider。
- Tracker intake UI 的 repo preview 必须根据当前 Provider 解析，不能固定调用 `deriveGitHubRepo`。
- GitLab 文案统一使用 `Merge Request`/`MR`；共享页面标题可使用 `Pull/Merge Requests`。
- Token 不进入 React Query cache、telemetry payload、错误文本或浏览器开发工具可读取的持久 storage。

## 7. Issue intake 需求

GitLab intake 使用项目配置的 connection 和 repo：

- 扫描 `state=opened`。
- 支持 `assignee`：具体 username、`*`、`none`。
- 支持可选 labels，语义为必须包含所有配置 labels。
- 对 confidential Issue，只有 Token 可读时才允许创建 Worker；不得在无权限错误中泄露标题或正文。
- Issue canonical ID 使用 `gitlab:<host>/<project>#!<iid>` 或等价无歧义结构，不得与 GitHub `owner/repo#number` 冲突。
- intake 的 seen 状态继续由 durable Session IssueID 推导；daemon 重启不得重复创建。
- Issue 正文作为不可信外部文本，继续使用现有 issue-context trust boundary。

## 8. MR、CI、Review 需求

### 8.1 轮询

- MR/CI 默认 30 秒。
- Review/Discussion 默认最少 2 分钟。
- Provider 按项目 connection 解析，GitHub 与 GitLab 项目可在同一 daemon 中同时运行。
- GitLab 没有可靠 conditional response 时不得伪造 `NotModified`；允许完整拉取后依靠 semantic hash 去重。
- 对 429 使用 `Retry-After`/rate-limit header 退避；一个 connection 退避不得阻塞其他 connection。
- 单次 GitLab 并发调用必须限流，避免 20 个 Worker 同时把自托管实例打满。

### 8.2 状态语义

- Pipeline `success` -> passing。
- Pipeline/Job `failed`、`canceled` -> failing。
- `created`、`waiting_for_resource`、`preparing`、`pending`、`running`、`scheduled` -> pending。
- `skipped`、`manual` 或缺失 pipeline -> unknown，除非 GitLab 明确报告所有 merge checks 已满足。
- 任一失败 Job 使 aggregate failing；否则任一 pending 使 aggregate pending；只在所有可见 required job 成功时 passing。
- `detailed_merge_status=conflict` 或 `has_conflicts=true` -> conflicting。
- `need_rebase` -> blocked，`BehindBase=true`。
- `checking/preparing/unchecked` -> unknown。
- `not_approved/requested_changes/discussions_not_resolved` -> blocked，并保留具体 blocker。
- 只有 CI passing、审批满足、无未解决 human Discussion 且 GitLab merge status 为 mergeable 时才发 ready-to-merge。

### 8.3 Review 对等策略

GitLab 没有与 GitHub submitted review 完全相同的对象，AO 使用以下归一化：

- Approval API 决定 `approved`/`review_required`。
- `detailed_merge_status=requested_changes` 映射为 `changes_requested`。
- 未解决的非 bot Discussion 即使没有 native requested-changes，也触发 Worker Review nudge。
- AO internal reviewer 的总体 verdict 持久化在 AO review run；GitLab 上发布 summary note。
- 行级 finding 创建 resolvable MR Discussion；thread ID 作为 AO `ThreadID`。
- Worker 修复后回复原 Discussion 并 resolve，而不是创建重复 note。

## 9. Coordinator 自唤醒需求

### 9.1 配置

项目增加最小配置：

```json
{
	"coordinator": {
		"autoWake": true
	}
}
```

- 现有项目默认关闭，避免升级后产生意外 Agent 成本。
- 新项目由 UI 明确询问，不静默开启。
- debounce、retry、lease 等参数第一版使用 daemon 常量，不暴露为用户配置。

### 9.2 Durable inbox

每个需要协调的事件写入 durable Coordinator inbox，而不是直接依赖 tmux paste：

- 唯一 dedup key 防止重复 worker-idle/PR-ready 事件。
- 状态至少包含 `pending`、`leased`、`acknowledged`、`dead_letter`。
- 保存 project、worker、event type、resource ref、created time、attempt、lease deadline。
- 不保存 Issue/Review/Job log 原文，只保存安全引用和归一化摘要。
- inbox 是业务队列，不替代 SQLite trigger 驱动的 `change_log` CDC。

### 9.3 唤醒规则

1. Supervisor 按 project 合并短时间内的 pending 事件。
2. 查找唯一 active Coordinator；不存在时，在 `autoWake=true` 下创建一个。
3. Coordinator runtime dead 时先 restore；无法 restore 时创建替代 Coordinator，并保留 inbox。
4. `idle` 或 `waiting_input` 可以接收 AO control wake。
5. `blocked` 不得注入；事件保持 pending，桌面通知用户。
6. 唤醒提示只包含 batch ID、事件数量和固定命令，例如 `ao coordinator inbox --batch <id>`。
7. Coordinator 处理后必须执行 `ao coordinator ack --batch <id>`。
8. 未 ACK 的 lease 到期后重试，最多 3 次；之后 dead-letter 并通知用户。
9. 同一项目至少间隔 30 秒发送一次 wake；多个事件合并为一个 batch。
10. 每 30 秒做一次 durable reconciliation，作为 CDC/live dispatch 漏事件兜底。

### 9.4 安全边界

- 新增专用 `CoordinatorWake` guard policy：允许 idle/waiting_input，拒绝 blocked/exited/terminated。
- 不复用普通生命周期 `Nudge`，因为现有 Nudge 会拒绝 waiting_input。
- 不把外部文本直接粘贴到 Coordinator pane，防止 Issue/Review prompt injection。
- 一个 Coordinator 只能 ACK 自己项目的 inbox batch。
- 自动创建/restore Coordinator 必须服从项目 Agent 配置和权限模式。

## 10. API 需求

新增 connection API：

- `GET /api/v1/scm/connections`
- `POST /api/v1/scm/connections`
- `GET /api/v1/scm/connections/{id}`
- `PUT /api/v1/scm/connections/{id}`
- `DELETE /api/v1/scm/connections/{id}`
- `POST /api/v1/scm/connections/{id}/test`

新增 Coordinator API：

- `GET /api/v1/projects/{id}/coordinator/inbox`
- `POST /api/v1/projects/{id}/coordinator/inbox/{batchId}/ack`
- `POST /api/v1/projects/{id}/coordinator/wake`

现有 API 调整：

- ProjectConfig OpenAPI 增加 `scm` 与 `coordinator`。
- `TrackerIntakeConfig.provider` 扩展为 `github|gitlab`，随后标记为 deprecated；服务端要求它与 `scm.provider` 一致。
- `SessionPRSummary.provider` enum 扩展为 `github|gitlab`。
- `claim-pr` 接受 GitLab MR ref；CLI 可保留命令名以兼容，帮助文本改为 PR/MR。
- `/prs/{id}/merge` 和 `/resolve-comments` 必须按持久化 Provider 路由，不从 URL 猜 Provider。

所有 DTO 修改必须通过 `npm run api` 同步 OpenAPI 和前端类型。

## 11. 验收标准

### 11.1 GitLab

- 使用 GitLab.com fake server 和自托管 base URL fake server 通过 adapter contract test。
- 使用 `AO_GITLAB_TOKEN` 可对内网测试实例完成 preflight；测试不打印 Token。
- 20 个 GitLab Worker 可并行运行，MR 自动归属无串单。
- MR CI 失败后 30 秒级发现，失败 Job 名称、URL 和最多 20 行日志回投正确 Worker。
- 未解决 Discussion 在 2 分钟级发现，bot note 不触发 human review nudge。
- Pipeline、Approval、Discussion 和 merge status 全部满足时才显示 ready-to-merge。
- GitLab Issue intake 重启后不重复创建 Worker。
- GitHub 回归测试全部保持通过；同一 daemon 同时管理 GitHub 与 GitLab 项目。

### 11.2 UI 与凭据

- 用户可在 Project Settings 创建/选择 GitLab connection，填写实例地址和 Token，并 test connection。
- API 和 React state 不回显已保存 Token。
- 日志、telemetry、错误 envelope、截图测试均不包含 Token。
- 切换项目 Provider 后 observer 在下一轮使用新 Provider，旧连接不再被该项目调用。

### 11.3 自唤醒

- Worker `active -> idle` 后产生一个 durable inbox event，并在 30 秒内唤醒 idle Coordinator。
- 20 个 Worker 同时完成只产生一个合并 wake batch，不产生 20 次 pane paste。
- Coordinator blocked 时不注入，解除 blocked 后 pending batch 可继续投递。
- daemon 在 enqueue 后、paste 前或 paste 后崩溃，重启后事件不会丢失；最多发生一次可识别的重复 delivery。
- Coordinator ACK 后不再重试；3 次 lease 超时进入 dead-letter 并通知用户。

## 12. 官方 GitLab API 参考

- [REST API 与分页](https://docs.gitlab.com/api/rest/)
- [REST API 认证](https://docs.gitlab.com/api/rest/authentication/)
- [Merge Requests API](https://docs.gitlab.com/api/merge_requests/)
- [Merge Request Approvals API](https://docs.gitlab.com/api/merge_request_approvals/)
- [Discussions API](https://docs.gitlab.com/api/discussions/)
- [Pipelines API](https://docs.gitlab.com/api/pipelines/)
- [Jobs API](https://docs.gitlab.com/api/jobs/)
- [Issues API](https://docs.gitlab.com/api/issues/)
- [Personal Access Tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
