# @nimiplatform/nimi-coding Product Design

> **Status**: Draft
> **Date**: 2026-04-10
> **Package**: `@nimiplatform/nimi-coding`
> **Scope**: standalone npm package and project design, `.nimi/**` project-local truth model, bootstrap/CLI surface, AI skill handoff surface, methodology/product boundary
> **Purpose**: 将近期关于 `nimi-coding` 独立产品化的讨论收束成一份完整设计文档，明确产品目标、问题定义、方法论边界、项目结构、CLI/skills 分层、bootstrap 路线以及后续实现阶段。本文件是设计输入，不是 normative source。

## 1. Problem Statement

当前大量 AI coding 实践的问题，不是单纯 “模型不够强”，而是缺少一套能在复杂项目里保持长期可维护性的工程治理层。

典型失败模式包括：

- 项目变大后 authority 不清，AI 在不同位置重复实现同一逻辑
- 没有唯一事实源，文档、代码、AI 上下文同时漂移
- 高风险改动缺少 freeze / acceptance / evidence discipline
- AI 经常改一半、删一半、补一半，留下不可追踪的并行真相
- 后续维护者无法判断哪些内容是 canonical，哪些只是临时推断

`nimi-coding` 在 Nimi 主仓中的实践已经证明，一套围绕 authority、packet、acceptance、evidence 的方法论，可以显著降低这些问题。

下一步目标不是把现有 monorepo 内的 `nimi-coding` 原样打包出去，而是把其**方法论和实践**沉淀为一个可安装、可复用、面向任意项目的独立产品：`@nimiplatform/nimi-coding`。

## 2. Product Goal

`@nimiplatform/nimi-coding` 的核心目标是：

> 给任意项目安装一层 AI-native 的工程治理层，让 AI coding 可以围绕项目内的结构化 truth 工作，而不是围绕临时上下文、零散文档和局部猜测工作。

它要解决的不是：

- 替代所有 human docs
- 自动生成所有代码
- 提供一个万能的持续后台 agent

它要解决的是：

- 如何为 AI coding 建立 project-local truth
- 如何让高风险工作进入 packetized execution discipline
- 如何把 human-readable docs / code conventions / existing project structure 抽离重建成 AI-consumable spec
- 如何让 AI coding 的行为稳定、可恢复、可审计

## 3. Product Positioning

`@nimiplatform/nimi-coding` 应被定义为：

- 一个独立产品
- 一个 npm package
- 一个 AI coding governance toolkit
- 一个 project bootstrap + methodology + skill handoff 工具

它不是：

- 当前 Nimi 主仓 `nimi-coding/**` 的简单导出
- 现有 `nimi-coding` monorepo layout 的机械复制
- 一个一上来就 self-hosting 的完整执行系统

更准确地说：

- 当前主仓 `nimi-coding` 是**验证过的方法论执行系统**
- `@nimiplatform/nimi-coding` 是**基于这套方法论产品化出来的通用工具**

## 4. Core Product Principles

### 4.1 AI-native first

`.nimi/**` 的首要目标不是给人读，而是给 AI 正确消费。

这意味着：

- 结构优先
- authority 密度优先
- 低冗余优先
- 不为人类直读牺牲 machine truth purity

human-friendly 视图不是 source truth，而应通过 skill / AI query / projection 派生。

### 4.2 No parallel truth

`.nimi/**` 必须是项目内 AI coding 的主 truth layer。

不允许：

- 再保留一套平行的人类说明文档作为同层 authority
- 用 CLI help / README / comments 替代 `.nimi/**`
- 把外部 skill runtime、scheduler、automation、host logs 误升格为语义 owner

### 4.3 Risk-shaped methodology

`nimi-coding` 方法论不应覆盖所有改动。

它主要用于：

- 大型重构
- 多阶段迭代
- authority-bearing changes
- cross-layer / high-risk changes

小而清晰的低风险改动不应强制 topic 化。

### 4.4 Inline manager-worker default

产品方法论默认 posture 应是：

- inline manager-worker

而不是：

- external worker CLI mandatory

`worker` 保留为 artifact / role 概念，但不应强制成为独立进程拓扑。

### 4.5 Continuity-agnostic

`nimi-coding` 方法论本身不应追求 manager continuity。

它只应保证：

- durable artifacts
- recoverable governance
- reentrant manager semantics

至于 heartbeat、daemon、automation、harness continuity，属于上层工程扩展，不属于方法论核心。

## 5. Standard Project Entry: `.nimi/**`

未来通用项目安装后，标准入口应是：

- `.nimi/**`

而不是强迫项目采用 Nimi 当前的 `spec/** + nimi-coding/.local/**` 结构。

`.nimi/**` 的作用是：

- 作为项目内 AI governance layer
- 作为 AI coding 的 primary truth surface
- 作为 bootstrap、spec reconstruction、high-risk execution 的统一入口

### 5.1 Proposed directory model

建议最小布局为：

- `.nimi/methodology/`
- `.nimi/spec/`
- `.nimi/contracts/`
- `.nimi/config/`
- `.nimi/local/`
- `.nimi/cache/`

当前 bootstrap 已验证的核心子面包括：

- `.nimi/methodology/core.yaml`
- `.nimi/methodology/spec-reconstruction.yaml`
- `.nimi/methodology/skill-handoff.yaml`
- `.nimi/spec/product-scope.yaml`
- `.nimi/spec/bootstrap-state.yaml`
- `.nimi/config/bootstrap.yaml`
- `.nimi/config/skills.yaml`
- `.nimi/config/skill-manifest.yaml`
- `.nimi/contracts/spec-reconstruction-result.yaml`
- `.nimi/contracts/doc-spec-audit-result.yaml`

当前已提炼但仍保持 seed-only posture 的高风险执行 contracts 包括：

- `.nimi/contracts/execution-packet.schema.yaml`
- `.nimi/contracts/orchestration-state.schema.yaml`
- `.nimi/contracts/prompt.schema.yaml`
- `.nimi/contracts/worker-output.schema.yaml`
- `.nimi/contracts/acceptance.schema.yaml`

### 5.2 Responsibility split inside `.nimi/**`

#### Strict machine structure

必须保持 strict machine structure 的内容：

- methodology core rules
- AI-native spec truth
- contracts
- config
- local execution state
- packet / orchestration / acceptance / evidence metadata

#### Semi-structured

可保持半结构化的内容：

- 探索记录
- worker-output narrative
- closeout narrative
- 部分 rationale

#### Projection-only

不应进入 truth 的内容：

- human-friendly methodology guide
- human-readable spec summary
- onboarding explanation
- review dashboard
- doc projections

这些都应通过 AI/skill/projection layer 派生。

## 6. CLI vs Skills Split

### 6.1 What CLI should own

CLI 应负责：

- package bootstrap
- `.nimi/**` skeleton creation
- AI entrypoint integration
- validation / doctor
- bounded bootstrap mutation
- local truth seeding

不应负责：

- project authority reasoning
- spec reconstruction itself
- project analysis with semantic judgment
- runtime skill execution

### 6.2 What skills should own

真正的 spec reconstruction 是 AI/skill work，而不是脚本工作。

skills 应负责：

- 从现有 docs / README / code conventions / codebase 抽离 authority
- 重建 `.nimi/spec/**`
- 对比 human docs 与 `.nimi/spec/**`
- 在高风险工作中按 methodology 执行 topic / packet discipline

也就是说：

- CLI 负责 bootstrap 和接线
- skills 负责 reasoning-heavy reconstruction and audit

## 7. Install and Bootstrap Experience

目标中的最小体验应是：

1. `npm install -D @nimiplatform/nimi-coding`
2. `npx nimicoding init`
3. 可选：`npx nimicoding init --with-entrypoints`
4. 项目得到 `.nimi/**` bootstrap seed
5. AI 通过入口文件读取 `.nimi/**`
6. AI/skills 基于 `.nimi/**` 继续做 spec reconstruction

### 7.1 Bootstrap behavior already admitted in the current product line

当前已收口的产品方向包括：

- minimal real `init`
- bounded `repair`
- `.nimi/**` bootstrap seed
- `.nimi/contracts/**` machine contract seed
- optional `AGENTS.md` / `CLAUDE.md` managed block integration
- AI-native reconstruction guidance seed
- canonical skill manifest seed
- canonical external handoff seed
- bounded `doctor`
- explicit local-only `closeout`

### 7.2 What bootstrap must not pretend to do

bootstrap 不应谎称：

- skills 已安装
- package 已能执行 skill runtime
- package 已能 self-host methodology execution
- package 已绑定某个 vendor-specific AI runtime

## 8. AI Entrypoint Integration

在用户授权下，CLI 应能更新：

- `AGENTS.md`
- `CLAUDE.md`
- 其他 AI coding 入口文件

但更新方式必须：

- flag-gated
- idempotent
- managed-block bounded
- 不越过项目其余内容

入口文件的作用不是承载完整方法论手册，而是：

- 确保 AI 知道 `.nimi/**` 是 primary truth
- 确保 AI 知道何时使用高风险 execution discipline
- 确保 AI 知道 reconstruction / manifest / handoff 应从哪读

## 9. Skill Manifest and External Handoff Model

这一步是产品从“bootstrap-only”走向“runtime-adjacent”的第一条线。

首个 admitted runtime-adjacent surface 应只到：

- package-level skill manifest
- explicit external handoff truth

不应直接进入：

- real runtime engine
- skill installer
- self-hosted orchestration
- provider-bound execution

### 9.1 Why this matters

如果没有 manifest / handoff truth，AI 只能知道：

- 项目未来需要 skills

却不知道：

- 具体需要哪些 skill surfaces
- 哪些内容属于 external host responsibility
- 何时应该 fail-close

manifest/handoff seed 解决的就是这个空缺。

### 9.2 First runtime-adjacent truth

当前已验证的正确产品方向是：

- `.nimi/config/skill-manifest.yaml`
- `.nimi/methodology/skill-handoff.yaml`
- `.nimi/contracts/spec-reconstruction-result.yaml`
- `.nimi/contracts/doc-spec-audit-result.yaml`

这两者负责：

- naming expected skills
- naming external ownership
- naming context order
- naming hard constraints
- naming reconstruction and audit closeout result shape

但不负责执行。

## 10. Methodology Boundary

`@nimiplatform/nimi-coding` 必须严格区分三层：

### 10.1 Core methodology

包括：

- authority discipline
- packet model
- acceptance/evidence model
- risk-shaped entry
- inline manager-worker default
- continuity-agnostic posture

### 10.2 Product runtime surface

包括：

- CLI bootstrap
- `.nimi/**` truth seeding
- AI entrypoint integration
- skill manifest / handoff truth

### 10.3 Upper engineering extensions

包括：

- manager continuity
- daemon / automation / scheduler
- host-specific runtime bindings
- harness-level orchestration

这些不应成为产品核心追求，否则会把方法论产品拉成 agent runtime 平台。

## 11. Roadmap

### Phase 0: Foundation

已完成 / 已验证方向：

- package identity
- repository foundation
- methodology seed
- minimal init
- bounded repair
- AI entrypoint integration
- reconstruction guidance seed
- skill manifest + handoff seed
- doctor / handoff / closeout early CLI surfaces
- reconstruction + doc-spec-audit result contracts
- seed-only high-risk execution contracts extracted into `.nimi/contracts/**`

### Phase 1: Runtime boundary maturation

下一步建议不是直接上 runtime engine，而是继续做：

- skill/runtime surface design
- host-profile neutrality
- later installer/runtime packet if admitted
- structural target-truth validation and audit closeout hardening

### Phase 2: Reconstruction and audit workflow

待后续 admitted 的方向：

- richer skill definitions
- doc/spec audit workflow
- project-specific reconstruction flow

### Phase 3: Self-hosting discussion

只有当 package 本身成熟到足以自举时，才讨论：

- self-hosting execution
- package-internal packet runtime
- higher-order automation

这不应是早期产品目标。

补充说明：

- execution packet / orchestration-state / prompt / worker-output / acceptance 当前仅以 contract seed 形式存在
- 它们不意味着 package 已拥有 topic runtime、scheduler、automation 或 provider-bound execution

## 12. Current Development Posture

在产品 bootstrap 阶段，开发仍应遵守：

- 主仓 `nimi-coding` 是 formal execution system
- `_external/nimi-coding` 是产品代码目标
- 不假设外部仓已经具备 self-hosting 条件

也就是说：

- 治理仍在主仓
- 代码在外部仓
- 等产品成熟后，再评估是否能反向管理自己

## 13. Recommended Near-Term Sequence

按当前讨论，推荐顺序是：

1. 继续完善 bootstrap truth 和 package-level product surface
2. 保持 skills 为 external handoff，而不是过早进入 runtime ownership
3. 在 runtime/admission 足够清楚后，再考虑 installer / host-profile / runtime packet
4. 将 human-facing explanations 始终作为 projection，而不是 source truth

## 14. Final Position

`@nimiplatform/nimi-coding` 是成立的独立产品方向，而且不是“现有 `nimi-coding` 打包发布”这么简单。

它真正的价值在于：

- 给普通项目安装一层 AI-native governance layer
- 帮项目建立 `.nimi/**` 作为 AI truth
- 帮 AI coding 脱离纯上下文驱动、进入 authority-driven working mode

它的正确产品形态应是：

- `.nimi/**` 作为标准 project-local truth layer
- CLI 负责 bootstrap 和接线
- skills 负责 reconstruction 与 audit
- human-readable 内容全部降为派生 projection
- runtime / self-hosting / continuity 保持后置，不抢占方法论核心

这才是 `@nimiplatform/nimi-coding` 与一般 AI coding tooling 的本质差异。
