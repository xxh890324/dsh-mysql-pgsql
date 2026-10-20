/**
 * PostgreSQL 方言适配器。
 *
 * 与 mysql.js 实现同一组方法（契约见 lib/index.js 的调用点），但有三处
 * **不可通过换驱动解决**的差异，必须在这里显式处理：
 *
 *  1. 结果形状：pg 返回 { rows, fields, rowCount } 对象，不是 mysql2 的
 *     [rows, fields] 元组。手工解构元组会让所有读路径直接 TypeError。
 *  2. 占位符：pg 只认 $1、$2；MySQL 的 ? 会原样发给服务端并报语法错。
 *     本适配器**不做隐式改写** —— 改写会误伤 jsonb 的 ? / ?| / ?& 运算符。
 *  3. 元数据：information_schema 缺 column_type / column_key / column_comment，
 *     且没有 DATABASE()。这里改用 pg_catalog 并把列**别名对齐到 MySQL 的列名**，
 *     让 groupColumnMetadata 无需感知方言即可复用。
 *
 * 另外两个 pg 特有的运行期陷阱：
 *  - 空闲连接被服务端切断时池会 emit('error')，无监听器会让宿主进程崩溃；
 *  - 时间戳默认被解析成 Date，再经 jsonSafe.toISOString() 会引入时区偏移
 *    （正是 MySQL 侧 v0.1.10 修掉的 bug）。前者靠 pool.on('error')，后者靠
 *    每连接池独立的 types 解析器（不改全局 pg.types）。
 */
import pg from 'pg'
import {
  PG_LEX,
  MAX_ROWS,
  stripSqlComments,
  classifyStatement,
  hasMultipleStatements,
  extractTableRefDetails,
  extractDdlTargets,
  checkDetailAllowlist,
  normalizeTables,
  checkScopedBoundary,
  describeDbError,
} from '../shared.js'

const { Pool, types } = pg

const DEFAULT_TYPE = 'postgres'

// 与 MySQL 侧对齐的超时/池参数：同一套语义，只是 pg 的字段名不同。
const STATEMENT_TIMEOUT_MS = 15000
const POOL_CONNECTION_LIMIT = 3
const CONNECT_TIMEOUT_MS = 10000
const IDLE_TIMEOUT_MS = 30000

/**
 * 以字符串形式返回的日期/时间类型 OID：
 * date(1082) / time(1083) / timestamp(1114) / timestamptz(1184) / timetz(1266)。
 * 这些类型在 pg 默认解析下会变成 JS Date，jsonSafe 再 toISOString() 就变成 UTC，
 * 与 MySQL 侧 dateStrings:true 的修复目标冲突。原样返回服务端文本最安全。
 */
const TEXT_DATE_OIDS = new Set(['1082', '1083', '1114', '1184', '1266'])

function createTypeOverrides() {
  return {
    getTypeParser(oid, format) {
      if (TEXT_DATE_OIDS.has(String(oid))) return (value) => value
      return types.getTypeParser(oid, format)
    },
  }
}

/** 把标识符包成 PG 的双引号形式（内部双引号翻倍）。 */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

/**
 * 建池。
 *
 * 注意 pg 会**静默忽略**它不认识的选项：如果照搬 mysql2 的 connectTimeout /
 * connectionLimit，不会报错，但连接超时与池上限会悄悄失效。因此这里显式做
 * 名称映射，并对明显是 mysql2 风格的键抛错（fail loud，便于测试发现）。
 */
function createPool(cfg, options = {}) {
  const unknown = ['connectTimeout', 'connectionLimit', 'waitForConnections', 'multipleStatements', 'dateStrings']
    .filter((key) => cfg[key] !== undefined)
  if (unknown.length > 0) {
    throw new Error('pg 连接池不接受 mysql2 风格选项：' + unknown.join(', ') + '（请使用 connectionTimeoutMillis / max 等）')
  }
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : POOL_CONNECTION_LIMIT
  // 会话级超时：PG 没有 MySQL 的 MAX_EXECUTION_TIME 优化器提示，注入 hint 会
  // 直接语法错误；改用启动参数把 statement_timeout 设到会话上。
  const serverOptions = ['-c statement_timeout=' + STATEMENT_TIMEOUT_MS]
  if (cfg.schema) serverOptions.push('-c search_path=' + quoteIdent(cfg.schema))
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    max: limit,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    keepAlive: true,
    application_name: 'dsh-mysql',
    options: serverOptions.join(' '),
    // 每池独立的类型解析器，不触碰全局 pg.types（宿主进程里可能还有别的插件用 pg）。
    types: createTypeOverrides(),
  })
  // 必须注册：空闲连接出错时 pg-pool 会 emit('error')，没有监听器 Node 会
  // 当作未捕获异常直接终止宿主进程。
  pool.on('error', (err) => {
    console.error('[dsh-mysql] pg idle client error', describeDbError(err, 'PostgreSQL'))
  })
  return pool
}

async function endPool(pool) {
  if (pool === null || typeof pool !== 'object') return
  if (typeof pool.end === 'function') await pool.end().catch(() => {})
}

/** 只读查询：把 pg 的 { rows, fields } 归一成与 mysql.js 相同的形状。 */
async function query(pool, sql, params) {
  const res = await pool.query(sql, Array.isArray(params) ? params : [])
  return {
    columns: Array.isArray(res.fields) ? res.fields.map((f) => f.name) : [],
    rows: Array.isArray(res.rows) ? res.rows : [],
  }
}

/**
 * 写语句。pg 没有 insertId；需要新行值时由调用方在 SQL 末尾加 RETURNING，
 * 结果会放在 returnedRows 里（工具层据此决定是否回传）。
 */
async function execute(pool, sql, params) {
  const res = await pool.query(sql, Array.isArray(params) ? params : [])
  return {
    affectedRows: typeof res.rowCount === 'number' ? res.rowCount : 0,
    insertId: null,
    warningCount: 0,
    returnedRows: Array.isArray(res.rows) ? res.rows : [],
  }
}

/** DDL。PG 对预处理协议没有 MySQL 那样的限制，走同一条 query 路径即可。 */
async function ddl(pool, sql, params) {
  const res = await pool.query(sql, Array.isArray(params) ? params : [])
  return {
    affectedRows: typeof res.rowCount === 'number' ? res.rowCount : 0,
    insertId: null,
    warningCount: 0,
    returnedRows: [],
  }
}

/**
 * PG 不需要（也不能接受）MySQL 的优化器提示：`/*+ ... *\/` 会被解析器拒绝。
 * 超时已在建池时通过 statement_timeout 落到会话上，这里原样返回。
 */
function prepareReadSql(sql) {
  return sql
}

/**
 * 列元数据查询。
 *
 * 用 pg_catalog 而不是 information_schema，理由是这里需要「键类型」与「注释」，
 * information_schema 拿不到（它只有 column_key 的 MySQL 对应物，PG 没有）。
 * 三处别名（column_type / column_key / column_comment）是为了让
 * groupColumnMetadata 直接复用：它的必需字段检查与表结构输出格式无需改动。
 */
function columnsSql(scope) {
  const bound = typeof scope === 'string' ? scope.trim() : ''
  const sql =
    'SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name, ' +
    'format_type(a.atttypid, a.atttypmod) AS column_type, ' +
    "CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, " +
    "COALESCE(pk.key_kind, '') AS column_key, " +
    "COALESCE(col_description(c.oid, a.attnum), '') AS column_comment " +
    'FROM pg_catalog.pg_class c ' +
    'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
    'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ' +
    "LEFT JOIN LATERAL (SELECT CASE WHEN i.indisprimary THEN 'PRI' ELSE 'UNI' END AS key_kind " +
    '  FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND a.attnum = ANY(i.indkey) ' +
    '  ORDER BY i.indisprimary DESC LIMIT 1) pk ON TRUE ' +
    "WHERE c.relkind IN ('r','p','v','m','f') " +
    'AND n.nspname = COALESCE(NULLIF($1, \'\'), current_schema()) ' +
    'ORDER BY c.relname, a.attnum'
  return { sql, params: [bound] }
}

/**
 * 表列表查询。
 * table_comment 用 obj_description 取，保持与 MySQL 的 table_comment 同义。
 */
function tablesSql(scope) {
  const bound = typeof scope === 'string' ? scope.trim() : ''
  const sql =
    'SELECT c.relname AS table_name, COALESCE(obj_description(c.oid, \'pg_class\'), \'\') AS table_comment ' +
    'FROM pg_catalog.pg_class c ' +
    'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
    "WHERE c.relkind IN ('r','p','v','m','f') " +
    'AND n.nspname = COALESCE(NULLIF($1, \'\'), current_schema()) ' +
    'ORDER BY c.relname'
  return { sql, params: [bound] }
}

/**
 * 作用域：PG 的作用域是 schema（不是库）。未配置时返回空串，
 * 让 SQL 回落到 current_schema()，同时让 groupColumnMetadata 跳过 schema 过滤。
 */
function scopeFor(cfg) {
  return typeof cfg.schema === 'string' ? cfg.schema : ''
}

const PROBE_SQL = 'SELECT 1 AS ok'

function poolConfig(cfg) {
  return {
    type: DEFAULT_TYPE,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    schema: cfg.schema,
  }
}

export default {
  type: DEFAULT_TYPE,
  label: 'PostgreSQL',

  toolNames: { query: 'pg_query', tables: 'pg_tables', execute: 'pg_execute', ddl: 'pg_ddl' },
  placeholder: '$1、$2',

  lex: PG_LEX,
  maxRows: MAX_ROWS,
  probeSql: PROBE_SQL,

  // PG 没有自增 ID 与 warning 计数；工具层据此决定结果字段，而不是伪造 0。
  supportsInsertId: false,
  supportsWarningCount: false,
  supportsReturning: true,

  createPool,
  endPool,
  query,
  execute,
  ddl,
  prepareReadSql,
  columnsSql,
  tablesSql,
  scopeFor,
  poolConfig,

  // ── 词法/校验（统一转调 shared.js，传 PG_LEX）───────────────────
  stripComments(sql) { return stripSqlComments(sql, PG_LEX) },
  classify(sql) { return classifyStatement(sql, PG_LEX) },
  hasMultipleStatements(sql) { return hasMultipleStatements(sql, PG_LEX) },
  tableRefs(sql) { return extractTableRefDetails(sql, PG_LEX) },
  ddlTargets(sql) { return extractDdlTargets(sql, PG_LEX) },
  normalizeAllowlist(list) { return normalizeTables(list, PG_LEX) },
  allowlistMatch(refs, allowlist) {
    return checkDetailAllowlist(refs, allowlist, PG_LEX)
  },
  /** 作用域边界：schema 限定名必须与连接的 schema（及库）一致。 */
  boundary(refs, cfg) {
    return checkScopedBoundary(refs, { database: cfg.database, schema: cfg.schema })
  },
  describeError(err) { return describeDbError(err, 'PostgreSQL') },

  scopeLabel(cfg) {
    const schema = cfg.schema ? cfg.schema : '未配置 schema（请先在连接设置中填写，否则显式 schema 前缀会被拒绝）'
    return '默认库（' + (cfg.database || '未指定') + '）与 schema（' + schema + '）'
  },
}
