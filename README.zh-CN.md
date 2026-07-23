# Nimi Coding

[English](./README.md)

**面向 AI Coding 系统和第三方扩展的确定性 authority 控制层。**

Nimi Coding 将项目自行拥有的规范性规则转化为稳定身份、精确源码位置、显式关系和有界、fail-closed 的机器产品。AI host、agent framework、CI、编辑器工具和第三方扩展可以据此发现 authority、组装证据、导航关系并审查精确变更，而不把模型推断当作 repository truth。

大多数最终用户不需要直接调用 `nimicoding`。当前主要 integration surface 是已文档化的 CLI 及其 purpose-specific JSON 产品。Nimi Coding 不是 AI agent、planner、代码生成器、审批 workflow 或万能规范语言。

## 为什么需要 Nimi Coding

AI 模型擅长生成代码，却不总能可靠判断：哪份文档真正权威、搜索结果是否完整、规则移动文件后是否还是同一规则、一次修改影响哪些显式关系，以及现有 evidence 是否真的证明 conformance。

Nimi Coding 把这些问题变成显式产品语义：

| AI Coding 常见问题 | Nimi Coding 的控制方式 |
| --- | --- |
| 多份文档看起来都像 authority | 一个封闭的 canonical authority 边界 |
| 路径和 heading 发生变化 | 与文件和顺序无关的稳定 logical unit ID |
| 搜索产生噪声或被截断的上下文 | 有界 discovery、exact query、declared context 和 graph 产品 |
| 模型无法精确引用规则来源 | 字段级和关系级的 portable SourceMap location |
| 文本 diff 掩盖真实语义变化 | Stable-ID semantic diff 和 declared impact obligations |
| “没有结果”被展示为“clean” | 显式 budget、completeness、gap、refusal 和 failure 语义 |
| Git review 可能混入移动中的输入 | Immutable base OID 加完整 worktree race revalidation |
| 文件或测试名称被当作符合性证明 | Evidence 与 conformance 是不同的产品状态 |

## 产品模型

```text
项目拥有的 canonical authority
  .nimi/spec/**/*.authority.{yaml,md}
                    │
                    ▼
Authority Foundation
  fmt · check · 基于 private AuthorityIR/SourceMap 的 compile CLI
                    │
                    ▼
Spec Intelligence Plane
  discover · query · context · refs/path/subgraph
  diff · impact · audit · review · evidence
                    │
                    ▼
Purpose-specific JSON / human output / SARIF（仅 audit）
                    │
                    ▼
AI host · 第三方扩展 · CI · future editor/UI surfaces
```

项目拥有全部产品语义。Nimi Coding 负责 admission、定位、关系和有界派生产品，不负责发明这些语义。OpenAPI、JSON Schema、Protobuf、tests、ADR 和 design docs 仍然适合承载专业结构、可执行验证、设计理由、示例和图表。

## 当前已经可用的能力

| 层 | 当前能力 | 证明边界 |
| --- | --- | --- |
| Authority Foundation | Canonical YAML/Markdown、formatter、完整 root check、private deterministic compiler 和 SourceMap | 未知或 unsupported canonical input 会被拒绝，不会被忽略 |
| Discovery 和 exact read | Exact kind/owner/scope/lifecycle filters、normalized lexical snippets、可选 direct relation preview、exact query、bounded declared context | 不提供 semantic search、自动 authority selection 或 absence proof |
| Graph navigation | `applies_to`/`supersedes` 上的 incoming/outgoing refs、deterministic path 和 bounded subgraph | 只使用 authored relations，不生成 inferred semantic graph |
| Change intelligence | Stable-ID semantic diff 和 relation-derived impact obligations | Impact 是 review requirement，不是同步证明 |
| Deterministic audit | Project-owned verifier bindings、observation/finding/required gap、JSON 和 SARIF 2.1.0 | 当前 built-in detector 是窄 governance verifier，不是自然语言矛盾引擎 |
| Git-aware review | Immutable base commit 加 exact、race-checked current worktree snapshot，并复用 compile/diff/impact/audit | 只读；不管理 branch、PR、approval 或 release |
| Authority-to-code evidence | Exact authority/scope 到 declared package-script command/test target reachability | 只是静态窄 slice；不执行 command/test，completed evidence 的 conformance 保持 `not_evaluated` |

当前 Nimi-realm 验证 corpus 包含 38 个 canonical containers、793 个 authority units 和 1,260 条 authored relations。这些数字证明了真实大型 corpus replay，不是 package 上限，也不代表 grammar 已覆盖所有领域。

## 五分钟接入

安装并初始化：

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

`start` 创建紧凑的 AI-visible authoring guide、`AGENTS.md`/`CLAUDE.md` 中的 managed instruction blocks，以及 ignored `.nimi/local/` root。它不会生成产品语义，也不会替项目创建 `.nimi/spec`。

创建一个完整 canonical source，例如 `.nimi/spec/checkout.authority.yaml`：

```yaml
format: nimicoding.authority/v1
units:
  - id: definition.checkout-session
    kind: definition
    owner: team.checkout
    lifecycle: active
    title: Checkout session
    meaning: A server-owned session representing an active checkout.
    relations: []
  - id: rule.checkout-session
    kind: rule
    owner: team.checkout
    lifecycle: active
    title: Checkout requires a server-owned session
    modality: must
    scope:
      - api.checkout
    statement: Checkout operations use a server-owned checkout session.
    condition: Whenever a checkout operation begins.
    failure: Reject the operation.
    relations:
      - type: applies_to
        target: definition.checkout-session
```

格式化变更文件、admit 完整 root，并查询一个 exact unit：

```bash
pnpm exec nimicoding authority fmt .nimi/spec/checkout.authority.yaml
pnpm exec nimicoding authority check .nimi/spec --json
pnpm exec nimicoding authority query .nimi/spec rule.checkout-session --max-bytes 32768 --json
```

对完整 root 执行 `authority check` 是唯一的 .nimi/spec conformance gate。格式化单个文件不代表其语义已被 admission，只检查 changed file 也不能替代 complete-root check。提供 `--scope-bindings <file>` 时，check 还会强制 registered scope 与 active-rule scope use 双向精确匹配；它只校验 binding declarations，不解析 repository paths。

Canonical YAML 是封闭的 `format` 加非空 `units` container；Canonical Markdown 是严格的 single-unit profile。当前模型刻意保持紧凑：`Rule` 和 `Definition`、`active` 和 `removed`、`must` 和 `must_not`，以及 authored `applies_to` 和线性 `supersedes` 关系。

如果某个领域需要 grammar 尚不支持的 API、schema、enum、state machine、formula 或 catalog 成员级结构，应把精度保留在 canonical grammar 之外的专业 artifact 中。只有存在显式 admitted project binding 或 adapter 时才能连接；当前 built-in evidence slice 只支持 package-script targets，不支持通用 API、schema、consumer 或 runtime integration。不要向 canonical authority 随意添加字段：unknown field 必须 fail closed，才能避免 consumer 静默忽略原本想表达的 authority。

## AI host 和第三方扩展的调用旅程

```text
任务没有 exact authority ID
  → discover 有界 lexical candidates
  → host 或 project authority 选择 exact ID
  → query/context/refs/path/subgraph
  → host 规划和编辑
  → fmt 变更 sources + check 完整 root
  → review immutable base 与 exact worktree
      (semantic diff + declared impact + current audit)
  → 如果已配置，再独立检查 current-worktree evidence
```

Host 负责 authority selection、planning、editing、retry、remediation、review state 和 completion。Nimi Coding 负责 request validation、deterministic computation、explicit budgets、exact locations 和诚实的结果边界。

Machine integration 应使用 argument array 调用 CLI，并同时消费 exit status 和 JSON envelope。必须读取 product-specific operation、completeness、policy、gap 和 evidence states，不能从空 candidate/finding array 推断 clean。Invalid usage/internal failure 与 completed 但 blocking/incomplete 的产品具有不同的 command-specific exit。

在已经配置好的 Git 项目中，可以使用 Git-aware exact review 获得一份组合后的 authority change product：

```bash
pnpm exec nimicoding authority review . \
  --base origin/main \
  --bindings .nimi/config/authority-verifiers.yaml \
  --dispositions .nimi/local/authority-impact-dispositions.yaml \
  --max-units 1024 \
  --max-edges 4096 \
  --max-bytes 2097152 \
  --json
```

这个例子假设 repository 已经拥有合法 verifier bindings 和 impact dispositions，并且 `origin/main` 能解析到包含 `.nimi/spec` 的 commit。`start` 刻意不会创建这些项目语义或 governance files。

Base ref 在开始时只解析一次并固定为 full commit OID。Base `.nimi/spec` tree 从 Git objects 读取；完整 current `.nimi/spec` filesystem tree 包含 tracked unchanged files、edits、deletions、untracked files 和 unsupported entries。Capture race、missing object、invalid corpus、malformed binding/disposition 或 budget 不足都会拒绝结果，而不是发布 mixed 或 false-clean review。该命令不会 checkout、stash、reset、stage、commit，也不管理 PR。

## 多维比较：旧 Nimi、当前 Nimi Coding 与成熟普通 spec

这里的“普通 spec”指严肃工程中 Markdown/ADR、OpenAPI、JSON Schema 或 Protobuf、tests 和 repository conventions 的成熟组合，不是刻意弱化的一堆 prose。

| 维度 | 重构前 Nimi spec 系统 | 当前 Nimi Coding | 成熟普通 spec 组合 |
| --- | --- | --- | --- |
| Authority 边界 | Human contracts、tables、generated views、maps 和 profile rules 依赖 precedence 约定 | 一个封闭 canonical authority root | 多个专业 source of truth，通常没有跨格式统一边界 |
| Reference corpus 形态 | 144 个混合文件：101 Markdown、43 YAML，其中包括 33 generated views 和 42 tables | 38 canonical containers 编译为 793 个稳定 units | 由项目决定，通常高度异构 |
| 身份 | Contract ID、`R-*` anchor、路径和 table row 没有统一覆盖所有对象 | 每个 unit 一个 stable ID，不依赖文件、顺序、移动或 regroup | 部分格式内部很强，跨格式不统一 |
| 领域内部精度 | 部分 tables 能直接建模 entity、required field、API operation、Prisma/OpenAPI/service locator | 很多 enum/schema/state/catalog 细节仍是 Definition 内的原子 prose | OpenAPI、Schema、Protobuf 和专业 DSL 在各自领域最强 |
| 人类 rationale | Rich contracts 和 generated guides | 刻意紧凑；长篇理由应放在 canonical authority 之外 | ADR 和 design docs 最强 |
| Admission | 多套 profile-specific validators 和 generators | 一个 complete-root、fail-closed admission oracle | 结构化格式内部很强；Markdown 和跨格式 admission 不统一 |
| Unknown input | 行为取决于具体 profile/tool | Canonical root 中一律拒绝 | 如果 schema/linter 没禁止，常被保留或静默忽略 |
| 重复与漂移 | Human/table/generated/alignment 多种表示可能分叉 | 一个 canonical unit 表示；derived products 可删除重建 | 跨文档、跨格式漂移仍很常见 |
| AI retrieval | 搜索和项目专用 projections 容易产生重复和噪声 | Bounded discovery、exact query 和 purpose-specific JSON | Full-text/RAG 灵活，但噪声和 completeness 不稳定 |
| Source traceability | 各 profile 以不同方式返回位置 | Units、fields 和 authored relations 共享统一 portable SourceMap | 单个工具内通常不错，工具之间不统一 |
| Relationship graph | Links、maps、custom fields 和 Atlas-like projections 共同表达 | 一个 authored、有界的 `applies_to`/`supersedes` graph | `$ref`、links、imports 和 conventions 仍按格式分散 |
| 冲突发现 | Custom checks 能发现项目特定 drift | 结构冲突可确定发现；prose 矛盾仍需 AI/人判断 | 格式内可很强，跨格式冲突仍困难 |
| Semantic change | File diff 和 generated drift 占主导 | Stable-ID semantic diff；rename/regroup/format-only 可为 semantic zero | Prose 多为 line diff；专业格式可能有优秀 domain diff |
| Impact 与 audit | Project scripts、maps 和团队知识共同决定 | Declared relation impact 加 project-bound finding/gap 语义 | Build graph、CODEOWNERS、linters 和 tests 很强但分散 |
| Git review | 没有统一 exact authority snapshot product | Immutable-base、race-checked worktree review | 通常是 Git diff 加多个独立 format-specific checks |
| Spec-to-code | Direct paths 很细，但可能 stale | 已有窄、identity-bound package-script evidence slice | Codegen、type checking 和 contract tests 可能明显更强 |
| Executable conformance | 部分 custom scripts 验证具体项目事实 | 当前 evidence 刻意不声称 conformance | 高质量 tests 和 executable contracts 最强 |
| 生态 | 高度 project-specific | 有稳定 CLI/JSON products，但还没有 public JS SDK 或模型/tool 标准 | OpenAPI/Schema/test 生态与第三方互操作最成熟 |
| Authoring 成本 | 多种表示和 generators 成本高 | 必须维护 ID、owner、scope、lifecycle 和 relation | 探索期最低；corpus 扩大后治理成本上升 |
| 最佳适用场景 | 项目专用的一体化 spec 系统 | 与大型、主要由 AI 消费的专业 spec estate 并行工作的稳定 normative authority control | 探索期和专业 API/data/behavior contracts |

这次重构并非所有维度都无条件胜出，而是一项明确取舍：当前 Nimi Coding 获得了统一 authority 坐标、确定性机器消费和 exact review 语义；专业格式继续保留领域精度、可执行验证、成熟生态和人类解释能力。

## 综合判断

当前架构已经是很强的 AI Coding substrate，因为它在不依赖具体模型的前提下，解决了 authority identity、retrieval、traceability、change review 和 false-clean prevention。

必须始终区分三层产品事实：

1. **当前已经很强：** stable identity、fail-closed admission、exact SourceMap、authored graph navigation、bounded machine products、semantic diff 和 exact Git review。
2. **已经改善但仍不完整：** 为人/AI conflict review 定位和追踪 exact inputs、task-context assembly、owner/scope accountability 和 spec-to-code traceability；矛盾判定本身不是 deterministic product。
3. **刻意没有解决：** 通用业务语义完备性、自动 authority selection、可执行 code conformance、模型推理和 AI workflow orchestration。

如果 Nimi Coding 标准化的是 authority protocol，而不是试图吞并所有领域语言，它的长期上限很高。Model-native 生态可以训练 AI：先 discover 再猜测、解析 exact ID、区分 authored fact 与 inference、尊重 gap/completeness，并在编辑后主动请求 review/evidence。但 deterministic runtime product 必须继续作为 oracle；模型熟悉 Nimi Coding 不能替代 admission 或 evidence。

## 安全与 truth 边界

- 只有 `.nimi/spec/**` 下的 `*.authority.yaml` 和 `*.authority.md` 是 canonical product authority。
- ID、relation、owner 和 scope 都是 declared facts。Nimi Coding 不从 prose 推断关系或现实组织责任。
- `discover` 是 deterministic lexical candidate retrieval，不是 semantic search、selection、context assembly 或 absence proof。
- `context` 是 complete bounded outgoing interpretation closure，不是 complete task context。
- `audit` 执行显式绑定的 deterministic governance check，不证明全部业务规则不存在矛盾。
- `impact` 生成 declared review obligations；disposition 不证明 implementation 或 tests 已同步。
- `review` 评价 captured current snapshot；除非未来产品显式比较 finding fingerprints，否则不把 current finding 归因为本次 change。
- Snapshot no-follow 加固受平台能力限制。在 `win32` 上，Node.js 不提供 `O_NOFOLLOW`/`O_DIRECTORY`，因此 snapshot capture 仅使用外围 `lstat`/`realpath` 校验，不具备 descriptor-level no-follow 保证。
- `evidence` 当前只证明 declared package-script target reachability。它不执行 command/test；每个 completed evidence product 都报告 `conformanceStatus: not_evaluated`，refused input 则不返回 evidence product。
- Raw AuthorityIR、SourceMap internals 和 compiler implementation 都是 package-private。当前没有 public JavaScript API（`exports` 为空）。
- `.nimi/local/**` 是 derived/local evidence，永远不是 product authority。

## Future roadmap

Roadmap 当前暂停在已经验证的 baseline。以下是 future candidate lanes，不代表 implementation authorization、release promise 或隐含顺序。未来每次迭代应只选择一个真实 adopter journey。

| Candidate lane | 目标产品 | Entry condition |
| --- | --- | --- |
| Stateless AI tool adapter | 在现有 bounded JSON products 上提供 typed tools，可采用 MCP 或 extension API | 真实 host integration 证明直接调用 CLI 不足 |
| General M4 API/consumer evidence | API/consumer locators 和 producer → API → consumer reachability | 存在真实 canonical-authority seam；不得从当前 package-script slice 外推 |
| D2 IDE/LSP | Live diagnostics、exact-ID navigation/completion、full-snapshot unsaved-buffer overlay | 持续 editor journey 足以支持独立 delivery unit |
| D3 local Studio | Read-only unit/graph/diff/impact/audit/evidence exploration | 先验证多个真实 review/exploration journeys |
| D4 external semantic candidates | 带 provenance 和 abstention 的 model/embedding/reranking candidates | 在 owner-approved task corpus 上量化 lexical/graph 不足 |
| E1 multi-repository Atlas | Visibility-filtered canonical repository snapshot composition | Ecosystem repositories、identity、visibility、ownership 和 workspace membership 都已明确 |

以下工作必须独立、按条件进入：

- Structured Definitions、replacement DAG、owner/scope registry 或 public library API，必须先证明真实 authoring/query/consumer loss。
- Storage、SQLite、cache 或 incremental compilation，必须先有真实 workload 违反预先声明的 SLO，并由 profiling 证明瓶颈来自 repeated parse/index/join。
- Version bump、4.0.0、tag、publish、ecosystem activation 和 release compatibility 都属于独立 release decision。
- AI planning、delegation、execution、approval、task state、model/provider orchestration 和 inferred model findings 不属于 core package。

## Command reference

当前 public integration surface 是 CLI。所有 budget 都是显式正安全整数；如果 required product 无法装入预算，blocking-capable result 会拒绝，而不是截断。

| 目的 | Commands |
| --- | --- |
| Author 和 admit | `authority fmt`、`authority check`、`authority compile` |
| Find 和 read | `authority discover`、`authority query`、`authority context` |
| Navigate | `authority refs`、`authority path`、`authority subgraph` |
| Analyze 和 review | `authority audit`、`authority diff`、`authority impact`、`authority review` |
| 连接 bounded evidence | `authority evidence` |
| Project lifecycle | `start`、`sync`、`doctor`、`clear` |
| 可选 L3 repository governance | `validate-ai-governance` |

<details>
<summary>完整 authority command syntax</summary>

```text
nimicoding authority fmt <file> [--check] [--json]
nimicoding authority check <path> [--scope-bindings <file>] [--json]
nimicoding authority compile <path> [--json]
nimicoding authority discover <path> <query> [--kind <definition|rule>] [--owner <exact-owner>] [--scope <exact-scope>] [--lifecycle <active|removed>] --max-candidates <n> --max-snippet-terms <n> --max-bytes <n> [--preview-direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-edges <n>] [--json]
nimicoding authority query <path> <id> --max-bytes <n> [--json]
nimicoding authority context <path> <id> --max-units <n> --max-bytes <n> [--json]
nimicoding authority refs <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority path <path> <from-id> <to-id> --traversal <directed|incidence> --relations <comma-separated-relation-types> --max-hops <n> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority subgraph <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --depth <n> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority audit <path> --bindings <file> --max-units <n> --max-edges <n> --max-bytes <n> [--json|--sarif]
nimicoding authority diff <before-path> <after-path> --max-bytes <n> [--json]
nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <n> [--json]
nimicoding authority review <repository-path> --base <git-ref> --bindings <file> --dispositions <file> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority evidence <repository-path> --bindings <tracked-.nimi/config-path> [--probe-results <.nimi/local-path>] --max-units <n> --max-bindings <n> --max-locators <n> --max-edges <n> --max-input-bytes <n> --max-bytes <n> [--json]
```

</details>

Relation types 是 closed set `applies_to,supersedes` 的非空、无重复 subset；discovery relation preview 必须同时提供 direction、relation types 和 edge budget。

<details>
<summary>Project lifecycle、governance 和 global syntax</summary>

```text
nimicoding start [--yes]
nimicoding sync [--apply|--check|--dry-run] [--json]
nimicoding clear [--yes]
nimicoding doctor [--verbose|--json]
nimicoding validate-ai-governance --profile <profile-id> --scope <all|agents-freshness|context-budget|structure-budget|high-risk-doc-metadata> [--json]
```

Global presentation options 是 `--lang en|zh`、`--color` 和 `--no-color`。

</details>

Projection ownership 是精确的：`start`/`sync` 只拥有其已文档化的 managed paths 和 marked instruction blocks。Projection sync 不检查或修改这些 exact managed surfaces 之外的 files。可选 `validate-ai-governance` 与 authority admission、host task execution 保持分离。

## Development

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

需要 Node.js 24+ 和 pnpm 10+。
