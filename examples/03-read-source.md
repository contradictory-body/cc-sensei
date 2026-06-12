# Example 3 — Source: read `services/compact/microCompact.ts` lines 1–60

> After learning the design, you want to read the actual source. `get_source_code` accepts both `src/...` and bare paths, supports line ranges, and rejects path traversal.

## Tool call

```json
{
  "tool": "get_source_code",
  "arguments": {
    "file_path": "services/compact/microCompact.ts",
    "start_line": 1,
    "end_line": 60
  }
}
```

**Latency:** 103 ms · **Response size:** 3,032 chars

## Response

```
## src/services/compact/microCompact.ts (lines 1-60 of 531)

```
   1│import { feature } from 'bun:bundle'
   2│import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
   3│import type { QuerySource } from '../../constants/querySource.js'
   4│import type { ToolUseContext } from '../../Tool.js'
   5│import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
   6│import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
   7│import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
   8│import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
   9│import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
  10│import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
  11│import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
  12│import type { Message } from '../../types/message.js'
  13│import { logForDebugging } from '../../utils/debug.js'
  14│import { getMainLoopModel } from '../../utils/model/model.js'
  15│import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
  16│import { jsonStringify } from '../../utils/slowOperations.js'
  17│import {
  18│  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  19│  logEvent,
  20│} from '../analytics/index.js'
  21│import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
  22│import { roughTokenCountEstimation } from '../tokenEstimation.js'
  23│import {
  24│  clearCompactWarningSuppression,
  25│  suppressCompactWarning,
  26│} from './compactWarningState.js'
  27│import {
  28│  getTimeBasedMCConfig,
  29│  type TimeBasedMCConfig,
  30│} from './timeBasedMCConfig.js'
  31│
  32│// Inline from utils/toolResultStorage.ts — importing that file pulls in
  33│// sessionStorage → utils/messages → services/api/errors, completing a
  34│// circular-deps loop back through this file via promptCacheBreakDetection.
  35│// Drift is caught by a test asserting equality with the source-of-truth.
  36│export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
  37│
  38│const IMAGE_MAX_TOKEN_SIZE = 2000
  39│
  40│// Only compact these tools
  41│const COMPACTABLE_TOOLS = new Set<string>([
  42│  FILE_READ_TOOL_NAME,
  43│  ...SHELL_TOOL_NAMES,
  44│  GREP_TOOL_NAME,
  45│  GLOB_TOOL_NAME,
  46│  WEB_SEARCH_TOOL_NAME,
  47│  WEB_FETCH_TOOL_NAME,
  48│  FILE_EDIT_TOOL_NAME,
  49│  FILE_WRITE_TOOL_NAME,
  50│])
  51│
  52│// --- Cached microcompact state (ant-only, gated by feature('CACHED_MICROCOMPACT')) ---
  53│
  54│// Lazy-initialized cached MC module and state to avoid importing in external builds.
  55│// The imports and state live inside feature() checks for dead code elimination.
  56│let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
  57│let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
  58│let pendingCacheEdits:
  59│  | import('./cachedMicrocompact.js').CacheEditsBlock
  60│  | null = null
```
```
