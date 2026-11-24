// This phone's keys (its device key pair and its group's keys: see
// ../worklet/src/node.ts's PhoneSecrets) live in the OS's key store
// (Keychain, Keystore), readable only while the phone is unlocked and
// never backed up or moved to another phone. pai's worklet gets them at
// start; nothing writes them to a file.
import * as SecureStore from 'expo-secure-store'
import type { PhoneSecrets } from './types'

const KEY = 'pai.secrets'
const LOCK = 'pai.lock'
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

export async function loadSecrets (): Promise<PhoneSecrets | null> {
  const raw = await SecureStore.getItemAsync(KEY, OPTS)
  return raw === null ? null : JSON.parse(raw) as PhoneSecrets
}

export async function saveSecrets (secrets: PhoneSecrets): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(secrets), OPTS)
}

export async function forgetSecrets (): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTS)
}

// Whether opening the app asks for the phone's unlock (on unless turned off).
export async function lockWanted (): Promise<boolean> {
  return (await SecureStore.getItemAsync(LOCK, OPTS)) !== 'off'
}

export async function setLockWanted (on: boolean): Promise<void> {
  await SecureStore.setItemAsync(LOCK, on ? 'on' : 'off', OPTS)
}
