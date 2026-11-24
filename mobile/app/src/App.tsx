import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { pai } from './worklet'
import type { FlowSummary, Inbox as InboxData, Job, Member, Status } from './types'
import { Join } from './Join'
import { Inbox, waiting } from './Inbox'
import type { Names } from './Inbox'
import { Flows, Jobs } from './Board'
import { Device } from './Device'
import { Lock } from './Lock'
import { Button, DARK, LIGHT, Note, Small, ThemeContext, useTheme } from './ui'
import { forgetSecrets } from './secrets'

type Tab = 'inbox' | 'jobs' | 'flows' | 'device'

export default function App (): ReactNode {
  const theme = useColorScheme() === 'dark' ? DARK : LIGHT
  return (
    <ThemeContext.Provider value={theme}>
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }} edges={['top', 'left', 'right']}>
          <StatusBar style={theme === DARK ? 'light' : 'dark'} />
          <Root />
        </SafeAreaView>
      </SafeAreaProvider>
    </ThemeContext.Provider>
  )
}

function Root (): ReactNode {
  const t = useTheme()
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(() => {
    setError(null)
    pai.init().then(setStatus, (err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => {
    start()
    return pai.onChange(setStatus)
  }, [start])

  // A start that fails every time (say, keys the OS can no longer read)
  // must not leave the app stuck: starting over forgets them.
  if (error !== null) {
    return (
      <View style={[styles.center, { gap: 12 }]}>
        <Note color={t.danger}>pai couldn’t start: {error}</Note>
        <Button label='Try again' onPress={start} />
        <Button kind='danger' label='Forget this phone’s keys and start over' onPress={() => {
          Alert.alert('Start over?', 'This phone forgets its keys and joins again from scratch. Remove the old device from a computer with pai device remove.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Start over', style: 'destructive', onPress: () => { forgetSecrets().finally(start) } }
          ])
        }} />
      </View>
    )
  }
  if (status === null) return <View style={styles.center}><Small>Starting pai…</Small></View>
  if (!status.joined) return <Join onJoined={setStatus} />
  return <Lock><Home status={status} onLeft={setStatus} /></Lock>
}

function Home ({ status: given, onLeft }: { status: Status, onLeft: (s: Status) => void }): ReactNode {
  const t = useTheme()
  const [tab, setTab] = useState<Tab>('inbox')
  const [inbox, setInbox] = useState<InboxData | null>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [flows, setFlows] = useState<FlowSummary[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  // Change events carry the status; a reload refreshes it too (peers come
  // and go without one).
  const [status, setStatus] = useState<Status>(given)
  useEffect(() => { setStatus(given) }, [given])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const [i, j, f, m, s] = await Promise.all([pai.inbox(), pai.jobs(), pai.flows(), pai.members(), pai.status()])
      setStatus(s)
      setInbox(i)
      setJobs(j)
      setFlows(f)
      setMembers(m)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  // The group changes in bursts (a sync is many): at most one reload per
  // 300 ms, the first soon after the first change, never put off longer.
  const soon = useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      load().catch(() => {})
    }, 300)
  }, [load])

  useEffect(() => {
    load().catch(() => {})
    const off = pai.onChange(soon)
    // Time moves things too (deadlines, a question's wait).
    const every = setInterval(soon, 15_000)
    return () => { off(); clearInterval(every); if (timer.current) clearTimeout(timer.current) }
  }, [load, soon])

  const names: Names = useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, m]))
    const of = (id: string): string => id === status.identity ? 'you' : byId.get(id)?.name ?? `${id.slice(0, 8)}…`
    return { of, target: (to) => to === null ? 'anyone' : to.startsWith('role:') ? to.slice(5) : of(to), groups: status.groups.map((g) => g.name) }
  }, [members, status.identity, status.groups])

  const count = waiting(inbox)

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { borderColor: t.line }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: t.text }]}>{members.find((m) => m.id === status.identity)?.name ?? status.name}</Text>
          <Small>on {status.name ?? 'this phone'} · {status.roles.filter((r) => r !== 'member').join(', ') || 'member'} · {status.groups.length === 1 ? `${status.members} in the group` : `${status.groups.length} groups`}</Small>
        </View>
        <View style={[styles.dot, { backgroundColor: !status.writable || status.peers === 0 ? t.warn : t.ok }]} />
        <Small>{!status.writable ? 'syncing' : status.peers === 0 ? 'connecting…' : `${status.peers} connected`}</Small>
      </View>
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load().finally(() => { setRefreshing(false) }) }} />}
        keyboardShouldPersistTaps='handled'
      >
        {status.problem !== null && <Note color={t.danger}>{status.problem}</Note>}
        {!status.running && (
          <View style={{ gap: 8, marginBottom: 8 }}>
            <Note color={t.warn}>pai isn’t running on this phone right now.</Note>
            <Button kind='plain' label='Start again' onPress={() => { pai.start().then(setStatus, (err: Error) => { setError(err.message) }) }} />
          </View>
        )}
        {error !== null && <Note color={t.danger}>{error}</Note>}
        {tab === 'inbox' && <Inbox data={inbox} names={names} refresh={soon} />}
        {tab === 'jobs' && <Jobs jobs={jobs} names={names} members={members} me={status.identity} after={soon} />}
        {tab === 'flows' && <Flows flows={flows} names={names} me={status.identity} after={soon} />}
        {tab === 'device' && <Device status={status} members={members} onLeft={onLeft} />}
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={[styles.tabs, { borderColor: t.line, backgroundColor: t.card }]}>
        <TabButton label='Inbox' badge={count} active={tab === 'inbox'} onPress={() => { setTab('inbox') }} />
        <TabButton label='Jobs' active={tab === 'jobs'} onPress={() => { setTab('jobs') }} />
        <TabButton label='Workflows' active={tab === 'flows'} onPress={() => { setTab('flows') }} />
        <TabButton label='Device' active={tab === 'device'} onPress={() => { setTab('device') }} />
      </SafeAreaView>
    </View>
  )
}

function TabButton ({ label, badge, active, onPress }: { label: string, badge?: number, active: boolean, onPress: () => void }): ReactNode {
  const t = useTheme()
  return (
    <Pressable onPress={onPress} style={styles.tab} accessibilityRole='tab' accessibilityState={{ selected: active }} accessibilityLabel={badge ? `${label}, ${badge} waiting` : label}>
      <Text style={[styles.tabText, { color: active ? t.accent : t.muted }]}>{label}</Text>
      {badge !== undefined && badge > 0 && <Text style={[styles.badge, { backgroundColor: t.accent, color: t.onAccent }]}>{badge}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { fontSize: 20, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  page: { padding: 16, paddingBottom: 40 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, flexDirection: 'row', gap: 6 },
  tabText: { fontSize: 14, fontWeight: '600' },
  badge: { fontSize: 11, fontWeight: '700', minWidth: 18, textAlign: 'center', borderRadius: 9, paddingHorizontal: 5, overflow: 'hidden' }
})
