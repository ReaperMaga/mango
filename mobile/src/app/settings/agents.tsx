import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { CircleAlert, CircleCheck, CircleDashed, QrCode, Server } from 'lucide-react-native'
import { AGENTS, type AgentId } from '~/types/chat'
import type { AgentUsage } from '~/agents/types'
import { useTheme } from '@/theme'
import { AgentIcon, Banner, Button, EmptyState, ListRow, ListSection, Sheet, Spinner, haptic } from '@/ui'
import { readUsage } from '@/agents/usage'
import { backend } from '@/remote'
import type { AgentAuth } from '@/remote/auth'
import { useEnvs } from '@/state/envs'
import { SettingsPage } from '@/screens/settings/SettingsPage'
import { UsageGauge } from '@/screens/UsageGauge'
import { accountLine, resetText } from '@/screens/usageText'

/**
 * Agents: whether each agent CLI is signed in in an environment, and how much of its plan is
 * used. Read-only, as the CLIs report it (their status commands and usage report; no turn is run,
 * so nothing is spent). Signing in and out is the CLI's own flow, in Mango on a computer.
 */

interface Place { key: string; label: string; hostId: string; instance: string }

interface UsageState { loading: boolean; usage: AgentUsage | null; error: string | null }
const NO_USAGE: UsageState = { loading: false, usage: null, error: null }

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function AgentsScreen() {
  const t = useTheme()
  const router = useRouter()
  const envs = useEnvs(st => st.envs)
  const instances = useEnvs(st => st.instances)
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [auth, setAuth] = useState<AgentAuth[] | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [usage, setUsage] = useState<Partial<Record<AgentId, UsageState>>>({})
  const [refreshing, setRefreshing] = useState(false)
  const latest = useRef(0)

  // Where to look: every running instance (a joined environment is its one instance).
  const places = useMemo<Place[]>(() => envs.flatMap((e) => {
    if (e.joined) return [{ key: e.id, label: e.name, hostId: e.id, instance: e.joined.instance }]
    return (instances[e.id] ?? []).filter(i => i.state === 'running')
      .map(i => ({ key: `${e.id}/${i.name}`, label: `${e.name} · ${i.name}`, hostId: e.id, instance: i.name }))
  }), [envs, instances])
  const place = places.find(p => p.key === pickedKey) ?? places[0] ?? null

  // A server's instances are known once it has been opened; look them up when they are not.
  useEffect(() => {
    for (const e of envs) if (!e.joined && !useEnvs.getState().instances[e.id]) void useEnvs.getState().refresh(e.id).catch(() => {})
  }, [envs])

  const load = useCallback(async (p: Place | null) => {
    const run = ++latest.current
    setAuth(null)
    setAuthError(null)
    setUsage({})
    if (!p) return
    const env = useEnvs.getState().byId(p.hostId)
    if (!env) return
    let found: AgentAuth[]
    try {
      found = await backend.agentAuth(env, p.instance)
    } catch (e) {
      if (run === latest.current) setAuthError(messageOf(e))
      return
    }
    if (run !== latest.current) return
    setAuth(found)
    // Each signed-in agent's plan limits, side by side; a failure belongs to that agent only.
    for (const a of found.filter(x => x.installed && x.loggedIn)) {
      setUsage(u => ({ ...u, [a.agent]: { loading: true, usage: null, error: null } }))
      readUsage(a.agent, p.hostId, p.instance).then(
        (value) => { if (run === latest.current) setUsage(u => ({ ...u, [a.agent]: { loading: false, usage: value, error: null } })) },
        (e) => { if (run === latest.current) setUsage(u => ({ ...u, [a.agent]: { loading: false, usage: null, error: messageOf(e) } })) },
      )
    }
  }, [])

  const placeKey = place?.key ?? null
  useEffect(() => { void load(place) }, [placeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    setRefreshing(true)
    await load(place)
    setRefreshing(false)
  }

  if (!envs.length) {
    return (
      <SettingsPage id="agents">
        <EmptyState
          icon={Server}
          title="No environment yet"
          body="Agents run in an environment. Join one with a share code from Mango on your computer, then its agents show up here."
          action={<Button label="Join with a share code" icon={QrCode} onPress={() => router.push('/join')} />}
        />
      </SettingsPage>
    )
  }

  if (!place) {
    return (
      <SettingsPage id="agents">
        <EmptyState
          icon={CircleDashed}
          title="No running instance"
          body="An agent's sign-in lives in an environment's instance. Start one from Mango on your computer, or pull down to look again."
        />
      </SettingsPage>
    )
  }

  return (
    <SettingsPage id="agents" refreshing={refreshing} onRefresh={refresh}>
      {places.length > 1
        ? (
            <ListSection title="Environment" footer="Each environment keeps its own agent sign-ins.">
              <ListRow title={place.label} leading={<Server size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} onPress={() => setPicking(true)} />
            </ListSection>
          )
        : null}

      {authError ? <Banner tone="error" title="Could not check the agents" message={authError} action={<Button label="Try again" size="sm" onPress={() => void load(place)} />} /> : null}

      {!auth && !authError
        ? (
            <View style={{ alignItems: 'center', padding: 24 }}>
              <Spinner size={20} label="Checking the agents" />
            </View>
          )
        : null}

      {auth?.map(a => (
        <AgentSection
          key={a.agent}
          auth={a}
          usage={usage[a.agent] ?? NO_USAGE}
          onRetry={() => {
            setUsage(u => ({ ...u, [a.agent]: { loading: true, usage: null, error: null } }))
            readUsage(a.agent, place.hostId, place.instance).then(
              value => setUsage(u => ({ ...u, [a.agent]: { loading: false, usage: value, error: null } })),
              e => setUsage(u => ({ ...u, [a.agent]: { loading: false, usage: null, error: messageOf(e) } })),
            )
          }}
        />
      ))}

      {backend.real ? null : <Banner title="Simulated" message="This preview has no SSH connection: the sign-ins and usage numbers are made up." />}

      <Sheet visible={picking} onClose={() => setPicking(false)} title="Environment">
        <ListSection>
          {places.map(p => (
            <ListRow
              key={p.key}
              title={p.label}
              accessory={p.key === place.key ? 'check' : 'none'}
              onPress={() => { haptic('select'); setPickedKey(p.key); setPicking(false) }}
            />
          ))}
        </ListSection>
      </Sheet>
    </SettingsPage>
  )
}

/** One agent: its sign-in, then its plan's usage windows. */
function AgentSection({ auth, usage, onRetry }: { auth: AgentAuth; usage: UsageState; onRetry: () => void }) {
  const t = useTheme()
  const name = AGENTS[auth.agent].name
  const mark = <AgentIcon agent={auth.agent} size={20} color={t.colors.fgMuted} />

  if (!auth.installed) {
    return (
      <ListSection title={name} footer={`Install ${name} in this instance from Mango on your computer (Settings > Agents).`}>
        <ListRow title="Not installed" subtitleTone="faint" leading={mark} />
      </ListSection>
    )
  }
  if (!auth.loggedIn) {
    return (
      <ListSection title={name} footer="Sign in from Mango on your computer (Settings > Agents). Mango never handles the sign-in itself.">
        <ListRow
          title="Not signed in"
          subtitle={auth.detail && !/not logged in/i.test(auth.detail) ? auth.detail : undefined}
          leading={<CircleAlert size={20} strokeWidth={1.75} color={t.colors.ripeWaitingFg} />}
        />
      </ListSection>
    )
  }
  const windows = usage.usage?.windows ?? []
  return (
    <ListSection title={name} footer={usage.usage?.note}>
      <ListRow
        title="Signed in"
        subtitle={accountLine({ ...auth, plan: auth.plan ?? usage.usage?.plan ?? null }) || undefined}
        leading={<CircleCheck size={20} strokeWidth={1.75} color={t.colors.ripeDoneFg} />}
      />
      {usage.loading
        ? [<ListRow key="loading" leading={<View />} title="Reading usage" subtitleTone="faint" trailing={<Spinner size={16} label="Reading usage" />} />]
        : usage.error
          ? [<ListRow key="error" leading={<View />} title="Could not read usage" subtitle={usage.error} subtitleLines={3} subtitleTone="error" trailing={<Button label="Try again" size="sm" variant="ghost" onPress={onRetry} />} />]
          : windows.map(w => (
              <ListRow
                key={w.id}
                leading={<View />}
                title={w.label}
                subtitle={resetText(w.resetsAt) || undefined}
                trailing={<UsageGauge percent={w.percent} />}
              />
            ))}
    </ListSection>
  )
}
