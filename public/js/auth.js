// auth.js — login helpers shared by all pages.

import { auth, db, doc, getDoc, signOut } from "./firebase.js";

// Which page each role goes to after login.
// Links always end in ".html", so they work on VS Code Live Server too.
export const HOME_PAGE = {
  student: "/student.html",
  lecturer: "/lecturer.html",
  admin: "/admin.html",
};

// Read users/{uid} (name, email, studentId, role). Returns null if it does not exist.
export async function getProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// A promise that never finishes. We return it while the browser is
// moving to another page, so the rest of the page code does not run.
const STOP = new Promise(() => {});

/**
 * Call this at the top of every protected page, e.g.
 *   const { user, profile } = await requireRole("lecturer");
 *
 * - Not logged in  → go to the login page.
 * - Wrong role     → go to your own home page.
 * - Right role     → show the page and return { user, profile }.
 *
 * This only controls what the browser SHOWS. The real protection
 * is in firestore.rules, which the browser cannot change.
 */
export async function requireRole(...allowedRoles) {
  // Wait until Firebase has checked whether someone is logged in.
  await auth.authStateReady();
  const user = auth.currentUser;

  if (!user) {
    location.replace("/");
    return STOP;
  }

  const profile = await getProfile(user.uid);
  if (!profile) {
    showFatal("Your account has no profile. Please contact an admin.");
    return STOP;
  }

  if (!allowedRoles.includes(profile.role)) {
    location.replace(HOME_PAGE[profile.role]);
    return STOP;
  }

  setUpHeader(profile);
  document.body.classList.remove("pending"); // the page was hidden until now
  return { user, profile };
}

export async function logOut() {
  await signOut(auth);
  location.replace("/");
}

// Fill the top bar with the user's name and wire up the "Log out" button.
function setUpHeader(profile) {
  document.getElementById("who").textContent = `${profile.name} · ${profile.role}`;
  document.getElementById("logout").addEventListener("click", logOut);
}

// Replace the page with an error message and a "Log out" button.
function showFatal(text) {
  const main = document.querySelector("main");
  main.innerHTML = "";
  const p = document.createElement("p");
  p.className = "message error";
  p.textContent = text;
  const button = document.createElement("button");
  button.textContent = "Log out";
  button.addEventListener("click", logOut);
  main.append(p, button);
  document.body.classList.remove("pending");
}
