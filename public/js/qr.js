// qr.js — the check-in QR code, shown on the classroom projector.
//
// How QR check-in works:
//   - Every 15 seconds this page makes a new secret token and saves it in
//     sessionTokens/{sessionId}. The QR code is a link that contains the token.
//   - A student scans it. Their phone opens /checkin, which saves their
//     attendance together with the token.
//   - firestore.rules only accepts the newest token or the one before it,
//     and only for 30 seconds. So a photo of the QR code sent to a friend
//     at home soon stops working.

import {
  db,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  onSnapshot,
  collection,
  query,
  where,
  serverTimestamp,
} from "./firebase.js";
import { requireRole } from "./auth.js";
import { el, getParam } from "./util.js";
import { getSession, getModule, closeSession } from "./sessions.js";

// How often the QR code changes. The rules accept a token for 30 seconds,
// so a code that was just replaced still works for a short while.
const REFRESH_MS = 15000;

// Only lecturers may see this page.
const { user } = await requireRole("lecturer");

const sessionId = getParam("id");
const registerUrl = `/session.html?id=${encodeURIComponent(sessionId)}`;
let tokenRef = null; // sessionTokens/{sessionId}, set once the session is loaded

const notice = document.getElementById("notice");
const screen = document.getElementById("screen");
const qrBox = document.getElementById("qr-box");
const moduleName = document.getElementById("module-name");
const roomText = document.getElementById("room");
const countText = document.getElementById("count");
const warning = document.getElementById("warning");
const fullscreenButton = document.getElementById("fullscreen");
const stopButton = document.getElementById("stop");
const registerLink = document.getElementById("register-link");

// The token we last saved, exactly as the server stored it: { current, currentAt }.
// null at the start. The rules check that the next save's "previous" and
// "previousAt" are EXACTLY these values, so nobody can slip in an old token.
let lastSaved = null;
let timer = null; // the 15-second repeating timer
let saving = false; // true while a save is still on its way to the server
let closed = false; // true once check-in has stopped

// ---------- Messages ----------

// Show a message (and a link) instead of the QR screen.
function showNotice(text, linkText, href, isError) {
  notice.replaceChildren(
    el("p", { className: isError ? "message error" : "qr-notice-text" }, text),
    el("a", { className: "button", href, textContent: linkText })
  );
  screen.classList.add("hidden");
  notice.classList.remove("hidden");
}

function showWarning() {
  warning.textContent = "The QR code could not be updated. Trying again…";
}

// ---------- The secret token ----------

// 16 random bytes, written as base64url text (about 22 letters).
// crypto.getRandomValues is the browser's secure random generator —
// Math.random() is NOT safe for secrets because it can be predicted.
function makeToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // btoa() makes normal base64. base64url swaps "+" and "/" for "-" and "_"
  // and drops the "=" padding, so the token is safe inside a link.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------- Draw the QR code ----------

function drawQr(link) {
  // 0 = choose the size automatically. "M" = medium error correction,
  // so the code still scans if a bit of it is blurry on the projector.
  const qr = qrcode(0, "M");
  qr.addData(link);
  qr.make();

  // The library gives us SVG text: black squares on a white background,
  // with a 4-square white margin (scanners need this "quiet zone").
  // It only contains shapes, no text from the database. DOMParser turns
  // the text into a real element, so we don't need innerHTML.
  const svgText = qr.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
  const svg = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
  svg.setAttribute("aria-label", "QR code for check-in");
  qrBox.replaceChildren(svg);
}

// ---------- Make a new token, save it, then show it ----------

async function refreshToken() {
  if (closed) return;

  // The last save hasn't finished (slow or no internet). Don't start
  // another one, or they would arrive in the wrong order.
  if (saving) {
    showWarning();
    return;
  }

  saving = true;
  const token = makeToken();
  try {
    await setDoc(tokenRef, {
      current: token,
      currentAt: serverTimestamp(), // the server's clock, not the laptop's
      previous: lastSaved ? lastSaved.current : null,
      previousAt: lastSaved ? lastSaved.currentAt : null,
    });

    // Read it back to learn the exact time the server stored.
    // We need that exact value for "previousAt" next time.
    const saved = (await getDoc(tokenRef)).data();
    lastSaved = { current: saved.current, currentAt: saved.currentAt };

    // Only show the new code once it is saved. Otherwise students could
    // scan a code that the rules don't know about yet.
    if (!closed) {
      drawQr(`${location.origin}/checkin.html?s=${sessionId}&t=${token}`);
      warning.textContent = "";
    }
  } catch {
    // Keep showing the old QR code (it still works for a few seconds).
    // Next time, start a fresh chain with previous = null, which the
    // rules always accept while the session is open.
    lastSaved = null;
    if (!closed) showWarning();
  } finally {
    saving = false;
  }
}

// ---------- Live "12 / 30 checked in" ----------

async function watchCount(moduleCode) {
  // Everyone enrolled on the module could check in.
  const enrolments = await getDocs(
    query(collection(db, "enrolments"), where("moduleCode", "==", moduleCode))
  );
  const total = enrolments.size;

  // onSnapshot runs again every time an attendance record is added or
  // changed, so the number goes up live as students scan.
  // (The rules only let a lecturer list attendance with these two filters.)
  const attendanceQuery = query(
    collection(db, "attendance"),
    where("sessionId", "==", sessionId),
    where("lecturerUid", "==", user.uid)
  );
  onSnapshot(
    attendanceQuery,
    (snap) => {
      const present = snap.docs.filter((d) => d.data().status === "present").length;
      countText.textContent = `${present} / ${total} checked in`;
    },
    () => {
      countText.textContent = "Could not load the count.";
    }
  );
}

// ---------- Check-in has stopped ----------

function showClosed() {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  qrBox.replaceChildren(el("p", { className: "qr-closed" }, "Check-in closed"));
  warning.textContent = "";
  stopButton.classList.add("hidden");
  registerLink.classList.remove("hidden");
}

// Watch the session. If check-in is stopped somewhere else (e.g. in another
// tab), hide the QR code here too.
function watchSession() {
  onSnapshot(
    doc(db, "sessions", sessionId),
    (snap) => {
      if (snap.exists() && snap.data().status === "closed") showClosed();
    },
    () => {} // ignore errors; the token saves would show a warning anyway
  );
}

// ---------- Buttons ----------

// Full screen hides the browser's address bar and tabs.
fullscreenButton.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  fullscreenButton.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
});
// Some browsers (e.g. iPhone Safari) can't do full screen, so hide the button.
if (!document.fullscreenEnabled) fullscreenButton.classList.add("hidden");

stopButton.addEventListener("click", async () => {
  if (!confirm("Stop check-in? Students will no longer be able to scan the QR code.")) return;
  stopButton.disabled = true;
  try {
    // Closes the session AND deletes the secret token (see sessions.js).
    await closeSession(sessionId);
    location.href = registerUrl;
  } catch (err) {
    warning.textContent = `Could not stop check-in: ${err.message}`;
    stopButton.disabled = false;
  }
});

registerLink.href = registerUrl;

// ---------- Start ----------

async function start() {
  // Load the session. A broken link (e.g. no ?id=) counts as "not found".
  let session = null;
  try {
    session = sessionId ? await getSession(sessionId) : null;
  } catch {
    session = null;
  }

  // Only the session's own lecturer may show its QR code.
  // (The rules would refuse their token saves anyway.)
  if (!session || session.lecturerUid !== user.uid) {
    showNotice("This session doesn't exist, or it isn't one of yours.", "Back to my sessions", "/lecturer.html", true);
    return;
  }

  if (session.status === "closed") {
    showNotice("Check-in for this session is closed.", "Open the register", registerUrl, false);
    return;
  }

  try {
    // "Start check-in": scheduled → open. The rules only accept tokens
    // and student check-ins while the session is open.
    if (session.status === "scheduled") {
      await updateDoc(doc(db, "sessions", sessionId), { status: "open" });
    }

    const module = await getModule(session.moduleCode);
    moduleName.textContent = module ? `${session.moduleCode} — ${module.title}` : session.moduleCode;
    roomText.textContent = `Room ${session.room}`;
    screen.classList.remove("hidden");

    tokenRef = doc(db, "sessionTokens", sessionId);
    watchSession();
    watchCount(session.moduleCode).catch(() => {
      countText.textContent = "Could not load the count.";
    });

    // Make the first QR code now, then a new one every 15 seconds.
    refreshToken();
    timer = setInterval(refreshToken, REFRESH_MS);
  } catch (err) {
    showNotice(`Could not start check-in: ${err.message}`, "Back to my sessions", "/lecturer.html", true);
  }
}

start();
