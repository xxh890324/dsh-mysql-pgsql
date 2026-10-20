/**
 * 方言注册表。
 *
 * 两个适配器都是**静态导入**，不采用动态 import()：
 * `apply()` 是同步函数，宿主可能在它返回后立即快照工具列表；如果工具注册依赖
 * 一个尚未 resolve 的动态 import，注册就会时序不确定（甚至整体丢失）。
 * 两个驱动在插件安装时都是硬依赖，静态导入不引入额外成本。
 *
 * 新增方言只需：写一个 lib/dialects/<name>.js + 在这里登记 defaults 与 registry。
 */

import * as mysql from './mysql.js'
import * as postgres from './postgres.js'

const REGISTRY = {
  mysql: mysql.default || mysql,
  postgres: postgres.default || postgres,
}

/** 各方言的默认连接参数。port/user 用于新建连接表单与配置归一化。 */
export const DIALECT_DEFAULTS = Object.freeze({
  mysql: Object.freeze({ type: 'mysql', label: 'MySQL', port: 3306, user: 'root', database: '' }),
  postgres: Object.freeze({ type: 'postgres', label: 'PostgreSQL', port: 5432, user: 'postgres', database: '' }),
})

/** 已实现的方言类型（顺序即 UI 里的展示顺序）。 */
export const DIALECT_TYPES = Object.freeze(Object.keys(REGISTRY))

/** 缺省方言：既有配置没有 type 字段时一律按 MySQL 处理（向后兼容）。 */
export const DEFAULT_DIALECT = 'mysql'

/** 是否为受支持的方言类型。 */
export function isDialectType(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, value)
}

/** 取默认参数（未知方言回落到 MySQL，保证旧数据可用）。 */
export function defaultsFor(type) {
  return DIALECT_DEFAULTS[type] || DIALECT_DEFAULTS[DEFAULT_DIALECT]
}

/**
 * 取方言适配器。同步返回（见文件头说明）。
 * @param {string} type
 * @returns {object} adapter
 */
export function createDialect(type) {
  const key = isDialectType(type) ? type : DEFAULT_DIALECT
  return REGISTRY[key]
}
