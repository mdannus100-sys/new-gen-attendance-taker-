// sessions.js — session helpers shared by the lecturer pages.

import { db, doc, getDoc, writeBatch } from "./firebase.js";

export const SESSION_TYPES = ["lecture", "seminar", "lab"];

// Load one session. Returns { id, ...fields } or null if it doesn't exist.
export async function getSession(sessionId) {
  const snap = await getDoc(doc(db, "sessions", sessionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Load one module. Returns { code, title, lecturerUid } or null.
export async function getModule(moduleCode) {
  const snap = await getDoc(doc(db, "modules", moduleCode));
  return snap.exists() ? snap.data() : null;
}

/**
 * "Stop check-in": close the session AND delete its secret token.
 * A batch does both together: either both happen or neither does.
 */
export async function closeSession(sessionId) {
  const batch = writeBatch(db);
  batch.update(doc(db, "sessions", sessionId), { status: "closed" });
  batch.delete(doc(db, "sessionTokens", sessionId));
  await batch.commit();
}
