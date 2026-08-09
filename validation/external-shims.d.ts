declare const Bun: any
declare const process: any

declare module 'node:os' {
  export function hostname(): string
}

declare module 'hono' {
  export class Hono<T = any> {
    fetch: any
    get(...args: any[]): this
    post(...args: any[]): this
    onError(...args: any[]): this
  }
}

declare module 'kysely' {
  export type ColumnType<S, I = S, U = S> = S
  export type Generated<T> = T
  export type JSONColumnType<S, I = S, U = S> = S
  export type Transaction<T = any> = any
  export const sql: any
  export class Kysely<T = any> {
    constructor(config: any)
    schema: any
    transaction(): any
    insertInto(...args: any[]): any
    selectFrom(...args: any[]): any
    updateTable(...args: any[]): any
    destroy(): Promise<void>
  }
  export class PostgresDialect {
    constructor(config: any)
  }
  export class Migrator {
    constructor(config: any)
    migrateToLatest(): Promise<any>
  }
}

declare module 'pg' {
  const pg: any
  export default pg
}

declare module 'zod' {
  export const z: any
  export namespace z {
    type infer<T> = any
  }
}
