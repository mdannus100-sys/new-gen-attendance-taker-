// firebase.js — starts Firebase and shares it with every page.
//
// All other JS files import from HERE, so the Firebase version
// number only appears in this one file.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator, terminate } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// Pass on every Auth and Firestore function (doc, getDoc, signOut, ...)
// so other files can write: import { doc, getDoc } from "./firebase.js";
export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// Which Firebase do we talk to?
//  - Page opened on THIS computer or your Wi-Fi (VS Code Live Server,
//    or "npm start"): use the local emulators (start them with "npm start").
//  - The deployed website (https://....web.app): use your REAL Firebase project.
const host = location.hostname;
export const USE_EMULATORS =
  host === "localhost" ||
  host === "127.0.0.1" ||
  host.startsWith("192.168.") ||
  host.startsWith("10.") ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host);

// With the emulators we use a "demo-" project: it works offline.
// For your real project, paste your config from:
// Firebase console → Project settings → General → Your apps → Web app.
const firebaseConfig = USE_EMULATORS
  ? {
      apiKey: "demo-key",
      authDomain: "demo-attendance.firebaseapp.com",
      projectId: "demo-attendance",
    }
  : {
      apiKey: "PASTE_YOUR_API_KEY",
      authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
      projectId: "PASTE_YOUR_PROJECT_ID",
      appId: "PASTE_YOUR_APP_ID",
    };

const app = initializeApp(firebaseConfig);

// getAuth() remembers the user in the browser by default,
// so students stay logged in on their phone.
export const auth = getAuth(app);
export const db = getFirestore(app);

if (USE_EMULATORS) {
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
}

// When you leave a page, close its database connections.
// Live updates (onSnapshot) keep a connection open. If we don't close it,
// the browser can keep it busy for a while after you move to another page.
// Browsers only allow about 6 connections to one address, so after a few
// page changes the next page would have to wait ~10 seconds.
addEventListener("pagehide", () => terminate(db));

// The Back button can bring a page back from the browser's memory.
// Its connections were closed above, so load it fresh instead.
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
