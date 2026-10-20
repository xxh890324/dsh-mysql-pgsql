/**
 * dsh-mysql 纯函数工具集：SQL 语句分类、表白名单校验、JSON 安全转换。
 * 无任何外部依赖，Host（lib/index.js）与单元测试（test/shared.test.mjs）共用。
 *
 * 方言无关性：本文件所有词法函数都接受一个可选的 `lex` 参数，默认值为
 * MYSQL_LEX —— 既有调用点与既有测试的 MySQL 行为逐字节不变。PostgreSQL
 * 通过传入 PG_LEX 复用同一套函数，而不是复制第二份词法实现：同一句表白名单
 * 校验逻辑只维护一份，安全修复不会漏掉某一侧。
 */

/** mysql_query 单次返回的最大行数，超出则截断并在结果中标记 truncated。 */
export const MAX_ROWS = 2000

// ── 词法配置（方言差异的唯一声明处）────────────────────────────────────────
//
// 每一项都对应一个真实存在的语法差异，没有为「将来可能」预留字段：
//  - identQuotes / stringQuotes：MySQL 用反引号包标识符、单双引号都是字符串；
//    PostgreSQL 用双引号包标识符、单引号才是字符串。把双引号当字符串抹掉会让
//    `SELECT * FROM "users"` 的表名凭空消失，白名单校验静默放行。
//  - lineComments：MySQL 额外支持 `#` 行注释；PostgreSQL 的 `#>` / `#>>` 是
//    JSON 运算符，当成注释会把后半条 SQL 截断，同样会让白名单漏检。
//  - dollarQuote：PostgreSQL 的 $tag$...$tag$ 字符串，函数体内部可以含分号。
//  - identPattern：供表引用 / DDL 目标正则使用的标识符片段。

/** MySQL 词法。默认值，保证既有行为不变。 */
export const MYSQL_LEX = Object.freeze({
  dialect: 'mysql',
  label: 'MySQL',
  identQuotes: Object.freeze(['`']),
  stringQuotes: Object.freeze(["'", '"']),
  lineComments: Object.freeze(['--', '#']),
  blockComments: true,
  dollarQuote: false,
  backslashEscapes: true, // MySQL 字符串里反斜杠是转义符
  eStrings: false,
  // 注意：整体带分组，拼接进其它正则时不会让 | 的优先级溢出。
  identPattern: '(?:`[^`]+`|[A-Za-z0-9_$]+)',
  // MySQL 表名在与白名单比对时统一小写（lower_case_table_names 语义）。
  foldAlways: true,
  cteMayWrite: false,
  readPatterns: Object.freeze([
    /^select\b/i,
    /^show\b/i,
    /^(?:describe|desc)\b/i,
    /^explain\b/i,
  ]),
  /** 要求在 DDL 判定之前命中的拒绝规则（语句任意位置匹配）。 */
  forbiddenBeforeDdl: Object.freeze([]),
  ddlPatterns: Object.freeze([
    /^create\s+(?:or\s+replace\s+)?(?:(?:temporary|unique|fulltext|spatial)\s+)*(?:table|view|index)\b/i,
    /^alter\s+(?:(?:online|offline|ignore)\s+)*(?:table|view)\b/i,
    /^drop\s+(?:temporary\s+)?(?:table|view|index)\b/i,
    /^rename\s+tables?\b/i,
    /^truncate\s+(?:table\s+)?(?=[`A-Za-z0-9_$])/i,
  ]),
  forbiddenPatterns: Object.freeze([
    /^(?:drop|truncate|alter|create|rename|grant|revoke|lock|unlock|set|use|call|do|handler|load|replace|start|stop|kill|purge|reset|flush|analyze|optimize|repair|check)\b/i,
  ]),
})

/** PostgreSQL 词法。 */
export const PG_LEX = Object.freeze({
  dialect: 'postgres',
  label: 'PostgreSQL',
  identQuotes: Object.freeze(['"']),
  stringQuotes: Object.freeze(["'"]),
  lineComments: Object.freeze(['--']),
  blockComments: true,
  dollarQuote: true,
  backslashEscapes: false, // 标准 SQL 字符串不含反斜杠转义，只有 E'...' 才有
  eStrings: true,
  // 注意：整体带分组，拼接进其它正则时不会让 | 的优先级溢出。
  identPattern: '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)',
  foldAlways: false, // 未加引号折叠小写，加引号保留原样
  cteMayWrite: true, // WITH 可以是数据修改 CTE：含顶层 DML 动作时按写处理
  readPatterns: Object.freeze([
    /^select\b/i,
    /^with\b/i,
    /^table\b/i,
    /^values\b/i,
    /^show\b/i,
    /^explain\b/i,
  ]),
  // DROP INDEX 无法在不查库的情况下把索引名映射到表名，白名单无法生效 → 永久拒绝。
  // ALTER ... OWNER TO / SET SCHEMA 属于权限与跨 schema 迁移，等同于绕过库边界。
  forbiddenBeforeDdl: Object.freeze([
    /\bdrop\s+index\b/i,
    /\balter\s+(?:table|view|materialized\s+view)\b[\s\S]*?\bowner\s+to\b/i,
    /\balter\s+(?:table|view|materialized\s+view)\b[\s\S]*?\bset\s+schema\b/i,
  ]),
  ddlPatterns: Object.freeze([
    /^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?(?:(?:unique\s+)?index|table|view|materialized\s+view|sequence)\b/i,
    /^alter\s+(?:table|view|materialized\s+view|index|sequence)\b/i,
    /^drop\s+(?:table|view|materialized\s+view|sequence)\b/i,
    /^truncate\s+(?:table\s+)?(?=[`"\w])/i,
  ]),
  forbiddenPatterns: Object.freeze([
    /^(?:grant|revoke|set|reset|call|do|copy|vacuum|analyze|cluster|reindex|listen|notify|unlisten|discard|checkpoint|comment|refresh|begin|commit|rollback|savepoint|release|prepare|execute|deallocate|declare|fetch|move|close|lock|unlock|load|import|drop|truncate|alter|create|rename)\b/i,
  ]),
})

/** 按 dialect 名取 lex（未识别时回落到 MySQL，保持兼容）。 */
export function lexFor(dialect) {
  return dialect === 'postgres' ? PG_LEX : MYSQL_LEX
}

/** 匹配 $tag$ / $$ 起始标记，返回完整标记文本；不是美元引用时返回 null。 */
function matchDollarTag(sql, at) {
  if (sql[at] !== '$') return null
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(at))
  return m === null ? null : m[0]
}

/** 判断 `'` 前面是否紧邻 E/e（PostgreSQL 的 E'...' 转义字符串）。 */
function isEscapeStringPrefix(sql, quoteIndex) {
  const prev = sql[quoteIndex - 1]
  if (prev !== 'E' && prev !== 'e') return false
  const before = sql[quoteIndex - 2]
  return before === undefined || !/[A-Za-z0-9_$]/.test(before)
}

/** Read a row property by SQL field label, tolerating server/driver label casing. */
export function readRowField(row, fieldName) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  if (Object.prototype.hasOwnProperty.call(row, fieldName)) return row[fieldName]
  const wanted = String(fieldName).toLowerCase()
  const actual = Object.keys(row).find((key) => key.toLowerCase() === wanted)
  return actual === undefined ? undefined : row[actual]
}

/**
 * Group information_schema.columns rows, tolerating column-label casing differences.
 *
 * `defaultDatabase` 是本函数唯一的「作用域」参数：MySQL 传默认库名（比对
 * table_schema=库名），PostgreSQL 传 schema 名（PG 的 information_schema 也把
 * schema 放在 table_schema 列）。两种方言的元数据 SQL 都把列别名对齐到 MySQL
 * 的列名（column_type / column_key / column_comment），因此本函数无需感知方言。
 */
export function groupColumnMetadata(rows, allowedTables = [], tableFilter = '', defaultDatabase = '') {
  if (!Array.isArray(rows)) return { ok: false, error: '数据库驱动返回的行集合不是数组' }
  const allowed = Array.isArray(allowedTables) ? allowedTables.map((name) => String(name).toLowerCase()) : []
  const filter = typeof tableFilter === 'string' ? tableFilter.trim().toLowerCase() : ''
  const database = typeof defaultDatabase === 'string' ? defaultDatabase.trim().toLowerCase() : ''
  const byTable = new Map()
  for (const row of rows) {
    const tableName = readRowField(row, 'table_name')
    const columnName = readRowField(row, 'column_name')
    const columnType = readRowField(row, 'column_type')
    const isNullable = readRowField(row, 'is_nullable')
    if ([tableName, columnName, columnType, isNullable].some((value) => value === undefined || value === null)) {
      const fields = row && typeof row === 'object' ? Object.keys(row).join(', ') : typeof row
      return { ok: false, error: 'information_schema 返回行缺少必需字段（实际字段：' + fields + '）' }
    }
    const table = String(tableName).toLowerCase()
    const tableSchema = readRowField(row, 'table_schema')
    if (tableSchema !== undefined && tableSchema !== null && database && String(tableSchema).toLowerCase() !== database) continue
    if (allowed.length > 0 && !allowed.includes(table)) continue
    if (filter && !table.includes(filter)) continue
    if (!byTable.has(table)) byTable.set(table, [])
    const columnKey = readRowField(row, 'column_key')
    const columnComment = readRowField(row, 'column_comment')
    byTable.get(table).push({
      column: String(columnName),
      type: String(columnType),
      nullable: String(isNullable).toUpperCase() === 'YES',
      key: columnKey ? String(columnKey) : '',
      comment: columnComment ? String(columnComment) : '',
    })
  }
  const tables = [...byTable.keys()].sort().map((name) => ({ name, columns: byTable.get(name) }))
  return { ok: true, tables }
}

/**
 * 去掉 SQL 注释（行注释、块注释），字符串与标识符字面量保持原样，
 * 用于语句分类与多语句检测。返回与输入等长的字符串（注释替换为空格）。
 *
 * MySQL：`-- `、`#`、`/* *\/`；标识符用反引号；字符串用单/双引号。
 * PostgreSQL：`--`、`/* *\/`；标识符用双引号；字符串用单引号、E'...'、$tag$...$tag$。
 */
export function stripSqlComments(sql, lex = MYSQL_LEX) {
  if (typeof sql !== 'string') return ''
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]

    // 行注释：逐字符替换为空格，保留换行符位置
    const lineMarker = lex.lineComments.find((marker) => (marker.length === 1 ? c === marker : c === marker[0] && next === marker[1]))
    if (lineMarker !== undefined) {
      while (i < n && sql[i] !== '\n') { out += ' '; i++ }
      continue
    }

    // 块注释
    if (lex.blockComments && c === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += ' '; i++ }
      out += '  '
      i += 2
      continue
    }

    // 美元引用（PostgreSQL）：整段原样保留，内部的分号不参与语句切分
    if (lex.dollarQuote && c === '$') {
      const tag = matchDollarTag(sql, i)
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        out += sql.slice(i, end)
        i = end
        continue
      }
    }

    // 标识符引号：原样保留
    const identQuote = lex.identQuotes.find((quote) => quote === c)
    if (identQuote !== undefined) {
      out += c
      i++
      while (i < n) {
        const ch = sql[i]
        out += ch
        i++
        if (ch === identQuote) {
          if (sql[i] === identQuote) { out += identQuote; i++; continue }
          break
        }
      }
      continue
    }

    // 字符串字面量：原样保留（含引号）
    const stringQuote = lex.stringQuotes.find((quote) => quote === c)
    if (stringQuote !== undefined) {
      const escape = lex.backslashEscapes || (lex.eStrings && isEscapeStringPrefix(sql, i))
      out += c
      i++
      while (i < n) {
        const ch = sql[i]
        if (ch === '\\' && escape) {
          out += ch
          i++
          if (i < n) { out += sql[i]; i++ }
          continue
        }
        out += ch
        i++
        if (ch === stringQuote) {
          if (sql[i] === stringQuote) { out += stringQuote; i++; continue }
          break
        }
      }
      continue
    }

    out += c
    i++
  }
  return out
}

/**
 * 把字符串字面量替换为等长空格，但保留标识符引号（MySQL 反引号 / PG 双引号），
 * 供表名提取正则安全扫描（避免把字符串内容里的 FROM xxx 误判为表引用）。
 * PostgreSQL 的美元引用同样按字符串处理。
 */
export function blankStrings(sql, lex = MYSQL_LEX) {
  if (typeof sql !== 'string') return ''
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]

    // 美元引用：整段抹成空格
    if (lex.dollarQuote && c === '$') {
      const tag = matchDollarTag(sql, i)
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        out += ' '.repeat(end - i)
        i = end
        continue
      }
    }

    // 标识符引号：原样保留（含内部转义）
    const identQuote = lex.identQuotes.find((quote) => quote === c)
    if (identQuote !== undefined) {
      let j = i + identQuote.length
      while (j < n) {
        if (sql.startsWith(identQuote, j)) {
          if (sql.startsWith(identQuote + identQuote, j)) { j += identQuote.length * 2; continue }
          j += identQuote.length
          break
        }
        j++
      }
      out += sql.slice(i, j)
      i = j
      continue
    }

    // 字符串字面量：抹成等长空格
    const stringQuote = lex.stringQuotes.find((quote) => quote === c)
    if (stringQuote !== undefined) {
      const escape = lex.backslashEscapes || (lex.eStrings && isEscapeStringPrefix(sql, i))
      let j = i + 1
      while (j < n) {
        const ch = sql[j]
        if (ch === '\\' && escape) { j += 2; continue }
        if (ch === stringQuote) {
          if (sql[j + 1] === stringQuote) { j += 2; continue }
          j++
          break
        }
        j++
      }
      out += ' '.repeat(Math.min(j, n) - i)
      i = j
      continue
    }

    out += c
    i++
  }
  return out
}

/** 把引号内的标识符文本按方言折叠：MySQL 一律小写；PG 仅未加引号时小写。 */
function foldIdent(part, lex) {
  if (part === null || part === undefined) return ''
  if (lex.foldAlways) return String(part.text).toLowerCase()
  return part.quoted ? String(part.text) : String(part.text).toLowerCase()
}

/**
 * 把一个（可能带限定前缀的）标识符文本切成 parts：[{ text, quoted }]。
 * 引号内部的点号不参与切分（`"a.b"` 是一个标识符）。
 */
function splitQualified(text, lex) {
  const source = String(text)
  const parts = []
  let i = 0
  const n = source.length
  while (i < n) {
    while (i < n && (source[i] === '.' || /\s/.test(source[i]))) i++
    if (i >= n) break
    const quote = lex.identQuotes.find((candidate) => source.startsWith(candidate, i))
    if (quote !== undefined) {
      let j = i + quote.length
      let value = ''
      while (j < n) {
        if (source.startsWith(quote, j)) {
          if (source.startsWith(quote + quote, j)) { value += quote; j += quote.length * 2; continue }
          j += quote.length
          break
        }
        value += source[j]
        j++
      }
      parts.push({ text: value, quoted: true })
      i = j
      continue
    }
    let j = i
    let value = ''
    while (j < n && source[j] !== '.') { value += source[j]; j++ }
    value = value.trim()
    if (value) parts.push({ text: value, quoted: false })
    i = j
  }
  return parts
}

/** 把一个（可能带限定前缀的）标识符解析为 { raw, database, schema, name, parts, quoted }。 */
function parseRef(raw, lex = MYSQL_LEX) {
  // 去掉点号两侧的语法空格，但保留引号标识符内部的空格。
  const text = String(raw).trim().replace(/\s*\.\s*/g, '.')
  if (!text) return null
  const parts = splitQualified(text, lex)
  if (parts.length === 0) return null
  const last = parts[parts.length - 1]
  if (!last.text) return null
  // 整体被一对标识符引号包裹 = 名字本身含点，不按限定名拆分
  const singleQuoted = parts.length === 1 && last.quoted
  const schemaPart = !singleQuoted && parts.length >= 2 ? parts[parts.length - 2] : null
  return {
    raw: text,
    // 兼容既有语义：MySQL 下这里是「库名」；PG 下这里是紧邻表名的 schema。
    database: schemaPart === null ? '' : foldIdent(schemaPart, lex),
    schema: schemaPart === null ? '' : foldIdent(schemaPart, lex),
    name: foldIdent(last, lex),
    parts,
    quoted: last.quoted,
  }
}

/** 结构变更（DDL）判定：动词与对象词必须同时命中（逐方言取出规则）。 */
function isDdlStatement(cleaned, lex) {
  for (const re of lex.ddlPatterns) {
    if (re.test(cleaned)) return true
  }
  return false
}

function isForbiddenBeforeDdl(cleaned, lex) {
  for (const re of lex.forbiddenBeforeDdl) {
    if (re.test(cleaned)) return true
  }
  return false
}

/** PG 数据修改 CTE：WITH 后面出现顶层 INSERT/UPDATE/DELETE 时按写操作处理（fail closed）。 */
const CTE_DML_RE = /\b(?:insert\s+into|update\s+[A-Za-z_][\w$."]*\s+set|delete\s+from)\b/i

/**
 * 语句分类：
 *  - read:       SELECT / SHOW / DESCRIBE / DESC / EXPLAIN
 *                （PostgreSQL 追加 WITH / TABLE / VALUES；WITH 内含 DML 时归 write-dml）
 *  - write-dml:  INSERT / UPDATE / DELETE
 *  - ddl:        CREATE / ALTER / DROP / RENAME / TRUNCATE 作用于表、视图、索引，
 *                即结构变更（要求连接显式开启 allowDdl）
 *  - forbidden:  账号与权限类、库级语句、事务与控制类语句 —— 与 allowDdl 无关，永久拒绝
 *  - unknown:    无法识别
 *  - empty:      空白
 */
export function classifyStatement(sql, lex = MYSQL_LEX) {
  const cleaned = stripSqlComments(sql, lex).trim()
  if (!cleaned) return 'empty'
  if (lex.readPatterns.some((re) => re.test(cleaned))) {
    // WITH 可能是数据修改 CTE：出现顶层写动作时不能当只读放行。
    if (lex.cteMayWrite && /^with\b/i.test(cleaned) && CTE_DML_RE.test(blankStrings(cleaned, lex))) return 'write-dml'
    return 'read'
  }
  if (/^insert\b/i.test(cleaned)) return 'write-dml'
  if (/^update\b/i.test(cleaned)) return 'write-dml'
  if (/^delete\b/i.test(cleaned)) return 'write-dml'
  if (isForbiddenBeforeDdl(cleaned, lex)) return 'forbidden'
  if (isDdlStatement(cleaned, lex)) return 'ddl'
  if (lex.forbiddenPatterns.some((re) => re.test(cleaned))) return 'forbidden'
  return 'unknown'
}

/** 检测多语句：去掉注释与字符串内容后，除末尾分号外仍出现分号即视为多语句。 */
export function hasMultipleStatements(sql, lex = MYSQL_LEX) {
  const cleaned = blankStrings(stripSqlComments(sql, lex), lex).trim()
  const noTrailing = cleaned.replace(/;+\s*$/, '')
  return noTrailing.includes(';')
}

/** 按方言缓存表引用提取正则（避免每次调用重新编译）。 */
const TABLE_REF_CACHE = new Map()
function tableRefRegex(lex) {
  const hit = TABLE_REF_CACHE.get(lex.dialect)
  if (hit !== undefined) return hit
  const qualified = lex.identPattern + '(?:\\s*\\.\\s*' + lex.identPattern + ')*'
  const re = new RegExp('\\b(from|join|update|into)\\s+(' + qualified + ')', 'gi')
  TABLE_REF_CACHE.set(lex.dialect, re)
  return re
}

/**
 * 提取 FROM / JOIN / UPDATE / INTO 后的表引用明细：
 * 每项为 { name, quoted, schema, database, parts, raw }。
 * quoted 表示名字在 SQL 里是否用了标识符引号（PG 下决定大小写语义）。
 */
export function extractTableRefDetails(sql, lex = MYSQL_LEX) {
  const cleaned = blankStrings(stripSqlComments(sql, lex), lex)
  const re = tableRefRegex(lex)
  const out = []
  const seen = new Set()
  let m
  re.lastIndex = 0
  while ((m = re.exec(cleaned)) !== null) {
    const ref = parseRef(m[2], lex)
    if (ref === null || !ref.name) continue
    const key = ref.schema + '\u0000' + ref.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** 提取表引用（仅表名，供既有白名单语义使用）。 */
export function extractTableRefs(sql, lex = MYSQL_LEX) {
  return extractTableRefDetails(sql, lex).map((ref) => ref.name)
}

/**
 * 表名白名单归一化：字符串数组 → 规范化表名（去引号、去限定前缀、去重、截断）。
 * 空数组表示「不限制」。
 *
 * MySQL：一律小写。
 * PostgreSQL：未加引号折叠小写，加引号（"Users"）保留原样。
 */
export function normalizeTables(tables, lex = MYSQL_LEX) {
  if (!Array.isArray(tables)) return []
  const seen = new Set()
  const out = []
  for (const entry of tables) {
    const parts = splitQualified(String(entry).trim(), lex)
    if (parts.length === 0) continue
    const name = foldIdent(parts[parts.length - 1], lex)
    if (!name) continue
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out.slice(0, 200)
}

/**
 * 校验一组表名是否全部在白名单内。
 * 白名单为空 → 放行（不限制）；否则返回 { ok:false, denied: [...] }。
 * DML（SQL 提取）与 DDL（目标对象提取）共用同一套白名单语义。
 */
export function checkTableRefs(names, allowlist) {
  const list = normalizeTables(allowlist)
  if (list.length === 0) return { ok: true }
  const denied = []
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw).trim().replace(/`/g, '').toLowerCase()
    if (name && !list.includes(name) && !denied.includes(name)) denied.push(name)
  }
  return denied.length > 0 ? { ok: false, denied } : { ok: true }
}

/**
 * 校验 SQL 引用的表是否全部在白名单内（DML 路径，沿用 FROM/JOIN/UPDATE/INTO 提取）。
 * 白名单为空 → 放行（不限制）；否则返回 { ok:false, denied: [...] }。
 */
export function checkTableAllowlist(sql, allowlist, lex = MYSQL_LEX) {
  return checkTableRefs(extractTableRefs(sql, lex), allowlist)
}

/** 白名单项解析：[{ schema, name, quoted, raw }]。 */
function normalizeAllowlistEntries(allowlist, lex) {
  if (!Array.isArray(allowlist)) return []
  const out = []
  for (const entry of allowlist) {
    const parts = splitQualified(String(entry).trim(), lex)
    if (parts.length === 0) continue
    const last = parts[parts.length - 1]
    const schemaPart = parts.length >= 2 ? parts[parts.length - 2] : null
    out.push({
      raw: String(entry).trim(),
      name: foldIdent(last, lex),
      quoted: last.quoted,
      schema: schemaPart === null ? '' : foldIdent(schemaPart, lex),
      schemaQuoted: schemaPart === null ? false : schemaPart.quoted,
    })
  }
  return out.slice(0, 200)
}

/** 单个标识符匹配：任一侧带引号时区分大小写，否则大小写不敏感。 */
function identMatches(entryText, entryQuoted, refText, refQuoted) {
  if (entryQuoted || refQuoted) return entryText === refText
  return entryText.toLowerCase() === refText.toLowerCase()
}

/**
 * 按方言语义校验表引用明细是否命中白名单（PostgreSQL 用）。
 *
 * 规则（与 MySQL 的 checkTableRefs 保持一致的「空白名单=不限制」语义）：
 *  - 白名单项写成 schema.table → 必须 schema 与表名同时命中；
 *  - 白名单项写成裸 table → 命中任意 schema 的同名表（沿用既有宽松语义）；
 *  - 任一侧使用引号标识符时按大小写敏感比较，否则大小写不敏感。
 */
export function checkDetailAllowlist(details, allowlist, lex = PG_LEX) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return { ok: true }
  const entries = normalizeAllowlistEntries(allowlist, lex)
  if (entries.length === 0) return { ok: true }
  const denied = []
  for (const detail of Array.isArray(details) ? details : []) {
    if (detail === null || typeof detail !== 'object') continue
    const refName = String(detail.name === undefined ? '' : detail.name)
    if (!refName) continue
    const refQuoted = detail.quoted === true
    const refSchema = typeof detail.schema === 'string' ? detail.schema : ''
    const hit = entries.some((entry) => {
      if (!identMatches(entry.name, entry.quoted, refName, refQuoted)) return false
      if (entry.schema === '') return true
      return identMatches(entry.schema, entry.schemaQuoted, refSchema, refQuoted)
    })
    const label = typeof detail.raw === 'string' && detail.raw ? detail.raw : refName
    if (!hit && !denied.includes(label)) denied.push(label)
  }
  return denied.length > 0 ? { ok: false, denied } : { ok: true }
}

// ── 结构变更（DDL）目标提取与跨库边界 ─────────────────────────────────────
//
// 白名单与库边界都必须看到 DDL 的目标对象，而 DDL 的语法形态与 DML 完全不同：
// `DROP TABLE t` / `ALTER TABLE t` / `TRUNCATE t` 里没有 FROM/JOIN/UPDATE/INTO，
// 走 extractTableRefs 会得到空集合 —— 校验会「空过」。这一节专门提取这些形态。

/** 逐个取出文本里的（可能带限定前缀的）标识符。 */
function collectRefs(text, lex) {
  const out = []
  const re = new RegExp(lex.identPattern + '(?:\\s*\\.\\s*' + lex.identPattern + ')*', 'g')
  let m
  while ((m = re.exec(text)) !== null) out.push(m[0])
  return out
}

/**
 * 提取结构变更语句的目标与来源引用，返回 { created, mutated, referenced }：
 *  - created：本次创建的新对象（CREATE TABLE / VIEW，CREATE INDEX 的索引名）
 *             —— 新建的名字不可能预先出现在白名单里，因此豁免白名单校验；
 *  - mutated：被修改/删除的目标（ALTER / DROP / TRUNCATE / RENAME，以及索引语句里
 *             `ON` 之后的那张表）—— 参与白名单校验；referenced 是 CREATE ... LIKE/AS SELECT
 *             等语句中的来源表（也参与库边界与白名单检查）。
 * 每项为 { raw, database, schema, name, parts, quoted }。
 */
export function extractDdlTargets(sql, lex = MYSQL_LEX) {
  const cleaned = blankStrings(stripSqlComments(sql, lex), lex)
  const created = []
  const mutated = []
  const referenced = []
  const push = (bucket, raw) => {
    const ref = parseRef(raw, lex)
    if (ref !== null && !bucket.some((r) => r.raw === ref.raw)) bucket.push(ref)
  }
  const IDENT = lex.identPattern
  const QUALIFIED = IDENT + '(?:\\s*\\.\\s*' + IDENT + ')*'
  let m

  // PG 允许 `ALTER TABLE ONLY t` / `ALTER TABLE IF EXISTS t`
  const alterHead = '\\balter\\s+(?:(?:online|offline|ignore)\\s+)*(?:table|view|materialized\\s+view)\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?'
  const alterRe = new RegExp(alterHead + '(' + QUALIFIED + ')', 'gi')
  while ((m = alterRe.exec(cleaned)) !== null) push(mutated, m[1])

  // ALTER TABLE ... RENAME [TO|AS] new_name also mutates the destination.
  // Ignore RENAME COLUMN / RENAME INDEX / RENAME CONSTRAINT, whose following identifier is not a table.
  const alterRenameRe = new RegExp(
    alterHead + '(' + QUALIFIED + ')[\\s\\S]*?\\brename\\s+(?!(?:column|index|constraint)\\b)(?:(?:to|as)\\s+)?(' + QUALIFIED + ')',
    'gi',
  )
  while ((m = alterRenameRe.exec(cleaned)) !== null) { push(mutated, m[1]); push(mutated, m[2]) }

  const createRe = new RegExp(
    '\\bcreate\\s+(?:or\\s+replace\\s+)?(?:(?:global|local)\\s+)?(?:(?:temporary|temp|unlogged)\\s+)?(?:table|view|materialized\\s+view)\\s+(?:if\\s+not\\s+exists\\s+)?(' + QUALIFIED + ')',
    'gi',
  )
  while ((m = createRe.exec(cleaned)) !== null) push(created, m[1])

  const createIndexRe = new RegExp(
    '\\bcreate\\s+(?:or\\s+replace\\s+)?(?:(?:unique|fulltext|spatial)\\s+)*index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(' + QUALIFIED + ')\\s+on\\s+(?:only\\s+)?(' + QUALIFIED + ')',
    'gi',
  )
  while ((m = createIndexRe.exec(cleaned)) !== null) { push(created, m[1]); push(mutated, m[2]) }

  const dropRe = new RegExp(
    '\\bdrop\\s+(?:temporary\\s+)?(?:table|view|materialized\\s+view)\\s+(?:if\\s+exists\\s+)?(' + QUALIFIED + '(?:\\s*,\\s*' + QUALIFIED + ')*)',
    'gi',
  )
  while ((m = dropRe.exec(cleaned)) !== null) {
    for (const ref of collectRefs(m[1], lex)) push(mutated, ref)
  }

  const dropIndexRe = new RegExp('\\bdrop\\s+index\\s+(' + QUALIFIED + ')\\s+on\\s+(' + QUALIFIED + ')', 'gi')
  while ((m = dropIndexRe.exec(cleaned)) !== null) push(mutated, m[2])

  // TRUNCATE 支持逗号分隔的多目标（PostgreSQL 常见写法）
  const truncateRe = new RegExp('\\btruncate\\s+(?:table\\s+)?(?:only\\s+)?(' + QUALIFIED + '(?:\\s*,\\s*' + QUALIFIED + ')*)', 'gi')
  while ((m = truncateRe.exec(cleaned)) !== null) {
    for (const ref of collectRefs(m[1], lex)) push(mutated, ref)
  }

  // RENAME TABLE a TO b, c TO d —— 源名与目标名都是本次改动的对象
  const renameRe = new RegExp('(?:\\brename\\s+tables?\\s+|,\\s*)(' + QUALIFIED + ')\\s+to\\s+(' + QUALIFIED + ')', 'gi')
  while ((m = renameRe.exec(cleaned)) !== null) { push(mutated, m[1]); push(mutated, m[2]) }

  // Also scope data/schema sources referenced by CREATE ... AS SELECT or LIKE.
  const tableRefRe = /\b(from|join|update|into|references)\s+((?:`[^`]+`|"(?:[^"]|"")*"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|"(?:[^"]|"")*"|[A-Za-z0-9_$]+))*)/gi
  tableRefRe.lastIndex = 0
  while ((m = tableRefRe.exec(cleaned)) !== null) push(referenced, m[2])
  const likeRe = new RegExp('\\blike\\s+(' + QUALIFIED + ')', 'gi')
  while ((m = likeRe.exec(cleaned)) !== null) push(referenced, m[1])

  return { created, mutated, referenced }
}

/**
 * 跨库边界：目标对象的库名前缀必须与连接的默认库一致（未加前缀视为默认库）。
 * 默认库为空时，任何显式带库名前缀的目标都被拒绝。
 * 返回 { ok:true } 或 { ok:false, denied: [原始目标...] }。
 *
 * 语义为 MySQL 的「两段式 db.table」。PostgreSQL 请使用 checkScopedBoundary。
 */
export function checkDatabaseBoundary(refs, defaultDatabase) {
  const db = typeof defaultDatabase === 'string' ? defaultDatabase.trim().replace(/`/g, '').toLowerCase() : ''
  const denied = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (ref === null || typeof ref !== 'object') continue
    const qualified = typeof ref.database === 'string' ? ref.database : ''
    if (qualified && qualified !== db && !denied.includes(ref.raw)) denied.push(ref.raw)
  }
  return denied.length > 0 ? { ok: false, denied } : { ok: true }
}

/**
 * PostgreSQL 的作用域边界：限定名最多三段 database.schema.table。
 *  - 一段（table）：视为当前 schema，放行；
 *  - 两段（schema.table）：schema 必须等于 scope.schema；
 *  - 三段（db.schema.table）：库名与 schema 都必须匹配；
 *  - 四段及以上：拒绝（PG 不接受额外限定）。
 * scope.schema 为空时任何显式 schema 前缀都被拒绝（fail closed）。
 */
export function checkScopedBoundary(refs, scope) {
  const database = typeof (scope && scope.database) === 'string' ? scope.database.trim().toLowerCase() : ''
  const schema = typeof (scope && scope.schema) === 'string' ? scope.schema.trim().toLowerCase() : ''
  const denied = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (ref === null || typeof ref !== 'object') continue
    const parts = Array.isArray(ref.parts) ? ref.parts : []
    if (parts.length <= 1) continue
    let blocked = false
    if (parts.length > 3) {
      blocked = true
    } else {
      const schemaPart = parts[parts.length - 2]
      if (!schema || foldIdent(schemaPart, PG_LEX).toLowerCase() !== schema) blocked = true
      if (!blocked && parts.length === 3) {
        const dbPart = parts[parts.length - 3]
        if (!database || foldIdent(dbPart, PG_LEX).toLowerCase() !== database) blocked = true
      }
    }
    if (blocked && !denied.includes(ref.raw)) denied.push(ref.raw)
  }
  return denied.length > 0 ? { ok: false, denied } : { ok: true }
}

/** 将 mysql2 行值转换为无损 JSON（Date/Buffer/bigint 安全）。 */
export function jsonSafe(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = jsonSafe(value[key])
    return out
  }
  return value
}

/**
 * 把驱动 / 服务端错误整理成一行可读文本。
 *
 * 背景：当 MySQL（或前置代理）返回 message 为空的错误包时，mysql2 的
 * `err.message` 与 `err.sqlMessage` 都会退化成空串或 `Unknown error <errno>`，
 * 而 `errno` / `code` / `sqlState` 仍然有效。此时 `String(err.message || err)`
 * 只会输出毫无信息量的「Error」/「Unknown error 1146」，把 1064、1146、1054
 * 这类关键线索丢掉。PostgreSQL 的失败同样只有 `code` / `detail` / `position`，
 * 因此这里统一处理，`label` 决定兜底文案里的方言名。
 *
 * 规则：优先 message，缺失时退回 sqlMessage；**只有当 message 信息量为零**
 * （空串，或 mysql2 合成的 `Unknown error <errno>`）时才补上尚未出现的
 * `code` / `errno` / `sqlState`。完整可读的报错文本（ECONNREFUSED、ENOENT、
 * 真实数据库错误描述）原样返回，不追加噪音。
 */
export function describeDbError(err, label = 'MySQL') {
  if (err === null || err === undefined) return '未知错误'
  if (typeof err !== 'object') return String(err)
  const message = typeof err.message === 'string' ? err.message.trim() : ''
  const sqlMessage = typeof err.sqlMessage === 'string' ? err.sqlMessage.trim() : ''
  const detail = message !== '' ? message : sqlMessage
  const tags = [err.code, err.errno, err.sqlState]
    .map((part) => (part === undefined || part === null ? '' : String(part).trim()))
    .filter((part) => part !== '' && !detail.includes(part))
    .join(' ')
  const degenerate = detail === '' || /^unknown error \d+$/i.test(detail)
  if (!degenerate) return detail
  if (detail !== '' && tags !== '') return detail + '（' + tags + '）'
  if (tags !== '') return String(label) + ' 错误（' + tags + '）'
  return detail !== '' ? detail : '未知错误'
}
