// stats.js — attendance % maths, shared by the student and admin pages.
//
// Attendance % = sessions attended / sessions held
//   - "held" means the session is closed (check-in has finished).
//   - "attended" means there is an attendance record with status "present".
//
// The functions take plain arrays, e.g.
//   sessions:   [{ id, moduleCode, status, date, ... }]
//   attendance: [{ sessionId, studentUid, status, ... }]

// Students below this % are highlighted.
export const LOW_ATTENDANCE_PERCENT = 80;

// A session counts as "held" once check-in is closed.
export function isHeld(session) {
  return session.status === "closed";
}

// Build a quick lookup of who was present: a Set of "sessionId_studentUid".
// (Same format as the attendance document IDs.)
export function presentSet(attendance) {
  return new Set(
    attendance
      .filter((a) => a.status === "present")
      .map((a) => `${a.sessionId}_${a.studentUid}`)
  );
}

// Whole-number % or null when nothing has been held yet.
export function toPercent(attended, held) {
  return held === 0 ? null : Math.round((attended / held) * 100);
}

// "85%" or "–" when there is no % yet.
export function formatPercent(percent) {
  return percent === null ? "–" : `${percent}%`;
}

// Is this % below the 80% line? (No % yet is not "low".)
export function isLow(percent) {
  return percent !== null && percent < LOW_ATTENDANCE_PERCENT;
}

/**
 * One student in one module.
 * Returns { held, attended, percent }.
 */
export function moduleStats(studentUid, moduleCode, sessions, present) {
  const held = sessions.filter((s) => s.moduleCode === moduleCode && isHeld(s));
  const attended = held.filter((s) => present.has(`${s.id}_${studentUid}`)).length;
  return { held: held.length, attended, percent: toPercent(attended, held.length) };
}

/**
 * One student across all their modules (moduleCodes = the modules they are enrolled in).
 * Returns { held, attended, percent }.
 */
export function overallStats(studentUid, moduleCodes, sessions, present) {
  let held = 0;
  let attended = 0;
  for (const code of moduleCodes) {
    const s = moduleStats(studentUid, code, sessions, present);
    held += s.held;
    attended += s.attended;
  }
  return { held, attended, percent: toPercent(attended, held) };
}

/**
 * One module across all its enrolled students.
 * held = sessions held × number of students (every student "could" attend each one).
 * Returns { sessionsHeld, held, attended, percent }.
 */
export function moduleOverallStats(moduleCode, studentUids, sessions, present) {
  const sessionsHeld = sessions.filter((s) => s.moduleCode === moduleCode && isHeld(s)).length;
  let attended = 0;
  for (const uid of studentUids) {
    attended += moduleStats(uid, moduleCode, sessions, present).attended;
  }
  const held = sessionsHeld * studentUids.length;
  return { sessionsHeld, held, attended, percent: toPercent(attended, held) };
}
