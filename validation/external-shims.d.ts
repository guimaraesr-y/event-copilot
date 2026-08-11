declare const Bun: any
declare const process: any

declare module 'node:os' {
  export function hostname(): string
}

declare module 'node:crypto' {
  export function createHmac(...args: any[]): any
  export function createHash(...args: any[]): any
  export function timingSafeEqual(...args: any[]): boolean
}

declare const Buffer: any

declare module 'hono' {
  export class Hono<T = any> {
    fetch: any
    get(...args: any[]): this
    post(...args: any[]): this
    patch(...args: any[]): this
    delete(...args: any[]): this
    onError(...args: any[]): this
  }
}

declare module 'kysely' {
  export type ColumnType<S, I = S, U = S> = S
  export type Generated<T> = T
  export type JSONColumnType<S, I = S, U = S> = S
  export type Transaction<T = any> = any
  export type Selectable<T> = T
  export const sql: any
  export class Kysely<T = any> {
    constructor(config: any)
    schema: any
    transaction(): any
    insertInto(...args: any[]): any
    selectFrom(...args: any[]): any
    updateTable(...args: any[]): any
    deleteFrom(...args: any[]): any
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

declare module 'kysely/migration' {
  export class Migrator {
    constructor(config: any)
    migrateToLatest(): Promise<any>
  }
}
