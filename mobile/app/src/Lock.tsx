// The app acts as its person, so it opens only to them: the phone's own
// unlock (fingerprint, face, or its PIN), on opening and after a minute
// away. A phone with no screen lock can't, and is told so (Device tab).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import * as LocalAuthentication from 'expo-local-authentication'
import { lockWanted } from './secrets'
import { Body, Button, Note, Title, useTheme } from './ui'

// How long away before it locks again.
const AWAY = 60_000

// Whether the phone can verify its person at all.
export async function canLock (): Promise<boolean> {
  return (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE
}

export function Lock ({ children }: { children: ReactNode }): ReactNode {
  const t = useTheme()
  const [locked, setLocked] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const away = useRef<number | null>(null)
  // Whether it should lock on coming back: worked out on leaving, so the
  // cover goes up at once on return instead of after another async check.
  const wanted = useRef(false)

  const shouldLock = useCallback(async () => await lockWanted() && await canLock(), [])

  const unlock = useCallback(async () => {
    setError(null)
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock pai', disableDeviceFallback: false })
    if (r.success) setLocked(false)
    else if (r.error !== 'user_cancel' && r.error !== 'system_cancel' && r.error !== 'app_cancel') setError(`Couldn't unlock: ${r.error}`)
  }, [])

  useEffect(() => {
    shouldLock().then((on) => {
      wanted.current = on
      setLocked(on)
      if (on) unlock().catch(() => {})
    }, () => { setLocked(false) })
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        away.current = Date.now()
        shouldLock().then((on) => { wanted.current = on }, () => {})
      }
      if (state === 'active' && away.current !== null && Date.now() - away.current > AWAY && wanted.current) {
        away.current = null
        setLocked(true)
        unlock().catch(() => {})
      }
    })
    return () => { sub.remove() }
  }, [shouldLock, unlock])

  // The app stays mounted under the cover, so what was typed survives a
  // lock; until the first check says, it's covered.
  return (
    <View style={{ flex: 1 }}>
      {locked !== null && children}
      {locked !== false && (
        <View style={[StyleSheet.absoluteFill, styles.page, { backgroundColor: t.bg }]} accessibilityViewIsModal>
          {locked === true && (
            <>
              <Title>pai is locked</Title>
              <Body muted>It acts as you, so it opens only to you.</Body>
              <Button label='Unlock' onPress={() => { unlock().catch(() => {}) }} />
              {error !== null && <Note color={t.danger}>{error}</Note>}
            </>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 }
})
