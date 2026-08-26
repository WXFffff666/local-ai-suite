#!/usr/bin/env bash
# scripts/release.sh — Wave7 T37
# 封装 gh release create：version 校验、latest.yml 校验、产物命名 LocalAISuite-<version>-Setup.exe
# 用法:  bash scripts/release.sh [v]<version> [--draft] [--dry-run]
#        bash scripts/release.sh 0.1.0
#        bash scripts/release.sh v0.2.0 --draft
#        DRY_RUN=1 bash scripts/release.sh 0.1.0
# 依赖: gh CLI (已通过 gh auth login 或 GH_TOKEN 环境变量认证)、git、release/ 产物
# 注意: 绝不硬编码 token — 依赖 gh 的凭证链 / GH_TOKEN 环境变量
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="$ROOT/release"
EXPECTED_PREFIX="LocalAISuite"
DRY_RUN="${DRY_RUN:-0}"
DRAFT="false"

# ---------- helpers ----------
red()  { printf "\033[31m%s\033[0m\n" "$*"; }
green(){ printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
info() { printf "[release] %s\n" "$*"; }
warn() { yellow "[release][warn] $*"; }
die()  { red "[release][error] $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh <version> [options]

  <version>   semver, 允许带或不带 v 前缀, e.g. 0.1.0 / v0.1.0 / 1.0.0-beta.1
  --draft     以草稿形式创建 release (gh release create --draft)
  --dry-run   仅校验与打印将执行的命令，不真正创建 release
  --help      显示此帮助

产物约定:
  Windows 安装包  release/LocalAISuite-<version>-Setup.exe
  自动更新元数据 release/latest.yml  (需含 version: <version>)

示例:
  bash scripts/release.sh 0.1.0
  bash scripts/release.sh v0.1.0 --draft --dry-run
USAGE
}

# ---------- parse args ----------
VERSION_RAW=""
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --draft) DRAFT="true" ;;
    --dry-run) DRY_RUN=1 ;;
    --*) die "未知选项: $arg (查看 --help)" ;;
    *) if [[ -z "$VERSION_RAW" ]]; then VERSION_RAW="$arg"; else die "多余参数: $arg"; fi ;;
  esac
done

# 环境变量也可触发 dry-run
if [[ "${DRY_RUN}" == "1" || "${DRY_RUN}" == "true" ]]; then
  DRY_RUN=1
fi

# gh 官方也支持 DRY_RUN 单独调用时需传入 version，故 version 必填
if [[ -z "$VERSION_RAW" ]]; then
  usage
  die "缺少 <version> 参数"
fi

# ---------- version 校验 ----------
# 允许 v 前缀，校验 semver: X.Y.Z 可选 -prerelease / +build
VERSION="${VERSION_RAW#v}"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$VERSION" =~ $SEMVER_RE ]]; then
  die "version 格式非法: '$VERSION_RAW' 期望 semver (e.g. 0.1.0 / 1.0.0-beta.1), 去掉 v 后得到 '$VERSION' 不匹配 $SEMVER_RE"
fi
TAG="v${VERSION}"
EXPECTED_EXE="${EXPECTED_PREFIX}-${VERSION}-Setup.exe"
EXPECTED_EXE_PATH="$RELEASE_DIR/$EXPECTED_EXE"

# package.json version 一致性提示（非强制阻断，仅警告）
PKG_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "")"
if [[ -n "$PKG_VERSION" && "$PKG_VERSION" != "$VERSION" ]]; then
  warn "package.json version ($PKG_VERSION) 与传入 version ($VERSION) 不一致，建议先更新 package.json"
fi

info "version : $VERSION"
info "tag     : $TAG"
info "产物    : $EXPECTED_EXE"
info "draft   : $DRAFT  dry-run: $DRY_RUN"

# ---------- 依赖检查 ----------
if ! command -v gh >/dev/null 2>&1; then
  die "未找到 gh CLI，请先安装 https://cli.github.com/ 并执行 gh auth login"
fi
if ! command -v git >/dev/null 2>&1; then
  die "未找到 git"
fi

# gh 认证检查（不硬编码 token，仅检查凭证链）
if ! gh auth status >/dev/null 2>&1; then
  # gh auth status 非零可能是未登录；同时检查 GH_TOKEN / GITHUB_TOKEN 是否存在作兼容
  if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
    warn "gh auth status 失败且未检测到 GH_TOKEN/GITHUB_TOKEN，请先 gh auth login 或导出 GH_TOKEN"
  else
    info "检测到 GH_TOKEN/GITHUB_TOKEN 环境变量，跳过 gh auth status 校验"
  fi
fi

# git tag 已存在检查（仅提示）
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  warn "tag $TAG 已存在本地；若远端已存在，gh release create 会失败，可先 git tag -d $TAG && git push origin :$TAG"
fi

# ---------- 产物 / latest.yml 校验 ----------
if [[ ! -d "$RELEASE_DIR" ]]; then
  die "未找到 $RELEASE_DIR，请先执行 pnpm build && pnpm dist:win (或 pnpm dist)"
fi

# 1) 查找 Windows 安装包：优先精确匹配，其次模糊匹配 *.exe
FOUND_EXE=""
if [[ -f "$EXPECTED_EXE_PATH" ]]; then
  FOUND_EXE="$EXPECTED_EXE_PATH"
  info "找到精确命名产物: $EXPECTED_EXE"
else
  # 尝试兼容 electron-builder 默认命名: "Local AI Suite Setup 0.1.0.exe" 等
  # 搜索 release/*.exe，取最新/最大者
  mapfile -t CANDIDATES < <(ls -1 "$RELEASE_DIR"/*.exe 2>/dev/null || true)
  if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
    die "在 $RELEASE_DIR 未找到任何 .exe，请先执行 pnpm dist:win 构建"
  elif [[ ${#CANDIDATES[@]} -eq 1 ]]; then
    FOUND_EXE="${CANDIDATES[0]}"
    warn "未找到 $EXPECTED_EXE，改为使用 ${FOUND_EXE#$ROOT/} 并将在发布前重命名/复制为 $EXPECTED_EXE"
  else
    # 多个 exe：优先匹配含 version 的
    for c in "${CANDIDATES[@]}"; do
      if [[ "$(basename "$c")" == *"$VERSION"* ]]; then FOUND_EXE="$c"; break; fi
    done
    if [[ -z "$FOUND_EXE" ]]; then
      # 取体积最大的（通常是主安装包）
      FOUND_EXE="$(ls -S "$RELEASE_DIR"/*.exe 2>/dev/null | head -n1)"
    fi
    warn "找到多个 .exe，选择 $(basename "$FOUND_EXE") 重命名为 $EXPECTED_EXE"
  fi
fi

# 若源文件不是期望命名，则复制/重命名为期望命名（保留源文件以便排查）
if [[ "$(basename "$FOUND_EXE")" != "$EXPECTED_EXE" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    info "[dry-run] 将执行: cp \"$FOUND_EXE\" \"$EXPECTED_EXE_PATH\""
  else
    cp -f "$FOUND_EXE" "$EXPECTED_EXE_PATH"
    green "[release] 已复制 $(basename "$FOUND_EXE") -> $EXPECTED_EXE"
  fi
fi

# 最终确认产物存在且非空
if [[ "$DRY_RUN" != "1" ]]; then
  if [[ ! -f "$EXPECTED_EXE_PATH" ]]; then
    die "产物仍不存在: $EXPECTED_EXE_PATH"
  fi
  SIZE="$(wc -c < "$EXPECTED_EXE_PATH" 2>/dev/null | tr -d ' ')"
  if [[ "$SIZE" -lt 1024 ]]; then
    die "产物异常过小 ($SIZE bytes): $EXPECTED_EXE_PATH"
  fi
  info "产物就绪: $EXPECTED_EXE ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE} bytes"))"
fi

# 2) latest.yml 校验
LATEST_YML="$RELEASE_DIR/latest.yml"
if [[ ! -f "$LATEST_YML" ]]; then
  die "未找到 $LATEST_YML — electron-builder 未生成自动更新元数据。请确认 electron-builder.yml publish 配置并重新构建"
fi

# 基础字段校验
if ! grep -q "version:" "$LATEST_YML"; then
  die "latest.yml 缺少 version: 字段 — 内容:\n$(cat "$LATEST_YML")"
fi

# version 必须匹配传入 version
if ! grep -Eq "version:[[:space:]]*\"?$VERSION\"?" "$LATEST_YML"; then
  ACTUAL="$(grep -E "version:" "$LATEST_YML" | head -n1 || true)"
  die "latest.yml version 不匹配 — 期望 $VERSION，实际: $ACTUAL\n请重新执行 pnpm dist:win 确保版本一致"
fi

# 必须包含指向期望产物的引用（path/url/file）
if ! grep -Eq "$EXPECTED_PREFIX|$EXPECTED_EXE|path:" "$LATEST_YML"; then
  warn "latest.yml 未包含 $EXPECTED_EXE 相关字段，建议检查 electron-builder artifactName 配置"
else
  # 若 latest.yml 中 path 指向旧命名，提示但不阻断（electron-builder 默认 path 可能为旧名）
  if grep -q "path:" "$LATEST_YML" && ! grep -q "$EXPECTED_EXE" "$LATEST_YML"; then
    warn "latest.yml path 未指向 $EXPECTED_EXE，建议在 electron-builder.yml 配置 artifactName: \${productName}-\${version}-Setup.\${ext} 并重建"
  fi
fi

# 校验 latest.yml 关联的 blockmap / 额外文件是否存在（若 yml 中引用）
if grep -q "\.blockmap" "$LATEST_YML"; then
  BLOCKMAP="$(grep -oE "[A-Za-z0-9._-]+\.blockmap" "$LATEST_YML" | head -n1 || true)"
  if [[ -n "$BLOCKMAP" && ! -f "$RELEASE_DIR/$BLOCKMAP" ]]; then
    warn "latest.yml 引用了 $BLOCKMAP 但文件不存在于 $RELEASE_DIR"
  fi
fi

green "[release] latest.yml 校验通过 ($(grep -E "version:" "$LATEST_YML" | head -n1 | xargs))"

# latest.yml 也需作为 release 资产上传（electron-updater 需要）
UPLOAD_FILES=("$EXPECTED_EXE_PATH" "$LATEST_YML")
# 若存在 blockmap，一并上传
if [[ -n "${BLOCKMAP:-}" && -f "$RELEASE_DIR/$BLOCKMAP" ]]; then
  UPLOAD_FILES+=("$RELEASE_DIR/$BLOCKMAP")
fi

# ---------- gh release create ----------
GH_ARGS=()
if [[ "$DRAFT" == "true" ]]; then
  GH_ARGS+=(--draft)
fi
# 自动生成 notes（GitHub 自动 notes）
GH_ARGS+=(--generate-notes)
# 标题
GH_ARGS+=(--title "$TAG")

info "将执行: gh release create $TAG ${GH_ARGS[*]} ${UPLOAD_FILES[*]#$ROOT/}"

if [[ "$DRY_RUN" == "1" ]]; then
  yellow "[dry-run] 跳过实际发布，仅校验通过"
  echo ""
  echo "  gh release create $TAG \\"
  for a in "${GH_ARGS[@]}"; do echo "    $a \\"; done
  for f in "${UPLOAD_FILES[@]}"; do echo "    \"$f\" \\"; done
  echo ""
  green "[release][dry-run] 校验全部通过"
  exit 0
fi

# 若本地 tag 不存在则创建（gh release create 会自动创建 tag，但本地先创建可确保一致性）
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  info "创建本地 tag $TAG"
  git tag "$TAG"
fi

# 推送 tag（若远端已存在则忽略错误）
if git remote get-url origin >/dev/null 2>&1; then
  info "推送 tag $TAG 到 origin"
  git push origin "$TAG" 2>&1 || warn "git push tag 失败，可能已存在远端 tag，继续创建 release"
fi

# 创建 release
set -x
gh release create "$TAG" "${UPLOAD_FILES[@]}" "${GH_ARGS[@]}"
set +x

green "[release] 完成: gh release create $TAG 成功"
info "资产: $EXPECTED_EXE + latest.yml${BLOCKMAP:+ + $BLOCKMAP}"
info "查看: gh release view $TAG --web  或  gh release view $TAG"
