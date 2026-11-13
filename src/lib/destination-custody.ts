import { z } from 'zod'
import type { Env } from '../index'
import { normalizeWebhookEndpointUrl } from './public-url'
import { openProtectedValue, sealProtectedValue } from './github-handoff-crypto'
const PURPOSE = 'hookrelay.destination.v1'
const value = z.string().min(1).max(4096)
const privateSchema = z.discriminatedUnion('type',[
  z.object({type:z.literal('discord'),url:value}).strict(),
  z.object({type:z.literal('ntfy'),server:value.optional(),topic:value,token:value.regex(/^[\x21-\x7e]+$/).optional()}).strict(),
  z.object({type:z.literal('webhook'),url:value,signingSecret:value}).strict(),
])
const referenceSchema = z.object({resourceId:z.uuid(),revision:z.number().int().positive()}).strict()
export interface DestinationBinding { authorityId:string;workspaceId:string;resourceId:string;revision:number;type:string }
export function parseDestinationPrivate(input: unknown) {
  const parsed = privateSchema.parse(input)
  try {
    if (parsed.type === 'ntfy') {
      const server = new URL(normalizeWebhookEndpointUrl(parsed.server ?? 'https://ntfy.sh'))
      if (server.search) throw new Error()
      return {...parsed,server:server.toString().replace(/\/$/,'')}
    }
    return {...parsed,url:normalizeWebhookEndpointUrl(parsed.url)}
  } catch { throw new Error('Destination input is invalid') }
}
export async function sealDestination(env: Env,binding: DestinationBinding,input: unknown) {
  const parsed = parseDestinationPrivate(input)
  if (parsed.type !== binding.type) throw new Error('Destination type changed')
  return sealProtectedValue(env,PURPOSE,binding,parsed)
}
export async function resolveDestination(env: Env,type: string,reference: unknown) {
  const ref = referenceSchema.parse(reference)
  const row = await env.EVENTS_DB.prepare(`SELECT c.* FROM destination_custody c
    JOIN configuration_entries e ON e.resource_id=c.resource_id AND e.namespace='SINKS'
    JOIN configuration_authority a ON a.authority_id=c.authority_id AND a.mode='active'
    WHERE c.resource_id=? AND c.revision=? AND c.type=? AND json_extract(e.value,'$.custody.resourceId')=c.resource_id
      AND json_extract(e.value,'$.custody.revision')=c.revision AND json_extract(e.value,'$.type')=c.type`)
    .bind(ref.resourceId,ref.revision,type).first<{authority_id:string;workspace_id:string;encrypted_json:string}>()
  if (!row) throw new Error('Destination custody is unavailable')
  const binding:DestinationBinding = {authorityId:row.authority_id,workspaceId:row.workspace_id,resourceId:ref.resourceId,revision:ref.revision,type}
  const parsed = parseDestinationPrivate(await openProtectedValue(env,PURPOSE,binding,JSON.parse(row.encrypted_json)))
  if (parsed.type !== type) throw new Error('Destination custody is unavailable')
  const secrets:Record<string,string> = {}
  if (parsed.type === 'ntfy') {
    if(parsed.token) secrets.DESTINATION_TOKEN = parsed.token
    return {config:{topic:parsed.topic,server:parsed.server,...(parsed.token?{tokenEnv:'DESTINATION_TOKEN'}:{})},secrets}
  }
  secrets.DESTINATION_URL = parsed.url
  if (parsed.type === 'webhook') secrets.DESTINATION_SIGNING_SECRET = parsed.signingSecret
  return {config:{urlEnv:'DESTINATION_URL',...(parsed.type==='webhook'?{signingSecretEnv:'DESTINATION_SIGNING_SECRET'}:{})},secrets}
}
