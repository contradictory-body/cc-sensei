# npm 包名决议（已确定）

> 检查日期：2025-06-11
> 检查方式：`npm view <name>`，404 表示未占用
> **最终决议：`cc-sensei`** — 已确认未被占用

## 候选名占用情况

| 候选名 | 长度 | npm 状态 | GitHub 搜索压力 | 适配 npx 体验 |
|---|---|---|---|---|
| `cc-sensei` | 9 | ✅ 未占用 | 零冲突 | ✅ 极短、记忆点强 |
| `agent-arch-oracle` | 17 | ✅ 未占用 | 零冲突 | ✅ 平衡 |
| `cc-oracle` | 9 | ✅ 未占用 | "cc" 歧义大（C compiler / credit card） | ✅ 极短 |

## 决议

### 🟢 GitHub Repo 名 → `cc-sensei`

理由：
- 短（9 字符）、catchy、好念
- CC = Claude Code，sensei = 师父，角色感明确
- Google/npm 零碰撞

### 🟢 npm 包名 → `cc-sensei`

理由：
- 与 GitHub 仓库名完全一致，零心智负担
- `npx cc-sensei` 极简
- 已确认未被占用

### 🟡 备选（如发现 `agent-arch-oracle` 临门被占）

按优先级回退：
1. `claude-code-oracle` — 强 SEO，但稍显"啃 cc 标"
2. `cc-mcp-oracle` — 全字母可读，留有"cc = claude code"提示
3. `agent-architecture-mcp` — 退回完整名 + mcp 后缀

**禁用**：
- `cc-oracle`（"cc" 太宽泛）
- `aao` / `aao-mcp` 等 3 字母缩写（搜不到）

## package.json 调整建议

发布前，把 `package.json` 改成：

```json
{
  "name": "cc-sensei",
  "version": "1.0.0",
  "description": "Your AI's shortcut to mastering Claude Code's architecture — 310K lines distilled into 32 queryable modules via MCP.",
  "bin": {
    "cc-sensei": "./dist/server.js"
  },
  "files": [
    "dist/",
    "knowledge/",
    "claude-code-main/MODULE_NOTES/",
    "README.md",
    "README_zh.md",
    "LICENSE"
  ],
  "keywords": [
    "mcp",
    "mcp-server",
    "claude-code",
    "ai-agent",
    "agent-architecture",
    "llm",
    "developer-tools",
    "anthropic"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/contradictory-body/cc-sensei.git"
  },
  "license": "MIT"
}
```

> 注意 `files` 不要包含 `claude-code-main/src/`（会让包体积膨胀到几十 MB）；只发布 MODULE_NOTES。
> 用户运行时如需读源码，可通过 `CC_SOURCE_ROOT` 环境变量指向本地源码。

## 发布前 checklist

- [ ] 确认 `cc-sensei` 在发布当天仍未被抢注（再 `npm view` 一次）
- [ ] `package.json` 已改名 + 加 `bin` 字段 ✅
- [ ] `dist/server.js` 顶部 shebang `#!/usr/bin/env node` 存在且唯一（参考此前 tsup 修复经验）
- [ ] `chmod +x dist/server.js` 后本地 `npx ./` 自测
- [ ] `npm pack --dry-run` 检查体积，期望 < 10 MB
- [ ] `npm login` 后 `npm publish --access public`
- [ ] 发布后 README 顶部加：`npx cc-sensei` 一行示例
