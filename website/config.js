// ====== Shark Tank settings ======

// Firebase project: shark-tank-ff66c
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDbMActbqKXJk3DP7rORvyqTd_lrUjyxJQ",
  authDomain: "shark-tank-ff66c.firebaseapp.com",
  projectId: "shark-tank-ff66c",
  storageBucket: "shark-tank-ff66c.firebasestorage.app",
  messagingSenderId: "151693134955",
  appId: "1:151693134955:web:59b17baae84d8b23cef52e",
};

// The two admins. MUST match adminEmails() in firestore.rules (the rules are what actually enforce it).
export const ADMINS = ["silvio.g@incfile.com", "i.lopez@bizee.com"];

// Only Google accounts on these domains can sign in. Keep in sync with companyAccount() in firestore.rules.
export const ALLOWED_DOMAINS = ["bizee.com", "incfile.com"];

// Your Zendesk agent domain
export const ZENDESK_HOST = "bizee.zendesk.com";
