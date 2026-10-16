// lecturer.js — the lecturer's home page.
//   1. A form to create a new session (for one of THEIR modules).
//   2. A list of all their sessions, with buttons to start check-in
//      (the QR screen) or open the register.

import { db, collection, query, where, getDocs, addDoc } from "./firebase.js";
import { requireRole } from "./auth.js";
import { el, withIds, todayISO, formatDate } from "./util.js";
import { SESSION_TYPES } from "./sessions.js";

// Only lecturers may see this page.
const { user } = await requireRole("lecturer");

const form = document.getElementById("create-form");
const createMessage = document.getElementById("create-message");
const listMessage = document.getElementById("list-message");
const sessionTable = document.getElementById("session-table");
const sessionRows = document.getElementById("session-rows");

// ---------- Helpers ----------

// "lecture" → "Lecture"
function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function showCreateMessage(text, type) {
  createMessage.textContent = text;
  createMessage.className = `message ${type}`;
}

// ---------- Fill the form ----------

// The "Type" list: lecture / seminar / lab.
for (const type of SESSION_TYPES) {
  form.elements.type.append(el("option", { value: type, textContent: capitalise(type) }));
}

// Most sessions are created for today, so start with today's date.
form.elements.date.value = todayISO();

// The "Module" list: only the modules this lecturer teaches.
// (firestore.rules would refuse a session for someone else's module anyway.)
async function loadModules() {
  const snap = await getDocs(
    query(collection(db, "modules"), where("lecturerUid", "==", user.uid))
  );
  const modules = withIds(snap).sort((a, b) => a.code.localeCompare(b.code));

  for (const m of modules) {
    form.elements.moduleCode.append(
      el("option", { value: m.code, textContent: `${m.code} — ${m.title}` })
    );
  }

  if (modules.length === 0) {
    showCreateMessage("You don't teach any modules yet. Ask an admin to assign one to you.", "error");
    form.querySelector("button").disabled = true;
  }
}

// ---------- Create a session ----------

form.addEventListener("submit", async (e) => {
  e.preventDefault(); // stop the browser reloading the page
  const button = form.querySelector("button");

  // The fields must match firestore.rules exactly (no more, no less).
  const session = {
    moduleCode: form.elements.moduleCode.value,
    lecturerUid: user.uid,
    date: form.elements.date.value, // "2026-10-15"
    startTime: form.elements.startTime.value, // "09:00"
    room: form.elements.room.value.trim(),
    type: form.elements.type.value,
    status: "scheduled", // new sessions always start as "scheduled"
  };

  if (!session.room) {
    showCreateMessage("Please type a room.", "error");
    return;
  }

  button.disabled = true; // so a double-click can't create two sessions
  try {
    // addDoc gives the new session an automatic ID.
    await addDoc(collection(db, "sessions"), session);
    showCreateMessage(
      `Session created: ${session.moduleCode} on ${formatDate(session.date)} at ${session.startTime}.`,
      "success"
    );
    form.reset();
    form.elements.date.value = todayISO();
    await loadSessions();
  } catch (err) {
    showCreateMessage(`Could not create the session: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
});

// ---------- My sessions ----------

// One table row. The buttons depend on the session's status:
//   scheduled → "Start check-in"   open → "Show QR"   always → "Register"
function sessionRow(s) {
  const id = encodeURIComponent(s.id);
  const actions = el("div", { className: "actions" });

  if (s.status === "scheduled") {
    actions.append(el("a", { className: "button small", href: `/qr.html?id=${id}`, textContent: "Start check-in" }));
  } else if (s.status === "open") {
    actions.append(el("a", { className: "button small", href: `/qr.html?id=${id}`, textContent: "Show QR" }));
  }
  actions.append(
    el("a", { className: "button secondary small", href: `/session.html?id=${id}`, textContent: "Register" })
  );

  // Only "open" has a coloured badge; scheduled and closed use the plain one.
  const badge = el("span", { className: s.status === "open" ? "badge open" : "badge" }, capitalise(s.status));

  return el(
    "tr",
    {},
    el("td", {}, formatDate(s.date)),
    el("td", {}, s.startTime),
    el("td", {}, s.moduleCode),
    el("td", {}, capitalise(s.type)),
    el("td", {}, s.room),
    el("td", {}, badge),
    el("td", {}, actions)
  );
}

async function loadSessions() {
  // The rules only let a lecturer list sessions with this exact filter.
  const snap = await getDocs(
    query(collection(db, "sessions"), where("lecturerUid", "==", user.uid))
  );

  // Newest date first; on the same day, the later time first.
  // ("2026-10-15" text sorts in date order, and "09:00" in time order.)
  const sessions = withIds(snap).sort(
    (a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime)
  );

  sessionRows.replaceChildren(...sessions.map(sessionRow));
  sessionTable.classList.toggle("hidden", sessions.length === 0);
  listMessage.textContent = sessions.length === 0 ? "No sessions yet. Create one above." : "";
  listMessage.classList.toggle("hidden", sessions.length > 0);
}

// ---------- Start ----------

try {
  await Promise.all([loadModules(), loadSessions()]);
} catch (err) {
  listMessage.textContent = `Could not load your sessions: ${err.message}`;
  listMessage.className = "message error";
}
