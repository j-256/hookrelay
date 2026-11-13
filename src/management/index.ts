import { readLifecycleConfiguration, planLifecycle, getLifecycle, applyLifecycle } from './lifecycle'
import { GitHubAuthError } from '../lib/github-app-contract'
import { readGitHubAuthStatus } from './github-auth'
import { readGitHubSetupConfiguration, planGitHubSetup, applyGitHubSetup, getGitHubSetup, readGitHubSetupStatus } from './github-setup'
import { readHandoffConfiguration, readHandoffRepository, planHandoff, applyHandoff, getHandoff, readHandoffStatus } from './github-handoff'
import { z } from 'zod'
import type { Env } from '../index'
import { ConfigurationError, configurationQuery } from '../configuration/authority'
import { authenticateManagement, authorizeManagement, authorizeResolution } from './access'
import { applyOperationalResolution, planOperationalResolution, readOperationalResolution, readOperationalSignals } from '../operational-review'
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
      case 'lifecycle_subscriptions': result = await readConfigurationPage(env, 'subscriptions', managementInputs.lifecycle_subscriptions.parse(envelope.input), true); break
      case 'lifecycle_subscription': result = await readConfigurationSubscription(env, managementInputs.lifecycle_subscription.parse(envelope.input).resourceId, true); break
      case 'lifecycle_configuration': result = await readLifecycleConfiguration(env, principal, context); break
      case 'lifecycle_plan': result = await planLifecycle(env, principal, managementInputs.lifecycle_plan.parse(envelope.input)); break
      case 'lifecycle_get': result = await getLifecycle(env, principal, managementInputs.lifecycle_get.parse(envelope.input)); break
      case 'lifecycle_apply': result = await applyLifecycle(env, principal, managementInputs.lifecycle_apply.parse(envelope.input)); break
      case 'github_handoff_configuration': result = await readHandoffConfiguration(env, principal); break
      case 'github_handoff_repository': result = await readHandoffRepository(env, envelope.input); break
      case 'github_handoff_plan': result = await planHandoff(env, principal, envelope.input); break
      case 'github_handoff_apply': result = await applyHandoff(env, principal, envelope.input); break
      case 'github_handoff_get': result = await getHandoff(env, principal, envelope.input); break
      case 'github_handoff_status': result = await readHandoffStatus(env, envelope.input); break
      case 'signals': {
        const { cursor, resolved } = managementInputs.signals.parse(envelope.input)
        result = await readOperationalSignals(configurationQuery(env.EVENTS_DB), { cursor, resolved })
        break
      }
      case 'resolution_plan':
      case 'resolution_apply':
      case 'resolution_get': {
        const owner = { clientId: principal.id, clientRevision: principal.revision, workspaceId: context.workspaceId, actorId: context.actorId }
        const query = configurationQuery(env.EVENTS_DB)
        if (envelope.command === 'resolution_get') {
          result = await readOperationalResolution(query, owner, managementInputs.resolution_get.parse(envelope.input).planId)
        } else {
          authorizeResolution(principal, context.workspaceId)
          if (envelope.command === 'resolution_plan') {
            const { workspaceId: _workspace, actorId: _actor, ...input } = managementInputs.resolution_plan.parse(envelope.input)
            result = await planOperationalResolution(query, owner, input)
          } else {
            result = await applyOperationalResolution(query, owner, managementInputs.resolution_apply.parse(envelope.input).planId)
          }
        }
        break
      }
      case 'github_auth_status': result = await readGitHubAuthStatus(env, principal, context); break
      case 'github_setup_configuration': result = await readGitHubSetupConfiguration(env, principal,context.workspaceId); break
      case 'github_setup_plan': result = await planGitHubSetup(env, principal, managementInputs.github_setup_plan.parse(envelope.input)); break
      case 'github_setup_apply': result = await applyGitHubSetup(env, principal, managementInputs.github_setup_apply.parse(envelope.input)); break
      case 'github_setup_get': result = await getGitHubSetup(env, principal, managementInputs.github_setup_get.parse(envelope.input)); break
      case 'github_setup_status': result = await readGitHubSetupStatus(env, managementInputs.github_setup_status.parse(envelope.input).resourceId,principal,context); break
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
      capabilities: principal.capabilities.filter(capability => capability === 'read' || capability === 'retry' || capability === 'resolve'),
      result,
    })
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      const statuses={validation:400,conflict:409,denied:403,unavailable:503,rate_limited:429,not_sent:503,indeterminate:503}
      return managementResponse({error:{code:error.code,message:error.message}},statuses[error.code])
    }
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
