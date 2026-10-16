// index.js — the login and sign-up page.

import {
  auth,
  db,
  doc,
  setDoc,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "./firebase.js";
import { getProfile, HOME_PAGE } from "./auth.js";
import { getParam } from "./util.js";

const loginCard = document.getElementById("login-card");
const signupCard = document.getElementById("signup-card");
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const message = document.getElementById("message");

// ---------- Helpers ----------

function showMessage(text) {
  message.textContent = text;
  message.className = "message error";
  document.body.classList.remove("pending");
}

// Turn Firebase error codes into plain English.
function friendlyError(err) {
  switch (err.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Wrong email or password.";
    case "auth/email-already-in-use":
      return "An account with this email already exists. Try logging in.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a minute and try again.";
    case "auth/network-request-failed":
      return "No connection. Check your internet and try again.";
    default:
      return err.message;
  }
}

// Disable a form's button while we wait, so it can't be clicked twice.
function setBusy(form, busy) {
  form.querySelector("button").disabled = busy;
}

// Send a logged-in user to the right page for their role.
async function goHome(user) {
  const profile = await getProfile(user.uid);
  if (!profile) {
    showMessage("Your account has no profile. Please contact an admin.");
    return;
  }
  // A student who scanned a QR code before logging in arrives here as
  // /?next=checkin. Send them back to the check-in page to scan again.
  // (Only this exact value is allowed, so a link can't send people elsewhere.)
  if (getParam("next") === "checkin") {
    location.replace("/checkin.html");
    return;
  }
  location.replace(HOME_PAGE[profile.role]);
}

// ---------- Already logged in? ----------
// Firebase remembers the user, so on a phone they skip this page.
await auth.authStateReady();
if (auth.currentUser) {
  await goHome(auth.currentUser);
} else {
  document.body.classList.remove("pending");
}

// ---------- Switch between the two forms ----------

document.getElementById("show-signup").addEventListener("click", (e) => {
  e.preventDefault();
  loginCard.classList.add("hidden");
  signupCard.classList.remove("hidden");
  message.textContent = "";
});

document.getElementById("show-login").addEventListener("click", (e) => {
  e.preventDefault();
  signupCard.classList.add("hidden");
  loginCard.classList.remove("hidden");
  message.textContent = "";
});

// ---------- Log in ----------

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault(); // stop the browser reloading the page
  const email = loginForm.elements.email.value.trim();
  const password = loginForm.elements.password.value;

  setBusy(loginForm, true);
  try {
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    await goHome(user);
  } catch (err) {
    showMessage(friendlyError(err));
  } finally {
    setBusy(loginForm, false);
  }
});

// ---------- Sign up ----------

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = signupForm.elements.name.value.trim();
  const studentId = signupForm.elements.studentId.value.trim();
  const email = signupForm.elements.email.value.trim();
  const password = signupForm.elements.password.value;

  setBusy(signupForm, true);
  try {
    // 1. Create the login (Firebase Authentication).
    const { user } = await createUserWithEmailAndPassword(auth, email, password);

    // 2. Create the profile in Firestore. New sign-ups are always students.
    //    Even if someone edits this code to say "admin", the security
    //    rules refuse it.
    await setDoc(doc(db, "users", user.uid), {
      name,
      email: user.email,
      studentId,
      role: "student",
    });

    await goHome(user);
  } catch (err) {
    showMessage(friendlyError(err));
  } finally {
    setBusy(signupForm, false);
  }
});
