# @nimiplatform/nimi-coding

[English](README.md) · **简体中文**

[![npm](https://img.shields.io/npm/v/@nimiplatform/nimi-coding.svg?label=npm)](https://www.npmjs.com/package/@nimiplatform/nimi-coding)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](#环境要求)

> 一套**厂商中立、AI 原生的方法论工具**（vendor-neutral, AI-native
> methodology toolkit），专门用于治理高风险的 AI 辅助软件开发。它在项目里
> 搭建一层 `.nimi/**` 真相面，配套 `nimicoding` CLI，把"AI 看起来做完了"
> 变成"四个闭合维度都有证据。"

读者文档：<https://docs.nimi.ai/nimicoding>
npm 包：[`@nimiplatform/nimi-coding`](https://www.npmjs.com/package/@nimiplatform/nimi-coding)

---

## 为什么需要这个项目

AI 辅助实现经常会产出**能编译、能跑通现有测试、Reviewer 看着合理、但实际上在权威、范围、语义或产品意义上是错的**代码。这些不是传统意义上的 bug——它们是*闭合失败*（closure failures）：在闭合条件还没真正成立的状态下，工作就被声明为"完成"了。

Nimi Coding 专门拦截的几种失败形态（非穷举）：

- **过期文档锚定**：模型跟随了一份看似权威、但已经偏离活跃 spec 的文档。
- **隐式范围扩张**：模型"顺手"改了相邻表面，所有权悄悄发生了转移。
- **看似合理的捏造**：缺乏权威源时，模型编造一个跟真实答案无法区分的连贯回答。
- **旧路径保留**：模型"为了安全迁移"在旧路径旁边加了新路径——而旧路径本来应该被删掉。
- **构建通过即闭合**：因为测试跑过了就宣告完成，但消费方面对的行为是错的。
- **伪成功**：强类型契约失败被一段返回"某种东西"的回退路径掩盖，没有 fail-closed（失败即关闭）。

更好的 Prompt 和更全的测试都解决不了这个问题。**审查 AI 输出的回路，和产出这个 AI 输出的，是同一个回路。** Nimi Coding 引入的是**结构性的分离**。

## Nimi Coding 是什么（不是什么）

Nimi Coding **不是**另一个 AI 写代码工具。它不写代码、不调度 provider、不跑 agent loop。

它是**独立的、host-agnostic 的边界包**（standalone host-agnostic boundary package），作为治理层坐落在你使用的任意 AI host（Claude、Codex、Gemini、OMX 或自建）下面。它交付：

- 包内自有的**方法论**源（`methodology/**`）
- 强类型**契约**（`contracts/**`）
- **bootstrap + host profile** 配置（`config/**`）
- **bootstrap spec 种子**（`spec/**`）
- **`nimicoding` CLI**：用于 bootstrap、校验、skill 握手、本地 closeout、topic 生命周期、sweep audit、sweep design、高风险执行闸门
- 外部 AI host 的**适配器** profile overlay

它**刻意不**交付：

- 一个 packet 绑定的运行内核
- provider-backed 的 AI 执行
- 一个调度器
- 通知基础设施
- 自动化后端
- 自托管方法论执行

运行时所有权留在外部 AI host 那里。方法论和契约保持可移植。明天你想换 AI host，方法论合同不需要改。

当一个 host project 跑 `nimicoding start` 时，包内自有的源会被**投影**到该项目的 `.nimi/{config,contracts,methodology,spec}/**`。被采纳的项目随后拥有自己 `.nimi/spec/**` 下的产品权威。**包不会让 host 直接读取包源路径**——被采纳的项目永远读它自己投影出来的 `.nimi/**`。

## 心智模型

让 Nimi Coding 区别于"另一个 checklist"的四个动作：

| 动作 | 含义 |
| --- | --- |
| **权威被显式命名** | 每次变更都先写清楚真相住在哪里（`.nimi/spec/**`）、表面归谁所有、属于哪一类工作。 |
| **执行被 packet 化** | 实现被一份开工前冻结的 packet 限定边界——允许的读、允许的写、验收恒定式、负面测试、停止线、重开条件。worker 不允许扩张范围。 |
| **闭合是多维的** | 四个独立闭合闸门——权威（Authority）、语义（Semantic）、消费方（Consumer，即真实用户/读者/运维有没有真的用上）、抗漂移（Drift Resistance）——必须全部成立。过三缺一不算关闭。 |
| **角色分离** | Manager 负责切边界和准入；Worker 在 packet 写集合内执行；Auditor 来自**结构上独立的回路**（另一个 AI 会话、另一家厂商）。 |

完整框架见 [Four Closures](https://docs.nimi.ai/nimicoding/four-closures) 与 [The Paradigm](https://docs.nimi.ai/nimicoding/the-paradigm)。

## 适合谁用

| 角色 | 收益 |
| --- | --- |
| 用 AI 推大项目的独立开发者 | 不需要团队就能拿到团队规模的复核纪律——同一台笔记本起第二个 AI 会话当 auditor |
| 小团队（2–5 人）引入 AI | 不需要扩招就能拿到结构性的复核冗余 |
| 接受 AI 辅助 PR 的开源维护者 | 可证的贡献纪律——packet 边界、强类型证据、四闭合闸门 |
| 有 AI 编程合规压力的工程组织 | 独立于任一 AI 厂商的审计轨迹和结构化验收 |
| 研究 AI 工程实践的研究者 | 一个可观测的方法论语料库，跑在真实仓库历史上 |

如果你见过 AI 辅助的变更在所有信号上看起来完成了——类型检查绿、测试绿、Reviewer 批了——结果在权威、范围或产品意义上是错的，那这个包就是为你做的。

## 环境要求

| 项 | 版本 |
| --- | --- |
| Node.js | `>=24.0.0` |
| 包管理器（消费方） | npm、pnpm、yarn 或兼容工具 |
| pnpm（仓库开发） | `>=10.0.0` |

建议在版本控制下的项目里使用——`start` 会创建文件。

## 安装

在需要接入 `.nimi/**` 治理层的项目里：

```bash
npm install --save-dev @nimiplatform/nimi-coding
# 或
pnpm add -D @nimiplatform/nimi-coding
```

确认 CLI：

```bash
npx nimicoding --version
npx nimicoding --help
```

## 5 分钟最小路径

大部分项目都应该从小路径开始。第一条跑通的路径是：

```bash
# 1. 在项目根目录 bootstrap .nimi/**
npx nimicoding start

# 2. 检查 bootstrap 健康
npx nimicoding doctor --json

# 3. 把权威 spec 重建任务握手交给你的 AI host
npx nimicoding handoff --skill spec_reconstruction --json

# 4. host 消费该 payload 并落地 .nimi/spec/** 后，校验权威树
npx nimicoding validate-spec-tree .nimi/spec
npx nimicoding validate-spec-audit
```

走完这条路径，你会拥有：项目本地的 `.nimi/**` 真相面、一份重建到 `.nimi/spec/**` 的强类型项目权威，以及可以在每次变更上重跑的机械校验器。

`handoff` 导出的是权威任务 payload。它不会调用 AI provider，也不会自己执行 reconstruction；外部 host 必须消费 payload，写入或返回预期工件，然后本地校验器检查结果。

**普通的低风险改动不需要创建 topic、冻结 packet、跑高风险闸门。** 那些工具是给权威级、跨模块、多 wave 或对审计敏感的工作准备的。

如果想从测试项目里只移除包托管的 bootstrap 内容（保留 `.nimi/spec/**`、`.nimi/local/**`、`.nimi/cache/**` 和被本地修改过的 bootstrap 文件）：

```bash
npx nimicoding clear --yes
```

## 需要进阶时：Topic、Wave、Packet

权威级、高风险或跨模块的工作，升级到 topic 生命周期。Topic 装一次战略性变更；wave 把 topic 拆成有边界的工作单元；每个 wave 在 worker 动手前冻结一份 **packet**。

```bash
nimicoding topic create <slug> --justification <text>
nimicoding topic wave add <topic-id> <wave-id> <slug> \
  --goal <text> --owner-domain <domain>
nimicoding topic packet freeze <topic-id> --from <draft-path>
nimicoding handoff --skill high_risk_execution --json
nimicoding ingest-high-risk-execution --from result.json
nimicoding review-high-risk-execution --from ingest.json
nimicoding decide-high-risk-execution --from review.json \
  --acceptance accept.md --verified-at <iso8601>
```

每一步都被强类型校验约束。跳步或者偷塞字段，CLI 直接拒绝（fail closed，没有例外）。

## 四个声明 Skill

外部 AI host 实现这些 skill；`handoff` CLI 为每一个发出机器可读 payload：

| Skill | 用途 | Bootstrap 必需 |
| --- | --- | --- |
| `spec_reconstruction` | 把项目权威重建到 `.nimi/spec/**`，带源依据和未决 gap 追踪 | 是 |
| `doc_spec_audit` | 对照权威树校验每个文件的 grounding 和 inference | 是 |
| `audit_sweep` | 把目标根切成可审计的 chunk，记录强类型证据 | 否 |
| `high_risk_execution` | 在准入的高风险 packet 上执行，附带 packet / orchestration / prompt / worker-output / acceptance 强类型证据 | 否 |

契约细节见 [Skills](https://docs.nimi.ai/nimicoding/skills)。

## CLI 总览

按使用场景分组的常用命令：

```bash
# Bootstrap
nimicoding start
nimicoding sync --check
nimicoding doctor --json
nimicoding clear --yes

# Skill 握手与本地 closeout
nimicoding handoff --skill <id> --json
nimicoding closeout --from result.json --write-local

# Spec 审计
nimicoding validate-spec-tree .nimi/spec
nimicoding validate-spec-audit
nimicoding blueprint-audit

# Topic 生命周期
nimicoding topic create <slug> --justification <text>
nimicoding topic wave add|select|admit ...
nimicoding topic packet freeze ...
nimicoding topic worker dispatch ...
nimicoding topic result record ...
nimicoding topic closeout ...
nimicoding topic true-close-audit ...
nimicoding topic run-next-step <topic-id> --json

# Sweep audit / sweep design
nimicoding sweep audit plan --root <dir> --json
nimicoding sweep audit chunk ...
nimicoding sweep design intake|packet-build|result-ingest|finalize ...

# 高风险执行闸门
nimicoding admit-high-risk-decision --from <json> --admitted-at <iso8601>
nimicoding ingest-high-risk-execution --from <json>
nimicoding review-high-risk-execution --from <json>
nimicoding decide-high-risk-execution --from <json> \
  --acceptance <path> --verified-at <iso8601>

# 机械工件校验器
nimicoding validate-execution-packet <path>
nimicoding validate-orchestration-state <path>
nimicoding validate-prompt <path>
nimicoding validate-worker-output <path>
nimicoding validate-acceptance <path>
```

CLI 概念总览：<https://docs.nimi.ai/nimicoding/cli>
字段级 reference：<https://docs.nimi.ai/nimicoding/reference/cli-commands>

## 它和 X 是什么关系

| | Cursor / Copilot / Claude Code | Lint / TDD / Code review | Nimi Coding |
| --- | --- | --- | --- |
| 写代码 | ✅ | ❌ | **❌** |
| 抓局部 bug | 部分 | ✅ | n/a |
| 抓权威漂移 | ❌ | ❌ | **✅** |
| 抓消费方闭合失败 | ❌ | ❌ | **✅** |
| 厂商绑定 | 有（按工具） | 无 | **无——host-agnostic** |
| 跨 AI 会话的审计轨迹 | 聊天记录 | PR 评论 | **`.nimi/**` 下的强类型证据** |

Nimi Coding 坐在你已经用的 AI host *底下*。它是让 AI 做完的工作从"看起来完成"晋升到"四维闭合、有证据"的机器装置。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `bin/nimicoding.mjs` | 可执行的包二进制 |
| `cli/**` | CLI 实现 |
| `config/**` | 包内自有的 bootstrap 与 host profile 源 |
| `contracts/**` | 包内自有的机器可读 schema 与契约 |
| `methodology/**` | 包内自有的方法论源（policy） |
| `spec/**` | bootstrap spec 种子和包 scope 源 |
| `adapters/**` | 外部 host 适配器 profile overlay（例如 `oh-my-codex`） |
| `test/**` | Node 测试套件与 fixture |

被采纳的项目使用 `.nimi/**` 作为投影层。这个仓库自身把包内自有源直接放在 `config/**`、`contracts/**`、`methodology/**`、`spec/**` 下。

## 开发

```bash
pnpm install
pnpm test           # 跑 node:test 套件（0.2.4 共 340 用例）
pnpm check:pack     # npm pack --dry-run
pnpm check:ci       # test + pack + CLI help/version smoke
```

本地 CLI smoke：

```bash
node ./bin/nimicoding.mjs --version
node ./bin/nimicoding.mjs --help
```

提交 PR 前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。简版要求：改动有边界、守住 host-agnostic 边界、除非方法论合同显式重设计否则不引入运行时所有权、自称完成前跑过相关测试。

## 发布

Release 由 tag 触发 GitHub Actions。一个 `vX.Y.Z` tag 在 test、pack dry-run、CLI smoke 都通过后，发布与 `package.json` 版本相匹配的包。Workflow 也支持手动的 dry-run release 闸门。

包以启用 npm provenance 发布。

## 安全

不要在公开 GitHub issue 里披露漏洞。请走私密渠道：

- GitHub 私密安全公告：[`nimiplatform/nimi-coding`](https://github.com/nimiplatform/nimi-coding/security/advisories/new)
- `security@nimi.ai`

支持的上报路径见 [SECURITY.md](SECURITY.md)。

## 文档

完整读者文档：<https://docs.nimi.ai/nimicoding>，包括：

- [The Paradigm](https://docs.nimi.ai/nimicoding/the-paradigm)
- [Four Closures](https://docs.nimi.ai/nimicoding/four-closures)
- [False Closure Typology](https://docs.nimi.ai/nimicoding/false-closure-typology)
- [Forbidden Shortcuts](https://docs.nimi.ai/nimicoding/forbidden-shortcuts)
- [Role Separation](https://docs.nimi.ai/nimicoding/role-separation)
- [Topic Lifecycle](https://docs.nimi.ai/nimicoding/topic-lifecycle)
- [The Package](https://docs.nimi.ai/nimicoding/the-package)
- [CLI Surface](https://docs.nimi.ai/nimicoding/cli)
- [Installation](https://docs.nimi.ai/nimicoding/installation)
- [Adoption Path](https://docs.nimi.ai/nimicoding/adoption-path)
- [Comparison](https://docs.nimi.ai/nimicoding/comparison)
- [Walkthrough](https://docs.nimi.ai/nimicoding/walkthrough)

## 许可

MIT。见 [LICENSE](LICENSE)。
