// Before anything else, the phone joins its person's identity as one more
// device: a code from `pai device invite` on a device of theirs that's
// running.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { pai } from './worklet'
import type { Status } from './types'
import { Body, Button, Card, Field, Note, Small, Title, useTheme } from './ui'

export function Join ({ onJoined }: { onJoined: (status: Status) => void }): ReactNode {
  const t = useTheme()
  const [name, setName] = useState('phone')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function join (): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      onJoined(await pai.join(code.trim(), name.trim()))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps='handled'>
        <Title>pai</Title>
        <Body muted>Your agents ask you things, hand you jobs only a person should do, and wait on your approval. This phone is where you answer.</Body>

        <Card style={{ marginTop: 20 }}>
          <Text style={[styles.step, { color: t.text }]}>1. On a computer that runs your pai</Text>
          <Body mono>pai device invite</Body>
          <Small>It prints a code. Keep its daemon running while this phone joins.</Small>
        </Card>

        <Card>
          <Text style={[styles.step, { color: t.text }]}>2. Join as a device of yours</Text>
          <Field value={name} onChangeText={setName} placeholder='This phone’s name' autoCapitalize='none' accessibilityLabel='Phone name' />
          <Field value={code} onChangeText={setCode} placeholder='Device invite code' autoCapitalize='none' autoCorrect={false} multiline accessibilityLabel='Invite code' style={{ minHeight: 72 }} />
          <View style={styles.row}>
            <Button kind='plain' label='Paste' onPress={() => { Clipboard.getStringAsync().then((s) => { setCode(s.trim()) }, () => {}) }} />
            <Button label={busy ? 'Looking for your device…' : 'Join'} busy={busy} disabled={code.trim() === '' || name.trim() === ''} onPress={() => { join().catch(() => {}) }} />
          </View>
          {busy && <Small>Finding your other device over the network. This can take a minute.</Small>}
          {error !== null && <Note color={t.danger}>{error}</Note>}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  page: { padding: 20, paddingTop: 32, gap: 8 },
  step: { fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8 }
})
