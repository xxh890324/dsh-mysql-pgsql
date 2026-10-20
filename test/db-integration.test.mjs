/**
 * 真实数据库联调测试（环境变量门控）。
 *
 * 未设置任何 *_URL 时**直接跳过并以 0 退出**，绝不连接任何数据库 —— 因此可以
 * 放进默认测试列表而不会影响没有数据库的机器。
 *
 * 用法：
 *   DSH_TEST_MYSQL_URL='mysql://root:pw@127.0.0.1:3306/dsh_test' node test/db-integration.test.mjs
 *   DSH_TEST_PG_URL='postgres://postgres:pw@127.0.0.1:5432/dsh_test'   node test/db-integration.test.mjs
 *
 * 每个方言跑同一组语义断言，验证「两次接入的行为一致，差异只在能力标记」。
 * 测试会创建并删除自己的表（dsh_it_*），不触碰既有数据。
 */
import assert from 'node:assert/strict'
import { createDialect } from '../lib/dialects/index.js'

const MYSQL_URL = process.env.DSH_TEST_MYSQL_URL
const PG_URL = process.env.DSH_TEST_PG_URL

if (!MYSQL_URL && !PG_URL) {
  console.log('skipped: 未设置 DSH_TEST_MYSQL_URL / DSH_TEST_PG_URL，不连接任何数据库')
  process.exit(0)
}

let passed = 0
let failed = 0
async function step(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    failed += 1
    console.error('  ✗ ' + name)
    console.error('    ' + (err && err.message ? err.message : err))
  }
}

/** 从 URL 解析出适配器需要的 config（不引入额外依赖）。 */
function parseUrl(raw, type) {
  const url = new URL(raw)
  return {
    type,
    host: url.hostname,
    port: Number(url.port) || (type === 'postgres' ? 5432 : 3306),
    user: decodeURIComponent(url.username || (type === 'postgres' ? 'postgres' : 'root')),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    schema: type === 'postgres' ? (url.searchParams.get('schema') || 'public') : '',
    tables: [],
    allowWrite: true,
    allowDdl: true,
  }
}

const TABLE = 'dsh_it_probe'

async function runSuite(type, rawUrl) {
  const dialect = createDialect(type)
  const cfg = parseUrl(rawUrl, type)
  const pool = dialect.createPool(dialect.poolConfig(cfg))
  const tag = dialect.label + '  '

  const run = async (sql, params) => dialect.query(pool, sql, params)
  const exec = async (sql, params) => dialect.execute(pool, sql, params)

  try {
    console.log('\n== ' + dialect.label + ' ==')

    await step('连通性探测', async () => {
      const { rows } = await run(dialect.probeSql)
      assert.equal(rows.length, 1)
    })

    await step('建表（DDL 路径）', async () => {
      await run('DROP TABLE IF EXISTS ' + TABLE)
      await run('CREATE TABLE ' + TABLE + ' (id INT, name VARCHAR(32), created_at TIMESTAMP)')
    })

    await step('写操作返回 affectedRows', async () => {
      const inserted = await exec('INSERT INTO ' + TABLE + ' (id, name) VALUES ($1, $2)', [1, 'alpha'])
        .catch(async () => {
          // MySQL 的 execute 走预处理协议，占位符是 ?；PG 是 $1。
          const sql = type === 'postgres'
            ? 'INSERT INTO ' + TABLE + ' (id, name) VALUES ($1, $2)'
            : 'INSERT INTO ' + TABLE + ' (id, name) VALUES (?, ?)'
          return exec(sql, [1, 'alpha'])
        })
      assert.equal(inserted.affectedRows, 1)
    })

    await step('读操作返回 columns 与 rows（形状跨方言一致）', async () => {
      const sql = type === 'postgres'
        ? 'SELECT id, name FROM ' + TABLE + ' WHERE id = $1'
        : 'SELECT id, name FROM ' + TABLE + ' WHERE id = ?'
      const { columns, rows } = await run(sql, [1])
      assert.deepEqual(columns, ['id', 'name'])
      assert.equal(rows.length, 1)
      assert.equal(String(rows[0].name), 'alpha')
    })

    await step('列元数据可被 groupColumnMetadata 消费', async () => {
      const scope = dialect.scopeFor(cfg)
      const spec = dialect.columnsSql(scope)
      const { rows } = await dialect.query(pool, spec.sql, spec.params)
      assert.ok(rows.length >= 3, '应至少返回 3 列，实际 ' + rows.length)
      const { groupColumnMetadata } = await import('../lib/shared.js')
      const grouped = groupColumnMetadata(rows, [], '', scope)
      assert.equal(grouped.ok, true, grouped.error)
      const found = grouped.tables.find((t) => t.name === TABLE)
      assert.ok(found !== undefined, '未找到表 ' + TABLE + '，实际：' + grouped.tables.map((t) => t.name).join(','))
      assert.deepEqual(found.columns.map((c) => c.column), ['id', 'name', 'created_at'])
    })

    await step('表列表可读', async () => {
      const spec = dialect.tablesSql(dialect.scopeFor(cfg))
      const { rows } = await dialect.query(pool, spec.sql, spec.params)
      assert.ok(rows.some((r) => String(r.table_name) === TABLE))
    })

    await step('时间戳按字符串返回（不发生时区偏移）', async () => {
      const sql = type === 'postgres'
        ? "SELECT created_at FROM " + TABLE + " WHERE id = $1"
        : 'SELECT created_at FROM ' + TABLE + ' WHERE id = ?'
      await exec(type === 'postgres'
        ? "UPDATE " + TABLE + " SET created_at = '2024-01-02 03:04:05' WHERE id = $1"
        : "UPDATE " + TABLE + " SET created_at = '2024-01-02 03:04:05' WHERE id = ?", [1])
      const { rows } = await run(sql, [1])
      const value = rows[0].created_at
      // mysql2 的 dateStrings 与 pg 的自定义 type parser 都必须给出字符串，
      // 而不是已被转成 UTC 的 Date。
      assert.equal(typeof value, 'string', '期望字符串，实际 ' + Object.prototype.toString.call(value))
      assert.doesNotMatch(String(value), /GMT|Z$/)
    })

    await step('白名单：引号/反引号标识符不得绕过', async () => {
      const quoted = type === 'postgres' ? '"' + TABLE + '"' : '`' + TABLE + '`'
      const refs = dialect.tableRefs('SELECT * FROM ' + quoted)
      assert.equal(refs.length, 1, '引号标识符必须被识别，实际 ' + refs.length)
      assert.equal(dialect.allowlistMatch(refs, ['some_other_table']).ok, false)
    })

    await step('错误凭证被拒绝且不泄露密码', async () => {
      const badPool = dialect.createPool(dialect.poolConfig({ ...cfg, password: 'definitely-wrong-pw' }), { limit: 1 })
      try {
        await dialect.query(badPool, dialect.probeSql, [])
        assert.fail('错误凭证竟然连通了')
      } catch (err) {
        const message = String(dialect.describeError(err))
        assert.ok(message.length > 0, '错误文案不能为空')
        assert.equal(message.includes('definitely-wrong-pw'), false, '错误文案不得回显密码')
      } finally {
        await dialect.endPool(badPool)
      }
    })

    await step('错误端口给出可读错误', async () => {
      const deadPool = dialect.createPool(dialect.poolConfig({ ...cfg, port: 1 }), { limit: 1 })
      try {
        await dialect.query(deadPool, dialect.probeSql, [])
        assert.fail('连到端口 1 竟然成功了')
      } catch (err) {
        assert.ok(String(dialect.describeError(err)).length > 0)
      } finally {
        await dialect.endPool(deadPool)
      }
    })

    await step('分页 LIMIT/OFFSET 可用', async () => {
      const ph = (n) => (type === 'postgres' ? '$' + n : '?')
      await exec('DELETE FROM ' + TABLE)
      const rows = type === 'postgres' ? '($1,$2),($3,$4),($5,$6)' : '(?,?),(?,?),(?,?)'
      await exec('INSERT INTO ' + TABLE + ' (id, name) VALUES ' + rows, [1, 'a', 2, 'b', 3, 'c'])
      const page1 = await run('SELECT id FROM ' + TABLE + ' ORDER BY id LIMIT ' + ph(1) + ' OFFSET ' + ph(2), [2, 0])
      const page2 = await run('SELECT id FROM ' + TABLE + ' ORDER BY id LIMIT ' + ph(1) + ' OFFSET ' + ph(2), [2, 2])
      assert.equal(page1.rows.length, 2)
      assert.equal(page2.rows.length, 1)
    })

    await step('复杂查询（CTE + 聚合 + 窗口函数）可用', async () => {
      const agg = await run(
        'WITH c AS (SELECT COUNT(*) AS n FROM ' + TABLE + ') SELECT n, ROW_NUMBER() OVER (ORDER BY n) AS rn FROM c',
      )
      assert.equal(agg.rows.length, 1)
      assert.equal(Number(agg.rows[0].n), 3)
      assert.equal(Number(agg.rows[0].rn), 1)
    })

    await step('UPDATE / DELETE 返回受影响行数', async () => {
      const upd = await exec('UPDATE ' + TABLE + ' SET name = ' + (type === 'postgres' ? '$1' : '?') + ' WHERE id = ' + (type === 'postgres' ? '$2' : '?'), ['z', 1])
      assert.equal(upd.affectedRows, 1)
      const del = await exec('DELETE FROM ' + TABLE + ' WHERE id = ' + (type === 'postgres' ? '$1' : '?'), [3])
      assert.equal(del.affectedRows, 1)
    })

    await step('多并发查询不超池上限（排队而非报错）', async () => {
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => run(dialect.probeSql, [])))
      assert.equal(results.length, 5)
      assert.ok(results.every((res) => res.rows.length === 1))
    })

    await step('DROP TABLE（清理）', async () => {
      await run('DROP TABLE IF EXISTS ' + TABLE)
    })
  } finally {
    await dialect.endPool(pool)
  }
}

for (const [type, url] of [['mysql', MYSQL_URL], ['postgres', PG_URL]]) {
  if (!url) {
    console.log('\n== ' + type + ' ==  skipped（未设置 URL）')
    continue
  }
  await runSuite(type, url)
}

console.log('\n通过 ' + passed + ' 组，失败 ' + failed + ' 组')
process.exit(failed === 0 ? 0 : 1)
