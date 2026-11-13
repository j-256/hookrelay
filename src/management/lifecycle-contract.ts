import { z } from 'zod'
import { authorityIdSchema } from '../configuration/authority'
import { githubSetupEvents, githubSetupRepository } from '../lib/github-setup'
const identity = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/)
const resourceId = z.uuid()
const context = z.object({ workspaceId: identity, actorId: identity }).strict()
export const destinationType = z.enum(['discord','ntfy','webhook'])
export const lifecycleChange = z.discriminatedUnion('kind', [
  z.object({ kind:z.literal('destination-create'),name:z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/),type:destinationType }).strict(),
  z.object({ kind:z.literal('destination-update'),resourceId,replaceCredentials:z.boolean() }).strict(),
  ...(['destination-retire','destination-restore','subscription-retire','subscription-restore','github-hook-delete'] as const).map(kind=>z.object({kind:z.literal(kind),resourceId}).strict()),
  z.object({ kind:z.literal('github-hook-adopt'),resourceId,repository:githubSetupRepository,hookId:z.number().int().positive().safe() }).strict(),
  z.object({ kind:z.literal('github-hook-update'),resourceId,events:githubSetupEvents,active:z.boolean() }).strict(),
])
export const lifecycleInputs = {
  lifecycle_configuration:context,
  lifecycle_subscriptions:context.extend({cursor:z.uuid().nullable().default(null),revision:z.number().int().nonnegative()}).strict(),
  lifecycle_subscription:context.extend({resourceId:z.uuid()}).strict(),
  lifecycle_plan:context.extend({planId:z.uuid(),authorityId:authorityIdSchema,revision:z.number().int().nonnegative(),change:lifecycleChange}).strict(),
  lifecycle_get:context.extend({planId:z.uuid()}).strict(),
  lifecycle_apply:context.extend({planId:z.uuid()}).strict(),
}
export type LifecycleInput = z.infer<typeof lifecycleInputs.lifecycle_plan>
export const LIFECYCLE_INPUT_PATH = '/admin/api/v1/lifecycle-input/'
