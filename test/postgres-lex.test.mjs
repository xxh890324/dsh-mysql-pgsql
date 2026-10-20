/**
 * dsh-mysql PostgreSQL 词法层单元测试（沙箱内直接运行：node test/postgres-lex.test.mjs；
 * 不要用 node --test —— 其子进程管道在沙箱内会 EPERM）。
 *
 * 目的有两层：
 *  1. 证明 PostgreSQL 的引号/注释/运算符/语句族语义被正确识别；
 *  2. **证明 MySQL 行为未被改变** —— 每个 PG 用例都配一条 MySQL 对照断言，
 *     避免「为支持 PG 而让 MySQL 悄悄换了语义」。
 */
import assert from 'node:assert/strict'
import {
  MYSQL_LEX,
  PG_LEX,
  lexFor,
  stripSqlComments,
  blankStrings,
  classifyStatement,
  hasMultipleStatements,
  extractTableRefs,
  extractTableRefDetails,
  extractDdlTargets,
  normalizeTables,
  checkTableAllowlist,
  checkDetailAllowlist,
  checkDatabaseBoundary,
  checkScopedBoundary,
  describeDbError,
} from '../lib/shared.js'

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

const names = (refs) => refs.map((ref) => ref.name)
const schemaNames = (refs) => refs.map((ref) => ref.schema + '.' + ref.name)

// ── 引号语义：PG 双引号是标识符，MySQL 双引号是字符串 ──────────────────────
test('PG 双引号标识符被保留（不被当作字符串抹掉）', () => {
  assert.equal(blankStrings('SELECT * FROM "users"', PG_LEX), 'SELECT * FROM "users"')
})

test('MySQL 双引号仍按字符串处理（既有行为不变）', () => {
  assert.equal(blankStrings('SELECT * FROM "users"', MYSQL_LEX), 'SELECT * FROM        ')
  // 默认 lex 必须等于 MySQL，保证所有既有调用点零改动
  assert.equal(blankStrings('SELECT * FROM "users"'), 'SELECT * FROM        ')
})

test('PG 引号标识符内的点号不参与限定名切分', () => {
  const [ref] = extractTableRefDetails('SELECT * FROM "weird.name"', PG_LEX)
  assert.equal(ref.name, 'weird.name')
  assert.equal(ref.schema, '')
  assert.equal(ref.parts.length, 1)
  assert.equal(ref.quoted, true)
})

test('PG 双引号转义（""）被正确还原', () => {
  const [ref] = extractTableRefDetails('SELECT * FROM "a""b"', PG_LEX)
  assert.equal(ref.name, 'a"b')
})

test('PG 单引号字符串里的表名不被误判', () => {
  assert.deepEqual(extractTableRefs("SELECT 'FROM fake' AS x FROM real", PG_LEX), ['real'])
})

test('PG E\'...\' 转义字符串不提前结束', () => {
  assert.deepEqual(extractTableRefs("SELECT E'a\\'b' AS x FROM real", PG_LEX), ['real'])
})

// ── 注释与运算符 ───────────────────────────────────────────────────────────
test('PG 的 #> / #>> 运算符不被当作行注释截断', () => {
  const cleaned = stripSqlComments("SELECT data #>> '{a}' FROM secret_table", PG_LEX)
  assert.match(cleaned, /#>>/)
  assert.deepEqual(extractTableRefs("SELECT data #>> '{a}' FROM secret_table", PG_LEX), ['secret_table'])
})

test('MySQL 的 # 行注释行为不变', () => {
  // 整段注释（含 # 之后的全部字符）替换为等长空格
  assert.equal(stripSqlComments('SELECT 1 # 注释', MYSQL_LEX), 'SELECT 1 ' + ' '.repeat('# 注释'.length))
  assert.equal(stripSqlComments('# 全行注释\nSELECT 1', MYSQL_LEX).trim(), 'SELECT 1')
  // 默认 lex 同样按 MySQL 处理
  assert.equal(stripSqlComments('SELECT 1 # 注释'), stripSqlComments('SELECT 1 # 注释', MYSQL_LEX))
})

test('PG 的 -- 行注释与块注释被正常剥离', () => {
  assert.deepEqual(extractTableRefs('SELECT * FROM real -- FROM fake\n', PG_LEX), ['real'])
  assert.deepEqual(extractTableRefs('SELECT * FROM real /* FROM fake */', PG_LEX), ['real'])
})

// ── 语句分类 ───────────────────────────────────────────────────────────────
test('PG 的 WITH / TABLE / VALUES 归为 read', () => {
  assert.equal(classifyStatement('WITH t AS (SELECT 1) SELECT * FROM t', PG_LEX), 'read')
  assert.equal(classifyStatement('TABLE users', PG_LEX), 'read')
  assert.equal(classifyStatement('VALUES (1)', PG_LEX), 'read')
})

test('同一批语句在 MySQL 下仍为 unknown（证明词法隔离生效）', () => {
  assert.equal(classifyStatement('WITH t AS (SELECT 1) SELECT * FROM t', MYSQL_LEX), 'unknown')
  assert.equal(classifyStatement('TABLE users', MYSQL_LEX), 'unknown')
  assert.equal(classifyStatement('VALUES (1)', MYSQL_LEX), 'unknown')
  assert.equal(classifyStatement('WITH t AS (SELECT 1) SELECT * FROM t'), 'unknown')
})

test('PG 的数据修改 CTE 不得被当作只读', () => {
  assert.equal(classifyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', PG_LEX), 'write-dml')
  assert.equal(classifyStatement('WITH u AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM u', PG_LEX), 'write-dml')
  assert.equal(classifyStatement('WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1', PG_LEX), 'write-dml')
  // 纯读 CTE 不受影响
  assert.equal(classifyStatement('WITH t AS (SELECT 1) SELECT * FROM t', PG_LEX), 'read')
})

test('PG 的结构变更归为 ddl', () => {
  assert.equal(classifyStatement('CREATE TABLE t (id int)', PG_LEX), 'ddl')
  assert.equal(classifyStatement('CREATE MATERIALIZED VIEW mv AS SELECT 1', PG_LEX), 'ddl')
  assert.equal(classifyStatement('CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)', PG_LEX), 'ddl')
  assert.equal(classifyStatement('ALTER TABLE ONLY t ADD COLUMN c int', PG_LEX), 'ddl')
  assert.equal(classifyStatement('DROP TABLE IF EXISTS t', PG_LEX), 'ddl')
  assert.equal(classifyStatement('TRUNCATE t', PG_LEX), 'ddl')
  // MySQL 既有分类不变
  assert.equal(classifyStatement('CREATE TABLE t (id INT)', MYSQL_LEX), 'ddl')
  assert.equal(classifyStatement('ALTER TABLE t ADD c INT', MYSQL_LEX), 'ddl')
})

test('PG 的提权与跨 schema 迁移语句永久 forbidden', () => {
  assert.equal(classifyStatement('ALTER TABLE t OWNER TO evil', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('ALTER TABLE t SET SCHEMA other', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('DROP INDEX idx', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('CREATE SCHEMA s', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('CREATE EXTENSION pgcrypto', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('GRANT ALL ON t TO u', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('REFRESH MATERIALIZED VIEW mv', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('SET search_path TO other', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('COPY t FROM stdin', PG_LEX), 'forbidden')
  assert.equal(classifyStatement('VACUUM t', PG_LEX), 'forbidden')
})

test('PG 的 DROP INDEX 拒绝规则不影响合法的 DROP TABLE / ALTER TABLE', () => {
  assert.equal(classifyStatement('DROP TABLE idx', PG_LEX), 'ddl')
  assert.equal(classifyStatement('ALTER TABLE t ADD COLUMN c int', PG_LEX), 'ddl')
})

// ── 多语句检测 ─────────────────────────────────────────────────────────────
test('PG 美元引用内的分号不算多语句', () => {
  assert.equal(hasMultipleStatements('DO $$ BEGIN DELETE FROM t; END $$', PG_LEX), false)
  assert.equal(hasMultipleStatements('SELECT $tag$ a; b $tag$', PG_LEX), false)
})

test('PG 真正的多语句仍被拒绝', () => {
  assert.equal(hasMultipleStatements('SELECT 1; SELECT 2', PG_LEX), true)
  assert.equal(hasMultipleStatements('SELECT 1;', PG_LEX), false)
  assert.equal(hasMultipleStatements('SELECT $1', PG_LEX), false)
})

test('MySQL 多语句行为不变', () => {
  assert.equal(hasMultipleStatements('SELECT 1; SELECT 2', MYSQL_LEX), true)
  assert.equal(hasMultipleStatements("SELECT ';' FROM t", MYSQL_LEX), false)
})

// ── 限定名与 DDL 目标 ──────────────────────────────────────────────────────
test('PG 的 schema.table 被解析出 schema', () => {
  const [ref] = extractTableRefDetails('SELECT * FROM public.users', PG_LEX)
  assert.equal(ref.schema, 'public')
  assert.equal(ref.name, 'users')
  // 既有语义（extractTableRefs 只回表名）不变
  assert.deepEqual(extractTableRefs('SELECT * FROM public.users', PG_LEX), ['users'])
})

test('PG 的 ALTER/DROP 目标提取出 schema', () => {
  assert.deepEqual(schemaNames(extractDdlTargets('ALTER TABLE public.users ADD c int', PG_LEX).mutated), ['public.users'])
  assert.deepEqual(extractDdlTargets('DROP TABLE db.public.t', PG_LEX).mutated[0].parts.map((p) => p.text), ['db', 'public', 't'])
  assert.deepEqual(schemaNames(extractDdlTargets('CREATE INDEX i ON public.t (a)', PG_LEX).mutated), ['public.t'])
  assert.deepEqual(schemaNames(extractDdlTargets('TRUNCATE a, b', PG_LEX).mutated), ['.a', '.b'])
})

test('PG 的 CREATE MATERIALIZED VIEW 目标进 created', () => {
  assert.deepEqual(names(extractDdlTargets('CREATE MATERIALIZED VIEW mv AS SELECT 1', PG_LEX).created), ['mv'])
})

test('MySQL DDL 目标提取结果不变', () => {
  const ddl = extractDdlTargets('DROP TABLE `db1`.`Orders`', MYSQL_LEX)
  assert.equal(ddl.mutated[0].name, 'orders')
  assert.equal(ddl.mutated[0].database, 'db1')
})

// ── 白名单：标识符大小写 ───────────────────────────────────────────────────
test('PG 白名单：引号项保留大小写，裸项折叠小写', () => {
  assert.deepEqual(normalizeTables(['"Users"'], PG_LEX), ['Users'])
  assert.deepEqual(normalizeTables(['Users'], PG_LEX), ['users'])
  assert.deepEqual(normalizeTables(['public."Orders"'], PG_LEX), ['Orders'])
})

test('MySQL 白名单归一化行为不变（一律小写、去反引号）', () => {
  assert.deepEqual(normalizeTables(['Orders', 'db.B', '`C`', 'b'], MYSQL_LEX), ['orders', 'b', 'c'])
})

test('PG 白名单：引号标识符区分大小写（fail closed）', () => {
  const quoted = extractTableRefDetails('SELECT * FROM "Users"', PG_LEX)
  // 白名单写 "Users" → 精确命中
  assert.equal(checkDetailAllowlist(quoted, ['"Users"'], PG_LEX).ok, true)
  // 白名单写 "users" → 不命中（PG 里是另一张表）
  assert.equal(checkDetailAllowlist(quoted, ['"users"'], PG_LEX).ok, false)
  // 白名单写裸 users → 折叠为 users，同样不等于 "Users" → 不命中
  // （PG 语义：裸 users 指向小写表 users，与带引号的 "Users" 是两张表。
  //   拒绝是安全方向；拒绝信息里会回显带引号的原样标识符，便于用户按提示修正白名单。）
  assert.equal(checkDetailAllowlist(quoted, ['users'], PG_LEX).ok, false)

  // 对照：未加引号查询的小写表，裸白名单正常命中
  const bare = extractTableRefDetails('SELECT * FROM users', PG_LEX)
  assert.equal(checkDetailAllowlist(bare, ['users'], PG_LEX).ok, true)
  // 对照：白名单写 "users" 与裸 users 指向同一张表，互相命中
  assert.equal(checkDetailAllowlist(bare, ['"users"'], PG_LEX).ok, true)
})

test('PG 白名单：空白名单=不限制（沿用既有语义）', () => {
  const refs = extractTableRefDetails('SELECT * FROM anything', PG_LEX)
  assert.equal(checkDetailAllowlist(refs, [], PG_LEX).ok, true)
  assert.equal(checkDetailAllowlist(refs, undefined, PG_LEX).ok, true)
})

test('PG 白名单：schema 限定项提供跨 schema 隔离', () => {
  const secret = extractTableRefDetails('SELECT * FROM secret.users', PG_LEX)
  const publicRef = extractTableRefDetails('SELECT * FROM public.users', PG_LEX)
  // 裸表名沿用宽松语义：命中任意 schema
  assert.equal(checkDetailAllowlist(secret, ['users'], PG_LEX).ok, true)
  // schema 限定项则严格隔离
  assert.equal(checkDetailAllowlist(secret, ['public.users'], PG_LEX).ok, false)
  assert.equal(checkDetailAllowlist(publicRef, ['public.users'], PG_LEX).ok, true)
})

test('MySQL 白名单校验行为不变', () => {
  assert.equal(checkTableAllowlist('SELECT * FROM anything', []).ok, true)
  const bad = checkTableAllowlist('SELECT * FROM a JOIN c ON a.id=c.id', ['a', 'b'])
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.denied, ['c'])
})

// ── 作用域边界 ─────────────────────────────────────────────────────────────
test('PG 作用域边界：schema 限定名必须匹配 search_path 作用域', () => {
  const refs = (sql) => extractDdlTargets(sql, PG_LEX).mutated
  assert.equal(checkScopedBoundary(refs('DROP TABLE t'), { database: 'appdb', schema: 'public' }).ok, true)
  assert.equal(checkScopedBoundary(refs('DROP TABLE public.t'), { database: 'appdb', schema: 'public' }).ok, true)
  assert.equal(checkScopedBoundary(refs('DROP TABLE secret.t'), { database: 'appdb', schema: 'public' }).ok, false)
  assert.equal(checkScopedBoundary(refs('DROP TABLE appdb.public.t'), { database: 'appdb', schema: 'public' }).ok, true)
  assert.equal(checkScopedBoundary(refs('DROP TABLE otherdb.public.t'), { database: 'appdb', schema: 'public' }).ok, false)
  assert.equal(checkScopedBoundary(refs('DROP TABLE a.b.c.d'), { database: 'appdb', schema: 'public' }).ok, false)
})

test('PG 作用域边界：未配置 schema 时显式前缀一律拒绝（fail closed）', () => {
  const refs = (sql) => extractDdlTargets(sql, PG_LEX).mutated
  assert.equal(checkScopedBoundary(refs('DROP TABLE t'), { database: 'appdb', schema: '' }).ok, true)
  assert.equal(checkScopedBoundary(refs('DROP TABLE public.t'), { database: 'appdb', schema: '' }).ok, false)
})

test('MySQL 库边界行为不变', () => {
  assert.equal(checkDatabaseBoundary(extractDdlTargets('DROP TABLE shop.t').mutated, 'shop').ok, true)
  const denied = checkDatabaseBoundary(extractDdlTargets('DROP TABLE other.t').mutated, 'shop')
  assert.equal(denied.ok, false)
  assert.deepEqual(denied.denied, ['other.t'])
})

// ── 错误文案 ───────────────────────────────────────────────────────────────
test('describeDbError 按方言标注兜底文案', () => {
  assert.equal(describeDbError({ code: '42P01' }, 'PostgreSQL'), 'PostgreSQL 错误（42P01）')
  // 默认参数保持 MySQL 文案（既有测试依赖）
  assert.equal(describeDbError({ code: '42P01' }), 'MySQL 错误（42P01）')
  // PG 真实错误自带 message，原样返回
  assert.equal(
    describeDbError(Object.assign(new Error('relation "users" does not exist'), { code: '42P01' }), 'PostgreSQL'),
    'relation "users" does not exist',
  )
})

// ── lexFor 分派 ────────────────────────────────────────────────────────────
test('lexFor 按 dialect 名分派，未知值回落 MySQL', () => {
  assert.equal(lexFor('postgres'), PG_LEX)
  assert.equal(lexFor('mysql'), MYSQL_LEX)
  assert.equal(lexFor('oracle'), MYSQL_LEX)
  assert.equal(lexFor(undefined), MYSQL_LEX)
  assert.equal(lexFor('postgres').label, 'PostgreSQL')
})

console.log('\n全部通过：' + passed + ' 组断言')
