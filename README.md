# 🦈 Shark Tank: website + Chrome extension

The Shark Tank has three parts:

- **A website** (hosted on GitHub Pages). Agents sign in with Google and press **Grab next ticket**. Admins manage the line.
- **Firebase** handles Google login and stores the queue. Its security rules enforce no cherry-picking and no duplicate grabs.
- **A Chrome extension** assigns the grabbed ticket to the agent in Zendesk, using the agent's **own Zendesk login**. It needs no API tokens and no Zendesk admin setup. It also adds a **🦈 Grab ticket** button inside Zendesk.

## How it works

1. An **admin** pastes ticket IDs into the Admin tab. New tickets go to the bottom of the line. Admins can reorder tickets (↑ ↓ Top) or remove them.
2. An **agent** clicks **🦈 Grab ticket**, either in Zendesk, from the extension icon, or on the website.
3. The website claims the ticket at the front of the line, in one atomic step:
   - Agents **can't see** the waiting list, only their own claims.
   - Agents can only take the **front** ticket.
   - If two agents click at the same moment, **only one gets it**. The other gets the next ticket.
4. The extension checks the ticket in Zendesk:
   - **Solved, closed, deleted, or already assigned:** it's marked *skipped* and the agent gets the next one automatically.
   - **Good:** it's **assigned to the agent**, tagged `shark_tank_claimed`, and given an internal note ("Claimed from the Shark Tank by Jane"), then opened in their Zendesk tab.
5. The ticket leaves the line and shows up in the **Log**: who, when and result. Admins can filter it, export it to CSV, and see per-agent counts.

**No extension installed?** The agent still gets the ticket (it's still removed from the line and logged), but as a link to assign themselves.

**Admins** can also pause the whole tank from Settings, and re-queue any ticket from the Log.

---

## Setup, step by step (~40 min)

### Step 1 · Create the Firebase project (5 min)

1. Go to **console.firebase.google.com** → **Create a project** → name it `shark-tank` → you can turn Google Analytics off → **Create**.
2. Make sure you're on the free **Spark** plan. Nothing in this setup needs billing.

### Step 2 · Turn on Google login (3 min)

1. **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable**. Pick a support email → **Save**.
3. **Settings → Authorized domains → Add domain**: `YOUR-GITHUB-USERNAME.github.io` (the domain GitHub Pages will give you in Step 5).

### Step 3 · Create the database + paste the rules (5 min)

1. **Build → Firestore Database → Create database** → choose **Production mode** → pick a location (e.g. `nam5 (us-central)`) → **Enable**.
2. Open `firestore.rules` in a text editor and edit the top section:
   - `adminEmails()`: **your** email and the **other admin's** email.
   - `companyAccount()`: the allowed Google domains (`bizee|incfile` is already filled in).
3. In Firestore, open the **Rules** tab, delete what's there, paste the whole file → **Publish**.

### Step 4 · Connect the website to Firebase (3 min)

1. **Project settings (⚙️) → General → Your apps → `</>` (Web)** → nickname `shark-tank-web` → **Register app**. Leave "Firebase Hosting" unticked.
2. Copy the `firebaseConfig` values into `website/config.js` → `FIREBASE_CONFIG`.
3. In the same file, set:
   - `ADMINS`: the same two emails as in the rules
   - `ALLOWED_DOMAINS`: e.g. `["bizee.com", "incfile.com"]`
   - `ZENDESK_HOST`: e.g. `bizee.zendesk.com`

> The Firebase `apiKey` is not a secret. It just identifies the project. The security rules are what protect the data.

### Step 5 · Put the website on GitHub Pages (5 min)

1. On GitHub, create a new repository called `shark-tank`.
2. Upload **the contents of the `website/` folder** to the repo root (`index.html`, `app.js`, `queue.js`, `config.js`, `style.css`).
3. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. After about a minute, the site is live at `https://YOUR-GITHUB-USERNAME.github.io/shark-tank/`.
   Make sure that domain is in Firebase's Authorized domains (Step 2.3).

> On a free GitHub account, Pages requires a public repo. That's fine: the code and config hold no secrets. If you'd rather keep it private, use a Bizee GitHub org with Pages enabled.

### Step 6 · Set up the Chrome extension (5 min)

1. In `extension/config.js`, set `SHARKTANK_SITE` to your Pages URL, e.g. `https://YOUR-GITHUB-USERNAME.github.io/shark-tank/`.
2. In `extension/manifest.json`, change the first `"matches"` entry to your domain: `"https://YOUR-GITHUB-USERNAME.github.io/*"`.
3. Open Chrome → `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** → select the `extension` folder.
4. You'll see the 🦈 icon, plus a **🦈 Grab ticket** button at the bottom-left of Zendesk.

**Rolling it out to the floor:**
- **Quick:** zip the `extension` folder, then on each PC unzip it and use **Load unpacked**. Chrome may show a "developer mode" reminder at startup.
- **Clean:** publish it to the Chrome Web Store as **Unlisted** or **Private** (one-time $5 developer fee). Your Google Workspace admin can then force-install it for everyone from the Admin console.

### Step 7 · First run + test (10 min)

1. Open the site and **sign in as an admin**. The first admin login creates the line automatically.
2. Go to **Admin → Queue** and paste 3 test tickets, including one solved ticket.
3. Go to the **Grab** tab and click **🦈 Grab next ticket** (with a Zendesk tab open). It should be assigned to you, opened in Zendesk, and moved to the Log.
4. The solved ticket should appear in the Log as `skipped: solved`, and you should get the next ticket automatically.
5. Have a second person sign in with a **non-admin** account. They should see only the Grab page, not the Admin tab.
6. Have two people click Grab at the same moment. They should get different tickets.
7. Try signing in with a personal Gmail account. It should be rejected.

---

## Day-to-day

| Who | Does what |
|---|---|
| Admins (2) | Paste tickets → Admin → Queue. Reorder or remove. Check History (who took what). Export CSV. Pause when needed. |
| Agents | Click **🦈 Grab ticket**. Work the ticket. Repeat. |

**Changing admins:** edit `adminEmails()` in `firestore.rules` (and re-publish), and `ADMINS` in `website/config.js` (and re-upload).

## Troubleshooting

| Problem | Fix |
|---|---|
| Sign-in popup errors with `auth/unauthorized-domain` | Add your github.io domain in Firebase → Authentication → Settings → Authorized domains. |
| "Missing or insufficient permissions" | The rules weren't published, or the admin email in the rules has a typo. |
| Pill says "Zendesk helper extension not detected" | The extension's `manifest.json` match doesn't match the site URL. Reload the extension after editing. |
| "you are not signed in to Zendesk as an agent" | Log in to Zendesk in the same Chrome profile. |
| "Zendesk refused the assignment" | The agent isn't in that ticket's Zendesk group. Ask a Zendesk admin to add them. |

## Tests

```bash
npm test             # offline simulation: 25 agents at once, removed tickets, pause, cherry-pick attempts
npm install && npm run test:rules   # runs the REAL firestore.rules in the Firebase emulator (needs Java)
```
