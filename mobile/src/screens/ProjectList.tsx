import { useMemo } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { FolderGit2, FolderOpen } from 'lucide-react-native'
import type { Thread } from '~/types/chat'
import { space, useTheme } from '@/theme'
import { Banner, Button, EmptyState, ListRow, ListSection, RipenessDot, Spinner, dotStatus } from '@/ui'
import { projectsKey, useEnvs } from '@/state/envs'
import { useThreads } from '@/state/threads'
import { hasUnreadResult } from '~/types/chat'
import { chatCount, mostUrgent } from './names'
import { knownProjects } from './places'

/**
 * The projects of one environment instance: name, branch in mono, how many chats, and the dot of
 * its most urgent chat, so a glance says where something waits. Tapping opens the project. Besides
 * the repositories the scan finds, it lists every folder a chat already works in (the desktop opens
 * any folder), recently used first.
 */
export function ProjectList({ envId, instance, title = 'Projects', onRetry }: {
  envId: string
  instance: string
  title?: string
  onRetry?: () => void
}) {
  const t = useTheme()
  const router = useRouter()
  const key = projectsKey(envId, instance)
  const env = useEnvs(s => s.envs.find(e => e.id === envId) ?? null)
  const scanned = useEnvs(s => s.projects[key])
  const error = useEnvs(s => s.projectErrors[key])
  const threads = useThreads(s => s.threads)
  const fromScan = useMemo(() => new Set((scanned ?? []).map(p => p.path)), [scanned])
  const merged = useMemo(
    () => (env ? knownProjects([{ env, instance }], { [key]: scanned }, threads) : []),
    [env, instance, key, scanned, threads],
  )
  // Still loading only while neither the scan nor a chat names a project.
  const projects = scanned || merged.length ? merged : undefined

  // Top-level, unarchived chats per project path.
  const byPath = useMemo(() => {
    const m = new Map<string, Thread[]>()
    for (const th of Object.values(threads)) {
      if (th.archived || th.parentId) continue
      const list = m.get(th.projectPath)
      if (list) list.push(th)
      else m.set(th.projectPath, [th])
    }
    return m
  }, [threads])

  if (error && !projects) {
    return <Banner tone="error" title="Could not list the projects" message={error} action={onRetry ? <Button label="Try again" size="sm" onPress={onRetry} /> : undefined} />
  }
  if (!projects) {
    return <View style={{ paddingVertical: space[8], alignItems: 'center' }}><Spinner size={18} label="Loading projects" /></View>
  }
  if (!projects.length) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No projects here yet"
        body="Mango lists the git repositories in the agent's home folder, and every folder a chat works in. Start a chat in any folder with New chat."
      />
    )
  }
  return (
    <ListSection title={title} footer={error ? `Not refreshed: ${error}` : undefined}>
      {projects.map((p) => {
        const chats = byPath.get(p.path) ?? []
        const top = mostUrgent(chats)
        return (
          <ListRow
            key={p.path}
            title={p.name}
            subtitle={p.branch ?? (fromScan.has(p.path) ? 'Not a git repository' : undefined)}
            subtitleMono={!!p.branch}
            subtitleTone={p.branch ? 'subtle' : 'faint'}
            detail={chats.length ? String(chats.length) : undefined}
            leading={top
              ? <RipenessDot status={dotStatus(top)} unseen={hasUnreadResult(top) || top.status === 'waiting'} size={14} />
              : <FolderGit2 size={20} strokeWidth={1.75} color={t.colors.fgFaint} />}
            accessibilityHint={chatCount(chats.length)}
            onPress={() => router.push({ pathname: '/project', params: { path: p.path } })}
          />
        )
      })}
    </ListSection>
  )
}
