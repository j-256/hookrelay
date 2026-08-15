import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import { parseRoutes, type Routes, type SinkRef, type Sub } from './sync'

const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function namedSubscription(routes: Routes, name: string): { subscription: Sub; index: number } {
  const matches = routes.subs
    .map((subscription, index) => ({ subscription, index }))
    .filter(({ subscription }) => subscription.name === name)
  if (matches.length === 0) throw new Error(`subscription does not exist: ${name}`)
  if (matches.length > 1) throw new Error(`subscription is declared more than once: ${name}`)
  return matches[0]!
}

function namedSink(sinks: readonly SinkRef[], name: string, label: string): { sink: SinkRef; index: number } {
  const matches = sinks
    .map((sink, index) => ({ sink, index }))
    .filter(({ sink }) => sink.name === name)
  if (matches.length === 0) throw new Error(`${label} does not exist: ${name}`)
  if (matches.length > 1) throw new Error(`${label} is declared more than once: ${name}`)
  return matches[0]!
}

export interface DisabledSubscription {
  routesText: string
  subscription: Sub
  changed: boolean
}

export function disableSubscription(routesText: string, name: string): DisabledSubscription {
  const routes = parseRoutes(routesText)
  const match = namedSubscription(routes, name)
  if (!match.subscription.enabled) return { routesText, subscription: match.subscription, changed: false }
  const updated = withTrailingNewline(applyEdits(routesText, modify(
    routesText,
    ['subs', match.index, 'enabled'],
    false,
    { formattingOptions: FORMATTING_OPTIONS },
  )))
  const subscription = namedSubscription(parseRoutes(updated), name).subscription
  return { routesText: updated, subscription, changed: true }
}

export interface RemovedSubscription {
  routesText: string
  subscription: Sub
}

export function removeSubscription(routesText: string, name: string): RemovedSubscription {
  const routes = parseRoutes(routesText)
  const match = namedSubscription(routes, name)
  const updated = withTrailingNewline(applyEdits(routesText, modify(
    routesText,
    ['subs', match.index],
    undefined,
    { formattingOptions: FORMATTING_OPTIONS },
  )))
  parseRoutes(updated)
  return { routesText: updated, subscription: match.subscription }
}

export interface RetiredSink {
  routesText: string
  sink: SinkRef
  changed: boolean
}

export function retireSink(routesText: string, name: string): RetiredSink {
  const routes = parseRoutes(routesText)
  const alreadyRetired = (routes.retiredSinks ?? []).filter((sink) => sink.name === name)
  if (alreadyRetired.length > 1) throw new Error(`retired sink is declared more than once: ${name}`)
  if (alreadyRetired.length === 1) {
    if (routes.sinks.some((sink) => sink.name === name)) {
      throw new Error(`sink is declared as both active and retired: ${name}`)
    }
    return { routesText, sink: alreadyRetired[0]!, changed: false }
  }

  const match = namedSink(routes.sinks, name, 'active sink')
  const activeReferences = routes.subs.filter((subscription) => (
    subscription.enabled && subscription.sinks.includes(name)
  ))
  if (activeReferences.length > 0) {
    throw new Error(`sink ${name} is referenced by enabled subscriptions: ${activeReferences.map((sub) => sub.name).sort().join(', ')}`)
  }
  if (routes.operations?.sinks.includes(name)) {
    throw new Error(`sink ${name} is referenced by operations alerting`)
  }

  let updated = routesText
  if (routes.retiredSinks) {
    updated = applyEdits(updated, modify(updated, ['retiredSinks', -1], match.sink, {
      isArrayInsertion: true,
      formattingOptions: FORMATTING_OPTIONS,
    }))
  } else {
    updated = applyEdits(updated, modify(updated, ['retiredSinks'], [match.sink], {
      formattingOptions: FORMATTING_OPTIONS,
    }))
  }
  const reparsed = parseRoutes(updated)
  const activeIndex = namedSink(reparsed.sinks, name, 'active sink').index
  updated = withTrailingNewline(applyEdits(updated, modify(
    updated,
    ['sinks', activeIndex],
    undefined,
    { formattingOptions: FORMATTING_OPTIONS },
  )))
  parseRoutes(updated)
  return { routesText: updated, sink: match.sink, changed: true }
}

export interface RemovedRetiredSink {
  routesText: string
  sink: SinkRef
}

export function removeRetiredSink(routesText: string, name: string): RemovedRetiredSink {
  const routes = parseRoutes(routesText)
  const match = namedSink(routes.retiredSinks ?? [], name, 'retired sink')
  const updated = withTrailingNewline(applyEdits(routesText, modify(
    routesText,
    ['retiredSinks', match.index],
    undefined,
    { formattingOptions: FORMATTING_OPTIONS },
  )))
  parseRoutes(updated)
  return { routesText: updated, sink: match.sink }
}
