import type { Env as ProjectEnv } from './src/index'

// env.d.ts -- bridge cloudflare:test's env typing to the project's Env
declare global {
  namespace Cloudflare {
    interface Env extends ProjectEnv {}
  }
}
