# Nimi Coding

Nimi Coding 提供紧凑的 canonical authority 方法论、formatter、私有 compiler primitives 与确定性的 fail-closed gates。项目自行撰写产品语义；Nimi Coding 不生成产品语义，也不控制 AI host 的规划、实现、审查或任务状态。

## 安装与启动

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

`start` 只创建或维护：

- `.nimi/methodology/authority-authoring.yaml`（AI 可见的紧凑 authoring guide）；
- `AGENTS.md` 与 `CLAUDE.md` 中的 managed instruction blocks；
- ignored `.nimi/local/` root 及对应 `.gitignore` 条目。

它不会创建 `.nimi/spec`、authority 示例、产品语义、config/contracts 投影、cache、migration state 或 generation-audit skeleton。

## Canonical 工作流

项目只在 `.nimi/spec/**` 中撰写 canonical `*.authority.yaml` 或 `*.authority.md`。历史 Markdown kernel、table、guidance、registry、generated view 与 evidence 不会被推断或接受。

```bash
pnpm exec nimicoding authority fmt .nimi/spec/example.authority.yaml
pnpm exec nimicoding authority check .nimi/spec --json

# check 成功后，可选使用私有 compiler/read primitives
pnpm exec nimicoding authority compile .nimi/spec --json
pnpm exec nimicoding authority query .nimi/spec rule.checkout-session --max-bytes 32768 --json
pnpm exec nimicoding authority context .nimi/spec rule.checkout-session --max-units 8 --max-bytes 65536 --json
pnpm exec nimicoding authority diff before/spec after/spec --max-bytes 262144 --json
pnpm exec nimicoding authority impact before/spec after/spec --dispositions .nimi/local/authority-impact-dispositions.yaml --max-bytes 262144 --json
```

`authority check` 是 `.nimi/spec` 唯一 conformance gate。它递归拒绝 unsupported file、symlink、非 canonical bytes，以及非法 grammar、identity、owner/lifecycle 与 relation。

`context` 返回 root unit 通过已声明 `applies_to` 与 `supersedes` 关系形成的完整有界 outgoing interpretation closure；它不是完整 task context。预算失败不返回 partial packet。

`impact` 只报告由已声明关系导出的 review obligations；disposition 文本不能证明 implementation、consumer 或 test 已同步。Diff/impact 预算失败不返回 partial semantic payload。

## Projection lifecycle

```bash
pnpm exec nimicoding start --yes
pnpm exec nimicoding sync --check
pnpm exec nimicoding sync --apply
pnpm exec nimicoding doctor --json
pnpm exec nimicoding clear --yes
```

Projection ownership 是精确的：Nimi Coding 只拥有紧凑 guide 的精确路径与标记 block。`.nimi/config`、`.nimi/contracts`、`.nimi/methodology` 或其他位置的无关 host 文件不会被 sync 检查。精确 deprecated package projection path 会使 `sync --check` 失败，但不会被自动删除。

## 可选 L3 repository governance

`validate-ai-governance` 为已有 repository-level consumer 保留。它执行确定性 repository checks，不 admission `.nimi/spec`，不执行 host task，也不聚合 host workflow command。

```bash
pnpm exec nimicoding validate-ai-governance --profile my-project --scope agents-freshness
```

## Surface 边界

- **Public：** 已文档化的 CLI commands 与 package documentation；
- **Canonical / project-owned：** `.nimi/spec/**/*.authority.{yaml,md}`；
- **Projected / AI-visible / package-owned：** `.nimi/methodology/authority-authoring.yaml` 与标记 instruction blocks；
- **Local / non-authoritative：** `.nimi/local/**`；
- **Package-internal：** grammar contracts、私有 AuthorityIR/SourceMap 与 compiler implementation。

SQLite、cache、incremental compilation、embedding、search、visualization、AI execution、Atlas 与历史格式兼容均未 admitted。
