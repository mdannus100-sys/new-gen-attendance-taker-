# University Attendance (QR check-in)

Students check in to a lecture by scanning a QR code on the classroom screen.
The code changes every 15 seconds, so a photo of it can't be shared later.

Built with plain HTML, CSS and JavaScript + Firebase (Authentication, Firestore, Hosting).
Everything runs on the free **Spark** plan: security is enforced by Firestore security
rules, not Cloud Functions.

---

## 1. What you need

| Tool | Why | Get it |
|---|---|---|
| Node.js 20 or newer | runs the Firebase tools, seed script and tests | https://nodejs.org |
| Java 21 or newer | the Firestore emulator is a Java program | https://adoptium.net (Temurin 21 LTS) |
| A Firebase project | only needed to deploy | https://console.firebase.google.com |

Then, in this folder:

```
npm install
```

This installs the Firebase CLI (`firebase-tools`) into the project, so you run it with
`npx firebase ...` — no global install needed.

---

## 2. Run it on your computer

You need **two terminals**.

**Terminal 1 — start the emulators** (a fake Firebase that runs on your computer):

```
npm start
```

Wait for `All emulators ready`. The first run downloads the emulators (about 140 MB).
If that download times out on a slow connection, just run `npm start` again.

**Terminal 2 — load the sample data:**

```
npm run seed
```

Now open **http://localhost:5000**.

| Login (password `password123`) | Role |
|---|---|
| admin@uni.test | admin |
| lecturer1@uni.test | lecturer (CS101, CS102) |
| lecturer2@uni.test | lecturer (MA101) |
| student01@uni.test … student15@uni.test | students |

Useful to know:
- **Emulator UI:** http://localhost:4000 — see and edit users and data.
- The emulators forget everything when you stop them. Run `npm run seed` again after `npm start`.
- `npm run seed` always deletes everything first, so it's also a "reset" button.

### Try a full check-in on your phone (same Wi-Fi)

The QR code contains the address of the page it is shown on. `localhost` only works on the
laptop itself, so open the lecturer pages using your laptop's Wi-Fi address instead:

1. Run `ipconfig` and find your **IPv4 Address**, e.g. `192.168.1.23`.
2. On the laptop open `http://192.168.1.23:5000`, log in as `lecturer1@uni.test`,
   and start check-in for a session.
3. If Windows Firewall asks, allow access on **Private networks**.
4. Scan the QR code with your phone's camera and log in as e.g. `student01@uni.test`.

### Run the security rule tests

With the emulators running (`npm start`), in another terminal:

```
npm test
```

You should see `# pass 86` and `# fail 0`. The tests use their own project id
(`demo-rules-test`), so they never touch your sample data. The emulator window may print
"Multiple projectIds are not recommended" while they run — that is only a warning.

The emulator also prints a long `DatastoreException` message every time the rules **refuse**
a request. Many tests check that bad requests are refused, so lots of these are normal.

---

## 3. Deploy to Firebase Hosting

### One-time setup in the Firebase console

1. Create a project (the free Spark plan is enough).
2. **Build → Authentication → Get started →** enable **Email/Password**.
3. **Build → Firestore Database → Create database.** Choose a location near you.
   Start in **production mode** (our rules file replaces the default rules).
4. **Project settings (⚙) → General → Your apps →** click the **web** icon `</>`,
   register an app (no need for Firebase Hosting setup there), and copy the `firebaseConfig` values.
5. Paste them into the **live** part of [public/js/firebase.js](public/js/firebase.js)
   (replace the `PASTE_...` values). The `apiKey` is not a secret — it is safe in the browser;
   the security rules protect the data.

### Deploy

```
npx firebase login
npx firebase use --add          (choose your project, call it "default")
npx firebase deploy --only hosting,firestore:rules
```

Your app is now at `https://YOUR-PROJECT-ID.web.app` (HTTPS, so phones can open it).

`npm start` keeps using the offline `demo-attendance` project, so local testing still works.

### Make yourself the first admin

1. Open your live app and **sign up** like a normal student.
2. In the Firebase console go to **Firestore Database → users** and click the document
   with your email.
3. Click the `role` field, change `student` to `admin`, click **Update**.
4. Reload the app — you are now on the admin page. From there you can make other people
   lecturers or admins.

(The console can do this because you own the project; the security rules only apply to the app.)

---

## 4. How it works

### Files

```
firebase.json            Hosting + emulator settings
firestore.rules          security rules — the most important file
scripts/seed.js          sample data (emulators only)
tests/rules.test.js      security rule tests
public/                  the website (this is what gets deployed)
  index.html             log in / sign up
  lecturer.html          lecturer: my sessions + create a session
  qr.html                lecturer: full-screen rotating QR code
  session.html           lecturer: live register, manual marking
  checkin.html           student: the page the QR code opens
  student.html           student: my attendance and %
  admin.html             admin: modules, enrolments, roles, report, CSV
  css/style.css          shared styles
  js/firebase.js         starts Firebase (emulators when local)
  js/auth.js             login helpers + "only this role may see this page"
  js/stats.js            attendance % maths
  js/sessions.js         session helpers
  js/util.js             small helpers
```

### Firestore collections

| Collection | Document ID | Fields |
|---|---|---|
| users | uid | name, email, studentId, role (student / lecturer / admin) |
| modules | module code, e.g. CS101 | code, title, lecturerUid |
| enrolments | `CS101_<studentUid>` | studentUid, moduleCode |
| sessions | auto ID | moduleCode, lecturerUid, date, startTime, room, type, status (scheduled / open / closed) |
| sessionTokens | same ID as the session | current, currentAt, previous, previousAt — **lecturer only** |
| attendance | `<sessionId>_<studentUid>` | sessionId, studentUid, moduleCode, lecturerUid, status, checkedInAt, method (qr / manual), token |

**Attendance %** = sessions attended ÷ sessions held. A session counts as *held* once
check-in is closed. No attendance document means absent.

### The token check

1. Every 15 seconds the lecturer's QR screen makes a new random token and saves it in
   `sessionTokens/<sessionId>`, with the time taken from Google's server clock.
   The old token moves to `previous`.
2. The QR code links to `/checkin?s=<sessionId>&t=<token>`.
3. The student's phone writes `attendance/<sessionId>_<theirUid>` containing that token.
4. The **security rules** check the write: the student is writing for themselves, the session
   is open, they are enrolled, and the token equals `current` or `previous` and is less than
   30 seconds old.
5. Students can't read `sessionTokens` — only the rules engine reads it for them.
   Students can create their attendance once but never update it, so a second scan is refused.

### Known limits

- The rotating code stops screenshots being shared later. It can't stop a student in the room
  sending a live photo to a friend outside.
- If a lecturer forgets to press "Stop check-in", that session is not counted in anyone's %
  until it is closed.
