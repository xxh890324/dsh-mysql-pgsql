/**
 * dsh-mysql 宿主插件（单一行挂载，见 cordis.patch.yml）。
 *
 * 职责：
 *  1. 连接管理：$DSH_HOME/storages/dsh-mysql/connections.json 持久化多套
 *     数据库连接（名称/类型/host/port/user/password/默认库/schema/表白名单/
 *     写权限/结构变更权限），按连接懒创建对应方言的连接池（配置变更自动重建，
 *     dispose 全部回收）；
 *  2. 全局注册模型工具（所有 Agent 预设可见），按方言分成两族：
 *     MySQL     → mysql_query / mysql_tables / mysql_execute / mysql_ddl
 *     PostgreSQL→ pg_query / pg_tables / pg_execute / pg_ddl
 *     - *_query    只读查询（单语句，白名单表校验，最多返回 MAX_ROWS 行）；
 *                  MySQL 额外注入 MAX_EXECUTION_TIME 提示；
 *     - *_tables   查看当前连接可读表的结构，缺少必需元数据时明确失败，
 *                  不伪造 undefined 表结构；
 *     - *_execute  写操作（仅 INSERT/UPDATE/DELETE），连接必须显式开启
 *                  allowWrite（默认关闭），同样受白名单约束；
 *     - *_ddl      结构变更，连接必须显式开启 allowDdl（默认关闭）；账号与权限类
 *                  语句、库级语句永久拒绝，改/删目标受白名单约束；
 *     MySQL 的 DDL 走文本协议（pool.query），因为 MySQL 对部分 DDL 不支持
 *     预处理协议（ER_UNSUPPORTED_PS 1295）。
 *  3. 会话级数据源选择：sessionId → Set<connectionId>，由 Client 输入栏按钮
 *     经 Typert RPC 立即增删；工具按单次调用的 connectionId 路由至一个已选源；
 *  4. systemPrompt 动态 section：每次提示词装配时注入「已选数据源 + 各自能力」
 *     上下文，所有预设的模型无需任何预设改动即可感知可用数据库；
 *  5. 提供 `mysql` 服务（Typert 网关）：连接 CRUD、测试、选择与表列表。
 *     服务名沿用 `mysql` 以保持既有 wire 契约不变，方法本身与方言无关。
 *
 * 只通过 ctx API 使用宿主能力，不 import 任何 @deepseek-ai 运行时包，
 * 因此与宿主进程共享同一套运行时实例。
 */

import { promises as fsp, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  resolveSelectedConnectionIds,
  replaceSelectedConnectionIds,
  removeSelectedConnectionId,
  resolveSelectedConnection,
} from './session-selection.js'
import {
  MAX_ROWS,
  jsonSafe,
  groupColumnMetadata,
  describeDbError,
  lexFor,
  normalizeTables,
} from './shared.js'
import {
  DEFAULT_DIALECT,
  DIALECT_TYPES,
  DIALECT_DEFAULTS,
  createDialect,
  defaultsFor,
  isDialectType,
} from './dialects/index.js'

export const name = 'dsh-mysql'
export const inject = ['tools']

// ── 配置存储（$DSH_HOME/storages/dsh-mysql/connections.json）──────────────

function storageDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-mysql')
}

function storageFile() {
  return path.join(storageDir(), 'connections.json')
}

/** 启动诊断日志（$DSH_HOME/storages/dsh-mysql/boot.log），尽力而为。 */
function bootLog(line) {
  try {
    mkdirSync(storageDir(), { recursive: true })
    appendFileSync(path.join(storageDir(), 'boot.log'), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch (err) { /* 诊断日志失败不影响插件 */ }
}

/** Host 是唯一写入方：内存缓存作为权威快照（section 文本提供器要求同步读取）。 */
let cachedConfigs = { connections: [] }
let loadedPromise = null

async function loadConfigsFromDisk() {
  try {
    const text = await fsp.readFile(storageFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.connections)) {
      return { connections: parsed.connections.map(normalizeConnection).filter((c) => c.name) }
    }
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND')) return { connections: [] }
    bootLog('load failed: ' + describeDbError(err))
    console.error('[dsh-mysql] 读取连接配置失败', describeDbError(err))
  }
  return { connections: [] }
}

function ensureLoaded() {
  if (loadedPromise === null) {
    loadedPromise = loadConfigsFromDisk()
      .then((configs) => { cachedConfigs = configs })
      .catch((err) => {
        console.error('[dsh-mysql] 初始化连接配置失败', describeDbError(err))
        cachedConfigs = { connections: [] }
      })
  }
  // loadedPromise 只作为一次性「已加载」门闩；每次调用都解析到当前 cachedConfigs，
  // 保证保存/删除后所有读取路径立即可见最新快照（修复旧版返回启动时旧快照的问题）。
  return loadedPromise.then(() => cachedConfigs)
}

async function persistConfigs(configs) {
  const previous = cachedConfigs
  cachedConfigs = configs
  try {
    await fsp.mkdir(storageDir(), { recursive: true })
    const file = storageFile()
    const tmp = file + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(configs, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    cachedConfigs = previous // 写盘失败：内存回滚，与磁盘保持一致
    console.error('[dsh-mysql] 保存连接配置失败', describeDbError(err))
    throw err
  }
}

// ── 连接配置归一化与对外视图 ───────────────────────────────────────────────

/**
 * 归一化一条连接配置。
 *
 * 方言识别：`type` 缺失或非法 → 'mysql'。既有 connections.json 没有该字段，
 * 因此旧配置无需任何迁移即可继续工作。
 *
 * `schema` 只对 PostgreSQL 有意义：MySQL 侧一律清空，避免无意义字段进入
 * fingerprint（否则客户端误传 schema 会让 MySQL 连接池被无谓重建）。
 */
function normalizeConnection(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const type = isDialectType(raw.type) ? raw.type : DEFAULT_DIALECT
  const defaults = defaultsFor(type)
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : ''
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : '',
    type,
    host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim().slice(0, 255) : '127.0.0.1',
    port: Number.isFinite(Number(raw.port)) && Number(raw.port) > 0 ? Math.floor(Number(raw.port)) : defaults.port,
    user: typeof raw.user === 'string' ? raw.user.slice(0, 64) : defaults.user,
    password: typeof raw.password === 'string' ? raw.password : '',
    database: typeof raw.database === 'string' ? raw.database.trim().slice(0, 128) : defaults.database,
    // PostgreSQL 的 schema 是「表所在的命名空间」，与库名是两级概念，必须分开存。
    // MySQL 没有这一层（库即作用域），强制留空以免污染 fingerprint 与元数据过滤。
    schema: type === 'postgres' && typeof raw.schema === 'string' ? raw.schema.trim().slice(0, 63) : '',
    tables: normalizeTables(raw.tables, lexFor(type)),
    allowWrite: raw.allowWrite === true,
    // 结构变更权限：默认关闭；旧配置没有该字段 → false（无需迁移）
    allowDdl: raw.allowDdl === true,
  }
}

/**
 * 对外安全视图：绝不回传密码，只回 hasPassword。
 * type/schema 是纯增量字段，客户端据此选择图标、表单字段与工具族。
 */
function publicView(c) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    host: c.host,
    port: c.port,
    user: c.user,
    database: c.database,
    schema: c.schema,
    tables: c.tables.slice(),
    allowWrite: c.allowWrite,
    allowDdl: c.allowDdl,
    hasPassword: c.password.length > 0,
    lastTest: lastTest.get(c.id) || null,
  }
}

// ── 连接池管理 ─────────────────────────────────────────────────────────────

const pools = new Map() // connectionId -> { fingerprint, pool, dialect }

/**
 * 配置指纹：任何影响连接语义的字段都必须参与，否则改配置不会触发池重建。
 * type 与 schema 都是新加的——把它们漏掉会让「同一 id 换方言」复用旧方言的池。
 */
function fingerprint(c) {
  return [c.type, c.host, String(c.port), c.user, c.password, c.database, c.schema].join('\u0000')
}

async function getPool(configs, connId) {
  const cfg = configs.connections.find((c) => c.id === connId)
  if (cfg === undefined) return { error: '连接不存在：' + connId }
  const fp = fingerprint(cfg)
  const hit = pools.get(connId)
  if (hit !== undefined && hit.fingerprint === fp) return { pool: hit.pool, config: cfg, dialect: hit.dialect }
  if (hit !== undefined) {
    pools.delete(connId)
    hit.dialect.endPool(hit.pool).catch(() => {})
  }
  const dialect = createDialect(cfg.type)
  const pool = dialect.createPool(dialect.poolConfig(cfg))
  pools.set(connId, { fingerprint: fp, pool, dialect })
  return { pool, config: cfg, dialect }
}

async function dropPool(connId) {
  const hit = pools.get(connId)
  pools.delete(connId)
  if (hit !== undefined) await hit.dialect.endPool(hit.pool).catch(() => {})
}

// ── 会话级数据源选择 ───────────────────────────────────────────────────────

const sessionSelection = new Map() // sessionId -> Set<connectionId>; absent != explicitly empty
const lastTest = new Map() // connectionId -> { at, latencyMs, error }（内存态：dsh web 重启后重置）

function resolveSelectedIds(configs, sessionId) {
  return resolveSelectedConnectionIds(configs.connections, sessionId, sessionSelection)
}

function resolveSelectedConnections(configs, sessionId) {
  const selectedIds = resolveSelectedIds(configs, sessionId)
  return selectedIds
    .map((id) => configs.connections.find((connection) => connection.id === id))
    .filter(Boolean)
}

function resolveToolConnection(configs, sessionId, requestedId) {
  return resolveSelectedConnection(configs.connections, sessionId, requestedId, sessionSelection)
}

function selectionResult(configs, sessionId) {
  const connectionIds = resolveSelectedIds(configs, sessionId)
  return {
    connectionIds,
    // Legacy scalar field remains populated only when routing is unambiguous.
    connectionId: connectionIds.length === 1 ? connectionIds[0] : null,
  }
}

// ── 查询执行 ───────────────────────────────────────────────────────────────

/**
 * 执行只读查询并做结果归一化。
 *
 * 驱动结果形状的差异（mysql2 的 [rows, fields] 元组 vs pg 的 {rows, fields}）
 * 由 dialect.query() 吸收，这里只处理方言无关的截断与 JSON 安全转换。
 */
async function runQuery(dialect, pool, sql, params) {
  const { columns, rows } = await dialect.query(pool, sql, Array.isArray(params) ? params : [])
  const list = Array.isArray(rows) ? rows : []
  const truncated = list.length > MAX_ROWS
  const slice = truncated ? list.slice(0, MAX_ROWS) : list
  return {
    columns: Array.isArray(columns) ? columns : [],
    rowCount: slice.length,
    totalRowCount: list.length,
    truncated,
    rows: slice.map(jsonSafe),
  }
}

/**
 * 工具执行公共前置：解析会话 → 验证所选目标 → 连接池 → 校验方言匹配。
 *
 * `expected` 是调用该工具的方言 adapter。类型不匹配时明确报错并给出正确的
 * 工具名，而不是让 SQL 在错误方言上执行后抛一句看不懂的语法错误。
 */
async function execCtx(exec, args, expected) {
  const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : undefined
  const configs = await ensureLoaded()
  const resolved = resolveToolConnection(configs, sessionId, args && args.connectionId)
  if (resolved.error !== undefined) return { error: resolved.error }
  const connection = resolved.connection
  if (expected !== undefined && connection.type !== expected.type) {
    // 提示里要给出**该连接自己**的工具族，而不是当前这个工具所属的族：
    // 在 PG 数据源上调 mysql_query 时，expected 是 mysql，若用它拼提示就会出现
    // 「请使用 mysql_query…」——恰好推荐了用户刚调用的那个错误工具。
    const names = createDialect(connection.type).toolNames
    return {
      error: '数据源「' + connection.name + '」是 ' + labelOf(connection.type) +
        ' 连接，请使用 ' + names.query + ' / ' + names.tables + ' / ' +
        names.execute + ' / ' + names.ddl + ' 工具。',
    }
  }
  const got = await getPool(configs, connection.id)
  if (got.error !== undefined) return { error: got.error }
  return { sessionId, configs, connection, pool: got.pool, dialect: got.dialect }
}

// ── 模型工具 ───────────────────────────────────────────────────────────────

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function toolError(error) {
  return { ok: false, error: String(error) }
}

function connectionToolError(connection, error) {
  return toolError('数据源「' + connection.name + '」（connectionId=' + connection.id + '）：' + String(error))
}

/**
 * 工具工厂：按方言生成四个工具。
 *
 * 为什么是工厂而不是「一套工具内部分支」：工具名与 description 会被模型当作
 * 契约读取。若 PG 数据源也叫 mysql_query，模型会自然地写出 MySQL 方言的 SQL
 * （反引号、LIMIT ?,? 、insertId），而错误会以「语法错误」的形式暴露在很远的
 * 地方。分族后工具名本身携带方言信息，参数说明也能精确到位。
 *
 * MySQL 侧的四个工具名称、参数结构与主要描述文字保持与改造前一致，
 * 只把方言专属的措辞（提示注入、information_schema、警告计数）抽到 adapter。
 */
function createToolSet(dialect) {
  const T = dialect.toolNames
  const isPostgres = dialect.type === 'postgres'
  const placeholder = dialect.placeholder
  const readVerbList = isPostgres
    ? 'SELECT/WITH/TABLE/VALUES/EXPLAIN/SHOW'
    : 'SELECT/SHOW/DESCRIBE/EXPLAIN'
  const writeResultShape = dialect.supportsInsertId
    ? '返回 { affectedRows, insertId }'
    : '返回 { affectedRows, returnedRows }（PostgreSQL 无自增 ID 概念；需要新行值请在 SQL 末尾加 RETURNING）'
  const ddlResultShape = dialect.supportsWarningCount
    ? '返回 { affectedRows, warningCount }'
    : '返回 { affectedRows }（PostgreSQL 无 warningCount 等价字段）'
  const ddlScopeText = isPostgres
    ? '目标只能是当前连接的默认库与 schema（未加限定前缀视为当前 schema），跨 schema / 跨库目标一律拒绝；DROP INDEX 因无法在不查库的前提下映射到目标表而永久拒绝；ALTER ... OWNER TO 与 SET SCHEMA 永久拒绝'
    : '目标只能是当前连接的默认库，跨库目标一律拒绝'
  const tablesScopeText = isPostgres
    ? '（含 PostgreSQL schema 限定名，未配置 schema 时使用连接默认 search_path 的 public）'
    : ''

  const queryTool = {
    name: T.query,
    description:
      '在当前会话已选数据源上执行一条只读 SQL（仅 ' + readVerbList + '，单条语句），受目标数据源表白名单限制（空名单=不限制）。' +
      '多选数据源时必须通过 connectionId 指定其中一个目标；仅选中一个时可省略。返回 { columns, rowCount, totalRowCount, truncated, rows }，最多 ' + MAX_ROWS + ' 行。' +
      (isPostgres
        ? '本工具只接受 PostgreSQL 连接；占位符必须用 $1、$2 形式（不是 ?）。Identifier 大小写：未加双引号的标识符会折叠为小写，需要保留大小写时用双引号。'
        : '查询前先用 ' + T.tables + ' 确认结构；写操作用 ' + T.execute + '。') +
      (isPostgres ? ' 查询前先用 ' + T.tables + ' 确认结构。' : ''),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        connectionId: { type: 'string', description: '多选数据源时必填：选择当前会话已选的一个数据源 ID。' },
        sql: { type: 'string', description: '一条 ' + readVerbList + ' SQL 语句。' },
        params: { type: 'array', description: '可选的位置参数，对应 SQL 中的 ' + placeholder + ' 占位符。' },
      },
      required: ['sql'],
    },
    output: OUTPUT,
    timeoutMs: 30000,
    async execute(args, exec) {
      const sql = dialect.stripComments(typeof (args && args.sql) === 'string' ? args.sql : '').trim()
      if (!sql) return toolError('SQL 为空')
      const base = await execCtx(exec, args, dialect)
      if (base.error !== undefined) return toolError(base.error)
      const kind = dialect.classify(sql)
      if (kind !== 'read') {
        return connectionToolError(
          base.connection,
          T.query + ' 只允许 ' + readVerbList + ' 语句；写入请使用 ' + T.execute + '，结构变更请使用 ' + T.ddl,
        )
      }
      if (dialect.hasMultipleStatements(sql)) return connectionToolError(base.connection, '不允许一次执行多条语句')
      const allow = dialect.allowlistMatch(dialect.tableRefs(sql), base.connection.tables)
      if (!allow.ok) return connectionToolError(base.connection, '查询涉及白名单外的表：' + allow.denied.join(', '))
      try {
        const result = await runQuery(dialect, base.pool, dialect.prepareReadSql(sql), args && args.params)
        return { ok: true, connection: base.connection.name, connectionId: base.connection.id, ...result }
      } catch (err) {
        return connectionToolError(base.connection, '查询失败：' + dialect.describeError(err))
      }
    },
  }

  const tablesTool = {
    name: T.tables,
    description:
      '列出当前会话已选数据源的可读表结构（表名/列名/类型/可否空/键/注释）' + tablesScopeText + '，受该数据源白名单限制；' +
      '多选时必须用 connectionId 指定目标，单选可省略；table 参数可模糊过滤，缺省返回全部。' +
      (isPostgres ? '本工具只接受 PostgreSQL 连接。' : '') +
      '写 SQL 前先用它确认字段名与类型，避免凭空猜测。',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        connectionId: { type: 'string', description: '多选数据源时必填：选择当前会话已选的一个数据源 ID。' },
        table: { type: 'string', description: '可选：按表名模糊过滤（不区分大小写）。' },
      },
    },
    output: OUTPUT,
    timeoutMs: 15000,
    async execute(args, exec) {
      const base = await execCtx(exec, args, dialect)
      if (base.error !== undefined) return toolError(base.error)
      const filter = typeof (args && args.table) === 'string' ? args.table.trim().toLowerCase() : ''
      const allowed = base.connection.tables
      try {
        const spec = dialect.columnsSql(dialect.scopeFor(base.connection))
        const { rows } = await dialect.query(base.pool, spec.sql, spec.params)
        // groupColumnMetadata 的第三个语义参数是「作用域」：MySQL 传库名（DATABASE()），
        // PG 传 schema 名（两侧的 information_schema 都把该值放在 table_schema 列）。
        const grouped = groupColumnMetadata(rows, allowed, filter, dialect.scopeFor(base.connection))
        if (!grouped.ok) return connectionToolError(base.connection, '读取表结构失败：' + grouped.error)
        return { ok: true, connection: base.connection.name, connectionId: base.connection.id, tables: grouped.tables }
      } catch (err) {
        return connectionToolError(base.connection, '读取表结构失败：' + dialect.describeError(err))
      }
    },
  }

  const executeTool = {
    name: T.execute,
    description:
      '对当前会话已选数据源执行一条写 SQL（仅 INSERT/UPDATE/DELETE，单条语句）。多选时必须用 connectionId 指定一个已选目标，单选可省略。' +
      '仅当目标连接显式开启「允许写操作」时可用（默认关闭）；表名受目标数据源白名单限制；结构变更（DDL）与多语句一律拒绝（DDL 请用 ' + T.ddl + '）。' +
      writeResultShape + '。写前先查库确认目标数据，值用 ' + placeholder + ' 占位符传参。' +
      (isPostgres ? '本工具只接受 PostgreSQL 连接。' : ''),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        connectionId: { type: 'string', description: '多选数据源时必填：选择当前会话已选的一个数据源 ID。' },
        sql: { type: 'string', description: '一条 INSERT/UPDATE/DELETE SQL 语句。' },
        params: { type: 'array', description: '可选的位置参数，对应 SQL 中的 ' + placeholder + ' 占位符。' },
      },
      required: ['sql'],
    },
    output: OUTPUT,
    timeoutMs: 30000,
    async execute(args, exec) {
      const sql = dialect.stripComments(typeof (args && args.sql) === 'string' ? args.sql : '').trim()
      if (!sql) return toolError('SQL 为空')
      const base = await execCtx(exec, args, dialect)
      if (base.error !== undefined) return toolError(base.error)
      if (base.connection.allowWrite !== true) {
        return connectionToolError(
          base.connection,
          '当前连接未开启写权限（allowWrite=false）：请在 设置 → 数据库连接 中为该连接开启「允许 Agent 执行写操作」',
        )
      }
      const kind = dialect.classify(sql)
      if (kind !== 'write-dml') {
        return connectionToolError(
          base.connection,
          T.execute + ' 只允许 INSERT/UPDATE/DELETE 语句；结构变更（DDL）请使用 ' + T.ddl + '，其它写操作一律拒绝',
        )
      }
      if (dialect.hasMultipleStatements(sql)) return connectionToolError(base.connection, '不允许一次执行多条语句')
      const allow = dialect.allowlistMatch(dialect.tableRefs(sql), base.connection.tables)
      if (!allow.ok) return connectionToolError(base.connection, '写入涉及白名单外的表：' + allow.denied.join(', '))
      try {
        const result = await dialect.execute(base.pool, sql, Array.isArray(args && args.params) ? args.params : [])
        const payload = {
          ok: true,
          connection: base.connection.name,
          connectionId: base.connection.id,
          affectedRows: result.affectedRows || 0,
        }
        // 只回传该方言真正能提供的字段，不伪造 0（PG 没有 insertId 概念）。
        if (dialect.supportsInsertId) payload.insertId = result.insertId || 0
        if (Array.isArray(result.returnedRows) && result.returnedRows.length > 0) {
          payload.returnedRows = result.returnedRows.map(jsonSafe)
        }
        return payload
      } catch (err) {
        return connectionToolError(base.connection, '写入失败：' + dialect.describeError(err))
      }
    },
  }

  const ddlTool = {
    name: T.ddl,
    description:
      '对当前会话已选数据源执行一条结构变更 SQL（仅 CREATE/ALTER/DROP/RENAME/TRUNCATE 作用于表、视图、索引，单条语句）。' +
      '多选时必须用 connectionId 指定一个已选目标，单选可省略。仅当目标连接显式开启「允许结构变更（DDL）」时可用（默认关闭）；' +
      'DDL 不可回滚，执行前先用 ' + T.tables + ' 确认现有结构。' +
      '账号与权限类语句与库级语句永久拒绝；ALTER/RENAME/DROP/TRUNCATE 的目标表受白名单限制（空名单=不限制），CREATE 新表无需预先加入白名单；' +
      ddlScopeText + '。' + ddlResultShape + '。值可用 ' + placeholder + ' 占位符传参，表名/列名等标识符不能用占位符。' +
      (isPostgres ? '本工具只接受 PostgreSQL 连接。' : ''),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        connectionId: { type: 'string', description: '多选数据源时必填：选择当前会话已选的一个数据源 ID。' },
        sql: { type: 'string', description: '一条 CREATE/ALTER/DROP/RENAME/TRUNCATE SQL 语句（作用于表、视图、索引）。' },
        params: { type: 'array', description: '可选的位置参数，对应 SQL 中的 ' + placeholder + ' 占位符。' },
      },
      required: ['sql'],
    },
    output: OUTPUT,
    timeoutMs: 30000,
    async execute(args, exec) {
      const sql = dialect.stripComments(typeof (args && args.sql) === 'string' ? args.sql : '').trim()
      if (!sql) return toolError('SQL 为空')
      const base = await execCtx(exec, args, dialect)
      if (base.error !== undefined) return toolError(base.error)
      if (base.connection.allowDdl !== true) {
        return connectionToolError(
          base.connection,
          '当前连接未开启结构变更权限（allowDdl=false）：请在 设置 → 数据库连接 → 权限与安全 中为该连接开启「允许结构变更（DDL）」',
        )
      }
      const kind = dialect.classify(sql)
      if (kind !== 'ddl') {
        return connectionToolError(
          base.connection,
          T.ddl + ' 只允许 CREATE/ALTER/DROP/RENAME/TRUNCATE 作用于表、视图、索引；账号与权限类语句、库级语句与其它语句一律拒绝',
        )
      }
      if (dialect.hasMultipleStatements(sql)) return connectionToolError(base.connection, '不允许一次执行多条语句')
      const ddl = dialect.ddlTargets(sql)
      const boundary = dialect.boundary([...ddl.created, ...ddl.mutated, ...ddl.referenced], base.connection)
      if (!boundary.ok) {
        const scope = dialect.scopeLabel(base.connection)
        return connectionToolError(
          base.connection,
          '结构变更只能作用于当前连接的' + scope + '，跨作用域目标被拒绝：' + boundary.denied.join(', '),
        )
      }
      // 新建对象豁免白名单（新名字不可能预先在白名单里）；改/删目标与语句读到的表都要命中
      const targets = dialect.allowlistMatch(ddl.mutated, base.connection.tables)
      if (!targets.ok) return connectionToolError(base.connection, '结构变更涉及白名单外的表：' + targets.denied.join(', '))
      const reads = dialect.allowlistMatch(
        [...dialect.tableRefs(sql), ...ddl.referenced],
        base.connection.tables,
      )
      if (!reads.ok) return connectionToolError(base.connection, '结构变更涉及白名单外的表：' + reads.denied.join(', '))
      try {
        const result = await dialect.ddl(base.pool, sql, Array.isArray(args && args.params) ? args.params : [])
        const payload = {
          ok: true,
          connection: base.connection.name,
          connectionId: base.connection.id,
          affectedRows: result.affectedRows || 0,
        }
        if (dialect.supportsWarningCount) payload.warningCount = result.warningCount || 0
        return payload
      } catch (err) {
        return connectionToolError(base.connection, '结构变更失败：' + dialect.describeError(err))
      }
    },
  }

  return { query: queryTool, tables: tablesTool, execute: executeTool, ddl: ddlTool }
}

/** 方言展示名（错误信息用）。 */
function labelOf(type) {
  return DIALECT_DEFAULTS[type] !== undefined ? DIALECT_DEFAULTS[type].label : type
}

/**
 * 生成上下文里的「可用工具族」段落。
 * 只列出本会话实际选中的方言对应的工具族 —— 会话里没有 PG 数据源时，
 * 提示词里不该出现 pg_* 的说明（既省 token，也避免模型误用）。
 */
function toolFamilyHelp(types) {
  const lines = []
  if (types.includes('mysql')) {
    lines.push(
      '- MySQL 工具族：mysql_query 只读查询（SELECT/SHOW/DESCRIBE/EXPLAIN，单条语句，最多返回 ' + MAX_ROWS +
      ' 行，占位符 ?）；mysql_tables 查看表结构；mysql_execute 写操作（仅 INSERT/UPDATE/DELETE，需目标连接开启写权限）；' +
      'mysql_ddl 结构变更（CREATE/ALTER/DROP/RENAME/TRUNCATE，需目标连接开启结构变更权限）。',
    )
  }
  if (types.includes('postgres')) {
    lines.push(
      '- PostgreSQL 工具族：pg_query 只读查询（SELECT/WITH/TABLE/VALUES/EXPLAIN/SHOW，单条语句，最多返回 ' + MAX_ROWS +
      ' 行，占位符 $1/$2）；pg_tables 查看表结构；pg_execute 写操作（仅 INSERT/UPDATE/DELETE，需目标连接开启写权限）；' +
      'pg_ddl 结构变更（仅表/视图/索引，需目标连接开启结构变更权限；DROP INDEX、OWNER TO、SET SCHEMA 永久拒绝）。',
    )
  }
  if (types.length > 1) {
    lines.push('- 每个数据源只能使用与其类型匹配的工具族（MySQL 用 mysql_*，PostgreSQL 用 pg_*）；用错会被明确拒绝。')
  }
  return lines
}

// ── Typert 服务方法（Client 经网关调用）───────────────────────────────────

async function listConnections() {
  const configs = await ensureLoaded()
  return { ok: true, connections: configs.connections.map(publicView) }
}

async function getSelection(args) {
  const configs = await ensureLoaded()
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined
  return {
    ok: true,
    ...selectionResult(configs, sessionId),
    connections: configs.connections.map(publicView),
  }
}

async function selectConnection(args) {
  const configs = await ensureLoaded()
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined
  const ids = args && Array.isArray(args.connectionIds)
    ? args.connectionIds
    : (args && typeof args.connectionId === 'string' && args.connectionId ? [args.connectionId] : null)
  const replaced = replaceSelectedConnectionIds(configs.connections, sessionId, ids, sessionSelection)
  if (!replaced.ok) return replaced
  const selected = configs.connections.filter((connection) => replaced.connectionIds.includes(connection.id))
  return {
    ok: true,
    ...selectionResult(configs, sessionId),
    name: selected.length === 1 ? selected[0].name : undefined,
    names: selected.map((connection) => connection.name),
  }
}

async function saveConnection(args) {
  const input = args && typeof args.connection === 'object' && !Array.isArray(args.connection) ? args.connection : null
  if (input === null) return { ok: false, error: '缺少连接配置' }
  // Host-side validation complements the UI gate: a direct RPC caller cannot
  // persist schema-change authorization without sending the explicit consent bit.
  if (input.allowDdl === true && input.ddlRiskConfirmed !== true) {
    return { ok: false, error: '开启结构变更权限前，请先勾选风险确认' }
  }
  const next = normalizeConnection(input)
  if (!next.name) return { ok: false, error: '连接名称不能为空' }
  const configs = await ensureLoaded()
  const existing = next.id ? configs.connections.find((c) => c.id === next.id) : undefined
  let id = next.id
  if (id === '') {
    id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }
  next.id = id
  if (existing !== undefined && (input.password === undefined || input.password === null || input.password === '')) {
    // 编辑时密码留空 = 保留原密码
    next.password = existing.password
  }
  const list = configs.connections.filter((c) => c.id !== id)
  list.push(next)
  try {
    await persistConfigs({ connections: list })
  } catch (err) {
    return { ok: false, error: '保存失败：' + describeDbError(err) }
  }
  // 配置变更：丢弃旧池，下次使用时按新配置重建
  await dropPool(id)
  lastTest.delete(id) // 配置已变，旧的测试状态失效
  return { ok: true, connection: publicView(next) }
}

async function deleteConnection(args) {
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  const configs = await ensureLoaded()
  const list = configs.connections.filter((c) => c.id !== connectionId)
  if (list.length === configs.connections.length) return { ok: false, error: '连接不存在：' + connectionId }
  try {
    await persistConfigs({ connections: list })
  } catch (err) {
    return { ok: false, error: '删除失败：' + describeDbError(err) }
  }
  await dropPool(connectionId)
  lastTest.delete(connectionId)
  removeSelectedConnectionId(connectionId, sessionSelection)
  return { ok: true }
}

async function testConnection(args) {
  const configs = await ensureLoaded()
  const input = args && typeof args.connection === 'object' && !Array.isArray(args.connection) ? args.connection : null
  let cfg
  let testId = null
  if (input !== null && input.name !== undefined) {
    // 测试未保存的表单草稿（不记录状态）
    cfg = normalizeConnection(input)
    if (cfg.id && (input.password === undefined || input.password === null || input.password === '')) {
      const existing = configs.connections.find((c) => c.id === cfg.id)
      if (existing !== undefined) cfg.password = existing.password
    }
  } else {
    const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
    const existing = configs.connections.find((c) => c.id === connectionId)
    if (existing === undefined) return { ok: false, error: '连接不存在：' + connectionId }
    cfg = existing
    testId = existing.id
  }
  let pool = null
  let dialect = null
  const started = Date.now()
  try {
    dialect = createDialect(cfg.type)
    // 测试连接用一次性小池（limit 1），与业务池分开，避免污染长期池的指纹。
    pool = dialect.createPool(dialect.poolConfig(cfg), { limit: 1 })
    const { rows } = await dialect.query(pool, dialect.probeSql, [])
    const latencyMs = Date.now() - started
    if (testId !== null) lastTest.set(testId, { at: Date.now(), latencyMs, error: null })
    return { ok: true, latencyMs, reached: !!(rows && rows[0]) }
  } catch (err) {
    const message = '连接失败：' + (dialect !== null ? dialect.describeError(err) : describeDbError(err))
    if (testId !== null) lastTest.set(testId, { at: Date.now(), latencyMs: null, error: message })
    return { ok: false, error: message }
  } finally {
    if (pool !== null) {
      const closer = dialect !== null ? dialect.endPool : null
      if (closer !== null) await closer(pool)
      else await pool.end().catch(() => {})
    }
  }
}

async function listTables(args) {
  const configs = await ensureLoaded()
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  const cfg = configs.connections.find((c) => c.id === connectionId)
  if (cfg === undefined) return { ok: false, error: '连接不存在：' + connectionId }
  const got = await getPool(configs, connectionId)
  if (got.error !== undefined) return { ok: false, error: got.error }
  const dialect = got.dialect
  try {
    const spec = dialect.tablesSql(dialect.scopeFor(cfg))
    const { rows } = await dialect.query(got.pool, spec.sql, spec.params)
    const allowed = cfg.tables
    // 白名单比较按方言归一化（PG 的引号标识符保留大小写），不再无条件 toLowerCase。
    const lowered = allowed.map((name) => name.toLowerCase())
    const tables = (Array.isArray(rows) ? rows : [])
      .filter((r) => {
        if (allowed.length === 0) return true
        const raw = String(r.table_name)
        return allowed.includes(raw) || lowered.includes(raw.toLowerCase())
      })
      .map((r) => ({ name: String(r.table_name), comment: r.table_comment ? String(r.table_comment) : '' }))
    return { ok: true, tables }
  } catch (err) {
    return { ok: false, error: '读取表列表失败：' + dialect.describeError(err) }
  }
}

const service = {
  listConnections,
  getSelection,
  selectConnection,
  saveConnection,
  deleteConnection,
  testConnection,
  listTables,
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx) {
  bootLog('apply start; storage file: ' + storageFile())
  ensureLoaded() // 启动即加载（systemPrompt section 提供器同步读取内存缓存）
  ensureLoaded().then((c) => bootLog('configs loaded: ' + c.connections.length)).catch(() => {})

  // 按方言注册工具族：MySQL → mysql_*，PostgreSQL → pg_*。
  // 分段防护：任何一族失败只记录日志，不拖垮其余注册（也不影响服务与上下文）。
  const registerToolFamilies = () => {
    const registered = []
    for (const type of DIALECT_TYPES) {
      try {
        const dialect = createDialect(type)
        const tools = createToolSet(dialect)
        for (const tool of Object.values(tools)) {
          ctx.tools.register(tool)
          registered.push(tool.name)
        }
      } catch (err) {
        bootLog('tools register FAILED for ' + type + ': ' + describeDbError(err))
        console.error('[dsh-mysql] tools register failed for ' + type, err)
      }
    }
    if (registered.length > 0) bootLog('tools registered: ' + registered.join(', '))
    return registered
  }
  registerToolFamilies()

  // 动态数据库上下文：走 systemPrompt.context（对话尾部的运行时上下文快照），
  // 不写入系统提示词前缀 —— 改变会话数据源集合/编辑配置不会让前缀缓存失效。
  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
      systemPrompt.context({
        name: 'dsh-mysql-context',
        order: 200,
        text: (assemble) => {
          const agent = assemble && assemble.agent
          const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
          if (cachedConfigs.connections.length === 0) return ''
          const connections = resolveSelectedConnections(cachedConfigs, sessionId)
          if (connections.length === 0) {
            return '数据库：当前会话尚未选择连接。需要查库时，请提醒用户在输入栏点击「数据库连接」按钮选择一个或多个连接。'
          }
          const multiple = connections.length > 1
          const dialectsInUse = [...new Set(connections.map((connection) => connection.type))]
          return [
            '数据库上下文（以下仅列出用户为当前会话选定的数据源）：',
            ...connections.flatMap((connection) => {
              const meta = DIALECT_DEFAULTS[connection.type] || DIALECT_DEFAULTS[DEFAULT_DIALECT]
              const scope = connection.type === 'postgres'
                ? '/' + (connection.database || '未指定默认库') + '（schema：' + (connection.schema || '未指定，使用 search_path') + '）'
                : '/' + (connection.database || '未指定默认库')
              return [
                '- 数据源：' + connection.name + '（connectionId=' + connection.id + '；类型：' + meta.label + '；' +
                  connection.host + ':' + connection.port + scope + '）',
                '  可读表：' + (connection.tables.length > 0 ? connection.tables.join('、') : '全部（未配置白名单）') +
                  '；行写入：' + (connection.allowWrite ? '已允许' : '未允许') +
                  '；结构变更：' + (connection.allowDdl ? '已允许' : '未允许'),
              ]
            }),
            multiple
              ? '- 重要：每次调用数据库工具，必须传入且仅传入一个上述已选数据源的 connectionId；禁止广播到多个数据源。'
              : '- 仅选中一个数据源，可省略工具参数 connectionId；也可显式传入上方 ID。',
            ...toolFamilyHelp(dialectsInUse),
            '- DDL 目标受对应数据源的表白名单限制（空白名单=不限），且只能在其允许的作用域内执行；查询前先确认结构，回答时附上实际执行的 SQL 与查到的字段值。',
            dialectsInUse.includes('postgres')
              ? '- PostgreSQL 专用：占位符用 $1、$2（不是 ?）；未加双引号的标识符折叠为小写；需要新行值时在 SQL 末尾加 RETURNING（结果在 returnedRows）。'
              : '',
          ].filter((line) => line !== '').join('\n')
        },
      })
      bootLog('systemPrompt context registered')
    }
  } catch (err) {
    bootLog('systemPrompt context FAILED: ' + describeDbError(err))
    console.error('[dsh-mysql] systemPrompt context failed', err)
  }

  // 会话销毁时清理所选数据源集合
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (agent && typeof agent.id === 'string') sessionSelection.delete(agent.id)
  })

  // Typert 服务提供（网关经 ./typert 清单暴露给客户端）
  try {
    // 幂等：插件可能被再次 apply（profile 重载 / HMR / 同进程重复挂载）。
    // 无条件的 defineProperty 在第二次会抛 TypeError: Cannot redefine property，
    // 让「服务未注册」这一致命状态只留下一行日志就继续 —— 客户端于是永远拿不到
    // RPC 接口。这里先看是否已经就位，避免重复定义。
    if (service.typertRemote === undefined) {
      Object.defineProperty(service, 'typertRemote', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: { service, serviceKey: 'mysql', namespace: 'mysql' },
      })
    }
    ctx.provide('mysql', service)
    bootLog('service mysql provided')
  } catch (err) {
    bootLog('provide mysql FAILED: ' + describeDbError(err))
    console.error('[dsh-mysql] provide mysql failed', err)
  }

  // 回收全部连接池（每种方言用自己的 endPool 语义）
  ctx.on('dispose', () => {
    for (const hit of pools.values()) hit.dialect.endPool(hit.pool).catch(() => {})
    pools.clear()
  })

  bootLog('apply complete')
  console.log('[dsh-mysql] host mounted, connections =', cachedConfigs.connections.length)
}
