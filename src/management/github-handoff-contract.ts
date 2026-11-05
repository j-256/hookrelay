import { z } from 'zod'
import { handoffBundleSchema, handoffProfileSchema } from '../lib/github-handoff'

const identity = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/)
export const handoffContext = z.object({ workspaceId: identity, actorId: identity }).strict()
const review = handoffContext.extend({ planId: z.uuid() }).strict()
const versioned = review.extend({ authorityId: z.string().regex(/^[a-f0-9]{32}$/), revision: z.number().int().nonnegative(), repository: z.string().min(1).max(512) })
export const handoffPlanSchema = versioned.extend({
  profile: handoffProfileSchema,
  sinks: z.array(z.string().min(1).max(160)).min(1).max(25).refine(values => new Set(values).size === values.length),
}).strict()
export const handoffRecoveryRecordSchema = z.object({
  hmac: handoffBundleSchema.shape.hmac, slugs: handoffBundleSchema.shape.slugs,
  profiles: z.array(handoffProfileSchema).min(1).max(3).refine(values => new Set(values).size === values.length).optional(),
  state: z.literal('active'),
}).strict()
export const handoffAdoptionSchema = versioned.extend({ record: handoffRecoveryRecordSchema }).strict()
export const handoffInputs = {
  github_handoff_configuration: handoffContext,
  github_handoff_repository: handoffContext.extend({ repository: z.string().min(1).max(512) }).strict(),
  github_handoff_plan: handoffPlanSchema,
  github_handoff_apply: review,
  github_handoff_get: review,
  github_handoff_status: handoffContext.extend({ resourceId: z.uuid() }).strict(),
} as const
export const handoffPrivateInputs = {
  adopt_plan: handoffAdoptionSchema,
  reveal: handoffContext.extend({ resourceId: z.uuid() }).strict(),
  export: handoffContext.extend({ repositoryId: z.uuid() }).strict(),
} as const
