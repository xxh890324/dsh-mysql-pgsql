import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mysql-host-test-'))
process.env.DSH_HOME = tempHome
const tools = new Map()
const listeners = new Map()
const contexts = new Map()
const service = new Map()
const connections = [
  // 既有 MySQL fixture 保持原样（含 port/user 显式值），验证旧配置零迁移。
  { id: 'source-dev', name: 'Development', host: 'dev.local', port: 3306, user: 'test', password: 'secret', database: 'devdb', tables: ['allowed'], allowWrite: false, allowDdl: false },
  { id: 'source-prod', name: 'Production', host: 'prod.local', port: 3306, user: 'test', password: 'secret', database: 'proddb', tables: [], allowWrite: true, allowDdl: true },
  // 未写 type 的一条：必须被归一化成 mysql（向后兼容）。
  { id: 'legacy-untyped', name: 'LegacyUntyped', host: 'legacy.local', database: 'legacydb', tables: [] },
  // PostgreSQL fixture：全权限，用于验证 pg_* 工具族与白名单/schema 语义。
  { id: 'pg-dev', name: 'PgDev', type: 'postgres', host: 'pg.local', port: 5432, user: 'postgres', password: 'secret', database: 'appdb', schema: 'public', tables: ['allowed'], allowWrite: false, allowDdl: false },
  { id: 'pg-prod', name: 'PgProd', type: 'postgres', host: 'pgprod.local', port: 5432, user: 'postgres', password: 'secret', database: 'appdb', schema: 'public', tables: [], allowWrite: true, allowDdl: true },
]
await fs.mkdir(path.join(tempHome, 'storages', 'dsh-mysql'), { recursive: true })
await fs.writeFile(path.join(tempHome, 'storages', 'dsh-mysql', 'connections.json'), JSON.stringify({ connections }), 'utf8')

const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  get: (key) => key === 'systemPrompt' ? { context: (entry) => contexts.set(entry.name, entry.text) } : undefined,
  on: (event, fn) => listeners.set(event, fn),
  provide: (key, value) => service.set(key, value),
}
apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 20))

const mysql = service.get('mysql')
assert.ok(mysql)
const selection = (sessionId) => mysql.getSelection({ sessionId })
const replace = (sessionId, connectionIds) => mysql.selectConnection({ sessionId, connectionIds })

const MYSQL_TOOLS = ['mysql_query', 'mysql_tables', 'mysql_execute', 'mysql_ddl']
const PG_TOOLS = ['pg_query', 'pg_tables', 'pg_execute', 'pg_ddl']
assert.equal(tools.size, 8)
for (const name of [...MYSQL_TOOLS, ...PG_TOOLS]) {
  assert.equal(tools.get(name).parameters.properties.connectionId.type, 'string')
}
// 两族工具必须各自声明自己的方言，避免模型在 PG 上写 MySQL 方言的 SQL。
assert.match(tools.get('pg_query').description, /PostgreSQL/)
assert.match(tools.get('pg_query').description, /\$1/)
assert.doesNotMatch(tools.get('mysql_query').description, /PostgreSQL/)
const initial = await selection('multi')
assert.deepEqual(initial.connectionIds, [])
assert.equal(initial.connectionId, null)
assert.equal(initial.connections.some((item) => 'password' in item), false)

const single = await selection('single-auto')
assert.deepEqual(single.connectionIds, []) // multiple configured sources => new session empty
const only = [{ id: 'only', name: 'Only' }]
const { resolveSelectedConnectionIds } = await import('../lib/session-selection.js')
assert.deepEqual(resolveSelectedConnectionIds(only, 'one-only', new Map()), ['only'])
const lateOneState = new Map()
assert.deepEqual(resolveSelectedConnectionIds([], 'late-one', lateOneState), [])
assert.deepEqual(resolveSelectedConnectionIds(only, 'late-one', lateOneState), ['only'])

assert.equal((await replace('multi', ['source-dev', 'source-prod'])).ok, true)
assert.deepEqual((await selection('multi')).connectionIds, ['source-dev', 'source-prod'])
assert.equal((await selection('multi')).connectionId, null)
assert.equal((await tools.get('mysql_query').execute({ sql: 'SELECT 1' }, { agent: { id: 'multi' } })).ok, false)
assert.match((await tools.get('mysql_query').execute({ sql: 'SELECT 1', connectionId: 'unselected' }, { agent: { id: 'multi' } })).error, /未在当前会话选中/)

assert.equal((await replace('multi', ['source-dev'])).ok, true)
const queryTool = tools.get('mysql_query')
const queryNoDb = await queryTool.execute({ sql: 'SELECT 1' }, { agent: { id: 'multi' } })
assert.match(queryNoDb.error, /ENOTFOUND/)
// Rejected routing must occur before pool creation.
assert.equal((await queryTool.execute({ sql: 'SELECT 1', connectionId: 'source-prod' }, { agent: { id: 'multi' } })).ok, false)

assert.equal((await replace('multi', [])).ok, true)
assert.match((await queryTool.execute({ sql: 'SELECT 1' }, { agent: { id: 'multi' } })).error, /尚未选择/)
assert.equal((await selection('multi')).connectionIds.length, 0)

assert.equal((await replace('legacy', ['source-dev'])).connectionId, 'source-dev')
assert.equal((await mysql.selectConnection({ sessionId: 'legacy-scalar', connectionId: 'source-prod' })).connectionId, 'source-prod')
assert.equal((await selection('legacy-scalar')).connectionId, 'source-prod')
assert.equal((await replace('invalid', ['source-dev', 'missing'])).ok, false)
assert.deepEqual((await selection('invalid')).connectionIds, [])

const contextText = contexts.get('dsh-mysql-context')
const context = contextText({ agent: { id: 'multi' } })
assert.match(context, /尚未选择连接/)
assert.equal(context.includes('source-prod'), false)
await replace('multi', ['source-dev', 'source-prod'])
const multiContext = contextText({ agent: { id: 'multi' } })
assert.match(multiContext, /source-dev/)
assert.match(multiContext, /source-prod/)
assert.match(multiContext, /禁止广播/)
assert.equal(multiContext.includes('secret'), false)

const executeTool = tools.get('mysql_execute')
const ddlTool = tools.get('mysql_ddl')
const devWriteDenied = await executeTool.execute({ connectionId: 'source-dev', sql: 'UPDATE allowed SET id = 1' }, { agent: { id: 'multi' } })
assert.match(devWriteDenied.error, /Development.*allowWrite=false/)
const devTableDenied = await queryTool.execute({ connectionId: 'source-dev', sql: 'SELECT * FROM private_table' }, { agent: { id: 'multi' } })
assert.match(devTableDenied.error, /Development.*白名单外/)
const prodWriteAttempt = await executeTool.execute({ connectionId: 'source-prod', sql: 'UPDATE private_table SET id = 1' }, { agent: { id: 'multi' } })
assert.match(prodWriteAttempt.error, /Production.*ENOTFOUND/)
const prodDdlAttempt = await ddlTool.execute({ connectionId: 'source-prod', sql: 'CREATE TABLE probe (id INT)' }, { agent: { id: 'multi' } })
assert.match(prodDdlAttempt.error, /Production.*ENOTFOUND/)

// ── 向后兼容：没有 type 的旧配置必须被当作 MySQL ───────────────────────────
const all = (await mysql.listConnections()).connections
const legacyUntyped = all.find((c) => c.id === 'legacy-untyped')
assert.equal(legacyUntyped.type, 'mysql')
assert.equal(legacyUntyped.port, 3306) // 缺省端口按方言补齐
assert.equal(legacyUntyped.user, 'root')
assert.equal(legacyUntyped.schema, '') // MySQL 侧 schema 恒为空

// ── PostgreSQL：publicView 暴露 type/schema，且仍不泄露密码 ──────────────
const pgView = all.find((c) => c.id === 'pg-dev')
assert.equal(pgView.type, 'postgres')
assert.equal(pgView.port, 5432)
assert.equal(pgView.schema, 'public')
assert.equal('password' in pgView, false)
assert.equal(pgView.hasPassword, true)

// ── 工具族隔离：用错方言必须被明确拒绝，而不是让 SQL 在错误方言上执行 ──
await replace('pg-session', ['pg-dev'])
const wrongFamily = await tools.get('mysql_query').execute(
  { sql: 'SELECT 1' },
  { agent: { id: 'pg-session' } },
)
assert.equal(wrongFamily.ok, false)
assert.match(wrongFamily.error, /PostgreSQL/)
// 提示必须给出「该连接自己」的工具族（pg_*），不能反过来推荐刚才误用的 mysql_*。
// 曾经的实现用被调工具的方言拼名字，导致在 PG 连接上建议「请使用 mysql_query」。
assert.match(wrongFamily.error, /pg_query/)
assert.doesNotMatch(wrongFamily.error, /请使用 mysql_query/)

await replace('mysql-session', ['source-dev'])
const wrongFamily2 = await tools.get('pg_query').execute(
  { sql: 'SELECT 1' },
  { agent: { id: 'mysql-session' } },
)
assert.equal(wrongFamily2.ok, false)
assert.match(wrongFamily2.error, /MySQL/)
assert.match(wrongFamily2.error, /mysql_query/)
assert.doesNotMatch(wrongFamily2.error, /请使用 pg_query/)

// ── PostgreSQL 写/DDL 权限默认关闭时必须拒绝 ────────────────────────────
const pgWriteDenied = await tools.get('pg_execute').execute(
  { connectionId: 'pg-dev', sql: 'UPDATE allowed SET id = 1' },
  { agent: { id: 'pg-session' } },
)
assert.match(pgWriteDenied.error, /PgDev.*allowWrite=false/)
const pgDdlDenied = await tools.get('pg_ddl').execute(
  { connectionId: 'pg-dev', sql: 'CREATE TABLE probe (id int)' },
  { agent: { id: 'pg-session' } },
)
assert.match(pgDdlDenied.error, /PgDev.*allowDdl=false/)

// ── PostgreSQL 白名单：引号标识符不得绕过（改前这里的 SQL 会让 extractTableRefs 返回空）──
const pgAllowlistDenied = await tools.get('pg_query').execute(
  { connectionId: 'pg-dev', sql: 'SELECT * FROM \"private_table\"' },
  { agent: { id: 'pg-session' } },
)
assert.match(pgAllowlistDenied.error, /PgDev.*白名单外/)

// ── PostgreSQL 只读工具拒绝写语句 ────────────────────────────────────────
const pgQueryDenied = await tools.get('pg_query').execute(
  { connectionId: 'pg-dev', sql: 'DELETE FROM allowed' },
  { agent: { id: 'pg-session' } },
)
assert.match(pgQueryDenied.error, /pg_query 只允许/)

// ── PostgreSQL 的 DROP INDEX / OWNER TO 永久拒绝（即使开了 allowDdl）──────
await replace('pg-prod-session', ['pg-prod'])
const pgDropIndex = await tools.get('pg_ddl').execute(
  { connectionId: 'pg-prod', sql: 'DROP INDEX idx' },
  { agent: { id: 'pg-prod-session' } },
)
assert.match(pgDropIndex.error, /pg_ddl 只允许/)
const pgOwner = await tools.get('pg_ddl').execute(
  { connectionId: 'pg-prod', sql: 'ALTER TABLE allowed OWNER TO evil' },
  { agent: { id: 'pg-prod-session' } },
)
assert.match(pgOwner.error, /pg_ddl 只允许/)

// ── 上下文按已选方言分组输出 ────────────────────────────────────────────
const pgContext = contextText({ agent: { id: 'pg-session' } })
assert.match(pgContext, /PostgreSQL/)
assert.match(pgContext, /pg_query/)
assert.equal(pgContext.includes('mysql_query'), false)

const mixedSessions = 'mixed-session'
await replace(mixedSessions, ['source-dev', 'pg-dev'])
const mixedContext = contextText({ agent: { id: mixedSessions } })
assert.match(mixedContext, /mysql_query/)
assert.match(mixedContext, /pg_query/)
assert.match(mixedContext, /与其类型匹配的工具族/)

// ── apply() 必须幂等：重复挂载不得抛错、不得让服务缺失 ──────────────────
// 回归护栏：曾经无条件 Object.defineProperty(service,'typertRemote')，第二次 apply
// 会抛 TypeError: Cannot redefine property，服务静默不注册（boot.log 里只剩一行
// provide mysql FAILED），客户端因此永远拿不到 RPC 接口。
{
  const again = new Map()
  let provideCalls = 0
  const ctx2 = {
    tools: { register: (tool) => again.set(tool.name, tool) },
    get: () => undefined,
    on: () => {},
    provide: () => { provideCalls += 1 },
  }
  assert.doesNotThrow(() => apply(ctx2), '首次 apply 不应抛错')
  assert.doesNotThrow(() => apply(ctx2), '重复 apply 不应抛错（必须幂等）')
  assert.equal(again.size, 8)
  assert.equal(provideCalls, 2, '每次 apply 都应调用 provide')
}

listeners.get('agent/disposed')({ agent: { id: 'legacy' } })
const deleted = await mysql.deleteConnection({ connectionId: 'source-prod' })
assert.equal(deleted.ok, true)
assert.deepEqual((await selection('multi')).connectionIds, ['source-dev'])
await fs.rm(tempHome, { recursive: true, force: true })
console.log('Host tools and session routing tests passed')
