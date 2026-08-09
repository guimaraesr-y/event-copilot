import type { Hono } from 'hono'

export function registerHealthRoutes(app: Hono, checkReady: () => Promise<void>): void {
  app.get('/api/health/live', (c) => c.json({ status: 'ok' }))

  app.get('/api/health/ready', async (c) => {
    try {
      await checkReady()
      return c.json({ status: 'ready', database: 'ok' })
    } catch (error) {
      console.error('[health] database unavailable', error)
      return c.json({ status: 'not_ready', database: 'unavailable' }, 503)
    }
  })
}
