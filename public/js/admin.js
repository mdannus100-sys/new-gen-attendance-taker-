// admin.js — the admin dashboard.
//
// Four tabs:
//   Modules     add, edit and delete modules
//   Enrolments  put students into a module, or take them out
//   Users       change someone's role (student / lecturer / admin)
//   Report      attendance % per student and per module, and a CSV download

import {
  db,
  doc,
  collection,
  query,
  where,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
} from "./firebase.js";
import { requireRole } from "./auth.js";
import { el, withIds, todayISO } from "./util.js";
import {
  LOW_ATTENDANCE_PERCENT,
  isHeld,
  presentSet,
  formatPercent,
  isLow,
  moduleStats,
  overallStats,
  moduleOverallStats,
} from "./stats.js";

// Only admins may see this page.
const { user } = await requireRole("admin");

const ROLES = ["student", "lecturer", "admin"];

// Same rule as firestore.rules: 2–12 capital letters or digits, e.g. CS101.
const CODE_PATTERN = /^[A-Z0-9]{2,12}$/;

// ---------- The data ----------
// We load every collection in full with getDocs when the page opens.
// That's fine for a university course (a few hundred students and a few
// thousand attendance records). For a whole university you would load
// less at once, e.g. only the module you are looking at.
const data = { users: [], modules: [], enrolments: [], sessions: [], attendance: [] };

// Load (or reload) some collections, e.g.  await load("modules", "enrolments");
async function load(...names) {
  await Promise.all(
    names.map(async (name) => {
      data[name] = withIds(await getDocs(collection(db, name)));
    })
  );
}

// ---------- Small helpers ----------

const message = document.getElementById("message");

function showMessage(text, type = "error") {
  message.textContent = text;
  message.className = `message ${type}`;
  // Scroll up to an error so it isn't missed. (Success needs no jump:
  // the table changing already shows it worked.)
  if (type === "error") message.scrollIntoView({ block: "nearest" });
}

function clearMessage() {
  message.textContent = "";
}

// Turn a Firebase error into plain English.
function errorText(err) {
  return err.code === "permission-denied"
    ? "The database refused this change (permission denied)."
    : err.message;
}

// For sort(): A → Z by name, or by module code.
const byName = (a, b) => a.name.localeCompare(b.name);
const byCode = (a, b) => a.code.localeCompare(b.code);

function findUser(uid) {
  return data.users.find((u) => u.id === uid);
}

function findModule(code) {
  return data.modules.find((m) => m.code === code);
}

function userName(uid) {
  return findUser(uid)?.name ?? "(unknown user)";
}

function usersWithRole(role) {
  return data.users.filter((u) => u.role === role).sort(byName);
}

function sortedModules() {
  return [...data.modules].sort(byCode);
}

// uids of the students in a module
function enrolledUids(moduleCode) {
  return data.enrolments.filter((e) => e.moduleCode === moduleCode).map((e) => e.studentUid);
}

// codes of the modules a student is in, A → Z
function enrolledCodes(studentUid) {
  return data.enrolments
    .filter((e) => e.studentUid === studentUid)
    .map((e) => e.moduleCode)
    .sort();
}

function sessionsOf(moduleCode) {
  return data.sessions.filter((s) => s.moduleCode === moduleCode);
}

// Rebuild a <select>'s options but keep the current choice (if it is still there).
function fillSelect(select, options) {
  const chosen = select.value;
  select.replaceChildren(...options);
  if (options.some((o) => o.value === chosen)) select.value = chosen;
}

// Draw every tab again from `data`. Cheap enough to do after each change.
function renderAll() {
  renderModules();
  renderEnrolments();
  renderUsers();
  renderReport();
}

// ---------- Tabs ----------

const tabButtons = document.querySelectorAll("#tabs button");

function showTab(name) {
  for (const button of tabButtons) {
    const active = button.dataset.tab === name;
    button.classList.toggle("secondary", !active);
    button.setAttribute("aria-pressed", active);
    document.getElementById(`tab-${button.dataset.tab}`).classList.toggle("hidden", !active);
  }
  clearMessage();
}

for (const button of tabButtons) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}

// ================= 1. Modules =================

const moduleForm = document.getElementById("module-form");
const moduleFormTitle = document.getElementById("module-form-title");
const moduleSubmit = moduleForm.querySelector("button[type=submit]");
const cancelEdit = document.getElementById("cancel-edit");

// The module being edited, or null when the form adds a new one.
let editingCode = null;

function renderModules() {
  // The lecturer drop-down lists everyone whose role is "lecturer".
  fillSelect(moduleForm.elements.lecturerUid, [
    el("option", { value: "", textContent: "Choose a lecturer" }),
    ...usersWithRole("lecturer").map((u) => el("option", { value: u.id, textContent: u.name })),
  ]);

  const rows = sortedModules().map((m) => {
    const sessions = sessionsOf(m.code);

    const deleteButton = el("button", {
      className: "small danger",
      textContent: "Delete",
      onclick: () => deleteModule(m),
    });
    // Sessions can never be deleted (see firestore.rules), so a module
    // with sessions must stay, or its sessions would point at nothing.
    if (sessions.length > 0) {
      deleteButton.disabled = true;
      deleteButton.title = "Can't delete: this module has sessions";
    }

    return el(
      "tr",
      {},
      el("td", {}, m.code),
      el("td", {}, m.title),
      el("td", {}, userName(m.lecturerUid)),
      el("td", { className: "num" }, enrolledUids(m.code).length),
      el("td", { className: "num" }, sessions.filter(isHeld).length),
      el(
        "td",
        {},
        el(
          "div",
          { className: "actions" },
          el("button", { className: "small secondary", textContent: "Edit", onclick: () => startEdit(m) }),
          deleteButton
        )
      )
    );
  });
  document.getElementById("modules-body").replaceChildren(...rows);
}

// "Edit": put the module into the form. The code is the document ID, so it can't change.
function startEdit(module) {
  clearMessage();
  editingCode = module.code;
  moduleForm.elements.code.value = module.code;
  moduleForm.elements.code.readOnly = true;
  moduleForm.elements.title.value = module.title;
  moduleForm.elements.lecturerUid.value = module.lecturerUid;
  moduleFormTitle.textContent = `Edit ${module.code}`;
  moduleSubmit.textContent = "Save changes";
  cancelEdit.classList.remove("hidden");
  moduleForm.elements.title.focus(); // also scrolls the form into view
}

// Back to "Add a module".
function stopEdit() {
  editingCode = null;
  moduleForm.reset();
  moduleForm.elements.code.readOnly = false;
  moduleFormTitle.textContent = "Add a module";
  moduleSubmit.textContent = "Add module";
  cancelEdit.classList.add("hidden");
}

cancelEdit.addEventListener("click", () => {
  stopEdit();
  clearMessage();
});

moduleForm.addEventListener("submit", async (e) => {
  e.preventDefault(); // stop the browser reloading the page
  clearMessage();
  const code = moduleForm.elements.code.value.trim();
  const title = moduleForm.elements.title.value.trim();
  const lecturerUid = moduleForm.elements.lecturerUid.value;

  // Check here first so the admin gets a clear message.
  // (The rules check the same things again on the server.)
  if (!CODE_PATTERN.test(code)) {
    showMessage("The module code must be 2–12 CAPITAL letters or digits, e.g. CS101.");
    return;
  }
  if (!title) {
    showMessage("Please enter a title.");
    return;
  }

  moduleSubmit.disabled = true;
  try {
    const ref = doc(db, "modules", code);
    if (editingCode) {
      // updateDoc fails if the module was deleted meanwhile (setDoc would bring it back).
      await updateDoc(ref, { code, title, lecturerUid });
      showMessage(`${code} saved.`, "success");
    } else {
      // The code is the document ID, and setDoc would quietly REPLACE an
      // existing module. So we check first — in the database, not in our
      // copy, in case another admin added it after this page loaded.
      const existing = await getDoc(ref);
      if (existing.exists()) {
        showMessage(`A module with the code ${code} already exists.`);
        return;
      }
      await setDoc(ref, { code, title, lecturerUid });
      showMessage(`${code} added.`, "success");
    }
    stopEdit();
    await load("modules");
    renderAll();
  } catch (err) {
    showMessage(errorText(err));
  } finally {
    moduleSubmit.disabled = false;
  }
});

async function deleteModule(module) {
  const count = enrolledUids(module.code).length;
  if (!confirm(`Delete ${module.code} "${module.title}"?\nIts ${count} enrolment(s) are deleted too.`)) {
    return;
  }
  clearMessage();
  try {
    // Check again in the database: a lecturer may have added a session
    // after this page loaded.
    const sessions = await getDocs(
      query(collection(db, "sessions"), where("moduleCode", "==", module.code))
    );
    if (!sessions.empty) {
      await load("sessions");
      renderAll();
      showMessage(`${module.code} has sessions, so it can't be deleted.`);
      return;
    }

    // One batch deletes the module AND its enrolments: either everything
    // is deleted or nothing is. (A batch takes up to 500 writes — plenty
    // for one module.)
    const enrolments = await getDocs(
      query(collection(db, "enrolments"), where("moduleCode", "==", module.code))
    );
    const batch = writeBatch(db);
    batch.delete(doc(db, "modules", module.code));
    enrolments.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    if (editingCode === module.code) stopEdit();
    await load("modules", "enrolments");
    renderAll();
    showMessage(`${module.code} deleted.`, "success");
  } catch (err) {
    showMessage(errorText(err));
  }
}

// ================= 2. Enrolments =================

const enrolModule = document.getElementById("enrol-module");
const enrolStudent = document.getElementById("enrol-student");
const enrolAdd = document.getElementById("enrol-add");

function renderEnrolments() {
  fillSelect(enrolModule, [
    el("option", { value: "", textContent: "Choose a module" }),
    ...sortedModules().map((m) => el("option", { value: m.code, textContent: `${m.code} · ${m.title}` })),
  ]);

  const code = enrolModule.value;
  document.getElementById("enrol-details").classList.toggle("hidden", !code);
  if (!code) return;

  // Who is in this module? (A user that no longer exists still gets a row,
  // so the enrolment can be removed.)
  const enrolled = enrolledUids(code)
    .map((uid) => findUser(uid) ?? { id: uid, name: "(unknown user)", studentId: "" })
    .sort(byName);

  const rows = enrolled.map((student) =>
    el(
      "tr",
      {},
      el("td", {}, student.name),
      el("td", {}, student.studentId),
      el(
        "td",
        { className: "num" },
        el("button", {
          className: "small danger",
          textContent: "Remove",
          onclick: (e) => removeEnrolment(code, student, e.target),
        })
      )
    )
  );
  document.getElementById("enrol-body").replaceChildren(...rows);
  document.getElementById("enrol-empty").classList.toggle("hidden", enrolled.length > 0);

  // The "Add student" list: students who are NOT in this module yet.
  const enrolledSet = new Set(enrolled.map((s) => s.id));
  const others = usersWithRole("student").filter((s) => !enrolledSet.has(s.id));
  fillSelect(
    enrolStudent,
    others.length > 0
      ? others.map((s) => el("option", { value: s.id, textContent: `${s.name} (${s.studentId})` }))
      : [el("option", { value: "", textContent: "Every student is already enrolled" })]
  );
  enrolAdd.disabled = others.length === 0;
}

// Choosing another module redraws the list.
enrolModule.addEventListener("change", () => {
  clearMessage();
  renderEnrolments();
});

enrolAdd.addEventListener("click", async () => {
  const moduleCode = enrolModule.value;
  const studentUid = enrolStudent.value;
  if (!moduleCode || !studentUid) return;

  clearMessage();
  enrolAdd.disabled = true;
  try {
    // The ID "CS101_uid" means a student can only be in a module once,
    // and lets the rules find an enrolment without searching.
    await setDoc(doc(db, "enrolments", `${moduleCode}_${studentUid}`), { studentUid, moduleCode });
    await load("enrolments");
    renderAll();
    showMessage(`${userName(studentUid)} added to ${moduleCode}.`, "success");
  } catch (err) {
    showMessage(errorText(err));
  } finally {
    enrolAdd.disabled = enrolStudent.value === "";
  }
});

async function removeEnrolment(moduleCode, student, button) {
  if (!confirm(`Remove ${student.name} from ${moduleCode}?`)) return;
  clearMessage();
  button.disabled = true;
  try {
    // Their old attendance records stay in the database (history is kept),
    // but the report only counts modules a student is enrolled in.
    await deleteDoc(doc(db, "enrolments", `${moduleCode}_${student.id}`));
    await load("enrolments");
    renderAll();
    showMessage(`${student.name} removed from ${moduleCode}.`, "success");
  } catch (err) {
    button.disabled = false;
    showMessage(errorText(err));
  }
}

// ================= 3. Users =================

function renderUsers() {
  const rows = [...data.users].sort(byName).map((person) => {
    const select = el(
      "select",
      {},
      ...ROLES.map((role) => el("option", { value: role, textContent: role }))
    );
    select.value = person.role;
    select.setAttribute("aria-label", `Role of ${person.name}`);
    const roleCell = el("td", {}, select);

    if (person.id === user.uid) {
      // The rules refuse this anyway: an admin could lock themselves out.
      select.disabled = true;
      roleCell.append(el("small", { className: "muted note" }, "You can't change your own role"));
    } else {
      select.addEventListener("change", () => changeRole(person, select));
    }

    return el(
      "tr",
      {},
      el("td", {}, person.name),
      el("td", {}, person.email),
      el("td", {}, person.studentId),
      roleCell
    );
  });
  document.getElementById("users-body").replaceChildren(...rows);
}

async function changeRole(person, select) {
  const newRole = select.value;
  if (!confirm(`Change ${person.name}'s role from ${person.role} to ${newRole}?`)) {
    select.value = person.role; // put the old role back
    return;
  }
  clearMessage();
  select.disabled = true;
  try {
    // The rules only let an admin change "role" — no other field.
    await updateDoc(doc(db, "users", person.id), { role: newRole });
    await load("users");
    renderAll(); // e.g. a new lecturer now appears in the lecturer list
    showMessage(`${person.name}'s role is now ${newRole}.`, "success");
  } catch (err) {
    select.value = person.role;
    select.disabled = false;
    showMessage(errorText(err));
  }
}

// ================= 4. Report =================
// All % maths comes from stats.js, so the student page shows the same numbers.

document.getElementById("low-legend").textContent =
  `Below ${LOW_ATTENDANCE_PERCENT}% is highlighted`;

// A table cell with a %, highlighted when it is below 80%.
function percentCell(percent) {
  return el("td", { className: isLow(percent) ? "num low" : "num" }, formatPercent(percent));
}

function renderReport() {
  const present = presentSet(data.attendance);
  const modules = sortedModules();

  // --- By student: one row per student, one column per module ---
  const head = el(
    "tr",
    {},
    el("th", {}, "Name"),
    el("th", {}, "Student ID"),
    ...modules.map((m) => el("th", { className: "num", title: m.title }, m.code)),
    el("th", { className: "num" }, "Overall")
  );

  const studentRows = usersWithRole("student").map((student) => {
    const codes = enrolledCodes(student.id);
    const moduleCells = modules.map((m) =>
      codes.includes(m.code)
        ? percentCell(moduleStats(student.id, m.code, data.sessions, present).percent)
        : el("td", { className: "num muted" }, "—") // not enrolled
    );
    const overall = overallStats(student.id, codes, data.sessions, present);
    return el(
      "tr",
      {},
      el("td", {}, student.name),
      el("td", {}, student.studentId),
      ...moduleCells,
      percentCell(overall.percent)
    );
  });

  document
    .getElementById("by-student")
    .replaceChildren(el("thead", {}, head), el("tbody", {}, ...studentRows));

  // --- By module ---
  const moduleRows = modules.map((m) => {
    const uids = enrolledUids(m.code);
    const stats = moduleOverallStats(m.code, uids, data.sessions, present);
    return el(
      "tr",
      {},
      el("td", {}, m.code),
      el("td", {}, m.title),
      el("td", { className: "num" }, uids.length),
      el("td", { className: "num" }, stats.sessionsHeld),
      el("td", { className: "num" }, formatPercent(stats.percent))
    );
  });
  document.getElementById("by-module").replaceChildren(...moduleRows);
}

// ---------- CSV export ----------

// Make one value safe to put in a CSV file.
function csvValue(value) {
  let text = String(value);
  // Excel and Google Sheets run a cell that starts with = + - @ as a
  // FORMULA. Someone could sign up with a name like "=HYPERLINK(...)" to
  // attack whoever opens the file ("CSV injection"). A ' in front makes
  // the spreadsheet show it as plain text instead.
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  // A value with a comma, a quote or a line break must be wrapped in
  // quotes, and each quote inside is written twice: She said "hi" → "She said ""hi"""
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

// One row per student per module they are enrolled in.
function buildCsv() {
  const present = presentSet(data.attendance);
  const rows = [
    [
      "Student ID",
      "Name",
      "Email",
      "Module code",
      "Module title",
      "Sessions held",
      "Sessions attended",
      "Attendance %",
      `Below ${LOW_ATTENDANCE_PERCENT}%`,
    ],
  ];

  for (const student of usersWithRole("student")) {
    for (const code of enrolledCodes(student.id)) {
      const stats = moduleStats(student.id, code, data.sessions, present);
      rows.push([
        student.studentId,
        student.name,
        student.email,
        code,
        findModule(code)?.title ?? "",
        stats.held,
        stats.attended,
        stats.percent ?? "", // empty when no session has been held yet
        isLow(stats.percent) ? "Yes" : "No",
      ]);
    }
  }

  // CSV lines end with \r\n (the official CSV format; Excel likes it).
  return rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
}

document.getElementById("export-csv").addEventListener("click", () => {
  // "\uFEFF" (an invisible mark called the BOM) at the start tells Excel the file is UTF-8,
  // so names like "Zoë" or "Łukasz" show correctly.
  const blob = new Blob(["\uFEFF" + buildCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  // A temporary link with "download" makes the browser save the file.
  const link = el("a", { href: url, download: `attendance-report-${todayISO()}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url); // free the memory
});

// ---------- Start ----------

try {
  await load("users", "modules", "enrolments", "sessions", "attendance");
  renderAll();
} catch (err) {
  showMessage(errorText(err));
}
