# Building the APK, and why the last one installed as a separate app

## The symptom

You install a new build and Android says **"App not installed"**, or it appears
as a second copy while the old one is still there and the old one's data is gone.

## The cause — it is NOT the package name

`com.alphalize.krakpi` has never changed. It is written in exactly three places,
all in agreement, in every commit of `app.json`:

- `app.json` → `android.package`
- `app.json` → `ios.bundleIdentifier`
- `google-services.json` → `package_name`

What changed is **who built it**. `app.json`'s `owner` + `extra.eas.projectId`
have moved across four different EAS accounts:

| Order | owner | projectId |
|---|---|---|
| 1 | `vacihe` | `c2b2bb46-279b-48ce-b697-5fbb5fec5a45` |
| 2 | `vavow` | `b561ec04-4631-4cc8-94d8-727416e9f359` |
| 3 | `vacihe` (back) | `c2b2bb46-…` |
| 4 | `vavow` (again) | `b561ec04-…` |
| 5 | `jicol` | `0a997e07-b838-4445-b1e9-2d381c617135` |
| 6 | `tajafiy` (current) | `7fd7b0cb-203d-4859-952e-58dbfa288ebe` |

`eas.json` does not set `credentialsSource`, so EAS defaults to **remote**: each
EAS project **generates its own Android keystore on its first build**.

Android identifies an app by *package name + signing certificate*. Same package,
different certificate = it is a different app as far as the OS is concerned, and
it refuses the in-place upgrade (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, which the
Samsung installer renders as "App not installed"). The only way through is
uninstall-then-install, which wipes the app's data.

There is a **second, independent** cause hiding behind the same symptom:
`appVersionSource: "remote"` makes `versionCode` a counter stored **per EAS
project**. A new project starts its own count, so a fresh build can carry a
*lower* versionCode than the one already on the device — which Android also
refuses.

## The fix

### Step 1 — one final uninstall (unavoidable)

Everyone on an old build uninstalls once. The old signing key lives in EAS
accounts that are no longer accessible, so there is no way to sign a new build
that the installed one will accept.

```bash
adb uninstall com.alphalize.krakpi
```

### Step 2 — pin the keystore so this cannot recur

This is the part that matters. Do it **once**, now, while `tajafiy/7fd7b0cb`
is still the configured project.

```bash
# 1. Log in as the owner named in app.json
eas login                      # account: tajafiy

# 2. Look at what is there. Record the SHA-256 fingerprint.
eas credentials -p android

# 3. Export the keystore: choose
#      Keystore: Manage everything needed to build your project
#      -> Download existing keystore
#    It writes the .jks plus the keystore/key passwords and the key alias.
```

Put the `.jks` somewhere **outside this repo and backed up** — a password
manager or the company drive. `*.jks` is gitignored (`.gitignore:19`) and must
stay that way; a signing key in git is a signing key in everyone's clone.

Then create `credentials.json` in the repo root (also gitignored — see below),
pointing at wherever you stored it:

```json
{
  "android": {
    "keystore": {
      "keystorePath": "C:/secure/krakpi-upload.jks",
      "keystorePassword": "…",
      "keyAlias": "…",
      "keyPassword": "…"
    }
  }
}
```

And add this to the `cli` block of `eas.json`:

```json
"credentialsSource": "local"
```

> Do **not** add `credentialsSource: "local"` before the keystore and
> `credentials.json` actually exist — every build fails immediately if it is set
> and the file is missing. That is why it is not already in `eas.json`.

From then on, moving to another EAS account changes nothing about signing, and
installed apps keep upgrading in place.

### Step 3 — make sure versionCode only goes up

```bash
# what is installed on the device right now
adb shell dumpsys package com.alphalize.krakpi | grep -a versionCode
```

The next build's versionCode must be **higher** than that. With
`appVersionSource: "remote"` the counter lives on the EAS server:

```bash
eas build:version:set -p android      # set it explicitly, above the installed value
```

## Building

`eas.json` now has three profiles, all producing an **installable APK**:

| Profile | What it is for |
|---|---|
| `development` | dev client + Metro. Needed for anything native — notifee alarms, the widget, cleartext HTTP. |
| `preview` | a normal standalone APK for testing |
| `production` | release APK |

```bash
eas build -p android --profile preview
eas build:run -p android --latest        # or: adb install -r <downloaded apk>
```

**`production` used to have no `distribution` key**, so it defaulted to `store`
and emitted an **AAB** — while `FIREBASE_PUSH_SETUP.md:113-115` instructed you to
build `production` and then "install the new APK". An AAB cannot be sideloaded,
so that instruction could never have worked. Both profiles are now explicit.

## What needs a rebuild, and what does not

There is **no `expo-updates`** in this project — no `runtimeVersion`, no updates
URL, no OTA channel. **Every change ships as a full APK install.** Nothing
updates itself over the air.

The app currently runs in **Expo Go**, where these are all silently inert:

| Feature | Why Expo Go can't run it |
|---|---|
| Task alarms (`@notifee/react-native`) | native module absent — `services/alarm.js:162` logs "schedule skipped — notifee unavailable (rebuild needed)" |
| Full-screen alarm over the lock screen | `plugins/withAlarmLockScreen.js` only applies at prebuild |
| `http://` to the Odoo server | works in Expo Go only because Expo Go's own manifest allows cleartext |
| FCM push | documented in `services/push.js:5-7` |
| The home-screen widget | `plugins/withTaskWidget.js`, prebuild only |

So the alarm-vs-notification sound separation **has never actually been heard on
a device**. It is verifiable only from a `development` or `preview` build.

## `credentials.json` must never be committed

It holds keystore passwords. Confirm it is ignored before your first commit
after creating it:

```bash
git check-ignore -v credentials.json
```
