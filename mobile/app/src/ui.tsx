// The app's look: a light and a dark palette, and the few pieces every
// screen is made of.
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { TextInputProps, ViewStyle } from 'react-native'

export interface Theme {
  bg: string
  card: string
  text: string
  muted: string
  line: string
  accent: string
  onAccent: string
  danger: string
  ok: string
  warn: string
  field: string
}

export const LIGHT: Theme = { bg: '#F4F2EE', card: '#FFFFFF', text: '#1C1B19', muted: '#6E6A63', line: '#E3DFD8', accent: '#2F5D50', onAccent: '#FFFFFF', danger: '#B3261E', ok: '#2E7D4F', warn: '#A86B00', field: '#F8F7F4' }
export const DARK: Theme = { bg: '#121211', card: '#1D1C1A', text: '#EDEAE4', muted: '#A39E95', line: '#2E2C29', accent: '#7FC4AE', onAccent: '#0F1F1A', danger: '#F2B8B5', ok: '#8FD3A8', warn: '#F0C060', field: '#171615' }

export const ThemeContext = createContext<Theme>(LIGHT)
export const useTheme = (): Theme => useContext(ThemeContext)

export function Card ({ children, style }: { children: ReactNode, style?: ViewStyle }): ReactNode {
  const t = useTheme()
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.line }, style]}>{children}</View>
}

export function Title ({ children }: { children: ReactNode }): ReactNode {
  return <Text style={[styles.title, { color: useTheme().text }]}>{children}</Text>
}

export function Section ({ title, count, children }: { title: string, count?: number, children: ReactNode }): ReactNode {
  const t = useTheme()
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: t.muted }]}>{title.toUpperCase()}{count !== undefined ? `  ${count}` : ''}</Text>
      {children}
    </View>
  )
}

export function Body ({ children, muted, mono, lines }: { children: ReactNode, muted?: boolean, mono?: boolean, lines?: number }): ReactNode {
  const t = useTheme()
  return <Text numberOfLines={lines} selectable style={[styles.body, { color: muted ? t.muted : t.text }, mono ? styles.mono : null]}>{children}</Text>
}

export function Small ({ children, color }: { children: ReactNode, color?: string }): ReactNode {
  return <Text style={[styles.small, { color: color ?? useTheme().muted }]}>{children}</Text>
}

export function Button ({ label, onPress, kind = 'primary', busy, disabled }: { label: string, onPress: () => void, kind?: 'primary' | 'plain' | 'danger', busy?: boolean, disabled?: boolean }): ReactNode {
  const t = useTheme()
  const fill = kind === 'primary' ? t.accent : 'transparent'
  const color = kind === 'primary' ? t.onAccent : kind === 'danger' ? t.danger : t.accent
  const off = disabled === true || busy === true
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: fill, borderColor: kind === 'primary' ? t.accent : t.line, opacity: off ? 0.5 : pressed ? 0.75 : 1 }]}
    >
      {busy === true ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{label}</Text>}
    </Pressable>
  )
}

export function Field (props: TextInputProps): ReactNode {
  const t = useTheme()
  return <TextInput placeholderTextColor={t.muted} {...props} style={[styles.field, { color: t.text, backgroundColor: t.field, borderColor: t.line }, props.multiline ? styles.multiline : null, props.style]} />
}

export function Row ({ children, gap = 8 }: { children: ReactNode, gap?: number }): ReactNode {
  return <View style={[styles.row, { gap }]}>{children}</View>
}

export function Chip ({ label, color }: { label: string, color?: string }): ReactNode {
  const t = useTheme()
  const c = color ?? t.muted
  return <Text style={[styles.chip, { color: c, borderColor: c }]}>{label}</Text>
}

export function Empty ({ children }: { children: ReactNode }): ReactNode {
  return <Text style={[styles.empty, { color: useTheme().muted }]}>{children}</Text>
}

export function Note ({ children, color }: { children: ReactNode, color: string }): ReactNode {
  return <View style={[styles.note, { borderColor: color }]}><Text style={[styles.body, { color }]}>{children}</Text></View>
}

// How long ago `at` was, briefly.
export function ago (at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 10, marginBottom: 10 },
  title: { fontSize: 26, fontWeight: '700', letterSpacing: -0.3 },
  section: { marginTop: 18 },
  sectionTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 0.8, marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 21 },
  mono: { fontFamily: 'monospace', fontSize: 13 },
  small: { fontSize: 12.5 },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44 },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  chip: { fontSize: 11.5, fontWeight: '600', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  empty: { fontSize: 14, paddingVertical: 6 },
  note: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4 }
})
