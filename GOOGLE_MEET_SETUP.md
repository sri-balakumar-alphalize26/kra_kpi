# How to set up "auto Google Meet link" in 369Chats

**What it does:** you type a word (like `meet`) in a chat, and 369Chats instantly posts a real Google Meet
link that everyone in the chat can click and join. It's free.

To make this work, you give 369Chats permission to create meetings on ONE Google account (a "host" account).
You do this once. Below is every single step, from scratch.

**What you need first:** one Gmail account that will host the meetings (a company Gmail is best). Be logged
into it in your browser.

---

# PART 1 — Set it up on Google (do this once)

### Step 1 — Open Google Cloud
1. Go to **https://console.cloud.google.com**
2. If it asks, agree to the terms.

### Step 2 — Make a project
(A "project" is just a folder for your settings.)
1. At the top, click the **project dropdown** (says "Select a project").
2. Click **New Project**.
3. Name it anything, e.g. **369Chats Meet** → click **Create**.
4. Wait a few seconds, then make sure that project is selected at the top.

### Step 3 — Turn on the Calendar service
(Google Meet links are created through Google Calendar, so we switch it on.)
1. In the search bar at the top, type **Google Calendar API**.
2. Click it in the results.
3. Click the blue **Enable** button. Wait for it to finish.

### Step 4 — Fill the consent screen
(This is the "who is asking for permission" screen. We just fill in names.)
1. In the left menu, open **APIs & Services → OAuth consent screen** (in newer Google it may be called
   **Audience**).
2. Choose **External** → **Create**.
3. Fill:
   - **App name:** `369Chats`
   - **User support email:** pick your host Gmail
   - **Developer contact email:** type the same host Gmail
4. Keep clicking **Save and Continue** until it's done.
5. Find the **Test users** section → **Add users** → add your host Gmail → Save.

### Step 5 — (Recommended) Make it permanent
By default it works for only 7 days, then you'd have to reconnect. To avoid that:
1. Go to **OAuth consent screen** (or **Audience**) → find **Publishing status**.
2. Click **Publish app** → confirm **Go to production**.
- **This is NOT publishing to the Play Store.** Nothing goes to any app store. It only stops the 7-day limit.
- Later, when you connect, Google may show a scary "unverified app" page → click **Advanced → Go to
  369Chats**. That's normal and safe for your own account.
- (If you skip this step, it still works — you'll just reconnect about once a week.)

### Step 6 — Create the key (Client ID + Secret)
(This is the actual "key" 369Chats will use.)
1. Left menu → **APIs & Services → Credentials**.
2. Click **+ Create Credentials** (top) → **OAuth client ID**.
3. **Application type:** choose **Web application**  ← very important. Do **NOT** choose Android or iOS.
4. **Name:** `369Chats Web`.
5. Find **Authorized redirect URIs** → click **+ Add URI** → paste this exactly:
   ```
   http://localhost:8069/chat/gmeet/oauth/callback
   ```
6. Click **Create**.
7. A box pops up with **Client ID** and **Client secret** → **copy both** (keep them somewhere for a minute).

**Google side is done.**

---

# PART 2 — Put the key into 369Chats

1. Open **369Chats**.
2. Bottom-left: click **your photo/avatar** (the round icon at the bottom of the dark strip).
3. Tap **Google Meet**.
4. Paste your **Client ID** and **Client Secret** into the boxes.
5. Type the **trigger words** you want (separated by commas), e.g. `meet, send link`.
   (These are the words that create a meeting when you type them.)
6. Pick **where it works** (Groups & 1:1 / only groups / only 1:1) and **Admins only** on/off.
7. Click **Save settings**.
8. Click **Connect Google account** → sign in with your **host Gmail** → **Allow**
   (if the "unverified app" warning shows → **Advanced → Go to 369Chats**).
9. You'll come back and it should say **Connected ✓**.

---

# PART 3 — Use it
- In any chat, type one of your trigger words (like `meet`) and send → a **Google Meet card** appears. Tap
  it to join.
- Or tap the **+** next to the message box → **Video meeting**.
- Everyone in that chat is invited automatically, so they can **join straight away — nobody has to let them
  in**.

---

# If something goes wrong
- **"redirect_uri_mismatch" error while connecting** → the link in Google (Step 6.5) must be exactly
  `http://localhost:8069/chat/gmeet/oauth/callback`. Check for typos/extra slash.
- **Typing the word does nothing** → make sure the word is in your trigger list, you're an admin (if
  "admins only" is on), and the chat type matches your setting.
- **"Google Meet is not set up yet"** → you haven't clicked **Connect** yet.
- **Worked before, stopped after a week** → do Step 5 (Publish to production).
- **One person has to "ask to join"** → that person has no email saved in their user profile, so they
  weren't invited — add their Google email to their user.
