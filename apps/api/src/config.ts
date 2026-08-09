export interface ApiConfig {
  port: number
}

export function readApiConfig(): ApiConfig {
  const port = Number.parseInt(process.env.API_PORT ?? '3000', 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('API_PORT must be a valid TCP port')
  }
  return { port }
}
