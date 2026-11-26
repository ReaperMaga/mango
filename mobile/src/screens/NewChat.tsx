import { useEffect, useMemo, useState } from 'react'
import { Switch, View } from 'react-native'
import { ArrowLeft, Folder, FolderGit2, FolderPlus } from 'lucide-react-native'
import { AGENTS, type AgentId } from '~/types/chat'
import { envPath, parseEnvPath } from '~/utils/envPath'
import { space, useTheme } from '@/theme'
import { AgentIcon, Banner, Button, ListRow, ListSection, Sheet, Spinner, TextField, haptic } from '@/ui'
import { backend } from '@/remote'
import { AGENT_HOME, validInstanceDir } from '@/remote/shell'
import { projectsKey, useEnvs } from '@/state/envs'
import { usePrefs } from '@/state/prefs'
import { MODE_SHORT, modeForProject } from '@/state/prefsModel'
import { useThreads } from '@/state/threads'
import { messageOf, placeOf, projectName } from './names'
import { knownProjects, placesOf, type Place } from './places'

type Step = 'project' | 'folder' | 'agent'

export interface NewChatSheetProps {
  visible: boolean
  onClose: () => void
  /** The new chat's id: open it. */
  onCreated: (id: string) => void
  /** Start in this project (the agent is all that's left to pick). */
  path?: string
  /** Offer only this environment's projects (and with `instance`, only that instance's). */
  envId?: string
  instance?: string
}

/**
 * Starting a chat from anywhere: pick the project (every project of every environment on this
 * phone, recently used first, or any folder in an instance), then the agent among those installed
 * there, and for a git repository whether the chat gets a worktree of its own. Opened from a
 * project, it skips straight to the agent.
 */
export function NewChatSheet({ visible, onClose, onCreated, path: fixed, envId, instance }: NewChatSheetProps) {
  const t = useTheme()
  const allEnvs = useEnvs(st => st.envs)
  const instances = useEnvs(st => st.instances)
  const scanned = useEnvs(st => st.projects)
  const threads = useThreads(st => st.threads)
  const [step, setStep] = useState<Step>('project')
  const [path, setPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const envs = useMemo(() => (envId ? allEnvs.filter(e => e.id === envId) : allEnvs), [allEnvs, envId])
  const places = useMemo(() => placesOf(envs, instances).filter(p => !instance || p.instance === instance), [envs, instances, instance])
  const projects = useMemo(() => knownProjects(places, scanned, threads), [places, scanned, threads])
  const several = envs.length > 1 || places.length > 1

  useEffect(() => {
    if (!visible) return
    setPath(fixed ?? null)
    setStep(fixed ? 'agent' : 'project')
    if (fixed) return
    // Fill in what this phone hasn't read yet: a server's instances, an instance's projects.
    const st = useEnvs.getState()
    const work: Promise<unknown>[] = []
    for (const e of envs) {
      if (e.joined) {
        if (!st.projects[`${e.id}/${e.joined.instance}`]) work.push(st.refreshProjects(e.id, e.joined.instance).catch(() => {}))
      } else if (!st.instances[e.id]) {
        work.push(st.refresh(e.id))
      }
    }
    if (!work.length) return
    let alive = true
    setLoading(true)
    void Promise.all(work).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [visible, fixed, envs])

  const pick = (p: string) => { setPath(p); setStep('agent') }
  const back = !fixed && step !== 'project'
    ? <Button label="Back" variant="ghost" size="sm" icon={ArrowLeft} onPress={() => setStep('project')} />
    : undefined

  return (
    <Sheet visible={visible} onClose={onClose} title={step === 'folder' ? 'Another folder' : 'New chat'} action={back}>
      {step === 'project'
        ? (
            !places.length
              ? loading
                ? <Loading label="Reading the environments" />
                : <Banner tone="info" title="Nowhere to run a chat" message={envs.length ? 'None of the instances is running. Start one from Mango on your computer, then pull to refresh.' : 'Join an environment first.'} />
              : (
                  <View style={{ gap: space[4] }}>
                    {projects.length
                      ? (
                          <ListSection title="Project">
                            {projects.map(p => (
                              <ListRow
                                key={p.path}
                                title={p.name}
                                subtitle={several ? placeOf(p.path, allEnvs.find(e => e.id === p.envId) ?? null) : (p.branch ?? undefined)}
                                subtitleMono={!several && !!p.branch}
                                leading={<Folder size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                                onPress={() => pick(p.path)}
                              />
                            ))}
                          </ListSection>
                        )
                      : loading ? <Loading label="Looking for projects" /> : null}
                    <ListSection footer={projects.length ? undefined : 'No git repositories were found under the agent\'s home. Pick the folder yourself.'}>
                      <ListRow
                        title="Another folder…"
                        leading={<FolderPlus size={20} strokeWidth={1.75} color={t.colors.accentInk} />}
                        onPress={() => setStep('folder')}
                      />
                    </ListSection>
                  </View>
                )
          )
        : step === 'folder'
          ? <FolderStep places={places} several={several} onPick={pick} />
          : path
            ? <AgentStep path={path} onCreated={onCreated} />
            : null}
    </Sheet>
  )
}

function Loading({ label }: { label: string }) {
  return <View style={{ paddingVertical: space[6], alignItems: 'center' }}><Spinner size={18} label={label} /></View>
}

/** Any folder in an instance, typed: the desktop opens folders that aren't repositories too. */
function FolderStep({ places, several, onPick }: { places: Place[]; several: boolean; onPick: (path: string) => void }) {
  const t = useTheme()
  const [at, setAt] = useState(0)
  const [dir, setDir] = useState(`${AGENT_HOME}/`)
  const [error, setError] = useState<string | null>(null)
  const place = places[Math.min(at, places.length - 1)]

  const go = () => {
    if (!place) return
    const folder = dir.trim().replace(/\/+$/, '') || '/'
    try {
      validInstanceDir(folder)
    } catch (e) {
      setError(messageOf(e))
      return
    }
    onPick(envPath({ hostId: place.env.id, instance: place.instance, dir: folder }))
  }

  return (
    <View style={{ gap: space[4] }}>
      {several
        ? (
            <ListSection title="Where">
              {places.map((p, i) => (
                <ListRow
                  key={`${p.env.id}/${p.instance}`}
                  title={p.env.joined ? p.env.name : p.instance}
                  subtitle={p.env.joined ? undefined : p.env.name}
                  accessory={i === at ? 'check' : 'none'}
                  onPress={() => setAt(i)}
                />
              ))}
            </ListSection>
          )
        : null}
      <TextField
        label="Folder"
        value={dir}
        onChangeText={(v) => { setDir(v); setError(null) }}
        mono
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        returnKeyType="next"
        onSubmitEditing={go}
        error={error}
        hint="An absolute path inside the environment. The agent starts there."
        placeholderTextColor={t.colors.fgFaint}
      />
      <Button label="Continue" variant="primary" block onPress={go} disabled={!place} />
    </View>
  )
}

/**
 * Pick the agent: the ones installed in the project's environment, each with its default model.
 * In a git repository the chat can also start in a new worktree (the desktop's "New chat in a
 * worktree"): its own folder and branch, made inside the environment when the first message goes.
 */
function AgentStep({ path, onCreated }: { path: string; onCreated: (id: string) => void }) {
  const t = useTheme()
  const [installed, setInstalled] = useState<AgentId[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inWorktree, setInWorktree] = useState(false)
  const loc = parseEnvPath(path)
  const envId = loc?.hostId
  const env = useEnvs(st => st.envs.find(e => e.id === envId) ?? null)
  // The scan finds only git repositories; a folder typed by hand is asked.
  const scanned = useEnvs(st => (loc ? st.projects[projectsKey(loc.hostId, loc.instance)]?.some(p => p.path === path) ?? false : false))
  const [checked, setChecked] = useState<boolean | null>(null)
  const repo = scanned || checked === true

  useEffect(() => {
    setChecked(null)
    setInWorktree(false)
    if (scanned) return
    let alive = true
    backend.gitState(path).then(s => { if (alive) setChecked(s.repo) }, () => { if (alive) setChecked(false) })
    return () => { alive = false }
  }, [path, scanned])

  useEffect(() => {
    const loc = parseEnvPath(path)
    if (!loc || !env) { setError("This project's environment is no longer on this phone."); return }
    let alive = true
    setError(null)
    setInstalled(null)
    backend.agentsInstalled(env, loc.instance).then(
      (list) => { if (alive) setInstalled(list) },
      (e) => { if (alive) setError(messageOf(e)) },
    )
    return () => { alive = false }
  }, [path, env])

  const defaultAgent = usePrefs(st => st.defaultAgent)
  const defaultMode = usePrefs(st => modeForProject(st, path))
  // The agent set in Settings comes first.
  const agents = (Object.keys(AGENTS) as AgentId[]).sort((a, b) => Number(b === defaultAgent) - Number(a === defaultAgent))
  return (
    <View style={{ gap: space[4] }}>
      <ListSection title="Project">
        <ListRow
          title={projectName(path)}
          subtitle={placeOf(path, env)}
          leading={<Folder size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
          accessory="none"
        />
      </ListSection>
      {repo
        ? (
            <ListSection footer="The branch is named from your first message. Other chats keep working in the project folder.">
              <ListRow
                title="New worktree"
                subtitle="Its own folder and branch"
                leading={<FolderGit2 size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                trailing={(
                  <Switch
                    value={inWorktree}
                    onValueChange={(on) => { haptic('select'); setInWorktree(on) }}
                    trackColor={{ false: t.colors.lineStrong, true: t.colors.accent }}
                    ios_backgroundColor={t.colors.lineStrong}
                    accessibilityLabel="Start in a new worktree"
                  />
                )}
              />
            </ListSection>
          )
        : null}
      {error
        ? <Banner tone="error" title="Could not check the agents" message={error} />
        : !installed
            ? <Loading label="Checking the agents" />
            : (
                <ListSection title="Agent" footer={installed.length ? 'Model and permissions can be changed in the chat; the defaults are in Settings.' : 'Install an agent in this environment from Mango on your computer (Settings > Agents).'}>
                  {agents.map((a) => {
                    const ok = installed.includes(a)
                    return (
                      <ListRow
                        key={a}
                        title={AGENTS[a].name}
                        subtitle={ok ? `${AGENTS[a].models[0]!.label} model · ${MODE_SHORT[defaultMode]}` : 'Not installed in this environment'}
                        subtitleTone={ok ? 'subtle' : 'faint'}
                        leading={<AgentIcon agent={a} size={20} color={t.colors.fgMuted} />}
                        detail={ok && a === defaultAgent ? 'Default' : undefined}
                        disabled={!ok}
                        onPress={ok ? () => onCreated(useThreads.getState().create({ projectPath: path, agent: a, mode: defaultMode, inWorktree: inWorktree && repo }).id) : undefined}
                      />
                    )
                  })}
                </ListSection>
              )}
    </View>
  )
}
