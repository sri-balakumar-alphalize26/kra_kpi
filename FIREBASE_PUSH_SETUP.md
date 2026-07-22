# Push Notifications Setup — KRA KPI App (Firebase / FCM)

A plain-English guide to how push notifications were set up for the KRA KPI Android app,
and how to redo it if the Expo/EAS project ever changes. Keep this file for reference.

---

## What problem this solves

Notifications were only appearing inside the app's **bell icon**, but never as a **banner
on the phone** or in the **notification tray** — not even when the app was closed.

The reason: on Android, an app that is closed can **only** be woken by **Firebase Cloud
Messaging (FCM)** — Google's free notification-delivery service. The app had **no Firebase
setup at all**, so every notification the server sent was silently rejected with the error
`DeviceNotRegistered` ("the device is not registered with FCM").

**Important:** Odoo is still the backend that *decides* when and what to notify. Firebase is
only the *delivery pipe* that carries the notification onto the phone. We did not replace
Odoo — we simply gave it the missing delivery pipe.

---

## The two pieces you need

Push notifications need **two separate things**, and both must be in place:

| Piece | What it does | Where it lives |
|-------|--------------|----------------|
| **`google-services.json`** | Lets the phone **register** with Firebase (so it can *receive*) | Inside the app build (committed to git) |
| **Service-account private key** (`...firebase-adminsdk...json`) | Lets Expo/Odoo **send** notifications through Firebase | Uploaded to EAS only — **never** in git |

If either one is missing, notifications do not work.

---

## Step-by-step (what we did)

### Part 1 — Create the Firebase project (in a web browser)

1. Go to **https://console.firebase.google.com** and sign in with a Google account.
2. Click **Add project**, give it a name, and create it (Analytics can be skipped).
   - Our project is named **`kra-kpi-3efd5`**.
3. Inside the project, click the **Android** icon ("Add app → Android").
4. For the **Android package name**, enter exactly:
   ```
   com.alphalize.krakpi
   ```
   (This must match the `package` in `app.json`, or Firebase registration fails.)
5. Click **Register app**, then **Download `google-services.json`**.
6. Place that file in the project root:
   ```
   C:\Users\sriba\OneDrive\Desktop\KRA_KPI\google-services.json
   ```

### Part 2 — Get the private key (for sending)

7. In Firebase, open **Project settings** (the gear icon) → **Service accounts** tab.
8. Click **Generate new private key** — this downloads a JSON file, for example:
   ```
   kra-kpi-3efd5-firebase-adminsdk-fbsvc-188191ef3a.json
   ```
9. Place it in the project root as well. **This file is a secret** — treat it like a password.

### Part 3 — Point the app at the Firebase file

10. In **`app.json`**, under `expo.android`, add:
    ```json
    "googleServicesFile": "./google-services.json"
    ```

### Part 4 — Give Expo permission to send (EAS credentials)

11. In a terminal in the project folder, run:
    ```
    eas credentials
    ```
12. Choose: **Android** → the **production** build profile → **Google Service Account** →
    **"Google Service Account Key for Push Notifications (FCM V1)"**.
13. Choose **Set up a Google Service Account Key** and give it the path to the private key:
    ```
    ./kra-kpi-3efd5-firebase-adminsdk-fbsvc-188191ef3a.json
    ```
14. It uploads to EAS and then shows **"FCM V1 already set up."**
    - Do **not** use the **"Push Notifications (Legacy)"** option — Google shut that old
      system down in 2024. Always use the **FCM V1** (Google Service Account) path.

### Part 5 — Handle the files in git (the mistake we hit and fixed)

15. At first we hid **both** files with `.gitignore` to protect the secret. But the build then
    failed with:
    ```
    "google-services.json" is missing ... EAS Build only uploads the files tracked by git.
    ```
    Because EAS Build only uploads files that git is tracking, a hidden `google-services.json`
    never reached the build.

16. The correct setup:
    - **Commit `google-services.json`** — it is *not* a real secret (it ends up inside every
      installed APK anyway), so it is safe to keep in git.
    - **Never commit the private key** (`...firebase-adminsdk...json`) — it stays git-ignored
      and lives only in EAS.

    In `.gitignore`, keep only the private key ignored:
    ```
    *-firebase-adminsdk-*.json
    ```

### Part 6 — Build and install

17. Build the app (it now includes `google-services.json`):
    ```
    eas build -p android --profile production
    ```
18. When it finishes, **install the new APK** on the phone.
    - A plain code reload will **not** work — Firebase config is baked into the native build,
      so a fresh build + install is required.
19. Open the app, tap **Allow** on the notification permission prompt, and **log in**.
    - This registers a fresh, FCM-valid device token with the server.

### Part 7 — Verify it works

20. Trigger a real notification (for example, assign a task) — or ask the developer running the
    server to send a test push.
21. It should appear as a **banner and in the notification tray**, even with the app closed.
    - Technically: the delivery receipt from Expo changes from `DeviceNotRegistered` to `ok`.
      When it says `ok`, notifications are confirmed working.

---

## The golden rule

| File | Is it secret? | Goes in git? | Goes in EAS? |
|------|---------------|--------------|--------------|
| `google-services.json` | No (it's inside the APK anyway) | **Yes** | Not needed (arrives via git) |
| `...firebase-adminsdk...json` (private key) | **Yes** | **Never** | **Yes** (via `eas credentials`) |

---

## Troubleshooting

- **Build fails: "google-services.json is missing"**
  The file is not committed to git. Commit it (`git add google-services.json`), then rebuild.
  Remember: EAS only uploads git-tracked files.

- **Notifications still only show in the bell, not on the phone**
  The app on the phone is the **old build** without Firebase. Build again and reinstall — the
  Firebase config only takes effect in a fresh native build.

- **Receipt says `DeviceNotRegistered`**
  The device is not registered with FCM. Confirm `google-services.json` is in the build
  (Part 3 + Part 5) and reinstall the newly built APK, then open the app and allow
  notifications so it re-registers.

- **The EAS project changed (new `projectId`)**
  Push credentials are tied to the EAS project. If the project changes, redo **Part 4**
  (upload the FCM V1 key again) for the new project, then rebuild.

- **Package name mismatch**
  The Android app in Firebase must use `com.alphalize.krakpi`, exactly matching `app.json`,
  or the phone cannot register with FCM.

---

*Both pieces (the Firebase file and the FCM V1 key) are in place. From here it is just:
build → install → open → allow notifications → verify.*
