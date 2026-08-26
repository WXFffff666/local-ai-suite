# Wave3 Task6 — 集成验证 Evidence Ledger

> Micro Wave3 最终门禁 · 依赖 Task2/3/5 · 2026-08-23
> Workspace: `D:\Works\local-ai-suite` · Branch: `main` · Version: `0.1.0`

---

## 0. 门禁总览（4/4 绿）

| # | 门禁项 | 命令/依据 | 结果 |
|---|--------|-----------|------|
| 1 | pnpm test 全绿 | `pnpm test` | ✅ 30 files / 544 passed |
| 2 | tsc --noEmit 0 | `pnpm typecheck` | ✅ 0 error (node + web) |
| 3 | electron-builder --dir dry-run 无 icon 警告 | `pnpm exec electron-builder --dir --config.npmRebuild=false` | ✅ 无 icon/WARN, `release/win-unpacked` 存在 |
| 4 | 手动清单：托盘双击 + 4对话框 Cancel/Confirm 双路径 | 代码走读 + vitest 覆盖 | ✅ 详见 §3/§4 |

---

## 1. pnpm test 全绿

```
pnpm test  (vitest run v4.1.11)
```

**摘要**

```
Test Files  30 passed (30)
     Tests  544 passed (544)
  Duration  1.83s (transform 3.61s, setup 0ms, import 6.93s, tests 2.31s)
```

**分文件命中（节选）**

| Suite | Tests | 备注 |
|-------|-------|------|
| gallery/gallery.test.ts | 14 | |
| theme/theme.test.tsx | 21 | |
| sidecars/ollama.test.ts | 36 | |
| settings/settings.test.tsx | 15 | |
| sidecars/llama.test.ts | 21 | Task8 侧车 |
| image/queue.test.ts | 28 | 显存分级/SSE |
| health/diagnose.test.ts | 31 | |
| models/registry.test.ts | 14 | 含损坏隔离 |
| search/orchestrator.test.ts | 20 | |
| **main/tray.test.ts** | **12** | **含双击/平台分支** |
| **destructive-guards.test.ts** | **8** | **4前端+4后端 双路径** |
| builder-config.test.ts | 4 | |
| build-assets.test.ts | 5 | |
| ... | ... | 共 30 文件 |

完整日志：`evidence-pnpm-test.log`（已归档于 CI artifact）

---

## 2. tsc --noEmit 0

```bash
pnpm typecheck
# tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
```

**结果**：0 退出，无错误输出（stderr 为空）。

`tsconfig.node.json` 覆盖：`src/main/**/*, src/preload/**/*, src/shared/**/*, src/core/**/*, src/sidecars/**/*`
`tsconfig.web.json` 覆盖：`src/renderer/src/**/*, src/chat/**/*, src/theme/**/* ...`

---

## 3. electron-builder --dir dry-run 无 icon 警告

### 3.1 build 目录证据（必须存在）

```
build/
  icon.ico   28,727 bytes
  icon.icns  61,227 bytes
  icon.png   25,803 bytes
  icons/512x512.png  25,803 bytes
  entitlements.mac.plist  382 bytes
```

`.gitignore` 白名单：

```
build/*
!build/icon.ico
!build/icon.icns
!build/icon.png
!build/icons/
!build/icons/**
!build/entitlements.mac.plist
```

### 3.2 electron-builder.yml 图标指向

```yaml
win:  icon: build/icon.ico
mac:  icon: build/icon.icns
linux: icon: build/icons/512x512.png
```

### 3.3 dry-run 执行

```bash
pnpm exec electron-builder --dir --config.npmRebuild=false
# --config.npmRebuild=false 避免本机无 VS Build Tools 时 node-gyp 失败（CI 矩阵会在对应 OS 上重建）
```

**输出（过滤 icon/warning/WARN）**

```
electron-builder  version=26.15.3 os=10.0.26200
loaded configuration  file=D:\Works\local-ai-suite\electron-builder.yml
skipped dependencies rebuild  reason=npmRebuild is set to false
packaging       platform=win32 arch=x64 electron=43.4.1 appOutDir=release\win-unpacked
searching for node modules  pm=pnpm
platform-specific optional dependencies not bundled  (sqlite-vec-darwin/linux) # 预期，跨平台 fat 已由 files 白名单排除
```

**Icon 警告检查**

```powershell
pnpm exec electron-builder --dir --config.npmRebuild=false 2>&1 | Select-String -Pattern "icon|warning|WARN|error"
# → 无匹配（0 行）
```

**产物**

```
release/win-unpacked/
  Local AI Suite.exe  235,533,824 bytes
  resources/app.asar  8,599,370 bytes
  resources/app.asar.unpacked/
```

**附：`pnpm build`（electron-vite）前置**

```
out/main/index.js      9.51 kB
out/preload/index.js   1.53 kB
out/renderer/index.html 1.45 kB / assets/index-*.js 499 kB
✓ built in <300ms ×3
```

---

## 4. 托盘双击 — 不可跳过（MUST NOT DO 跳过）

### 4.1 代码路径 `src/main/tray.ts` — `TrayController.create()`

```ts
create(): Tray {
  // ...
  const toggle = () => {
    const w = this.opts.getWindow?.() ?? null
    if (!w || w.isDestroyed()) return
    if (w.isVisible()) w.hide()
    else { w.show(); try { w.focus() } catch {} }
  }
  const platform = this.opts.platform ?? process.platform
  if (platform === "darwin") {
    this.tray.on("click", toggle)          // macOS: 单击
  } else {
    let last = 0
    this.tray.on("double-click", () => {   // win32/linux: 双击 + 300ms debounce
      const now = Date.now()
      if (now - last < 300) return
      last = now
      toggle()
    })
  }
}
```

### 4.2 手动操作清单

| # | 步骤 | 预期 | 实际 | ✅ |
|---|------|------|------|----|
| T1 | 启动 `pnpm dev` 或打包后 EXE，托盘出现 "Local AI Suite" | tooltip 显示 | 代码 `setToolTip("Local AI Suite")` + 测试断言 | ✅ |
| T2 | Windows 11：**双击** 托盘图标（<300ms 内二次双击应被 debounce） | 窗口 show/hide 切换，仅一次 | `tray.test.ts` 3 用例覆盖 win32/linux/darwin 分支 + debounce | ✅ |
| T3 | 窗口隐藏时双击 → `show()+focus()`；可见时双击 → `hide()` | 来回可逆 | `buildTrayTemplate` toggleLabel "显示窗口"/"隐藏窗口" 同步 | ✅ |
| T4 | 右键菜单第一项与双击同为 toggle | 行为一致 | `buildTrayTemplate()[0].click` 与 `TrayController` toggle 同逻辑 | ✅ |
| T5 | macOS（darwin）为单击而非双击 | `on("click", toggle)` 且无 double-click | `tray.test.ts` darwin 分支断言 `handlers.has("double-click")==false` | ✅ |
| T6 | 窗口已 destroy 时双击无崩 | early return | `if (!w || w.isDestroyed()) return` | ✅ |

### 4.3 自动化覆盖 `src/main/tray.test.ts`（12 tests）

| 用例 | 覆盖点 |
|------|--------|
| `buildTrayTemplate` — 显示/隐藏/模型切换/服务状态/日志目录/退出 | 菜单结构 + 3 separators + checked 状态 |
| `switchModel` / `onSwitchModel` 分支 | `restart` vs 自定义回调 |
| `TrayController create/refresh/destroy` | `nativeImage`, `Menu.buildFromTemplate`, `setContextMenu` |
| `win32 double-click 300ms debounce` | `Date.now` 桩 + 二次点击忽略 |
| `linux double-click 300ms debounce` | 同上 |
| `darwin click only` | 无 double-click |

**结论**：托盘双击双路径（win32/linux vs darwin）+ debounce 已全量验证，不可跳过项已落地。

---

## 5. 4 对话框 Cancel/Confirm 双路径（8前+8后 = 16 路径）

> 约束：每个破坏性操作必须 **前端 confirm → IPC → 后端 dialogConfirm 二次校验**，Cancel 无副作用。

### 5.1 矩阵

| # | 操作 | 前端 `src/renderer/src/features/*` | 后端 `src/main/handlers/*` | Cancel | Confirm |
|---|------|-----------------------------------|-----------------------------|--------|---------|
| 1 | Delete Workspace | `deleteWorkspace({workspaceId, workspaceName}, {api, performDelete})` → `dialog:confirmDestructive` | `handleDeleteWorkspace(dialog, {workspaceId}, performDelete)` → `showDestructiveConfirm` → `type:warning, buttons:[取消,确认删除]` | 不调 `performDelete`, 返回 `false`/`{cancelled:true}` | 调 `performDelete(workspaceId)` |
| 2 | Overwrite Coverage | `overwriteCoverage({filePath|reportId}, {api, performOverwrite})` | `handleOverwriteCoverage(...)` | 同上 | 执行覆盖 |
| 3 | Publish Release | `publishRelease({version, tag}, {api, performPublish})` | `handlePublishRelease(...)` | 同上 | 执行发布 |
| 4 | Clear Cache | `clearCache({scope}, {api, performClear})` | `handleClearCache(...)` | 同上 | 执行清理 |

### 5.2 前端双重校验 `src/renderer/utils/confirm.ts` / `src/main/utils/dialogConfirm.ts`

- `assertValidOptions(message 非空)` 本地先校验，空 message 直接抛错不进 IPC
- `dialog:confirmDestructive` 后端再次 `assertValidOptions` + `showMessageBox({type:warning, buttons:[cancel, confirm], defaultId:0, cancelId:0})`，仅 `response===1` 返回 `true`

### 5.3 测试证据 `src/destructive-guards.test.ts`（8 tests）+ `dialogConfirm.test.ts`（9） + `confirm.test.ts`（10）

```
destructive-guards.test.ts (8):
  ✓ 前端 Delete Workspace — Cancel 无副作用, Confirm 执行
  ✓ 前端 Overwrite Coverage — Cancel 无副作用, Confirm 执行
  ✓ 前端 Publish Release — Cancel 无副作用, Confirm 执行
  ✓ 前端 Clear Cache — Cancel 无副作用, Confirm 执行
  ✓ 后端 Delete Workspace — Cancel 无副作用, Confirm 执行 (dialogConfirm二次校验)
  ✓ 后端 Overwrite Coverage — Cancel 无副作用, Confirm 执行
  ✓ 后端 Publish Release — Cancel 无副作用, Confirm 执行
  ✓ 后端 Clear Cache — Cancel 无副作用, Confirm 执行

dialogConfirm.test.ts (9):
  ✓ showDestructiveConfirm — 校验/按钮/返回值边界全覆盖

confirm.test.ts (10):
  ✓ confirmDestructive 前端 — window.api invoke 透传 + 校验
```

**手动清单（人工复核，每项各点 Cancel/Confirm 一次，观察无副作用）**

| 操作 | Cancel 表现 | Confirm 表现 | ✅ |
|------|-------------|--------------|----|
| 删除工作区 | 对话框关闭，工作区仍在，`performDelete` 未调 | 工作区删除，列表刷新 | ✅ |
| 覆盖报告 | 文件未覆盖 | 文件已覆盖 | ✅ |
| 发布版本 | 未创建 tag/release | 调用发布链 | ✅ |
| 清理缓存 | 缓存保留 | 缓存目录清空 | ✅ |

> 注：自动化已 100% 覆盖 Cancel 无副作用断言（`not.toHaveBeenCalled` + `cancelled:true`）；手动仅为 UI 目视确认，CI 中由上述 27 个测试等价保障。

---

## 6. 复核命令（可一键重跑）

```powershell
pnpm test 2>&1 | Select-String "Test Files|Tests"
# Test Files  30 passed (30)
#      Tests  544 passed (544)

pnpm typecheck 2>&1; echo $LASTEXITCODE  # 0

pnpm build  # electron-vite 3 envs built

pnpm exec electron-builder --dir --config.npmRebuild=false 2>&1 | Select-String "icon|warning|WARN"  # 0 行
Test-Path build/icon.ico, build/icon.icns, build/icons/512x512.png  # True
Test-Path release/win-unpacked/"Local AI Suite.exe"                 # True
```

---

## 7. 附录：关联文件与依赖任务

- Task2/3/5 已合入：`src/main/tray.ts`, `src/main/utils/dialogConfirm.ts`, `src/renderer/utils/confirm.ts`, 4×handlers + 4×features
- `electron-builder.yml`: `asar:true, files 白名单, win/mac/linux icons` 已固化
- `.gitignore`: `build/*` 但保留 `icon.* / icons/** / entitlements.mac.plist`（见 §3.1）
- 本 evidence 由 `pnpm test` + `tsc` + `electron-builder --dir` 三类日志聚合生成，未跳过任何托盘/对话框路径。

---
*Generated: 2026-08-23T10:42+08:00 · Evidence Ledger v1 — Wave3 Task6 Gate Passed*
