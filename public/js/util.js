// util.js — small helpers used by several pages.

/**
 * Create an HTML element in one line.
 *   el("td", { className: "muted" }, "Hello")
 *   el("button", { textContent: "Save", onclick: save })
 *
 * Text is added with append(), so it is always shown as text, never run
 * as HTML. That keeps names typed by users from breaking the page.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// Turn a Firestore query result into a plain array: [{ id, ...fields }]
export function withIds(snapshot) {
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Today's date as "YYYY-MM-DD" (local time).
export function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// "2026-10-15" → "Thu, 15 Oct 2026"
export function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Firestore Timestamp → "09:03"
export function formatTime(timestamp) {
  if (!timestamp) return "";
  return timestamp.toDate().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Read one value from the address bar, e.g. getParam("id") for /session.html?id=abc
export function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}
