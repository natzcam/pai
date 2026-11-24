// This phone: which device of whom it is, its lock, and leaving.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Switch, View } from 'react-native'
import { pai } from './worklet'
import { lockWanted, setLockWanted } from './secrets'
import { canLock } from './Lock'
import type { Member, Status } from './types'
import { Body, Button, Card, Note, Row, Section, Small, useTheme } from './ui'

export function Device ({ status, members, onLeft }: { status: Status, members: Member[], onLeft: (s: Status) => void }): ReactNode {
  const t = useTheme()
  const [lock, setLock] = useState<boolean | null>(null)
  const [lockable, setLockable] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const me = members.find((m) => m.id === status.identity)

  useEffect(() => {
    lockWanted().then(setLock, () => { setLock(true) })
    canLock().then(setLockable, () => { setLockable(false) })
  }, [])

  function leave (): void {
    Alert.alert('Leave this identity?', 'This phone stops acting as you, and its pai data is deleted. One of your other devices has to be running.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          setBusy('leave')
          setError(null)
          pai.leave().then(onLeft, (err: Error) => { setError(err.message) }).finally(() => { setBusy(null) })
        }
      }
    ])
  }

  function wipe (): void {
    Alert.alert('Wipe this phone?', `Its keys and pai data are deleted here, but your identity still lists it: remove it from another device with\n\npai device remove ${status.device ?? ''}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Wipe', style: 'destructive', onPress: () => { pai.wipe().then(onLeft, (err: Error) => { setError(err.message) }) } }
    ])
  }

  return (
    <View>
      <Section title='This phone'>
        <Card>
          <Body>{status.name ?? 'phone'}</Body>
          <Small>A device of {me?.name ?? 'your identity'}{status.roles.length ? ` (${status.roles.join(', ')})` : ''}, in {status.groups.length === 0 ? 'no group yet (it gets them from your other devices)' : status.groups.map((g) => `${g.name} (${g.members})`).join(', ')}.</Small>
          <Small>Device</Small>
          <Body mono>{status.device ?? '…'}</Body>
          <Small>Identity</Small>
          <Body mono>{status.identity ?? '…'}</Body>
          <Small>{status.peers > 0 ? `Connected to ${status.peers} device${status.peers === 1 ? '' : 's'}` : 'Not connected to another device right now'}</Small>
        </Card>
      </Section>

      <Section title='Lock'>
        <Card>
          <Row>
            <View style={{ flex: 1 }}><Body>Ask for your unlock to open pai</Body></View>
            <Switch
              value={lock === true && lockable}
              disabled={!lockable || lock === null}
              onValueChange={(on) => { setLock(on); setLockWanted(on).catch(() => {}) }}
              accessibilityLabel='Ask for your unlock to open pai'
            />
          </Row>
          {!lockable && <Note color={t.warn}>This phone has no screen lock, so pai can’t lock either: anyone holding it can act as you. Set a screen lock in the phone’s settings.</Note>}
        </Card>
      </Section>

      <Section title='Leave'>
        <Card>
          <Small>Stop using this phone as you: it’s removed from your identity, and its keys and data are deleted.</Small>
          <Button kind='danger' label='Leave this identity' busy={busy === 'leave'} onPress={leave} />
          {error !== null && (
            <>
              <Note color={t.danger}>{error}</Note>
              <Button kind='plain' label='Wipe this phone anyway' onPress={wipe} />
            </>
          )}
        </Card>
      </Section>
    </View>
  )
}
