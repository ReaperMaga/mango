import type { AgentQuestion, QuestionAnswers } from './types.ts'

/**
 * MCP elicitation forms (an MCP server asking the user for input, passed on by Claude Code or
 * Codex) as questions for the chat's question card, and the user's answers back as the form's
 * content. Forms are flat: each property is a string, number, boolean or enum (MCP 2025-11-25,
 * `ElicitRequestFormParams`). Plain TypeScript, so the adapters stay runnable outside the app.
 */

export interface ElicitationForm {
  questions: AgentQuestion[]
  /** The form's `content` for the answers, one entry per question. */
  content(answers: QuestionAnswers): Record<string, unknown>
}

type Json = any

const YES = 'Yes'
const NO = 'No'

const PLACEHOLDERS: Record<string, string> = {
  'email': 'name@example.com',
  'uri': 'https://…',
  'date': 'YYYY-MM-DD',
  'date-time': 'YYYY-MM-DDTHH:MM',
}

/** Choices as [value, label] pairs from the enum shapes MCP allows; null when `p` is not one. */
function choices(p: Json): [string, string][] | null {
  const consts = (list: Json) => (Array.isArray(list) ? list : [])
    .filter((o: Json) => typeof o?.const === 'string')
    .map((o: Json) => [o.const, typeof o.title === 'string' && o.title ? o.title : o.const] as [string, string])
  if (Array.isArray(p?.enum)) {
    const names: unknown[] = Array.isArray(p.enumNames) ? p.enumNames : []
    return p.enum.filter((v: unknown) => typeof v === 'string')
      .map((v: string, i: number) => [v, typeof names[i] === 'string' && names[i] ? names[i] : v] as [string, string])
  }
  if (Array.isArray(p?.oneOf)) return consts(p.oneOf)
  if (Array.isArray(p?.anyOf)) return consts(p.anyOf)
  return null
}

/**
 * The questions for a form schema, in `order` when the CLI gives one. Null when a property has a
 * shape the card cannot ask for (nested objects, arrays of anything but choices).
 */
export function elicitationForm(schema: Json, order?: unknown): ElicitationForm | null {
  const props: Record<string, Json> = schema && typeof schema.properties === 'object' && schema.properties ? schema.properties : {}
  const required: string[] = Array.isArray(schema?.required) ? schema.required : []
  const keys = Array.isArray(order) && order.every(k => typeof k === 'string' && k in props) && order.length === Object.keys(props).length
    ? (order as string[])
    : Object.keys(props)

  const questions: AgentQuestion[] = []
  const readers: ((answer: string[]) => unknown)[] = []
  for (const key of keys) {
    const p = props[key] ?? {}
    const base: AgentQuestion = {
      question: typeof p.title === 'string' && p.title ? p.title : key,
      options: [],
      ...(typeof p.description === 'string' && p.description ? { detail: p.description } : {}),
      ...(required.includes(key) ? {} : { optional: true }),
    }
    const list = p.type === 'array' ? choices(p.items) : choices(p)
    if (list) {
      const label = new Map(list.map(([v, l]) => [v, l]))
      const value = new Map(list.map(([v, l]) => [l, v]))
      const defaults = (Array.isArray(p.default) ? p.default : typeof p.default === 'string' ? [p.default] : [])
        .map((v: string) => label.get(v)).filter(Boolean) as string[]
      questions.push({ ...base, options: list.map(([, l]) => ({ label: l })), ...(p.type === 'array' ? { multiSelect: true } : {}), ...(defaults.length ? { preset: defaults } : {}) })
      readers.push(p.type === 'array'
        ? a => a.map(l => value.get(l)).filter(v => v !== undefined)
        : a => (a[0] === undefined ? undefined : value.get(a[0])))
    } else if (p.type === 'boolean') {
      questions.push({ ...base, options: [{ label: YES }, { label: NO }], ...(typeof p.default === 'boolean' ? { preset: [p.default ? YES : NO] } : {}) })
      readers.push(a => (a[0] === undefined ? undefined : a[0] === YES))
    } else if (p.type === 'number' || p.type === 'integer') {
      questions.push({ ...base, freeText: true, format: p.type, ...(typeof p.default === 'number' ? { preset: [String(p.default)] } : {}) })
      readers.push(a => (a[0] === undefined || a[0] === '' ? undefined : Number(a[0])))
    } else if (p.type === 'string') {
      const placeholder = PLACEHOLDERS[String(p.format)]
      questions.push({ ...base, freeText: true, ...(placeholder ? { placeholder } : {}), ...(typeof p.default === 'string' && p.default ? { preset: [p.default] } : {}) })
      readers.push(a => a[0])
    } else {
      return null
    }
  }
  return {
    questions,
    content(answers) {
      const out: Record<string, unknown> = {}
      keys.forEach((key, i) => {
        const v = readers[i]!(answers[i] ?? [])
        if (v !== undefined && !(Array.isArray(v) && !v.length && questions[i]!.optional)) out[key] = v
      })
      return out
    },
  }
}

/** A URL-mode elicitation: the server wants the user to finish something in the browser. */
export function elicitationLink(url: string): AgentQuestion {
  return {
    question: `Open this link and finish there, then come back: ${url}`,
    options: [{ label: 'Done', description: 'I finished in the browser' }],
  }
}
