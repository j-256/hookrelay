import { registerAdapter } from './adapters'
import statuspage from './adapters/statuspage'
import github from './adapters/github'
import cloudflare from './adapters/cloudflare'
import uptime from './adapters/uptime'
import cloudevents from './adapters/cloudevents'

import { registerSink } from './sinks'
import ntfy from './sinks/ntfy'
import discord from './sinks/discord'
import webhook from './sinks/webhook'

let installed = false

export function installRegistry(): void {
  if (installed) return
  installed = true
  registerAdapter(statuspage)
  registerAdapter(github)
  registerAdapter(cloudflare)
  registerAdapter(uptime)
  registerAdapter(cloudevents)
  registerSink(ntfy)
  registerSink(discord)
  registerSink(webhook)
}

installRegistry()
