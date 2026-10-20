/**
 * 方言适配器契约测试。
 *
 * 目的：两个 adapter 必须实现**同一组方法**、返回**同一组形状**。工具层是
 * 完全方言无关的，任何一方少一个方法或换了返回形状，都会在某个语支上变成
 * 运行期 TypeError 而不是启动期错误 —— 这个文件用来把那种问题提前暴露。
 *
 * 只跑纯函数与 SQL 文本生成，不连接任何数据库。
 */
import assert from 'node:assert/strict'
import { createDialect, isDialectType, defaultsFor, DIALECT_TYPES, DIALECT_DEFAULTS } from '../lib/dialects/index.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('✓ ' + name)
  } catch (err) {
    console.error('✗ ' + name)
    throw err
  }
}

const MYSQL = createDialect('mysql')
const PG = createDialect('postgres')
const ADAPTERS = [MYSQL, PG]

// 工具层实际调用的每一个成员。少一个都会在运行期炸。
const REQUIRED_METHODS = [
  'createPool', 'endPool', 'query', 'execute', 'ddl', 'prepareReadSql',
  'columnsSql', 'tablesSql', 'scopeFor', 'poolConfig',
  'stripComments', 'classify', 'hasMultipleStatements',
  'tableRefs', 'ddlTargets', 'normalizeAllowlist', 'allowlistMatch',
  'boundary', 'describeError', 'scopeLabel',
]
const REQUIRED_PROPS = [
  'type', 'label', 'lex', 'maxRows', 'probeSql', 'placeholder',
  'supportsInsertId', 'supportsWarningCount', 'toolNames',
]

test('两个适配器实现同一组方法', () => {
  for (const adapter of ADAPTERS) {
    for (const method of REQUIRED_METHODS) {
      assert.equal(typeof adapter[method], 'function', adapter.type + ' 缺少方法 ' + method)
    }
    for (const prop of REQUIRED_PROPS) {
      assert.notEqual(adapter[prop], undefined, adapter.type + ' 缺少属性 ' + prop)
    }
  }
})

test('工具名互不重叠，且与方言一致', () => {
  const all = [...Object.values(MYSQL.toolNames), ...Object.values(PG.toolNames)]
  assert.equal(new Set(all).size, all.length)
  for (const name of Object.values(MYSQL.toolNames)) assert.match(name, /^mysql_/)
  for (const name of Object.values(PG.toolNames)) assert.match(name, /^pg_/)
})

test('defaults 表与适配器一致', () => {
  assert.equal(defaultsFor('mysql').port, 3306)
  assert.equal(defaultsFor('postgres').port, 5432)
  assert.equal(defaultsFor('mysql').user, 'root')
  assert.equal(defaultsFor('postgres').user, 'postgres')
  assert.deepEqual([...DIALECT_TYPES], ['mysql', 'postgres'])
  assert.equal(isDialectType('postgres'), true)
  assert.equal(isDialectType('oracle'), false)
  assert.equal(DIALECT_DEFAULTS.mysql.label, 'MySQL')
  assert.equal(DIALECT_DEFAULTS.postgres.label, 'PostgreSQL')
})

test('未知方言回落 MySQL（旧配置无需迁移）', () => {
  assert.equal(createDialect(undefined).type, 'mysql')
  assert.equal(createDialect('sqlite').type, 'mysql')
  assert.equal(createDialect('').type, 'mysql')
})

// ── prepareReadSql：只有 MySQL 注入优化器提示 ─────────────────────────────
test('prepareReadSql：MySQL 注入 MAX_EXECUTION_TIME，PG 原样返回', () => {
  assert.equal(MYSQL.prepareReadSql('SELECT 1'), 'SELECT /*+ MAX_EXECUTION_TIME(15000) */ 1')
  assert.equal(PG.prepareReadSql('SELECT 1'), 'SELECT 1')
  // PG 绝不能出现 MySQL 的 hint（那是语法错误）
  assert.doesNotMatch(PG.prepareReadSql('select * from t'), /MAX_EXECUTION_TIME/)
  // 已自带 hint 时不重复注入（既有行为）
  assert.equal(MYSQL.prepareReadSql('SELECT /*+ OTHER */ 1'), 'SELECT /*+ OTHER */ 1')
})

// ── 元数据 SQL：列别名必须对齐，否则 groupColumnMetadata 会 fail closed ──
test('columnsSql 产出可被 groupColumnMetadata 直接消费的列名', () => {
  // MySQL 的原生列名本来就是这套名字，不需要别名；
  // PG 的 pg_catalog 列名不同，必须靠 AS 别名对齐。两者最终都要能喂给
  // groupColumnMetadata 的必需字段检查（table_name/column_name/column_type/is_nullable）。
  const REQUIRED_COLUMNS = ['table_schema', 'table_name', 'column_name', 'column_type', 'is_nullable', 'column_key', 'column_comment']
  for (const adapter of ADAPTERS) {
    const spec = adapter.columnsSql(adapter.type === 'postgres' ? 'public' : '')
    assert.equal(typeof spec.sql, 'string')
    assert.ok(Array.isArray(spec.params), adapter.type + ' 的 params 必须是数组')
    for (const column of REQUIRED_COLUMNS) {
      assert.match(spec.sql, new RegExp(column), adapter.type + ' 的查询缺少列 ' + column)
    }
  }
  // PG 额外要求：这些列来自 pg_catalog，必须以别名产出（不能指望原生同名）
  const pgSql = PG.columnsSql('public').sql
  for (const alias of ['AS table_name', 'AS column_name', 'AS column_type', 'AS is_nullable', 'AS column_key', 'AS column_comment']) {
    assert.ok(pgSql.includes(alias), 'PG 查询缺少 ' + alias)
  }
})

test('tablesSql 产出 table_name / table_comment 两列', () => {
  for (const adapter of ADAPTERS) {
    const spec = adapter.tablesSql('')
    assert.match(spec.sql, /table_name/i)
    assert.match(spec.sql, /table_comment/i)
  }
})

test('PG 元数据查询使用占位符而不是字符串拼接（避免注入）', () => {
  const spec = PG.columnsSql('public')
  assert.deepEqual(spec.params, ['public'])
  assert.match(spec.sql, /\$1/)
  assert.doesNotMatch(spec.sql, /'public'/)
  // schema 为空时让 SQL 回落到 current_schema()
  assert.deepEqual(PG.columnsSql('').params, [''])
  assert.match(PG.columnsSql('').sql, /current_schema\(\)/)
})

test('MySQL 元数据查询保持 DATABASE() 语义', () => {
  assert.match(MYSQL.columnsSql().sql, /DATABASE\(\)/)
  assert.match(MYSQL.tablesSql().sql, /DATABASE\(\)/)
  assert.doesNotMatch(MYSQL.columnsSql().sql, /current_schema/)
})

// ── 作用域 ─────────────────────────────────────────────────────────────────
test('scopeFor：MySQL 取库名，PG 取 schema', () => {
  assert.equal(MYSQL.scopeFor({ database: 'devdb' }), 'devdb')
  assert.equal(PG.scopeFor({ schema: 'public' }), 'public')
  assert.equal(PG.scopeFor({ schema: '' }), '')
  assert.equal(PG.scopeFor({}), '')
})

test('poolConfig 只传本方言认识的字段', () => {
  const base = { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd', schema: 'public' }
  const pgCfg = PG.poolConfig(base)
  assert.equal(pgCfg.schema, 'public')
  assert.equal(pgCfg.connectTimeout, undefined)
  assert.equal(pgCfg.connectionLimit, undefined)
  // MySQL 侧不应携带 schema
  assert.equal(MYSQL.poolConfig(base).schema, undefined)
})

// ── 词法分派确实接了各自方言 ───────────────────────────────────────────────
test('classify 走各自方言的词法', () => {
  assert.equal(MYSQL.classify('SELECT 1'), 'read')
  assert.equal(PG.classify('SELECT 1'), 'read')
  // CTE 只在 PG 下被识别
  assert.equal(MYSQL.classify('WITH t AS (SELECT 1) SELECT * FROM t'), 'unknown')
  assert.equal(PG.classify('WITH t AS (SELECT 1) SELECT * FROM t'), 'read')
  // PG 的提权语句
  assert.equal(PG.classify('ALTER TABLE t OWNER TO u'), 'forbidden')
  assert.equal(PG.classify('DROP INDEX i'), 'forbidden')
})

test('stripComments 走各自方言的注释与引号规则', () => {
  assert.equal(PG.stripComments("SELECT a #>> '{b}'"), "SELECT a #>> '{b}'")
  assert.doesNotMatch(MYSQL.stripComments('SELECT 1 # x'), /# x/)
})

test('tableRefs 返回统一形状 { name, quoted, schema }', () => {
  for (const adapter of ADAPTERS) {
    const refs = adapter.tableRefs('SELECT * FROM t1 JOIN t2 ON t1.a = t2.a')
    assert.deepEqual(refs.map((r) => r.name).sort(), ['t1', 't2'])
    for (const ref of refs) {
      assert.equal(typeof ref.name, 'string')
      assert.equal(typeof ref.quoted, 'boolean')
      assert.equal(typeof ref.schema, 'string')
    }
  }
})

test('allowlistMatch 空白名单=不限制、非空则强制（两种方言一致）', () => {
  for (const adapter of ADAPTERS) {
    const refs = adapter.tableRefs('SELECT * FROM anything')
    assert.equal(adapter.allowlistMatch(refs, []).ok, true)
    const denied = adapter.allowlistMatch(adapter.tableRefs('SELECT * FROM secret'), ['allowed'])
    assert.equal(denied.ok, false)
    assert.deepEqual(denied.denied.map(String), ['secret'])
  }
})

test('PG 的引号标识符不会绕过白名单（改前的核心漏洞）', () => {
  const refs = PG.tableRefs('SELECT * FROM "private_table"')
  assert.equal(refs.length, 1)
  assert.equal(PG.allowlistMatch(refs, ['allowed']).ok, false)
})

test('boundary 各自实现自己的作用域语义', () => {
  // MySQL：两段式 db.table
  assert.equal(MYSQL.boundary(MYSQL.ddlTargets('DROP TABLE db.t').mutated, { database: 'db' }).ok, true)
  assert.equal(MYSQL.boundary(MYSQL.ddlTargets('DROP TABLE other.t').mutated, { database: 'db' }).ok, false)
  // PG：schema 限定
  assert.equal(PG.boundary(PG.ddlTargets('DROP TABLE public.t').mutated, { database: 'appdb', schema: 'public' }).ok, true)
  assert.equal(PG.boundary(PG.ddlTargets('DROP TABLE secret.t').mutated, { database: 'appdb', schema: 'public' }).ok, false)
})

test('describeError 各自标注方言', () => {
  assert.match(MYSQL.describeError({ code: 'X' }), /^MySQL 错误/)
  assert.match(PG.describeError({ code: '42P01' }), /^PostgreSQL 错误/)
})

test('scopeLabel 给出可读作用域描述', () => {
  assert.match(MYSQL.scopeLabel({ database: 'devdb' }), /devdb/)
  assert.match(PG.scopeLabel({ database: 'appdb', schema: 'public' }), /public/)
})

// ── 池参数：pg 必须拒绝 mysql2 风格键（避免静默失效）──────────────────────
test('PG 对 mysql2 风格池选项抛错，而不是静默忽略', () => {
  assert.throws(
    () => PG.createPool({ host: 'h', port: 5432, user: 'u', password: 'p', connectionLimit: 3 }),
    /mysql2 风格/,
  )
  assert.throws(
    () => PG.createPool({ host: 'h', port: 5432, user: 'u', password: 'p', connectTimeout: 1000 }),
    /mysql2 风格/,
  )
})

// ── 能力标记必须真实反映方言 ───────────────────────────────────────────────
test('能力标记：MySQL 有 insertId/warningCount，PG 没有', () => {
  assert.equal(MYSQL.supportsInsertId, true)
  assert.equal(MYSQL.supportsWarningCount, true)
  assert.equal(PG.supportsInsertId, false)
  assert.equal(PG.supportsWarningCount, false)
  assert.equal(PG.supportsReturning, true)
})

test('占位符说明与方言一致', () => {
  assert.equal(MYSQL.placeholder, '?')
  assert.match(PG.placeholder, /\$1/)
})

console.log('\n全部通过：' + passed + ' 组断言')
