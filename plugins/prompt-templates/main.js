/**
 * Prompt templates: each line of the `templates` setting (`name: prompt`) becomes a composer slash command.
 * Running `/name some words` sends the prompt with `{{args}}` filled in, so a template is just a prompt
 * the user does not have to type again.
 *
 * Placeholders:
 *   {{args}}            what was typed after the command ('' when nothing)
 *   {{args|fallback}}   the same, or `fallback` when nothing was typed
 *   {{project}}         the project folder's name
 * A template without {{args}} still gets the typed words, appended as their own paragraph.
 */

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** Parse the setting into `{ name, template }` pairs; bad lines are reported, not fatal. */
export function parseTemplates(source) {
  const templates = []
  const problems = []
  const seen = new Set()
  const lines = String(source ?? '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const colon = line.indexOf(':')
    const name = (colon > 0 ? line.slice(0, colon) : '').trim().replace(/^\//, '').toLowerCase()
    const template = colon > 0 ? line.slice(colon + 1).trim().replace(/\\n/g, '\n') : ''
    if (!NAME.test(name) || !template) {
      problems.push(`line ${i + 1}: expected "name: prompt" with a name of letters, digits, - or _`)
      return
    }
    if (seen.has(name)) {
      problems.push(`line ${i + 1}: /${name} is defined twice; the first one is used`)
      return
    }
    seen.add(name)
    templates.push({ name, template })
  })
  return { templates, problems }
}

/** Fill a template's placeholders. */
export function fill(template, args, projectPath) {
  const typed = String(args ?? '').trim()
  const project = projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '' : ''
  let usedArgs = false
  let text = template.replace(/\{\{\s*(args|project)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback) => {
    if (key === 'project') return project
    usedArgs = true
    return typed || (fallback ?? '').trim()
  })
  if (!usedArgs && typed) text += `\n\n${typed}`
  // An empty {{args}} can leave doubled or trailing spaces behind.
  return text.replace(/[ \t]{2,}/g, ' ').trim()
}

/** The palette description: the template's start, placeholders shown as written. */
function describe(template) {
  const flat = template.replace(/\s+/g, ' ')
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

export function activate(mango) {
  let registered = []

  const unregister = () => {
    for (const d of registered) {
      try { d.dispose() } catch { /* already gone with the plugin */ }
    }
    registered = []
  }

  const register = () => {
    unregister()
    let parsed
    try {
      parsed = parseTemplates(mango.settings.get('templates'))
    } catch (e) {
      mango.log.error('Could not read the templates setting:', e)
      return
    }
    for (const problem of parsed.problems) mango.log.warn(problem)
    for (const { name, template } of parsed.templates) {
      try {
        registered.push(mango.chat.slashCommands.register({
          name,
          description: describe(template),
          argumentHint: /\{\{\s*args/.test(template) ? '[text]' : '',
          // Returning the text makes Mango send it in place of the typed command.
          run: ({ args, projectPath }) => fill(template, args, projectPath),
        }))
      } catch (e) {
        mango.log.error(`Could not register /${name}:`, e)
      }
    }
    mango.log.info(`${registered.length} template${registered.length === 1 ? '' : 's'} registered`)
  }

  register()
  mango.settings.onChange(key => {
    if (key === 'templates') register()
  })
  mango.onDispose(unregister)
}
