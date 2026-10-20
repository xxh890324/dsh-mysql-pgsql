#!/usr/bin/env bash
#
# dsh-mysql 隔离 Headless 验收（macOS / Linux 版）。
#
# 与 dsh02-headless-smoke.ps1 等价：在一个一次性 profile / 一次性 DSH_HOME 上
# 启动 headless 组合，验证 Host 侧兼容性，完全不依赖 LLM、网络或既有的 dsh web 实例：
#
#   1. 组合后的 profile 树里含 dsh-mysql 行，且 Typert loader 行存在；
#   2. 进程 stdout 报告 [dsh-mysql] host mounted；
#   3. 插件自己的 boot.log 报告两族工具注册（mysql_* 与 pg_*）、
#      service mysql provided、apply complete；
#   4. stderr 没有 typert-loader 注册失败。
#
# 用法：
#   scripts/smoke-host.sh [--cli <path>] [--profile <name>] [--home <dir>] [--timeout <sec>]
#
set -uo pipefail

CLI_PATH="${DSH_CLI:-}"
PROFILE="dsh-mysql-compat-headless"
TEST_HOME=""
TIMEOUT_SECONDS=60

while [ $# -gt 0 ]; do
  case "$1" in
    --cli) CLI_PATH="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --home) TEST_HOME="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$CLI_PATH" ]; then
  if command -v dsh >/dev/null 2>&1; then
    CLI_PATH="$(command -v dsh)"
  elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]; then
    CLI_PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  else
    echo "找不到 dsh CLI；请用 --cli <path> 或设置 DSH_CLI" >&2
    exit 2
  fi
fi
[ -x "$CLI_PATH" ] || { echo "dsh CLI 不可执行：$CLI_PATH" >&2; exit 2; }

if [ -z "$TEST_HOME" ]; then TEST_HOME="$REPO/.tmp/smoke-host-home"; fi
mkdir -p "$TEST_HOME"
TEST_HOME="$(cd "$TEST_HOME" && pwd)"
LOG_DIR="$TEST_HOME/smoke-logs"
mkdir -p "$LOG_DIR"

OLD_HOME="${DSH_HOME-}"
SERVER_PID=""
FAILURES=()

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$OLD_HOME" ]; then export DSH_HOME="$OLD_HOME"; else unset DSH_HOME; fi
}
trap cleanup EXIT

fail() { FAILURES+=("$1"); }

export DSH_HOME="$TEST_HOME"
echo "==> 隔离 DSH_HOME：$TEST_HOME"

PROFILE_JSON="$TEST_HOME/profiles/$PROFILE/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  echo "==> 从内置 'headless' 模板初始化 profile '$PROFILE'"
  "$CLI_PATH" --from-default-profile headless --profile "$PROFILE" --dump-config >"$LOG_DIR/init.log" 2>&1
  [ -f "$PROFILE_JSON" ] || { echo "profile 初始化失败，见 $LOG_DIR/init.log" >&2; exit 1; }
fi

echo "==> 把本地 bundle 安装进 profile '$PROFILE'"
"$CLI_PATH" plugin --profile "$PROFILE" add "$REPO" >"$LOG_DIR/plugin-add.log" 2>&1
if [ $? -ne 0 ]; then
  echo "无法把 dsh-mysql 安装进隔离 profile，见 $LOG_DIR/plugin-add.log" >&2
  exit 1
fi

CONFIG="$("$CLI_PATH" --profile "$PROFILE" --dump-config 2>&1)"
if ! printf '%s' "$CONFIG" | grep -qE '^- id: dsh-mysql[[:space:]]*$'; then
  echo "组合后的 profile 树里没有 dsh-mysql 行" >&2
  exit 1
fi
printf '%s' "$CONFIG" | grep -q 'dsh-typert-loader' || fail "组合后的 profile 树里没有 Typert loader 行"

BOOT_LOG="$TEST_HOME/storages/dsh-mysql/boot.log"
rm -f "$BOOT_LOG"

echo "==> 启动隔离 headless 组合"
OUT="$LOG_DIR/headless.stdout.log"
ERR="$LOG_DIR/headless.stderr.log"
: >"$OUT"; : >"$ERR"
"$CLI_PATH" --profile "$PROFILE" >"$OUT" 2>"$ERR" &
SERVER_PID=$!

STDOUT_TEXT=""
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 0.5
  [ -f "$OUT" ] && STDOUT_TEXT="$(cat "$OUT")"
  if printf '%s' "$STDOUT_TEXT" | grep -q '\[dsh-mysql\] host mounted' && [ -f "$BOOT_LOG" ]; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
done

echo '--- stdout ---'; cat "$OUT" 2>/dev/null || true
if [ -s "$ERR" ]; then echo '--- stderr ---'; cat "$ERR"; fi

printf '%s' "$STDOUT_TEXT" | grep -q '\[dsh-mysql\] host mounted' || fail "Host 行从未报告成功挂载"
if grep -q 'typert-loader:' "$ERR" 2>/dev/null; then fail "Typert loader 报告了 dsh-mysql 注册失败"; fi

BOOT=""
[ -f "$BOOT_LOG" ] && BOOT="$(cat "$BOOT_LOG")"

# 两族工具都必须注册（8 个）。逐个断言，避免整串匹配在新增工具时失效。
for TOOL in mysql_query mysql_tables mysql_execute mysql_ddl pg_query pg_tables pg_execute pg_ddl; do
  printf '%s' "$BOOT" | grep -q "$TOOL" || fail "Host 未注册工具 $TOOL"
done
printf '%s' "$BOOT" | grep -q 'service mysql provided' || fail "Host 未提供 mysql 服务"
printf '%s' "$BOOT" | grep -q 'apply complete' || fail "Host apply 未完成"

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo '隔离 Headless 冒烟失败：' >&2
  for f in "${FAILURES[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

echo 'PASS: 隔离 DSH Headless 冒烟测试'
