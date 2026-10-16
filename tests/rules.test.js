// rules.test.js — automatic tests for firestore.rules.
//
// How to run:
//   1. In one terminal:     npm start     (starts the Firebase emulators)
//   2. In another terminal: npm test
//
// Each test pretends to be one user (a student, a lecturer, an admin, or
// nobody at all) and tries ONE read or write. Then we check the answer:
//   assertSucceeds(...)  → the rules MUST allow it
//   assertFails(...)     → the rules MUST refuse it
// Testing the "refuse" cases matters most: they prove a cheater can't
// get around the app by talking to the database directly.
//
// The tests use their OWN project id ("demo-rules-test"), so they never
// touch the app's sample data in "demo-attendance".
// Before EVERY test the test database is wiped and filled with the same
// small set of data (see addFixtures below), so tests can't affect each other.

import { readFileSync } from "node:fs";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc,
  collection,
  query,
  where,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
  setLogLevel,
} from "firebase/firestore";

// Firestore prints a long warning for every refused request. Half of these
// tests are refused on purpose, so hide the warnings to keep the output readable.
// (If a test fails, its error message still says which rule refused it.)
setLogLevel("error");

const EMULATOR_HOST = "127.0.0.1";
const EMULATOR_PORT = 8080;

// ---------- Is the emulator running? ----------
// Without it every test would fail with a confusing network error,
// so we check first and print a clear message instead.
async function emulatorIsRunning() {
  try {
    await fetch(`http://${EMULATOR_HOST}:${EMULATOR_PORT}/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

if (!(await emulatorIsRunning())) {
  console.error(
    `\nThe Firestore emulator is not running on ${EMULATOR_HOST}:${EMULATOR_PORT}.\n` +
      "Start the emulators first with npm start (in another terminal), then run npm test again.\n"
  );
  process.exit(1); // exit code 1 = "failed"
}

// ---------- Helpers ----------

let testEnv;

// A Firestore connection logged in as `uid`.
// We add an email because the users "create" rule compares it.
function dbAs(uid) {
  return testEnv.authenticatedContext(uid, { email: `${uid}@uni.test` }).firestore();
}

// A Firestore connection for someone who is NOT logged in.
function loggedOutDb() {
  return testEnv.unauthenticatedContext().firestore();
}

// Run `fn` with a connection that IGNORES the rules.
// Only used to set up test data, never inside the thing being tested.
async function withoutRules(fn) {
  await testEnv.withSecurityRulesDisabled((context) => fn(context.firestore()));
}

// A time `seconds` ago, as a Firestore Timestamp.
// (The emulator uses this computer's clock for request.time, so they match.)
function secondsAgo(seconds) {
  return Timestamp.fromMillis(Date.now() - seconds * 1000);
}

// ---------- Test data ----------
// The same small "university" is set up before every test:
//   admin1                an admin
//   lecturer1             teaches CS101
//   lecturer2             teaches MA101
//   student1, student2    students enrolled in CS101
//   student3              a student NOT enrolled in anything
// CS101 has one session in each status (all taught by lecturer1):
//   scheduledSession, openSession, closedSession
// Every session has a valid QR token (made just now), and closedSession
// already has two attendance records.

// Tokens are at least 16 characters, like the real random ones.
const CURRENT_TOKEN = "current-token-0123456789";
const PREVIOUS_TOKEN = "previous-token-0123456789";

// When the current token was made. The rotation tests need the exact value.
let tokenMadeAt;

function sessionData(status) {
  return {
    moduleCode: "CS101",
    lecturerUid: "lecturer1",
    date: "2026-10-15",
    startTime: "09:00",
    room: "B12",
    type: "lecture",
    status,
  };
}

async function addFixtures() {
  tokenMadeAt = Timestamp.fromMillis(Date.now());
  const freshTokens = {
    current: CURRENT_TOKEN,
    currentAt: tokenMadeAt,
    previous: PREVIOUS_TOKEN,
    previousAt: secondsAgo(10),
  };

  await withoutRules(async (db) => {
    // A batch saves everything in one go (faster than one write at a time).
    const batch = writeBatch(db);

    const people = [
      ["admin1", "Ada Admin", "", "admin"],
      ["lecturer1", "Lee Lecturer", "", "lecturer"],
      ["lecturer2", "Liz Lecturer", "", "lecturer"],
      ["student1", "Sam Student", "S001", "student"],
      ["student2", "Sara Student", "S002", "student"],
      ["student3", "Sid Student", "S003", "student"],
    ];
    for (const [uid, name, studentId, role] of people) {
      batch.set(doc(db, "users", uid), { name, email: `${uid}@uni.test`, studentId, role });
    }

    batch.set(doc(db, "modules/CS101"), { code: "CS101", title: "Programming", lecturerUid: "lecturer1" });
    batch.set(doc(db, "modules/MA101"), { code: "MA101", title: "Maths", lecturerUid: "lecturer2" });

    batch.set(doc(db, "enrolments/CS101_student1"), { studentUid: "student1", moduleCode: "CS101" });
    batch.set(doc(db, "enrolments/CS101_student2"), { studentUid: "student2", moduleCode: "CS101" });

    for (const status of ["scheduled", "open", "closed"]) {
      batch.set(doc(db, "sessions", `${status}Session`), sessionData(status));
      batch.set(doc(db, "sessionTokens", `${status}Session`), freshTokens);
    }

    batch.set(doc(db, "attendance/closedSession_student1"), {
      sessionId: "closedSession",
      studentUid: "student1",
      moduleCode: "CS101",
      lecturerUid: "lecturer1",
      status: "present",
      checkedInAt: secondsAgo(3600),
      method: "qr",
      token: "an-old-token-0123456789",
    });
    batch.set(doc(db, "attendance/closedSession_student2"), {
      sessionId: "closedSession",
      studentUid: "student2",
      moduleCode: "CS101",
      lecturerUid: "lecturer1",
      status: "absent",
      checkedInAt: secondsAgo(3600),
      method: "manual",
    });

    await batch.commit();
  });
}

// ---------- The tests ----------

describe("Firestore security rules", () => {
  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "demo-rules-test",
      firestore: {
        rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
        host: EMULATOR_HOST,
        port: EMULATOR_PORT,
      },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await addFixtures();
  });

  after(async () => {
    await testEnv?.cleanup();
  });

  // ================= users =================
  // Sign-up may only create your OWN profile, as a "student".
  // Only an admin can change a role (never their own), and nothing else may change.
  describe("users", () => {
    // What the sign-up page saves.
    function newProfile(uid, changes = {}) {
      return { name: "New Person", email: `${uid}@uni.test`, studentId: "S999", role: "student", ...changes };
    }

    it("a new user can sign up as a student", async () => {
      await assertSucceeds(setDoc(doc(dbAs("newbie"), "users/newbie"), newProfile("newbie")));
    });

    it("a new user can NOT sign up as an admin", async () => {
      await assertFails(setDoc(doc(dbAs("newbie"), "users/newbie"), newProfile("newbie", { role: "admin" })));
    });

    it("a new user can NOT sign up with someone else's email", async () => {
      const profile = newProfile("newbie", { email: "someone.else@uni.test" });
      await assertFails(setDoc(doc(dbAs("newbie"), "users/newbie"), profile));
    });

    it("a new user can NOT sign up with an extra field", async () => {
      const profile = newProfile("newbie", { isAdmin: true });
      await assertFails(setDoc(doc(dbAs("newbie"), "users/newbie"), profile));
    });

    it("a student can NOT read another user's profile", async () => {
      await assertFails(getDoc(doc(dbAs("student1"), "users/student2")));
    });

    it("a lecturer can read a student's profile", async () => {
      await assertSucceeds(getDoc(doc(dbAs("lecturer1"), "users/student1")));
    });

    it("a student can NOT change their own role", async () => {
      await assertFails(updateDoc(doc(dbAs("student1"), "users/student1"), { role: "admin" }));
    });

    // Otherwise two students could make each other admins.
    it("a student can NOT change another user's role", async () => {
      await assertFails(updateDoc(doc(dbAs("student1"), "users/student2"), { role: "admin" }));
    });

    it("an admin can change another user's role", async () => {
      await assertSucceeds(updateDoc(doc(dbAs("admin1"), "users/student1"), { role: "lecturer" }));
    });

    it("an admin can NOT change their own role", async () => {
      await assertFails(updateDoc(doc(dbAs("admin1"), "users/admin1"), { role: "student" }));
    });

    it("an admin can NOT change a user's name", async () => {
      await assertFails(updateDoc(doc(dbAs("admin1"), "users/student1"), { name: "Changed" }));
    });

    it("an admin can NOT set an invalid role", async () => {
      await assertFails(updateDoc(doc(dbAs("admin1"), "users/student1"), { role: "superuser" }));
    });

    it("nobody can delete a user profile (not even an admin)", async () => {
      await assertFails(deleteDoc(doc(dbAs("admin1"), "users/student1")));
    });
  });

  // ================= modules =================
  // Anyone logged in can see modules. Only admins create them, the ID must be
  // a code like CS101, and the lecturer must really be a lecturer.
  describe("modules", () => {
    const newModule = { code: "CS200", title: "Web Development", lecturerUid: "lecturer1" };

    it("a logged-in user can read a module", async () => {
      await assertSucceeds(getDoc(doc(dbAs("student1"), "modules/CS101")));
    });

    it("a logged-out visitor can NOT read a module", async () => {
      await assertFails(getDoc(doc(loggedOutDb(), "modules/CS101")));
    });

    it("an admin can create a module", async () => {
      await assertSucceeds(setDoc(doc(dbAs("admin1"), "modules/CS200"), newModule));
    });

    it("a lecturer can NOT create a module", async () => {
      await assertFails(setDoc(doc(dbAs("lecturer1"), "modules/CS200"), newModule));
    });

    it("a module code with lowercase letters is refused", async () => {
      await assertFails(setDoc(doc(dbAs("admin1"), "modules/cs200"), { ...newModule, code: "cs200" }));
    });

    // "_" would break enrolment IDs, which are "moduleCode_studentUid".
    it('a module code containing "_" is refused', async () => {
      await assertFails(setDoc(doc(dbAs("admin1"), "modules/CS_200"), { ...newModule, code: "CS_200" }));
    });

    it("a module's lecturer can NOT be a student", async () => {
      const module = { ...newModule, lecturerUid: "student1" };
      await assertFails(setDoc(doc(dbAs("admin1"), "modules/CS200"), module));
    });
  });

  // ================= enrolments =================
  // Only admins enrol students. The ID is "moduleCode_studentUid", so the rules
  // can look an enrolment up directly. Students see only their own.
  describe("enrolments", () => {
    it("an admin can enrol a student", async () => {
      const ref = doc(dbAs("admin1"), "enrolments/CS101_student3");
      await assertSucceeds(setDoc(ref, { studentUid: "student3", moduleCode: "CS101" }));
    });

    it("an enrolment with the wrong ID format is refused", async () => {
      const ref = doc(dbAs("admin1"), "enrolments/student3_CS101");
      await assertFails(setDoc(ref, { studentUid: "student3", moduleCode: "CS101" }));
    });

    it("an admin can NOT enrol someone who is not a student", async () => {
      const ref = doc(dbAs("admin1"), "enrolments/CS101_lecturer2");
      await assertFails(setDoc(ref, { studentUid: "lecturer2", moduleCode: "CS101" }));
    });

    it("a student can read their own enrolment", async () => {
      await assertSucceeds(getDoc(doc(dbAs("student1"), "enrolments/CS101_student1")));
    });

    it("a student can NOT read another student's enrolment", async () => {
      await assertFails(getDoc(doc(dbAs("student1"), "enrolments/CS101_student2")));
    });

    // The check-in page asks "am I enrolled?" — the answer may be "no such document".
    it("a student can get their own enrolment even when it does not exist", async () => {
      await assertSucceeds(getDoc(doc(dbAs("student3"), "enrolments/CS101_student3")));
    });

    it("a student can list their own enrolments (where studentUid == me)", async () => {
      const db = dbAs("student1");
      const q = query(collection(db, "enrolments"), where("studentUid", "==", "student1"));
      const snapshot = await assertSucceeds(getDocs(q));
      assert.equal(snapshot.size, 1);
    });

    it("a lecturer can list a module's enrolments (where moduleCode == CS101)", async () => {
      const db = dbAs("lecturer1");
      const q = query(collection(db, "enrolments"), where("moduleCode", "==", "CS101"));
      const snapshot = await assertSucceeds(getDocs(q));
      assert.equal(snapshot.size, 2);
    });

    it("a student can NOT enrol themselves", async () => {
      const ref = doc(dbAs("student3"), "enrolments/CS101_student3");
      await assertFails(setDoc(ref, { studentUid: "student3", moduleCode: "CS101" }));
    });
  });

  // ================= sessions =================
  // A lecturer creates sessions for THEIR modules. New sessions start as
  // "scheduled", and the status only moves forward: scheduled → open → closed.
  describe("sessions", () => {
    function newSession(changes = {}) {
      return { ...sessionData("scheduled"), date: "2026-10-20", ...changes };
    }

    it("a lecturer can create a session for their own module", async () => {
      await assertSucceeds(addDoc(collection(dbAs("lecturer1"), "sessions"), newSession()));
    });

    it("a lecturer can NOT create a session for another lecturer's module", async () => {
      const session = newSession({ moduleCode: "MA101" });
      await assertFails(addDoc(collection(dbAs("lecturer1"), "sessions"), session));
    });

    it("a student can NOT create a session", async () => {
      await assertFails(addDoc(collection(dbAs("student1"), "sessions"), newSession()));
    });

    it('a new session must start as "scheduled"', async () => {
      const session = newSession({ status: "open" });
      await assertFails(addDoc(collection(dbAs("lecturer1"), "sessions"), session));
    });

    it("a session with an unknown type is refused", async () => {
      const session = newSession({ type: "party" });
      await assertFails(addDoc(collection(dbAs("lecturer1"), "sessions"), session));
    });

    it("the lecturer can move a session from scheduled to open", async () => {
      const ref = doc(dbAs("lecturer1"), "sessions/scheduledSession");
      await assertSucceeds(updateDoc(ref, { status: "open" }));
    });

    it("the lecturer can move a session from open to closed", async () => {
      const ref = doc(dbAs("lecturer1"), "sessions/openSession");
      await assertSucceeds(updateDoc(ref, { status: "closed" }));
    });

    it("a closed session can NOT be opened again", async () => {
      const ref = doc(dbAs("lecturer1"), "sessions/closedSession");
      await assertFails(updateDoc(ref, { status: "open" }));
    });

    it("a scheduled session can NOT skip straight to closed", async () => {
      const ref = doc(dbAs("lecturer1"), "sessions/scheduledSession");
      await assertFails(updateDoc(ref, { status: "closed" }));
    });

    it("another lecturer can NOT change the session", async () => {
      const ref = doc(dbAs("lecturer2"), "sessions/scheduledSession");
      await assertFails(updateDoc(ref, { status: "open" }));
    });

    it("the lecturer can NOT change anything except the status", async () => {
      const ref = doc(dbAs("lecturer1"), "sessions/scheduledSession");
      await assertFails(updateDoc(ref, { status: "open", room: "Z99" }));
    });
  });

  // ================= sessionTokens =================
  // The secret QR token. Only the session's lecturer may read or write it, only
  // while the session is open, and the time must be the SERVER's time.
  // "previous" must be exactly the token that was stored before (or null).
  describe("sessionTokens", () => {
    const NEW_TOKEN = "brand-new-token-0123456789";

    // What the QR page saves when it starts (no previous token yet).
    function firstToken(changes = {}) {
      return { current: NEW_TOKEN, currentAt: serverTimestamp(), previous: null, previousAt: null, ...changes };
    }

    it("the lecturer can write a token while the session is open", async () => {
      const ref = doc(dbAs("lecturer1"), "sessionTokens/openSession");
      await assertSucceeds(setDoc(ref, firstToken()));
    });

    it("the lecturer can rotate the token (previous = the stored current)", async () => {
      const ref = doc(dbAs("lecturer1"), "sessionTokens/openSession");
      const rotated = firstToken({ previous: CURRENT_TOKEN, previousAt: tokenMadeAt });
      await assertSucceeds(setDoc(ref, rotated));
    });

    it("a token can NOT be written while the session is still scheduled", async () => {
      const ref = doc(dbAs("lecturer1"), "sessionTokens/scheduledSession");
      await assertFails(setDoc(ref, firstToken()));
    });

    it("a token can NOT be written after the session is closed", async () => {
      const ref = doc(dbAs("lecturer1"), "sessionTokens/closedSession");
      await assertFails(setDoc(ref, firstToken()));
    });

    it("another lecturer can NOT write the token", async () => {
      const ref = doc(dbAs("lecturer2"), "sessionTokens/openSession");
      await assertFails(setDoc(ref, firstToken()));
    });

    it("the lecturer can read the token", async () => {
      await assertSucceeds(getDoc(doc(dbAs("lecturer1"), "sessionTokens/openSession")));
    });

    // If students could read it, they could check in from home.
    it("a student can NOT read the token", async () => {
      await assertFails(getDoc(doc(dbAs("student1"), "sessionTokens/openSession")));
    });

    it("a student can NOT write the token", async () => {
      const ref = doc(dbAs("student1"), "sessionTokens/openSession");
      await assertFails(setDoc(ref, firstToken()));
    });

    // A laptop clock can be wrong (or faked), so only serverTimestamp() is accepted.
    it("a token with a time from the computer's clock is refused", async () => {
      const ref = doc(dbAs("lecturer1"), "sessionTokens/openSession");
      await assertFails(setDoc(ref, firstToken({ currentAt: Timestamp.now() })));
    });

    it("a previous token that is not the stored current token is refused", async () => {
      const ref = doc(dbAs("lecturer1"), "sessionTokens/openSession");
      const wrong = firstToken({ previous: "made-up-token-0123456789", previousAt: tokenMadeAt });
      await assertFails(setDoc(ref, wrong));
    });

    it("the lecturer can delete the token", async () => {
      await assertSucceeds(deleteDoc(doc(dbAs("lecturer1"), "sessionTokens/openSession")));
    });
  });

  // ================= attendance: QR check-in =================
  // A student scans the QR code and saves ONE "present" record for themselves.
  // The rules check: open session, enrolled, a token less than 30 seconds old,
  // server time, and fields copied correctly from the session.
  describe("attendance: QR check-in", () => {
    // Exactly what the check-in page saves for student1 in openSession.
    function checkIn(changes = {}) {
      return {
        sessionId: "openSession",
        studentUid: "student1",
        moduleCode: "CS101",
        lecturerUid: "lecturer1",
        status: "present",
        checkedInAt: serverTimestamp(),
        method: "qr",
        token: CURRENT_TOKEN,
        ...changes,
      };
    }

    function student1Ref(id = "openSession_student1") {
      return doc(dbAs("student1"), "attendance", id);
    }

    // Replace openSession's token document (ignoring the rules).
    async function setTokens(tokens) {
      await withoutRules((db) => setDoc(doc(db, "sessionTokens/openSession"), tokens));
    }

    it("a student can check in with the current token", async () => {
      await assertSucceeds(setDoc(student1Ref(), checkIn()));
    });

    // The QR code changes every 15 s, so a scan just before a change still works.
    it("a student can check in with the previous token", async () => {
      await assertSucceeds(setDoc(student1Ref(), checkIn({ token: PREVIOUS_TOKEN })));
    });

    it("a wrong token is refused", async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ token: "guessed-token-0123456789" })));
    });

    // e.g. a photo of the QR code sent to a friend at home.
    it("a current token older than 30 seconds is refused", async () => {
      await setTokens({ current: CURRENT_TOKEN, currentAt: secondsAgo(31), previous: null, previousAt: null });
      await assertFails(setDoc(student1Ref(), checkIn()));
    });

    it("a previous token older than 30 seconds is refused", async () => {
      await setTokens({
        current: CURRENT_TOKEN,
        currentAt: secondsAgo(0),
        previous: PREVIOUS_TOKEN,
        previousAt: secondsAgo(31),
      });
      await assertFails(setDoc(student1Ref(), checkIn({ token: PREVIOUS_TOKEN })));
    });

    it("a student who is not enrolled can NOT check in", async () => {
      const ref = doc(dbAs("student3"), "attendance/openSession_student3");
      await assertFails(setDoc(ref, checkIn({ studentUid: "student3" })));
    });

    it("a student can NOT check in to a scheduled session", async () => {
      const ref = student1Ref("scheduledSession_student1");
      await assertFails(setDoc(ref, checkIn({ sessionId: "scheduledSession" })));
    });

    // closedSession still has a token document (as if it was never deleted).
    it("a student can NOT check in to a closed session", async () => {
      const ref = student1Ref("closedSession_student1");
      await assertFails(setDoc(ref, checkIn({ sessionId: "closedSession" })));
    });

    it("a student can NOT check in a friend (studentUid is someone else)", async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ studentUid: "student2" })));
    });

    it("a student can NOT check in a friend (document ID has someone else's uid)", async () => {
      await assertFails(setDoc(student1Ref("openSession_student2"), checkIn()));
    });

    it("a student can NOT check in twice for the same session", async () => {
      const ref = student1Ref();
      await assertSucceeds(setDoc(ref, checkIn()));
      await assertFails(setDoc(ref, checkIn()));
    });

    it('a check-in with method "manual" is refused', async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ method: "manual" })));
    });

    // A student copying exactly what a lecturer's manual mark looks like (no token).
    it("a student can NOT save a lecturer-style manual record", async () => {
      const manual = checkIn({ method: "manual" });
      delete manual.token;
      await assertFails(setDoc(student1Ref(), manual));
    });

    it('a check-in with status "absent" is refused', async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ status: "absent" })));
    });

    it("a check-in time from the phone's clock is refused", async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ checkedInAt: Timestamp.now() })));
    });

    it("a check-in with the wrong moduleCode is refused", async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ moduleCode: "MA101" })));
    });

    it("a check-in with the wrong lecturerUid is refused", async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ lecturerUid: "lecturer2" })));
    });

    // The lecturer stopped the QR screen, so the token document was deleted.
    it("a check-in is refused when the session has no token document", async () => {
      await withoutRules((db) => deleteDoc(doc(db, "sessionTokens/openSession")));
      await assertFails(setDoc(student1Ref(), checkIn()));
    });

    it("a check-in with an extra field is refused", async () => {
      await assertFails(setDoc(student1Ref(), checkIn({ seat: "A1" })));
    });
  });

  // ================= attendance: manual marking =================
  // The session's lecturer can mark an enrolled student present or absent by
  // hand, and later switch it. Students can never change a record.
  describe("attendance: manual marking", () => {
    // Exactly what the lecturer's register saves for student2 in openSession.
    function manualMark(changes = {}) {
      return {
        sessionId: "openSession",
        studentUid: "student2",
        moduleCode: "CS101",
        lecturerUid: "lecturer1",
        status: "present",
        checkedInAt: serverTimestamp(),
        method: "manual",
        ...changes,
      };
    }

    // What the register sends when a record already exists.
    function switchTo(status) {
      return { status, method: "manual", checkedInAt: serverTimestamp() };
    }

    it("the session's lecturer can mark a student present", async () => {
      const ref = doc(dbAs("lecturer1"), "attendance/openSession_student2");
      await assertSucceeds(setDoc(ref, manualMark()));
    });

    it("the session's lecturer can mark a student absent", async () => {
      const ref = doc(dbAs("lecturer1"), "attendance/openSession_student2");
      await assertSucceeds(setDoc(ref, manualMark({ status: "absent" })));
    });

    it("another lecturer can NOT mark students in this session", async () => {
      const ref = doc(dbAs("lecturer2"), "attendance/openSession_student2");
      await assertFails(setDoc(ref, manualMark({ lecturerUid: "lecturer2" })));
    });

    it("the lecturer can NOT mark a student who is not enrolled", async () => {
      const ref = doc(dbAs("lecturer1"), "attendance/openSession_student3");
      await assertFails(setDoc(ref, manualMark({ studentUid: "student3" })));
    });

    it("the lecturer can switch a record present → absent → present", async () => {
      const ref = doc(dbAs("lecturer1"), "attendance/closedSession_student1");
      await assertSucceeds(updateDoc(ref, switchTo("absent")));
      await assertSucceeds(updateDoc(ref, switchTo("present")));
    });

    it("a student can NOT change their own record", async () => {
      const ref = doc(dbAs("student2"), "attendance/closedSession_student2");
      await assertFails(updateDoc(ref, switchTo("present")));
    });

    it("the lecturer can NOT move a record to another student", async () => {
      const ref = doc(dbAs("lecturer1"), "attendance/closedSession_student1");
      await assertFails(updateDoc(ref, { ...switchTo("absent"), studentUid: "student2" }));
    });

    it("nobody can delete an attendance record (not even the lecturer)", async () => {
      await assertFails(deleteDoc(doc(dbAs("lecturer1"), "attendance/closedSession_student1")));
    });
  });

  // ================= attendance: reading =================
  // Students see only their own records, the lecturer sees their sessions'
  // records, and admins see everything. A LIST query is only allowed when
  // its filters prove every result is allowed — the rules don't filter for you.
  describe("attendance: reading", () => {
    it("a student can read their own record", async () => {
      await assertSucceeds(getDoc(doc(dbAs("student1"), "attendance/closedSession_student1")));
    });

    it("a student can NOT read another student's record", async () => {
      await assertFails(getDoc(doc(dbAs("student1"), "attendance/closedSession_student2")));
    });

    it("a student can list their own records (where studentUid == me)", async () => {
      const db = dbAs("student1");
      const q = query(collection(db, "attendance"), where("studentUid", "==", "student1"));
      const snapshot = await assertSucceeds(getDocs(q));
      assert.equal(snapshot.size, 1);
    });

    it("a student can NOT list all records", async () => {
      await assertFails(getDocs(collection(dbAs("student1"), "attendance")));
    });

    it("the lecturer can list a session's records (where sessionId + where lecturerUid == me)", async () => {
      const db = dbAs("lecturer1");
      const q = query(
        collection(db, "attendance"),
        where("sessionId", "==", "closedSession"),
        where("lecturerUid", "==", "lecturer1")
      );
      const snapshot = await assertSucceeds(getDocs(q));
      assert.equal(snapshot.size, 2);
    });

    it("another lecturer can NOT list them by filtering on the owner's lecturerUid", async () => {
      const db = dbAs("lecturer2");
      const q = query(
        collection(db, "attendance"),
        where("sessionId", "==", "closedSession"),
        where("lecturerUid", "==", "lecturer1")
      );
      await assertFails(getDocs(q));
    });

    it("an admin can list all records", async () => {
      const snapshot = await assertSucceeds(getDocs(collection(dbAs("admin1"), "attendance")));
      assert.equal(snapshot.size, 2);
    });

    // The check-in page asks "am I already checked in?" before the record exists.
    it("a student can get their own record even when it does not exist", async () => {
      await assertSucceeds(getDoc(doc(dbAs("student1"), "attendance/openSession_student1")));
    });
  });
});
