// student.js — the student's home page: my attendance in each module.
//
// What we load (the security rules only let a student read their OWN
// enrolments and attendance, so every query filters by my uid):
//   1. my enrolments         → which modules I am in
//   2. those modules         → their titles
//   3. their sessions        → which sessions have happened
//   4. my attendance records → which sessions I was present at
// Then we show one card per module with my % and a list of its sessions.

import { db, collection, query, where, getDocs } from "./firebase.js";
import { requireRole } from "./auth.js";
import { getModule } from "./sessions.js";
import { el, withIds, formatDate } from "./util.js";
import { LOW_ATTENDANCE_PERCENT, presentSet, moduleStats, formatPercent, isLow } from "./stats.js";

// Only students may see this page.
const { user } = await requireRole("student");

const modulesBox = document.getElementById("modules");
const note = document.getElementById("note");
const message = document.getElementById("message");

// ---------- Loading the data ----------

// Firestore's "in" filter accepts at most 30 values,
// so we split a long list into groups of 30.
function chunks(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

// All sessions of these modules: one query per group of 30 module codes.
async function loadSessions(codes) {
  const snapshots = await Promise.all(
    chunks(codes, 30).map((group) =>
      getDocs(query(collection(db, "sessions"), where("moduleCode", "in", group)))
    )
  );
  // Join the results of all the queries into one array.
  return snapshots.flatMap((snapshot) => withIds(snapshot));
}

async function loadEverything() {
  // 1. My enrolments. Sorting the codes puts the cards in order (CS101, CS102, MA101).
  const enrolments = withIds(
    await getDocs(query(collection(db, "enrolments"), where("studentUid", "==", user.uid)))
  );
  const codes = enrolments.map((e) => e.moduleCode).sort();

  if (codes.length === 0) {
    return { codes, modules: [], sessions: [], attendance: [] };
  }

  // 2, 3 and 4 don't depend on each other, so we start them all
  // at the same time and wait until every one has finished.
  const [modules, sessions, attendanceSnapshot] = await Promise.all([
    Promise.all(codes.map((code) => getModule(code))), // same order as codes
    loadSessions(codes),
    getDocs(query(collection(db, "attendance"), where("studentUid", "==", user.uid))),
  ]);

  return { codes, modules, sessions, attendance: withIds(attendanceSnapshot) };
}

// ---------- Showing the data ----------

// The coloured label on the right of each session.
function statusBadge(session, wasPresent) {
  if (session.status === "closed") {
    return wasPresent
      ? el("span", { className: "badge present" }, "Present")
      : el("span", { className: "badge absent" }, "Absent");
  }
  // The session is still open: check-in is happening right now,
  // so "not checked in yet" is not the same as absent.
  return wasPresent
    ? el("span", { className: "badge present" }, "Checked in")
    : el("span", { className: "badge" }, "In progress");
}

// One line in a module's list of sessions.
function sessionRow(session, present) {
  // presentSet() stores "sessionId_studentUid" (the attendance document ID).
  const wasPresent = present.has(`${session.id}_${user.uid}`);
  return el(
    "li",
    {},
    el(
      "span",
      {},
      el("span", { className: "when" }, formatDate(session.date)),
      el(
        "span",
        { className: "details muted" },
        `${session.startTime} · `,
        el("span", { className: "type" }, session.type)
      )
    ),
    statusBadge(session, wasPresent)
  );
}

// One card: module name, my %, and the list of its sessions.
function moduleCard(code, module, sessions, present) {
  // All the % maths lives in stats.js, so every page gets the same answer.
  const stats = moduleStats(user.uid, code, sessions, present);
  const low = isLow(stats.percent);

  // Sessions that have started ("open") or finished ("closed"), newest first.
  // "scheduled" sessions haven't happened yet, so we leave them out.
  // "2026-10-15 09:00" text sorts in time order, so we can compare the text.
  const shown = sessions
    .filter((s) => s.moduleCode === code && s.status !== "scheduled")
    .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`));

  return el(
    "section",
    { className: "card module" },
    // If the module was deleted, we still know its code.
    el("h2", {}, module ? `${code} — ${module.title}` : code),
    el("p", { className: low ? "percent low-text" : "percent" }, formatPercent(stats.percent)),
    low && el("p", { className: "low-text" }, `Below ${LOW_ATTENDANCE_PERCENT}%`),
    el("p", { className: "muted" }, `Attended ${stats.attended} of ${stats.held} sessions`),
    el("ul", { className: "sessions" }, ...shown.map((s) => sessionRow(s, present)))
  );
}

function render({ codes, modules, sessions, attendance }) {
  if (codes.length === 0) {
    modulesBox.replaceChildren(
      el(
        "p",
        { className: "card" },
        "You are not enrolled in any modules yet. " +
          "Once the university adds you to your modules, your attendance will appear here."
      )
    );
    return;
  }

  note.classList.remove("hidden");
  const present = presentSet(attendance);
  // codes and modules are in the same order, so modules[i] belongs to codes[i].
  modulesBox.replaceChildren(
    ...codes.map((code, i) => moduleCard(code, modules[i], sessions, present))
  );
}

// ---------- Start ----------

try {
  render(await loadEverything());
} catch (err) {
  console.error(err); // the details are for the developer, in the browser console
  modulesBox.replaceChildren();
  message.textContent = "Sorry, your attendance could not be loaded. Please refresh the page.";
}
