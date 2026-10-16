// checkin.js — the page a student lands on after scanning the QR code.
//
// The QR code holds a link like  /checkin?s=SESSION_ID&t=TOKEN
//   s = which session (class) this is
//   t = a secret token that the lecturer's screen changes every 15 seconds
//
// This page checks a few things first so it can show a clear message,
// then writes the attendance document. The REAL protection is in
// firestore.rules: if the token is wrong or too old, the rules refuse
// the write, whatever this code does.

import { auth, db, doc, getDoc, setDoc, serverTimestamp } from "./firebase.js";
import { getProfile, HOME_PAGE, logOut } from "./auth.js";
import { getSession, getModule } from "./sessions.js";
import { el, formatDate, formatTime, getParam } from "./util.js";

const result = document.getElementById("result");
const myAttendance = document.getElementById("my-attendance");

// Read the session ID and the token from the address bar.
const sessionId = getParam("s");
const token = getParam("t");

// ---------- Helpers ----------

// The symbol shown in the circle at the top of the card.
const ICONS = { success: "✓", problem: "!", info: "i" };

/**
 * Fill the big result card.
 *   kind:  "success" (green), "problem" (red) or "info" (white)
 *   title: the big line of text
 *   extra: more lines or buttons, made with el()
 */
function showResult(kind, title, ...extra) {
  result.className = `card result ${kind}`;
  result.replaceChildren(
    el("div", { className: "icon", ariaHidden: "true" }, ICONS[kind]),
    el("h1", {}, title),
    ...extra,
  );
}

// A normal line of text inside the card.
function line(text) {
  return el("p", {}, text);
}

// "CS101 — Introduction to Programming" (just "CS101" if the module is missing).
function moduleName(session, module) {
  return module ? `${session.moduleCode} — ${module.title}` : session.moduleCode;
}

// Date, time and room of the session, shown under a successful check-in.
function sessionDetails(session) {
  return el("dl", { className: "details" },
    el("dt", {}, "Date"), el("dd", {}, formatDate(session.date)),
    el("dt", {}, "Time"), el("dd", {}, session.startTime),
    el("dt", {}, "Room"), el("dd", {}, session.room),
  );
}

// Take the token out of the address bar (without reloading the page).
// Otherwise pressing reload would try the same old token again.
function forgetToken() {
  const url = new URL(location.href);
  url.searchParams.delete("t");
  history.replaceState(null, "", url);
}

// ---------- The check-in itself ----------

async function checkIn(user) {
  // 1. Which session is this? Real session IDs are only letters and digits,
  //    so anything else (e.g. a broken link) can't be a session.
  const session = /^[A-Za-z0-9]+$/.test(sessionId) ? await getSession(sessionId) : null;
  if (!session) {
    showResult("problem", "This QR code isn't valid.");
    return;
  }

  // 2. Load the module, so we can show its title and not just "CS101".
  const name = moduleName(session, await getModule(session.moduleCode));

  // 3. The lecturer must have started check-in (status "open").
  if (session.status !== "open") {
    showResult("problem", `Check-in for ${name} is closed.`);
    return;
  }

  // 4. Are you on this module? Enrolment IDs are "moduleCode_studentUid".
  const enrolment = await getDoc(doc(db, "enrolments", `${session.moduleCode}_${user.uid}`));
  if (!enrolment.exists()) {
    showResult("problem", `You are not enrolled in ${name}.`);
    return;
  }

  // 5. Is there already an attendance record for you in this session?
  //    The ID is "sessionId_studentUid", so there can only ever be one.
  const attendanceRef = doc(db, "attendance", `${session.id}_${user.uid}`);
  const existing = await getDoc(attendanceRef);
  if (existing.exists()) {
    const record = existing.data();
    if (record.status === "present") {
      showResult("success", `You are already checked in to ${name} ✓`,
        line(`Checked in at ${formatTime(record.checkedInAt)}`));
    } else {
      // The lecturer marked you absent by hand. Students can't change that.
      showResult("problem",
        "Your lecturer has already recorded your attendance for this session.",
        line("Please speak to them."));
    }
    return;
  }

  // 6. Write the attendance record. These must be EXACTLY the fields the
  //    rules expect. The rules also check the token is still valid.
  try {
    await setDoc(attendanceRef, {
      sessionId: session.id,
      studentUid: user.uid,
      moduleCode: session.moduleCode,   // copied from the session...
      lecturerUid: session.lecturerUid, // ...the rules check they match
      status: "present",
      checkedInAt: serverTimestamp(),   // the server's clock, not the phone's
      method: "qr",
      token,
    });
  } catch (err) {
    // We already checked everything else above, so if the rules say no,
    // it is almost always because the token is more than 30 seconds old.
    if (err.code === "permission-denied") {
      showResult("problem", "This QR code has expired.",
        line("Please scan the code on the screen again."));
      return;
    }
    throw err; // any other error is handled at the bottom of this file
  }

  // 7. Done!
  showResult("success", `You are checked in to ${name}`, sessionDetails(session));
}

// ---------- What to show a logged-in user ----------

async function showPageFor(user) {
  const profile = await getProfile(user.uid);
  document.body.classList.remove("pending"); // the page was hidden until now

  if (!profile) {
    showResult("problem", "Your account has no profile. Please contact an admin.");
    return;
  }

  // Fill the top bar, like the other pages do.
  document.getElementById("who").textContent = `${profile.name} · ${profile.role}`;

  if (profile.role !== "student") {
    showResult("problem", "Only students can check in.",
      el("a", { className: "button secondary", href: HOME_PAGE[profile.role] }, "Go to your home page"));
    return;
  }

  myAttendance.classList.remove("hidden");

  if (!sessionId || !token) {
    // Logged in, but no QR code in the link (e.g. just came back from the login page).
    showResult("info", "You're logged in ✓", line("Now scan the QR code on the screen again."));
    return;
  }

  await checkIn(user);
}

// ---------- Start ----------
// We don't use requireRole() here, because it would send a logged-out
// student away from this page. Instead we show them what to do.

await auth.authStateReady(); // wait until Firebase knows if someone is logged in
const user = auth.currentUser;

if (!user) {
  // Not logged in. We do NOT pass the token on to the login page: it will be
  // too old by the time they have typed their password. They scan again instead.
  showResult("info", "Please log in first.",
    line("After logging in, scan the QR code again — it changes every 15 seconds."),
    el("a", { className: "button", href: "/?next=checkin" }, "Log in"));
  document.body.classList.remove("pending");
} else {
  // Show "Log out" first, so it works even if something below goes wrong.
  const logoutButton = document.getElementById("logout");
  logoutButton.classList.remove("hidden");
  logoutButton.addEventListener("click", logOut);

  try {
    await showPageFor(user);
  } catch (err) {
    // e.g. no internet on the phone
    console.error(err); // details for the developer, in the browser console
    showResult("problem", "Something went wrong.",
      line("Check your internet connection and scan the QR code again."));
    document.body.classList.remove("pending"); // in case it failed before the page was shown
  }
}

// The attempt is over: take the token out of the address bar.
forgetToken();
