import { createDatabase } from '@ecc/database'
import { createApp } from './app.ts'
import { readApiConfig } from './config.ts'

const config = readApiConfig()
const db = createDatabase()
const app = createApp(db)

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
})

console.log(`[api] listening on http://0.0.0.0:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`[api] received ${signal}, shutting down`)
    server.stop(true)
    await db.destroy()
    process.exit(0)
  })
}
