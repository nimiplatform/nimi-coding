# Nimi Coding

Nimi Coding 是面向 AI 原生开发的方法论与 spec 治理包。它提供明确的权威模型、canonical spec 构建 contract、受管治理投影和确定性校验。

Nimi Coding 不控制 AI host。规划、委派、实现、审查与任务状态由 host 原生能力负责。

## 安装与初始化

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

初始化采用默认拒绝的精确 allowlist，只创建或更新：

- `.nimi/config/spec-generation-inputs.yaml`：host 自有的重构输入
- `.nimi/contracts/domain-admission.schema.yaml`：host profile 的 domain admission override
- `.nimi/methodology/authority-authoring.yaml`：日常 authoring 的紧凑指南
- `AGENTS.md`、`CLAUDE.md` 中的受管说明块

产品权威始终位于 `.nimi/spec/**`。本地生成证据位于 `.nimi/local/state/spec-generation/**`，不能成为产品权威。

Canonical YAML 文件是由 `format` 与非空 `units` 组成的封闭 container，可包含多个显式 authority unit。Unit identity 不依赖文件名、源顺序、移动或 regroup；Canonical Markdown 暂时保持单 unit profile。

## 核心命令

```bash
pnpm exec nimicoding authority fmt .nimi/spec/authority/example.authority.yaml
pnpm exec nimicoding authority check .nimi/spec/authority --json
pnpm exec nimicoding authority compile .nimi/spec/authority --json
pnpm exec nimicoding authority query .nimi/spec/authority rule.checkout-session --max-bytes 32768 --json
pnpm exec nimicoding authority context .nimi/spec/authority rule.checkout-session --max-units 8 --max-bytes 65536 --json
pnpm exec nimicoding authority diff before/authority after/authority --max-bytes 262144 --json
pnpm exec nimicoding authority impact before/authority after/authority --dispositions .nimi/local/authority-impact-dispositions.yaml --max-bytes 262144 --json

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

`authority diff` 和 `authority impact` 的 `--max-bytes` 只约束 compact semantic diff/impact payload，不约束完整 CLI report 或 compiler diagnostics；超限返回 null semantic payload，不做截断。

分类与迁移计划命令只做分析，不修改源文件；迁移计划是本地证据，不是执行调度。

## 权威模型

1. host 的 `.nimi/spec/**` 是产品 canonical authority。
2. 包内 methodology 与 contracts 保持 installed-package 权威；仅投影上述三个明确 allowlist 文件。
3. 生成视图、审计证据和运行态数据都不是权威。
4. 未分类 placement 与未解决的语义分叉必须 fail closed。

规范入口：`methodology/spec-reconstruction.yaml`、`contracts/surface-taxonomy.schema.yaml`、`contracts/placement-contract.schema.yaml`。
