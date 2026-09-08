import { z } from 'zod'
import type { Env } from '../index'
import { ConfigurationError } from '../configuration/authority'
import { authenticateManagement, authorizeManagement } from './access'
import {
  MANAGEMENT_VERSION, ManagementError, managementEnvelope, managementInputs,
  managementResponse, readManagementBody,
} from './contract'
import { readDeliveries, readDelivery, readSnapshot, readSubscriptions } from './read'
import { applyRetry, planRetry, readRetry } from './retry'
import {
  applyConfigurationPolicy, planConfigurationPolicy, readConfiguration, readConfigurationPage,
  readConfigurationPolicy, readConfigurationSubscription,
} from './configuration'

export async function handleManagement(request: Request, env: Env): Promise<Response> {
  try {
    const principal = await authenticateManagement(request, env)
    if (request.method !== 'POST') {
      const response = managementResponse({ error: { code: 'method', message: 'Use POST' } }, 405)
      response.headers.set('allow', 'POST')
      return response
    }
    const envelope = managementEnvelope.parse(await readManagementBody(request))
    const context = managementInputs[envelope.command].parse(envelope.input)
    authorizeManagement(principal, context.workspaceId, ['retry_plan', 'retry_apply'].includes(envelope.command))
    let result: unknown
    switch (envelope.command) {
      case 'snapshot': result = await readSnapshot(env); break
      case 'subscriptions':
        result = await readSubscriptions(env, managementInputs.subscriptions.parse(envelope.input).cursor)
        break
      case 'deliveries':
        result = await readDeliveries(env, managementInputs.deliveries.parse(envelope.input))
        break
      case 'delivery': {
        const input = managementInputs.delivery.parse(envelope.input)
        result = await readDelivery(env, input.eventId, input.sinkName)
        break
      }
      case 'retry_plan':
        result = await planRetry(env, principal, managementInputs.retry_plan.parse(envelope.input))
        break
      case 'retry_apply':
        result = await applyRetry(env, principal, managementInputs.retry_apply.parse(envelope.input))
        break
      case 'retry_get':
        result = await readRetry(env, principal, managementInputs.retry_get.parse(envelope.input))
        break
      case 'configuration': result = await readConfiguration(env, principal); break
      case 'configuration_subscriptions':
        result = await readConfigurationPage(env, 'subscriptions', managementInputs.configuration_subscriptions.parse(envelope.input))
        break
      case 'configuration_subscription':
        result = await readConfigurationSubscription(env, managementInputs.configuration_subscription.parse(envelope.input).resourceId)
        break
      case 'configuration_sinks':
        result = await readConfigurationPage(env, 'sinks', managementInputs.configuration_sinks.parse(envelope.input))
        break
      case 'configuration_policy_plan':
        result = await planConfigurationPolicy(env, principal, managementInputs.configuration_policy_plan.parse(envelope.input))
        break
      case 'configuration_policy_apply':
        result = await applyConfigurationPolicy(env, principal, managementInputs.configuration_policy_apply.parse(envelope.input))
        break
      case 'configuration_policy_get':
        result = await readConfigurationPolicy(env, principal, managementInputs.configuration_policy_get.parse(envelope.input))
        break
    }
    return managementResponse({
      version: MANAGEMENT_VERSION,
      capabilities: principal.capabilities.filter(capability => capability !== 'configure'),
      result,
    })
  } catch (error) {
    if (error instanceof ConfigurationError) {
      const statuses = { unavailable: 503, validation: 400, conflict: 409, expired: 409, not_found: 404, inactive: 409 }
      return managementResponse({ error: { code: error.code, message: error.message } }, statuses[error.code])
    }
    if (error instanceof ManagementError) {
      return managementResponse({ error: { code: error.code, message: error.message } }, error.status)
    }
    if (error instanceof z.ZodError) {
      return managementResponse({ error: { code: 'validation', message: 'Management input is invalid' } }, 400)
    }
    console.log(JSON.stringify({ level: 'warn', msg: 'management.request.failed' }))
    return managementResponse({ error: { code: 'unavailable', message: 'Management is temporarily unavailable; reconcile uncertain retries before acting again' } }, 503)
  }
}
