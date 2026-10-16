// session.js — one session: its details, the check-in buttons and the live register.
//
// Address: /session.html?id=SESSION_ID
// The lecturer sees every enrolled student as Present or Absent.
// The list updates by itself when a student scans the QR code,
// and the lecturer can mark anyone present or absent by hand
// (also after class, to fix the register).

import {
  db,
  doc,
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "./firebase.js";
import { requireRole, getProfile } from "./auth.js";
import { el, formatDate, formatTime, getParam } from "./util.js";
import { getSession, getModule, closeSession } from "./sessions.js";

// Only lecturers may see this page.
const { user } = await requireRole("lecturer");

const sessionId = getParam("id");

const message = document.getElementById("message");
const content = document.getElementById("content");
const titleEl = document.getElementById("title");
const detailsEl = document.getElementById("details");
const actionsEl = document.getElementById("actions");
const summaryEl = document.getElementById("summary");
const registerEl = document.getElementById("register");

// ---------- What the page knows ----------

let session = null; // the session document, kept up to date live
let students = []; // enrolled students: [{ uid, name, studentId }], sorted by name
let attendance = new Map(); // studentUid → attendance record (no record = absent)
const saving = new Set(); // studentUids whose button is waiting for the database

// Words shown to the lecturer for the values stored in the database.
const STATUS_LABEL = { scheduled: "Scheduled", open: "Check-in open", closed: "Closed" };
const TYPE_LABEL = { lecture: "Lecture", seminar: "Seminar", lab: "Lab" };
const METHOD_LABEL = { qr: "QR", manual: "Manual" };

// ---------- Helpers ----------

function showError(text) {
  message.textContent = text;
  message.className = "message error";
}

function clearMessage() {
  message.textContent = "";
}

// Turn Firebase error codes into plain English.
function friendlyError(err) {
  if (err.code === "permission-denied") return "You are not allowed to do that.";
  if (err.code === "unavailable") return "No connection. Check your internet and try again.";
  return err.message;
}

// ---------- Header: details and buttons ----------

function renderHeader() {
  const type = TYPE_LABEL[session.type] ?? session.type;
  // "open" gets a green badge; scheduled and closed use the plain grey one.
  const badgeClass = session.status === "open" ? "badge open" : "badge";

  detailsEl.replaceChildren(
    `${formatDate(session.date)} · ${session.startTime} · ${session.room} · ${type} `,
    el("span", { className: badgeClass }, STATUS_LABEL[session.status] ?? session.status)
  );
  renderActions();
}

// Which buttons to show depends on the status:
//   scheduled → "Start check-in"   open → "Show QR code" + "Stop check-in"   closed → none
function renderActions() {
  // The QR page opens check-in itself, so both links simply go there.
  const qrLink = `/qr.html?id=${encodeURIComponent(sessionId)}`;

  if (session.status === "scheduled") {
    actionsEl.replaceChildren(el("a", { className: "button", href: qrLink }, "Start check-in"));
  } else if (session.status === "open") {
    actionsEl.replaceChildren(
      el("a", { className: "button", href: qrLink }, "Show QR code"),
      el("button", { className: "danger", onclick: stopCheckIn }, "Stop check-in")
    );
  } else {
    actionsEl.replaceChildren(); // closed: nothing to start or stop
  }
}

async function stopCheckIn(event) {
  if (!confirm("Stop check-in? Students will no longer be able to scan the QR code.")) return;

  const button = event.currentTarget;
  button.disabled = true; // so it can't be clicked twice
  clearMessage();
  try {
    await closeSession(sessionId);
    // Nothing else to do: the live session listener below sees "closed"
    // and redraws the header without the buttons.
  } catch (err) {
    showError(`Could not stop check-in: ${friendlyError(err)}`);
    button.disabled = false;
  }
}

// ---------- The register ----------

// Load everyone enrolled in the module, with their name and student ID.
async function loadStudents(moduleCode) {
  const enrolments = await getDocs(
    query(collection(db, "enrolments"), where("moduleCode", "==", moduleCode))
  );
  const uids = enrolments.docs.map((d) => d.data().studentUid);

  // Ask for all the profiles at the same time instead of one after another.
  const profiles = await Promise.all(uids.map((uid) => getProfile(uid)));

  return uids
    .map((uid, i) => ({
      uid,
      name: profiles[i]?.name ?? uid, // fall back to the uid if the profile is missing
      studentId: profiles[i]?.studentId ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Draw the whole table again. It is called every time the attendance changes.
// (Rebuilding ~30 rows is instant, and much simpler than updating single cells.)
function renderRegister() {
  let present = 0;
  const rows = students.map((student) => {
    const record = attendance.get(student.uid);
    const isPresent = record?.status === "present";
    if (isPresent) present++;
    return registerRow(student, record, isPresent);
  });

  registerEl.replaceChildren(...rows);
  const absent = students.length - present;
  summaryEl.textContent = `Present ${present} · Absent ${absent} · ${students.length} enrolled`;
}

function registerRow(student, record, isPresent) {
  // Small grey note under the badge: how and when it was recorded, e.g. "QR 09:03".
  // A student with no record at all simply shows "Absent".
  const detail = record
    ? el(
        "span",
        { className: "muted status-detail" },
        `${METHOD_LABEL[record.method] ?? record.method} ${formatTime(record.checkedInAt)}`
      )
    : null;

  const button = el(
    "button",
    {
      className: isPresent ? "small secondary" : "small",
      disabled: saving.has(student.uid), // greyed out while saving
      onclick: () => mark(student, isPresent ? "absent" : "present"),
    },
    isPresent ? "Mark absent" : "Mark present"
  );

  return el(
    "tr",
    {},
    el("td", {}, student.name),
    el("td", {}, student.studentId),
    el(
      "td",
      {},
      el("span", { className: isPresent ? "badge present" : "badge absent" }, isPresent ? "Present" : "Absent"),
      detail
    ),
    el("td", { className: "action" }, button)
  );
}

// Mark one student present or absent by hand.
async function mark(student, status) {
  saving.add(student.uid);
  renderRegister(); // shows the button as disabled
  clearMessage();

  // Attendance IDs are "sessionId_studentUid", so there is only ever one per student.
  const ref = doc(db, "attendance", `${sessionId}_${student.uid}`);
  try {
    if (attendance.has(student.uid)) {
      // There is already a record (a QR scan or an earlier manual mark).
      // The rules only let us change these three fields.
      await updateDoc(ref, { status, method: "manual", checkedInAt: serverTimestamp() });
    } else {
      // No record yet: create one. The rules check that we send exactly these fields.
      await setDoc(ref, {
        sessionId,
        studentUid: student.uid,
        moduleCode: session.moduleCode,
        lecturerUid: user.uid,
        status,
        checkedInAt: serverTimestamp(),
        method: "manual",
      });
    }
    // No need to redraw the badge here: the live attendance listener does it.
  } catch (err) {
    showError(`Could not update ${student.name}: ${friendlyError(err)}`);
  } finally {
    saving.delete(student.uid);
    renderRegister();
  }
}

// ---------- Start ----------

async function start() {
  // 1. Is this a real session, and is it one of MINE?
  session = sessionId ? await getSession(sessionId) : null;
  if (!session || session.lecturerUid !== user.uid) {
    showError("Session not found, or it is not one of your sessions.");
    return;
  }

  // 2. Fill in the header and show the page.
  const module = await getModule(session.moduleCode);
  titleEl.textContent = module ? `${session.moduleCode} · ${module.title}` : session.moduleCode;
  renderHeader();
  content.classList.remove("hidden");

  // 3. Watch the session document, so the status and buttons change by
  //    themselves, e.g. when check-in is stopped from the QR screen.
  onSnapshot(
    doc(db, "sessions", sessionId),
    (snap) => {
      if (!snap.exists()) return;
      session = { id: snap.id, ...snap.data() };
      renderHeader();
    },
    (err) => showError(`Live updates stopped: ${friendlyError(err)}`)
  );

  // 4. Who should be here?
  students = await loadStudents(session.moduleCode);

  // 5. Who IS here? onSnapshot runs once now, then again every time
  //    a student scans the QR code or a mark is changed.
  //    (The rules only allow this exact query for lecturers.)
  const attendanceQuery = query(
    collection(db, "attendance"),
    where("sessionId", "==", sessionId),
    where("lecturerUid", "==", user.uid)
  );
  onSnapshot(
    attendanceQuery,
    (snapshot) => {
      attendance = new Map();
      for (const d of snapshot.docs) {
        // "estimate": right after a click, the server time isn't known yet.
        // Show the browser's guess instead of an empty time.
        const record = d.data({ serverTimestamps: "estimate" });
        attendance.set(record.studentUid, record);
      }
      renderRegister();
    },
    (err) => showError(`Live updates stopped: ${friendlyError(err)}`)
  );
}

start().catch((err) => showError(`Could not load the session: ${friendlyError(err)}`));
