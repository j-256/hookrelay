import { registerAdapter } from './adapters'
import statuspage from './adapters/statuspage'
import github from './adapters/github'
import cloudflare from './adapters/cloudflare'
import uptime from './adapters/uptime'

import { registerSink } from './sinks'
import ntfy from './sinks/ntfy'
import discord from './sinks/discord'

let installed = false

export function installRegistry(): void {
  if (installed) return
  installed = true
  registerAdapter(statuspage)
  registerAdapter(github)
  registerAdapter(cloudflare)
  registerAdapter(uptime)
  registerSink(ntfy)
  registerSink(discord)
}

installRegistry()
