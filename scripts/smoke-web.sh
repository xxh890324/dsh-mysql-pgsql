#!/usr/bin/env bash
#
# dsh-mysql 隔离 Web 验收（macOS / Linux 版）。
#
# 与 dsh02-web-smoke.ps1 等价：一次性 DSH_HOME + 一次性 profile + 一次性端口
# 启动 dsh web，然后：
#   1. 校验 HTTP 200 且文档含 __DSH_BOOT__；
#   2. 用无头浏览器（CDP）确认 boot 图含 dsh-mysql、无失败遮罩、
#      输入栏数据库控件真的渲染（scripts/web-boot-probe.mjs）；
#   3. 加 --rpc 时再用 scripts/web-rpc-probe.mjs 驱动真实 UI 打通 RPC。
#
# 绝不触碰既有的 dsh web 实例（拒绝使用 3080）。
#
# 用法：
#   scripts/smoke-web.sh [--cli <path>] [--profile <name>] [--home <dir>]
#                        [--port <n>] [--debug-port <n>] [--browser <path>]
#                        [--timeout <sec>] [--rpc]
#
set -uo pipefail

CLI_PATH="${DSH_CLI:-}"
PROFILE="dsh-mysql-compat-web"
TEST_HOME=""
PORT=33180
DEBUG_PORT=9333
BROWSER_PATH=""
TIMEOUT_SECONDS=60
RPC_PROBE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cli) CLI_PATH="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --home) TEST_HOME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --debug-port) DEBUG_PORT="$2"; shift 2 ;;
    --browser) BROWSER_PATH="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="$2"; shift 2 ;;
    --rpc) RPC_PROBE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT_PROBE="$REPO/scripts/web-boot-probe.mjs"
RPC_PROBE_JS="$REPO/scripts/web-rpc-probe.mjs"

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

if [ -z "$BROWSER_PATH" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then BROWSER_PATH="$candidate"; break; fi
  done
fi
[ -n "$BROWSER_PATH" ] && [ -x "$BROWSER_PATH" ] || {
  echo "找不到无头浏览器；请用 --browser <path> 指定 Chrome/Chromium/Edge" >&2
  exit 2
}

if [ "$PORT" = "3080" ] || [ "$DEBUG_PORT" = "3080" ]; then
  echo '拒绝使用既有的 3080 端口' >&2
  exit 2
fi

if [ -z "$TEST_HOME" ]; then TEST_HOME="$REPO/.tmp/smoke-web-home"; fi
mkdir -p "$TEST_HOME"
TEST_HOME="$(cd "$TEST_HOME" && pwd)"
LOG_DIR="$TEST_HOME/smoke-logs"
mkdir -p "$LOG_DIR"
BROWSER_PROFILE="$TEST_HOME/browser-profile"

OLD_HOME="${DSH_HOME-}"
SERVER_PID=""
BROWSER_PID=""
FAILURES=()

cleanup() {
  if [ -n "$BROWSER_PID" ] && kill -0 "$BROWSER_PID" 2>/dev/null; then
    pkill -TERM -P "$BROWSER_PID" 2>/dev/null || true
    kill -TERM "$BROWSER_PID" 2>/dev/null || true
  fi
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
# 从探针 JSON 里取一个 JSON 指针风格路径（如 snapshot.entryCount）；
# jq 缺失时退回 node。空值统一输出空串，调用方自行给默认值。
json_get() {
  local file="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg p "$path" 'getpath($p | split(".")) // ""' "$file" 2>/dev/null
  else
    node -e '
      const fs = require("fs")
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      let value = data
      for (const key of process.argv[2].split(".")) {
        if (value === null || value === undefined) break
        value = value[key]
      }
      process.stdout.write(value === null || value === undefined ? "" : String(value))
    ' "$file" "$path" 2>/dev/null
  fi
}

# 取某个数组字段的长度（jq 的 getpath 取不到 .length，必须单独走 pipe）。
json_len() {
  local file="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg p "$path" '(getpath($p | split(".")) // []) | length' "$file" 2>/dev/null
  else
    node -e '
      const fs = require("fs")
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      let value = data
      for (const key of process.argv[2].split(".")) {
        if (value === null || value === undefined) break
        value = value[key]
      }
      process.stdout.write(String(Array.isArray(value) ? value.length : 0))
    ' "$file" "$path" 2>/dev/null
  fi
}

export DSH_HOME="$TEST_HOME"
echo "==> 隔离 DSH_HOME：$TEST_HOME"

PROFILE_JSON="$TEST_HOME/profiles/$PROFILE/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  echo "==> 从内置 'web' 模板初始化 profile '$PROFILE'"
  "$CLI_PATH" --from-default-profile web --profile "$PROFILE" --dump-config >"$LOG_DIR/init.log" 2>&1
  [ -f "$PROFILE_JSON" ] || { echo "profile 初始化失败，见 $LOG_DIR/init.log" >&2; exit 1; }
fi

echo "==> 把本地 bundle 安装进 profile '$PROFILE'"
"$CLI_PATH" plugin --profile "$PROFILE" add "$REPO" >"$LOG_DIR/plugin-add.log" 2>&1
if [ $? -ne 0 ]; then
  echo "无法把 dsh-mysql 安装进隔离 profile，见 $LOG_DIR/plugin-add.log" >&2
  exit 1
fi

CONFIG="$("$CLI_PATH" --profile "$PROFILE" --dump-config 2>&1)"
printf '%s' "$CONFIG" | grep -qE '^- id: dsh-mysql[[:space:]]*$' || {
  echo "组合后的 profile 树里没有 dsh-mysql 行" >&2
  exit 1
}

echo "==> 在端口 $PORT 启动隔离 web 实例"
SERVER_OUT="$LOG_DIR/web.stdout.log"
SERVER_ERR="$LOG_DIR/web.stderr.log"
: >"$SERVER_OUT"; : >"$SERVER_ERR"
"$CLI_PATH" --profile "$PROFILE" --no-open --port "$PORT" >"$SERVER_OUT" 2>"$SERVER_ERR" &
SERVER_PID=$!

URL=""
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 0.5
  if [ -f "$SERVER_OUT" ]; then
    URL="$(grep -oE 'dsh web:[[:space:]]*[^[:space:]]+' "$SERVER_OUT" | head -1 | sed -E 's/^dsh web:[[:space:]]*//')"
    [ -n "$URL" ] && break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "隔离 web 进程提前退出；见 $SERVER_ERR" >&2
    cat "$SERVER_ERR" >&2
    exit 1
  fi
done
[ -n "$URL" ] || { echo "隔离 web 实例从未报告 URL；见 $SERVER_OUT" >&2; exit 1; }

echo "==> 服务地址 $URL"
# 带 token 的首次请求返回 303 并用 Set-Cookie 下发会话；必须保存并回传该 cookie，
# 否则跟随后拿到的是 401。/ 与 ./ 都通过同一套认证。
COOKIE_JAR="$LOG_DIR/cookies.txt"
rm -f "$COOKIE_JAR"
HTTP_CODE="$(curl -sL -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o "$LOG_DIR/served.html" -w '%{http_code}' --max-time 20 "$URL")"
[ "$HTTP_CODE" = "200" ] || { echo "隔离 web 返回 HTTP $HTTP_CODE" >&2; exit 1; }
grep -q '__DSH_BOOT__' "$LOG_DIR/served.html" || { echo '返回的文档不含 __DSH_BOOT__ 清单' >&2; exit 1; }

echo "==> 启动无头浏览器并探测客户端组合"
rm -rf "$BROWSER_PROFILE"
"$BROWSER_PATH" \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --disable-extensions --disable-background-networking --mute-audio \
  --remote-debugging-port="$DEBUG_PORT" --remote-allow-origins='*' \
  --user-data-dir="$BROWSER_PROFILE" about:blank >"$LOG_DIR/browser.log" 2>&1 &
BROWSER_PID=$!

node "$BOOT_PROBE" "$URL" "$DEBUG_PORT" "$((TIMEOUT_SECONDS * 1000))" >"$LOG_DIR/probe.json" 2>"$LOG_DIR/probe.err"
PROBE_JSON="$LOG_DIR/probe.json"
if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$PROBE_JSON" 2>/dev/null; then
  echo "浏览器探针输出无法解析：" >&2
  cat "$PROBE_JSON" "$LOG_DIR/probe.err" >&2
  exit 1
fi

VERDICT="$(json_get "$PROBE_JSON" 'verdict')"
echo "    verdict: $VERDICT"
ENTRY_COUNT="$(json_get "$PROBE_JSON" 'snapshot.entryCount')"
CONTROL_COUNT="$(json_get "$PROBE_JSON" 'snapshot.mysqlControl')"
echo "    entries: $ENTRY_COUNT, db control: $CONTROL_COUNT"

if [ "$VERDICT" != "ok" ]; then
  fail "客户端 boot verdict 为 '$VERDICT'（期望 'ok'）"
else
  [ "$(json_get "$PROBE_JSON" 'snapshot.hasMysqlEntry')" = "true" ] || fail '客户端 boot 图里缺少 dsh-mysql'
  [ "$(json_get "$PROBE_JSON" 'snapshot.failedPlugins')" != "true" ] || fail '启动遮罩报告了插件加载失败'
  [ "${CONTROL_COUNT:-0}" -ge 1 ] || fail 'conversation.input.left 贡献没有渲染'
  [ "$(json_get "$PROBE_JSON" 'snapshot.mysqlControlWarn')" = "0" ] || fail '输入栏控件渲染为 RPC 错误态（is-warn）'
fi
CONSOLE_ERR="$(json_len "$PROBE_JSON" 'console')"
EXC_ERR="$(json_len "$PROBE_JSON" 'exceptions')"
[ "${CONSOLE_ERR:-0}" = "0" ] || fail "渲染进程 console 错误：$CONSOLE_ERR 条（见 $PROBE_JSON）"
[ "${EXC_ERR:-0}" = "0" ] || fail "渲染进程未捕获异常：$EXC_ERR 条（见 $PROBE_JSON）"

if [ "$RPC_PROBE" = "1" ]; then
  echo '==> 通过真实 UI 驱动数据库 RPC 接口'
  node "$RPC_PROBE_JS" "$URL" "$DEBUG_PORT" 120000 >"$LOG_DIR/rpc-probe.json" 2>"$LOG_DIR/rpc-probe.err"
  RPC_JSON="$LOG_DIR/rpc-probe.json"
  if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$RPC_JSON" 2>/dev/null; then
    echo "RPC 探针输出无法解析：" >&2
    cat "$RPC_JSON" "$LOG_DIR/rpc-probe.err" >&2
    exit 1
  fi
  RPC_VERDICT="$(json_get "$RPC_JSON" 'verdict')"
  echo "    rpc verdict: $RPC_VERDICT"
  node -e "
    const j = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    for (const s of (j.steps||[])) console.log('      ' + (s.ok ? '[ok]  ' : '[FAIL]') + ' ' + s.step);
  " "$RPC_JSON"
  if [ "$RPC_VERDICT" != "ok" ]; then
    while IFS= read -r line; do [ -n "$line" ] && fail "RPC 探针步骤失败：$line"; done \
      < <(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));for(const s of (j.failed||[]))console.log(s)" "$RPC_JSON")
    [ ${#FAILURES[@]} -gt 0 ] || fail "RPC 探针 verdict 为 '$RPC_VERDICT'"
  fi
  [ "$(json_len "$RPC_JSON" 'console')" = "0" ] || fail 'RPC 探针期间出现渲染进程 console 错误'
  [ "$(json_len "$RPC_JSON" 'exceptions')" = "0" ] || fail 'RPC 探针期间出现未捕获异常'
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo '隔离 Web 冒烟失败：' >&2
  for f in "${FAILURES[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

echo 'PASS: 隔离 DSH Web 冒烟测试'
