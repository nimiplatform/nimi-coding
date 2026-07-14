# Nimi Coding

Nimi Coding 是面向 AI 原生开发的方法论与 spec 治理包。它提供明确的权威模型、canonical spec 构建 contract、受管治理投影和确定性校验。

Nimi Coding 不控制 AI host。规划、委派、实现、审查与任务状态由 host 原生能力负责。

## 安装与初始化

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

初始化只创建或更新：

- `.nimi/config/**`：包默认配置与 host 自有的 spec 输入配置
- `.nimi/contracts/**`：权威、taxonomy、placement 与审计 contract
- `.nimi/methodology/**`：推理原则与 spec 构建方法论
- `AGENTS.md`、`CLAUDE.md` 中的受管说明块

产品权威始终位于 `.nimi/spec/**`。本地生成证据位于 `.nimi/local/state/spec-generation/**`，不能成为产品权威。

## 核心命令

```bash
pnpm exec nimicoding start --yes
pnpm exec nimicoding sync --check
pnpm exec nimicoding doctor --json

pnpm exec nimicoding classify-spec-tree --root .nimi/spec --json
pnpm exec nimicoding generate-spec-migration-plan --root .nimi/spec --json

pnpm exec nimicoding validate-spec-tree -- .nimi/spec
pnpm exec nimicoding validate-spec-audit -- .nimi/local/state/spec-generation/spec-generation-audit.yaml
pnpm exec nimicoding validate-placement --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-table-family --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-projection-edges --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-guidance-bodies --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-domain-admission --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-spec-governance --profile nimi --scope all
pnpm exec nimicoding validate-ai-governance --profile nimi --scope all
```

分类与迁移计划命令只做分析，不修改源文件；迁移计划是本地证据，不是执行调度。

## 权威模型

1. host 的 `.nimi/spec/**` 是产品 canonical authority。
2. 包内 methodology 与 contracts 保持包权威，并投影到 `.nimi/{methodology,contracts,config}/**`。
3. 生成视图、审计证据和运行态数据都不是权威。
4. 未分类 placement 与未解决的语义分叉必须 fail closed。

规范入口：`methodology/spec-reconstruction.yaml`、`contracts/surface-taxonomy.schema.yaml`、`contracts/placement-contract.schema.yaml`。
