// seed.js — fills the LOCAL emulators with sample data.
//
// How to run (while "npm start" is running in another terminal):
//   npm run seed
//
// It deletes everything in the emulators first, so you can run it
// again any time to get a fresh start.
//
// It uses the Firebase Admin SDK. Admin code skips the security rules.
// That's fine here, because it only talks to the emulators on your computer.

// Tell the Admin SDK to use the emulators, NOT a real Firebase project.
// (This must happen before getAuth() / getFirestore() are called below.)
const PROJECT_ID = "demo-attendance";
const FIRESTORE_HOST = "127.0.0.1:8080";
const AUTH_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const db = getFirestore();

// Every sample account uses this password.
const PASSWORD = "password123";

// ---------- People ----------

const STAFF = [
  { uid: "admin1", name: "Alex Morgan", email: "admin@uni.test", role: "admin" },
  { uid: "lecturer1", name: "Dr Amina Khan", email: "lecturer1@uni.test", role: "lecturer" },
  { uid: "lecturer2", name: "Dr Tom Clarke", email: "lecturer2@uni.test", role: "lecturer" },
];

const STUDENT_NAMES = [
  "Aisha Begum", "Ben Carter", "Chloe Davies", "Daniel Evans", "Emily Foster",
  "Farhan Hussain", "Grace Hughes", "Harry Jones", "Isla King", "Jack Lewis",
  "Katie Morris", "Liam Patel", "Mia Roberts", "Noah Smith", "Olivia Taylor",
];

// student01 ... student15
const STUDENTS = STUDENT_NAMES.map((name, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    uid: `student${n}`,
    name,
    email: `student${n}@uni.test`,
    studentId: `S10${n}`,
    role: "student",
  };
});

// How likely each student is to turn up (default 95%).
// A few are low, so the admin report has someone below 80%.
const TURNOUT = { student03: 0.6, student08: 0.7, student14: 0.5 };

// ---------- Modules ----------
// "students" lists which student numbers are enrolled.

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const MODULES = [
  {
    code: "CS101", title: "Introduction to Programming", lecturerUid: "lecturer1",
    students: range(1, 12), startTime: "09:00", room: "A101", dayOffset: 0,
  },
  {
    code: "CS102", title: "Web Development", lecturerUid: "lecturer1",
    students: [...range(1, 6), 13, 14, 15], startTime: "11:00", room: "Lab 3", dayOffset: 1,
  },
  {
    code: "MA101", title: "Discrete Mathematics", lecturerUid: "lecturer2",
    students: range(4, 15), startTime: "14:00", room: "B204", dayOffset: 2,
  },
];

const PAST_WEEKS = 6; // closed sessions per module
const TYPES = ["lecture", "seminar", "lab"];

// ---------- Small helpers ----------

// A random number generator that gives the SAME numbers every run,
// so the sample data is always the same.
function makeRandom(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const random = makeRandom(42);

// Date as "YYYY-MM-DD" in local time.
function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Firestore allows max 500 writes per batch, so we write in chunks.
async function writeAll(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const { ref, data } of writes.slice(i, i + 400)) batch.set(ref, data);
    await batch.commit();
  }
}

// ---------- Main ----------

async function main() {
  // 1. Are the emulators running?
  try {
    await fetch(`http://${FIRESTORE_HOST}/`);
  } catch {
    console.error("Can't reach the emulators. Start them first with:  npm start");
    process.exit(1);
  }

  // 2. Delete everything (emulator-only endpoints).
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: "DELETE" });
  console.log("Cleared old data.");

  const writes = [];

  // 3. Accounts (Authentication) + profiles (users collection).
  for (const person of [...STAFF, ...STUDENTS]) {
    await auth.createUser({
      uid: person.uid,
      email: person.email,
      password: PASSWORD,
      displayName: person.name,
    });
    writes.push({
      ref: db.doc(`users/${person.uid}`),
      data: {
        name: person.name,
        email: person.email,
        studentId: person.studentId ?? "", // staff have no student ID
        role: person.role,
      },
    });
  }

  // 4. Modules, enrolments, sessions and attendance.
  let sessionCount = 0;
  let attendanceCount = 0;

  for (const mod of MODULES) {
    writes.push({
      ref: db.doc(`modules/${mod.code}`),
      data: { code: mod.code, title: mod.title, lecturerUid: mod.lecturerUid },
    });

    const enrolledUids = mod.students.map((n) => `student${String(n).padStart(2, "0")}`);

    // Enrolment ID = moduleCode_studentUid (so security rules can find it).
    for (const studentUid of enrolledUids) {
      writes.push({
        ref: db.doc(`enrolments/${mod.code}_${studentUid}`),
        data: { studentUid, moduleCode: mod.code },
      });
    }

    // Past sessions, one per week, all closed.
    for (let week = PAST_WEEKS; week >= 1; week--) {
      const date = isoDate(daysAgo(week * 7 + mod.dayOffset));
      const sessionRef = db.collection("sessions").doc(); // random ID
      writes.push({
        ref: sessionRef,
        data: {
          moduleCode: mod.code,
          lecturerUid: mod.lecturerUid,
          date,
          startTime: mod.startTime,
          room: mod.room,
          type: TYPES[week % TYPES.length],
          status: "closed",
        },
      });
      sessionCount++;

      // Who turned up? (No document = absent.)
      for (const studentUid of enrolledUids) {
        const chance = TURNOUT[studentUid] ?? 0.95;
        if (random() >= chance) continue;

        const minutesLate = Math.floor(random() * 10);
        const checkedIn = new Date(`${date}T${mod.startTime}:00`);
        checkedIn.setMinutes(checkedIn.getMinutes() + minutesLate);

        // Attendance ID = sessionId_studentUid (one per student per session).
        writes.push({
          ref: db.doc(`attendance/${sessionRef.id}_${studentUid}`),
          data: {
            sessionId: sessionRef.id,
            studentUid,
            moduleCode: mod.code,
            lecturerUid: mod.lecturerUid,
            status: "present",
            checkedInAt: Timestamp.fromDate(checkedIn),
            method: random() < 0.1 ? "manual" : "qr",
          },
        });
        attendanceCount++;
      }
    }
  }

  // 5. One session TODAY for each lecturer, not started yet,
  //    so you can try "Start check-in" straight away.
  for (const code of ["CS101", "MA101"]) {
    const mod = MODULES.find((m) => m.code === code);
    writes.push({
      ref: db.collection("sessions").doc(),
      data: {
        moduleCode: mod.code,
        lecturerUid: mod.lecturerUid,
        date: isoDate(new Date()),
        startTime: mod.startTime,
        room: mod.room,
        type: "lecture",
        status: "scheduled",
      },
    });
    sessionCount++;
  }

  await writeAll(writes);

  console.log(`Created ${STAFF.length + STUDENTS.length} users, ${MODULES.length} modules, ` +
    `${sessionCount} sessions, ${attendanceCount} attendance records.`);
  console.log(`\nLog in with any of these (password: ${PASSWORD}):`);
  console.log("  admin@uni.test        (admin)");
  console.log("  lecturer1@uni.test    (lecturer: CS101, CS102)");
  console.log("  lecturer2@uni.test    (lecturer: MA101)");
  console.log("  student01@uni.test ... student15@uni.test");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
