# Learnings

## T5 — Release workflow (`.github/workflows/release.yml` + `electron-builder.yml`)

- **触发与矩阵**: `on.push.tags: v*` 仅标签触发；单 job `release` 用 `matrix.include` 三行显式钉 `windows-latest / macos-latest / ubuntu-22.04`，满足「钉 ubuntu-22.04」审计点，比 `matrix.os: [..]` 更易为每平台定制 env/step。
- **钉版本**: `pnpm/action-setup@v4` `version: 9.x` + `actions/setup-node@v4` `node-version: '20.x'` + `cache: pnpm`；`ubuntu-22.04` 固定而非 `ubuntu-latest`，避免 runner 镜像漂移导致 xvfb/libgtk 行为差异。
- **Linux 图形**: `xvfb-run -a pnpm exec electron-builder --publish always` 仅在 `matrix.platform == 'linux'` 分支执行；`if: matrix.platform != 'linux'` / `== 'linux'` 拆两步，避免 Windows/macOS 无 xvfb 报错。`shell: bash` 统一跨平台。
- **发布语义**: `electron-builder --publish always` 由 CI 触发，`electron-builder.yml` 中 `publish: { provider: github, releaseType: draft, publishAutoUpdate: false }` 确保推送 `v0.0.1-test` 生成 *draft* Release 而非直接公开；本地执行不带 `--publish` 时不上传。
- **签名占位**: `CSC_LINK / CSC_KEY_PASSWORD / APPLE_ID / APPLE_ID_PASSWORD / APPLE_TEAM_ID` 均以 `${{ secrets.* }}` 占位，绝不硬编码；`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 由 GitHub 自动注入。`mac.hardenedRuntime: true` 与 `entitlements` 指向占位路径，缺文件时需自备 `build/entitlements.mac.plist`。
- **actionlint 自检**: `Validate workflows with actionlint` step 优先 `command -v actionlint`，缺失时 `go install github.com/rhysd/actionlint/cmd/actionlint@latest` 并回退到 `~/go/bin` / `$(go env GOPATH)/bin`；本地用 `~/.cache/actionlint/actionlint.exe` 校验 `exit 0`，`on:` 的 YAML 1.1 `true` 别名不影响 actionlint，但 `python yaml.safe_load` 会将 `on` 解析为 `True`，属误报。
- **验证**: `actionlint .github/workflows/release.yml` 本地 0 退出；`python -c` 断言 `v* / windows-latest / macos-latest / ubuntu-22.04 / 20.x / 9.x / xvfb-run / --publish always / secrets.*` 全命中；`act --dryrun` 受限于 Windows 未装 act，以 YAML 解析+actionlint 双重保障等价。
- **坑**: `copyright: Copyright ©` 含非 ASCII，在 GBK 控制台下 `python json.dumps(ensure_ascii=False)` 会 `UnicodeEncodeError`，改为 `(c)` 规避；`electron-builder.yml` 的 `directories.buildResources: build` 需确保 `build/icon.*` 存在否则打包警告但不阻塞 draft 流程。

## T6 — Release workflow 提交即构建 + tag 才发布（branch trigger + publish 条件分流）

- **分支触发补齐**: `on.push` 原仅 `tags: 'v*'`，补 `branches: [main, master]`，实现「提交即构建」(push 到 main/master 即跑矩阵构建)；tag `v*` 仍保留用于 Release 发布，满足「提交即构建、tag 即发布」需求。
- **发布分流**: `electron-builder` 原固定 `--publish always`，改为 shell 条件 `if [[ "${{ github.ref }}" == refs/tags/v* ]]; then --publish always else --publish never`，tag 推触发 `always` 创建 draft Release，非 tag 分支构建仅本地打包验证不上抛。`matrix.platform != 'linux'` 与 `== 'linux'` 两分支均改 `xvfb-run -a` 保持一致，`shell: bash` 保证 `[[` 可用。
- **产物留存**: 新增 `actions/upload-artifact@v4` `if: always()`，`name: LocalAISuite-${{ matrix.platform }}-${{ github.sha }}` 避免三平台矩阵产物名冲突，`path: release/*` 对应 `electron-builder.yml directories.output: release`，`if-no-files-found: warn` + `retention-days: 14`，分支构建可在 Actions 页直接下载安装包，无需 draft Release。
- **保留项**: `pnpm 9.x / Node 20.x / xvfb / actionlint 自检 / CSC_LINK/CSC_KEY_PASSWORD/APPLE_ID*` 占位原样保留，未硬编码 secrets；`permissions: contents: write` 供 `--publish always` 时 `GH_TOKEN` 创建 draft 必要。
- **验证**: `pnpm build` (electron-vite) 0 退出；`actionlint` wasm 本地校验 0 错误；`on.push.branches` + `tags: v*` + `xvfb-run` + `upload-artifact` 全命中字符串断言。
- **Lesson**: 提交即构建必须显式声明 `branches`，仅 `tags` 会导致日常 push 失活；`--publish never` 分支配合 `upload-artifact` 才能在不污染 Release 的情况下保留构建证据；`github.ref` 的 `refs/tags/v*` 判别比 `github.ref_name` 更稳，避免分支名 `v*` 误触发。

## T7 — Storage db.ts 双库持久化（better-sqlite3 + sqlite-vec 可选）

- **双库单例**: `getDb()` -> `chat.db` 主库，`getVecDb()` -> `vec.db` 向量库，模块级 `chatDb/vecDb` 缓存 + `.open` 检查，`closeDb()` 清空句柄后下次 `getDb()` 重建，天然支持“删除文件后重建”（`ensureDbDir` + `new BetterSqlite3(path)` 自动建文件）。
- **migrate**: 导出 `migrate(db)` 执行 SQL，优先读取 `migrations/001-init.sql`（多候选路径兼容 vitest/src 与 out/main 编译后），缺失时回退内联最小 schema，均用 `IF NOT EXISTS` 幂等；`openDatabase` 内自动调用，调用方可单独对任意 Database 复用。
- **vector 可选**: `tryLoadVecExtension(db)` 动态 `require('sqlite-vec')` 并 `vec.load(db)`，try/catch 包裹，失败仅置 `vecAvailable=false`，`vec.db` 仍以普通 SQLite 打开，`getVecDb()` 永不抛错，保证无 sqlite-vec 时可运行；`isVecAvailable()` 供上层决定是否走向量检索。
- **路径**: `getDbDir()` 优先 `electron.app.getPath('userData')`，失败回退 `process.cwd()/userData`（测试友好）；`getChatDbPath/getVecDbPath` 供测试断言/清理；`pragma journal_mode=WAL / busy_timeout=5000 / foreign_keys=ON` 均 try/catch。
- **合规**: 依赖 `better-sqlite3@13 MIT` + `sqlite-vec@0.1.9 MIT OR Apache-2.0`，未引入 AGPL；`require('better-sqlite3')` 动态引入配合 `electron-vite externalizeDepsPlugin` 避免打包进 renderer。
- **验证**: `pnpm --filter local-ai-suite typecheck` `tsconfig.node.json + tsconfig.web.json` 0 退出；`getDb()` 单例与 `closeDb()` 后重建手动验证通过。

## T7 — Storage 001-init.sql 三表迁移（chats/messages/vectors）

- **文件**: src/main/storage/migrations/001-init.sql 幂等迁移，db.ts:resolveMigrationSql/migrate(db) 通过多候选路径读取后 db.exec(sql) 执行，IF NOT EXISTS 保证重复执行安全；缺文件时回退内联最小 schema。
- **chats**: id TEXT PRIMARY KEY, 	itle TEXT NOT NULL DEFAULT 'New Chat', created_at/updated_at INTEGER NOT NULL。
- **messages**: id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, ole TEXT CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at INTEGER + idx_messages_chat_id 索引。
- **vectors**: id TEXT PRIMARY KEY, chat_id TEXT, content TEXT NOT NULL, embedding BLOB, created_at INTEGER + idx_vectors_chat_id 索引；BLOB 存向量，sqlite-vec 可选扩展不阻塞建表。
- **不覆盖**: 已存在迁移不覆写，仅校验 CREATE TABLE IF NOT EXISTS 三表及关键列命中；适用 T7 子任务3/4。

## T7 — storage.test.ts 三用例（config读写 / migrate / 删除重建）

- **隔离**: `mkdtempSync(join(tmpdir(), 'las-storage-'))` + `process.chdir(tmpDir)` + `afterEach: closeDb() + chdir(origCwd) + rmSync(tmpDir)`，配合 `vi.mock('electron', () => { app:{getPath: throw}})` 强制回退到 `process.cwd()/userData`，绝不污染真实 `userData/`（验证 `userData` 不存在）。
- **electron mock 坑**: `config.ts/db.ts` 均 `require('electron')` 动态加载，无 mock 时 vitest 会触发真实 `electron` 包加载并 `Downloading Electron binary...` 导致单测 >5s 超时；`vi.mock('electron')` 必须置于 `import {config,db}` 之前（hoisted），factory 内 `throw` 让 `getConfigPath/getDbDir` 走 fallback。
- **三用例**: ① config读写 — `getConfig()==DEFAULT` → `setConfig({theme:'dark',locale:'en-US'})` 持久化到 `getConfigPath()` → 回读合并 → `resetConfig()==DEFAULT`；② migrate — `getDb()` 后 `sqlite_master` 校验 `chats/messages/vectors` 三表 + `PRAGMA table_info` 关键列 + 索引 `idx_*` + `migrate(db)` 幂等 + 插入一条 `chats/messages` 验证约束；③ 删除重建 — 写入1行 → `closeDb()` → `unlinkSync(chat.db[-wal/-shm], vec.db[-wal/-shm])` → `getDb()` 重建空表 `count==0` 且可再写入。
- **验证**: `pnpm test` 3文件21用例通过（whitelist 3 + SidecarManager 15 + storage 3），`storage.test.ts` 单文件 99-111ms；WAL/SHM 一并删除否则重建时可能残留。

## T8 — 推理侧车 llama.cpp server 封装（src/sidecars/llama.ts）

- **复用 SidecarManager**: `LLAMA_HOST=127.0.0.1` / `LLAMA_PORT=11435` / `LLAMA_HEALTH_URL=http://127.0.0.1:11435/health` 强制断言，`LLAMA_COMPLETION_URL=http://127.0.0.1:11435/completion`；`buildLlamaArgs({modelPath,ctxSize=4096,port,host,extraArgs})` 产出 `--host 127.0.0.1 --port 11435 --ctx-size 4096 --model <gguf>`，host 非 127.0.0.1 直接抛错，`port/ctxSize/extraArgs` 透传；`resolveLlamaBin(explicit)` 优先级 `explicit > LLAMA_BIN env > llama-server`。
- **工厂**: `createLlamaSidecarConfig(opts): ISidecar & {modelPath?}` 组装 `name=llama/bin=args/port/healthUrl`，`createLlamaSidecar(opts): SidecarManager` 以 `logDir=<cwd>/logs` + `managerOptions` 透传 `spawner/fetcher/fsDeps/healthIntervalMs` 注入友好；`LlamaSidecar` class 二次封装 `manager+port` 提供 `start/stop/restart/getStatus/isRunning/logPath/completionUrl/healthUrl/stream(generate)` 便捷方法，日志天然落 `logs/sidecar-llama.log`（SidecarManager `sidecar-<name>.log` 映射 + 5MiB 轮转 -> .1）。
- **SSE /completion**: `LlamaCompletionRequest {prompt,stream,temperature,top_p,...}` + `LlamaCompletionChunk {content,stop}`；`parseSseLine(line)` 解析 `data: JSON` 归一化 `content/stop` 与 `delta.content` 包装及 `[DONE]` 过滤；`streamCompletion(req,{port,fetchImpl,signal})` 以 `POST /completion {stream:true}` 发起，`content-type=text/event-stream` 时用 `ReadableStream.getReader()` 逐片 `TextDecoder` 解码按 `\n` 切行产出 chunk，非 SSE 时回退 JSON 单 chunk，`!ok` 抛 `status` 含 body；`complete(req)` 非流式 `stream:false` 取 `res.json()`；`checkLlamaHealth(port,fetchImpl)` 2s Abort 独立探活供 UI。
- **合规**: 未引入 AGPL，`llama-server` 仅作子进程 `spawn` 隔离，主进程零链接；仅依赖 `SidecarManager/types` 与 Node `path`/`fetch`，无额外第三方；`DEFAULT_LLAMA_BIN=llama-server` 用 MIT 二进制路径，不捆绑模型。
- **测试**: `src/sidecars/llama.test.ts` 21 用例：常量断言(Host/Port/Health/Completion/Log/ctxSize/Bin)、`getHealthUrl/getCompletionUrl` 默认与自定义端口、`resolveLlamaBin` 三级优先级、`buildLlamaArgs` 默认/Model/Ctx/Extra/Host校验、`createLlamaSidecarConfig` 127.0.0.1 校验、`SidecarManager` 健康越权拒、`createLlamaSidecar` spawn + 日志路径 `sidecar-llama.log` + 状态、`logPath/restart` 计数、`parseSseLine` 7分支、`streamCompletion` SSE多chunk/JSON回退/500抛错、`complete` 成功与422、`checkLlamaHealth` 三态、`LlamaSidecar` wrapper 透出与 `stream/generate` 代理；`pnpm test` 4文件42用例全绿，`pnpm typecheck 0`；`tsconfig.node.json` 追加 `src/sidecars/**` ensure include。
- **Lesson**: sidecar 必须 `127.0.0.1` 双校验（buildLlamaArgs + SidecarManager assertLocalHealthUrl），端口/URL 需 `number` 而非字面量 `11435` 避免 TS 窄化；SSE 需兼容 `content` 与 `delta.content` 双形及 `[DONE]` 哨兵，`ReadableStream` reader 与 JSON 回退双路径保证 mock 与真实 fetch 均可测；注入 `spawner/fetcher/fsDeps` 是 100% 覆盖 sidecar 启动/日志/健康的关键，不触真实进程/网络。

## T6(Wave3) — 集成验证门禁（test / tsc / builder --dir / 托盘双击 / 4对话框双路径）

- **四门禁一键重跑**: `pnpm test`（30f/544t）+ `pnpm typecheck`（node+web 0）+ `pnpm build`（electron-vite 3 envs）+ `electron-builder --dir --config.npmRebuild=false`（无 icon 警告，产物 `release/win-unpacked/Local AI Suite.exe`），`--config.npmRebuild=false` 用于本机无 VS Build Tools 时跳过 better-sqlite3 重建，CI 矩阵会在对应 OS 上 `npmRebuild:true` 正常重建。
- **托盘双击不可跳过**: `TrayController.create()` 按 `platform` 分流 — `darwin: on("click", toggle)`，`win32/linux: on("double-click", debounce 300ms)`，6 步手动清单（tooltip/双击切换/debounce/右键一致/darwin 单击/destroy 容错）+ `tray.test.ts` 12 用例（win32/linux/darwin 三分支 + `Date.now` 桩 debounce + `buildTrayTemplate` 菜单结构）等价覆盖。
- **4对话框双路径**: `deleteWorkspace / overwriteCoverage / publishRelease / clearCache` 各自前端 `src/renderer/src/features/*` → `dialog:confirmDestructive` → 后端 `src/main/handlers/*` → `showDestructiveConfirm(type:warning, buttons:[取消,确认])` 二次校验，仅 `response===1` 执行；`destructive-guards.test.ts` 8 用例（4前+4后）各测 Cancel（`not.toHaveBeenCalled` + `cancelled:true`）与 Confirm（执行副作用），外加 `dialogConfirm.test.ts` 9 + `confirm.test.ts` 10 兜底校验边界。
- **build 目录证据**: `build/icon.ico 28k / icon.icns 61k / icon.png 25k / icons/512x512.png 25k / entitlements.mac.plist` + `.gitignore` `build/*` 但 `!build/icon.*` 白名单 + `electron-builder.yml` 三平台 icon 指向一致，`Select-String "icon|warning"` 0 行即为无警告证据。
- **验证**: `pnpm test 544 passed / pnpm typecheck 0 / electron-builder --dir 0 + release 验证 / docs/WAVE3_T6_EVIDENCE.md` 落盘，满足 Wave3 最终门禁依赖 Task2/3/5。
