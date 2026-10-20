/**
 * MySQL 方言适配器。
 *
 * 这个文件的内容**从 lib/index.js 逐字搬迁**，唯一的变化是包装成统一接口：
 * 池参数、文本协议 DDL、MAX_EXECUTION_TIME 提示、information_schema 查询、
 * dateStrings 时区处理等 MySQL 专属行为全部保持原样（每处都标注了原行号来源）。
 *
 * 不在这里做的事：配置持久化、会话选择、工具参数校验 —— 那些是方言无关的，
 * 留在 lib/index.js。
 */
import { createPool as createMysqlPool } from 'mysql2/promise'
import {
  MYSQL_LEX,
  MAX_ROWS,
  stripSqlComments,
  classifyStatement,
  hasMultipleStatements,
  extractTableRefDetails,
  extractDdlTargets,
  checkTableRefs,
  checkDatabaseBoundary,
  normalizeTables,
  describeDbError,
} from '../shared.js'

const DEFAULT_TYPE = 'mysql'

// 池与超时参数：与改造前 lib/index.js:61-63 一致，数值不得改变。
const MAX_EXECUTION_MS = 15000
const POOL_CONNECTION_LIMIT = 3
const CONNECT_TIMEOUT_MS = 10000

/**
 * 建池。`options.limit` 用于测试连接场景（原 lib/index.js:593 的 connectionLimit: 1），
 * 其余参数与改造前 getPool() 完全一致（原 lib/index.js:188-204）。
 */
function createPool(cfg, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : POOL_CONNECTION_LIMIT
  const pool = createMysqlPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    waitForConnections: true,
    connectionLimit: limit,
    enableKeepAlive: true,
    multipleStatements: false,
    // 原样保留 MySQL 返回的日期/时间字符串，避免 mysql2 按本机时区转 Date 后
    // 再由 jsonSafe 的 toISOString() 转成 UTC，造成 DATETIME/TIMESTAMP 时区偏移。
    // （v0.1.10 的时区修复，不得移除。）
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  })
  // 空闲连接被服务端/中间件切断时，mysql2 会在池上 emit('error')。
  // 没有监听器时 Node 会当作未捕获异常。记录日志即可，下次取连接会自动重连。
  attachPoolErrorHandler(pool)
  return pool
}

function attachPoolErrorHandler(pool) {
  if (pool !== null && typeof pool === 'object' && typeof pool.on === 'function') {
    pool.on('error', (err) => {
      console.error('[dsh-mysql] mysql pool error', describeDbError(err, 'MySQL'))
    })
  }
}

async function endPool(pool) {
  if (pool === null || typeof pool !== 'object') return
  if (typeof pool.end === 'function') await pool.end().catch(() => {})
}

/**
 * 执行只读查询。
 * 注意返回值形状与 pg 对齐（{ columns, rows }）：mysql2 返回 [rows, fields] 元组，
 * pg 返回对象，差异在这里被吸收，调用方不再解构元组。
 */
async function query(pool, sql, params) {
  const [rows, fields] = await pool.query(sql, Array.isArray(params) ? params : [])
  const columns = Array.isArray(fields) ? fields.map((f) => f.name) : []
  return { columns, rows: Array.isArray(rows) ? rows : [] }
}

/**
 * 执行写语句：沿用预处理协议（pool.execute），返回受影响行数与自增 ID。
 * 原 lib/index.js:401-408。
 */
async function execute(pool, sql, params) {
  const [result] = await pool.execute(sql, Array.isArray(params) ? params : [])
  return {
    affectedRows: (result && result.affectedRows) || 0,
    insertId: (result && result.insertId) || 0,
    warningCount: (result && typeof result.warningStatus === 'number') ? result.warningStatus : 0,
    returnedRows: [],
  }
}

/**
 * 执行 DDL：必须走文本协议（pool.query）。
 * MySQL 对部分 DDL 直接返回 ER_UNSUPPORTED_PS 1295，不能走预处理协议。
 * 原 lib/index.js:463-473。
 */
async function ddl(pool, sql, params) {
  const [result] = await pool.query(sql, Array.isArray(params) ? params : [])
  const header = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : null
  return {
    affectedRows: header && typeof header.affectedRows === 'number' ? header.affectedRows : 0,
    insertId: header && typeof header.insertId === 'number' ? header.insertId : 0,
    warningCount: header && typeof header.warningStatus === 'number' ? header.warningStatus : 0,
    returnedRows: [],
  }
}

/**
 * 为 SELECT 注入 MAX_EXECUTION_TIME 提示，防止无 LIMIT 的长查询拖垮连接。
 * 原 lib/index.js:247-251。MySQL 5.7.8+ 支持；MariaDB 可能忽略。
 */
function prepareReadSql(sql) {
  if (/\/\*\+/i.test(sql)) return sql // 已自带优化器提示时不重复注入
  return sql.replace(/^(\s*)(select)/i, '$1$2 /*+ MAX_EXECUTION_TIME(' + MAX_EXECUTION_MS + ') */')
}

/** 列元数据查询（原 lib/index.js:354-358，逐字保留 DATABASE() 语义）。 */
function columnsSql() {
  return {
    sql:
      'SELECT table_schema, table_name, column_name, column_type, is_nullable, column_key, column_comment ' +
      'FROM information_schema.columns WHERE table_schema = DATABASE() ' +
      'ORDER BY table_name, ordinal_position',
    params: [],
  }
}

/** 表列表查询（原 lib/index.js:617-619）。 */
function tablesSql() {
  return {
    sql: 'SELECT table_name, table_comment FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
    params: [],
  }
}

/**
 * 「作用域」在本方言里就是默认库名：information_schema 用 table_schema 比对库名。
 * 未配置默认库时返回空串，groupColumnMetadata 会跳过库过滤（与改造前一致）。
 */
function scopeFor(cfg) {
  return typeof cfg.database === 'string' ? cfg.database : ''
}

/** 连通性探测语句（原 lib/index.js:596）。 */
const PROBE_SQL = 'SELECT 1 AS ok'

/** 建池时把配置里的方言专属字段（schema）剔除，避免传给 mysql2。 */
function poolConfig(cfg) {
  return {
    type: DEFAULT_TYPE,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  }
}

export default {
  type: DEFAULT_TYPE,
  label: 'MySQL',

  /** 该方言的工具族命名（工具名是模型可读的契约，不能两边共用一套）。 */
  toolNames: { query: 'mysql_query', tables: 'mysql_tables', execute: 'mysql_execute', ddl: 'mysql_ddl' },

  /** 占位符样式与提示文案：MySQL 用 ?，PG 用 $n。 */
  placeholder: '?',

  lex: MYSQL_LEX,
  maxRows: MAX_ROWS,
  probeSql: PROBE_SQL,

  // 能力标记：工具层据此决定结果字段里出现哪些键，而不是猜。
  supportsInsertId: true,
  supportsWarningCount: true,
  supportsReturning: false,

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

  // ── 词法/校验（全部转调 shared.js 的 MySQL 默认语义）──────────────
  stripComments(sql) { return stripSqlComments(sql, MYSQL_LEX) },
  classify(sql) { return classifyStatement(sql, MYSQL_LEX) },
  hasMultipleStatements(sql) { return hasMultipleStatements(sql, MYSQL_LEX) },
  tableRefs(sql) { return extractTableRefDetails(sql, MYSQL_LEX) },
  ddlTargets(sql) { return extractDdlTargets(sql, MYSQL_LEX) },
  normalizeAllowlist(list) { return normalizeTables(list, MYSQL_LEX) },
  allowlistMatch(refs, allowlist) {
    return checkTableRefs(refs.map((ref) => ref.name), allowlist)
  },
  /** 库边界：MySQL 是两段式 db.table。 */
  boundary(refs, cfg) {
    return checkDatabaseBoundary(refs, cfg.database)
  },
  /**
   * 错误文案。
   *
   * 连接在建立阶段被对端关掉时，mysql2 给出的是
   * `Connection lost: The server closed the connection.`（PROTOCOL_CONNECTION_LOST）。
   * 这句本身可读，但没说是「连接超时」还是「地址/端口不通」；与 pg 侧一致补上
   * 排查方向。其余错误（ER_*、ECONNREFUSED、ENOENT）原样返回，不追加噪音。
   */
  describeError(err) {
    const base = describeDbError(err, 'MySQL')
    if (/^Connection lost: The server closed the connection\.?$/i.test(base)) {
      return base + '（连接未建立即被对端关闭：请检查主机/端口可达性，或连接超时 ' + CONNECT_TIMEOUT_MS + 'ms 是否过短）'
    }
    return base
  },

  /** 作用域的展示文案（错误信息用）。 */
  scopeLabel(cfg) {
    return cfg.database ? '默认库（' + cfg.database + '）' : '默认库（连接未配置默认库）'
  },
}
