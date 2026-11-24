# pai on the phone

A phone app for the person in their groups' loops: questions agents ask
on jobs, jobs held for a person to do, proposals to approve, and the
boards and workflows to follow, from every group they're in. The phone is
another device of its person's identity (`pai device invite`, then the
code in the app), so it acts as them in all their groups, with no server
in between.

pai's core runs on the phone in a [Bare](https://github.com/holepunchto/bare)
worklet (react-native-bare-kit), the way Holepunch's own apps run
Hyperswarm and Autobase on mobile. The app (Expo, React Native) talks to
it over the worklet's IPC.

| Folder | What it is |
| --- | --- |
| `worklet/` | pai's core for Bare. `src/node.ts` is the phone's pai (`PhoneNode`: join, inbox, take, done or fail, answer, approve, workflows); `src/ipc.ts` serves it as newline-delimited JSON; `src/worklet.ts` is the entry. `scripts/build.mjs` bundles pai's source with its few Node built-ins mapped to Bare's (`node:crypto` to `src/shims/crypto.ts`, on sodium; `node:fs/promises` to bare-fs, with `src/shims/fs-promises.ts` making exclusive writes exclusive) and every package left external, so Bare resolves each package's own Bare build. |
| `app/` | The Expo app: `src/worklet.ts` starts the worklet and calls it; `src/App.tsx`, `Join.tsx`, `Inbox.tsx`, `Board.tsx` are the screens. `scripts/pack-worklet.mjs` packs the worklet per platform with bare-pack; `scripts/link-addons.mjs` builds its native addons into react-native-bare-kit. |

## Using it

1. On a computer that runs your pai daemon: `pai device invite`.
2. In the app: a name for the phone, the code, Join. The daemon has to be
   running while the phone joins (it hands the phone your identity), and
   then your groups, including ones you join later.
3. The Inbox tab shows what waits on you. Jobs for a role you have (say
   `approver`, from `pai group role`) or for your identity show up as open:
   take one, then Done with a result, Fail with why, or Give back. A
   workflow's approval step is such a job: the app reads which branches
   test its answer and offers them as buttons ("approved → publish",
   "Reject → rejected"), with a text box for anything else. A review step
   that repeats until it's approved shows where the other answers go
   ("Send → draft again").
4. Jobs: every group's board, and posting a job for a role or a member, in
   the group you pick (or cancel one of yours). Workflows: their steps,
   cancel one of yours, or run one again on new input. With more than one
   group, each item names its group.
5. Device: which device of whom this is, its groups, the lock, and leaving.

The app acts as you, so:

- **Keys** (this phone's device key pair, your identity's key and secret,
  and each group's keys) live in the OS's key store (Keychain, Keystore),
  readable only while the phone is unlocked and never backed up; pai's
  worklet gets them at start, hands the app the new set when a group is
  added, and writes no key files. The groups' data (their logs, which hold
  what the groups do) stays in the app's own storage, as the OS protects
  it.
- **Lock**: opening the app, and coming back after a minute, asks for the
  phone's unlock (fingerprint, face, or PIN). A phone with no screen lock
  can't, and the Device tab says so.
- **Leaving** removes this phone from your identity, once another of your
  devices has the removal (so one has to be running), then deletes its
  keys and data. If none is reachable, "Wipe this phone anyway" deletes
  them here; then remove it from a computer with `pai device remove`.

The phone runs pai only while the app is open. In the background,
react-native-bare-kit suspends the worklet; past a short grace period pai's
swarm winds down too (suspendify keeps quick switches from racing), and
on return it finds its devices again, which can take up to a minute: the
header says "connecting…" until it has. A job it holds keeps its lease
while the app runs, and goes back to the board if the lease lapses.

Android builds are 64-bit only (arm64, and x86_64 for emulators): some
of the worklet's native addons have no 32-bit build.

## Building

```sh
cd mobile/worklet && npm install
npm test --prefix ../..       # the shim, PhoneNode, and the worklet under Bare
cd ../app && npm install
npm run android:release        # packs the worklet, links and checks addons, builds, installs
```

`npm run android` is a debug build against Metro. Android needs the SDK
and NDK; iOS (`npm run ios`) needs Xcode. The worklet's tests run with
pai's (`npm test` at the root): the crypto shim against Node's, PhoneNode
against a DHT testnet, and the built worklet under bare-sidecar's Bare,
joined to a group over IPC as the app does.

## Releasing the app

The app builds with [EAS](https://docs.expo.dev/build/introduction/)
(`eas.json`): `eas build --platform android --profile preview` for an APK
to share, `--profile production` for the Play Store's app bundle (and the
same for `ios`, with an Apple developer account). EAS's post-install hook
installs pai and the worklet and packs it; on iOS the Podfile links the
addons (`app.config.js`). Before the first store release:

- Pick the real app id: `dev.pai.mobile` (app.json's `android.package`
  and `ios.bundleIdentifier`) is a placeholder, and can't change after.
- Let EAS make and keep the signing keys (`eas credentials`), or bring
  your own.
- The icons (`assets/`) are made by `python3 scripts/make-icons.py`.
- Bump `version` in app.json for each release.

`npm run e2e:android` runs the app on an attached device or emulator
against a daemon on this computer: it joins, takes a workflow's approval
step and answers it with the step's button, and checks the workflow
moved on.

