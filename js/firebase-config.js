// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
// 1. הייבוא לאנליטיקס:
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyDDUcheGr5UaOKSu3zp7PivgOo30aX2qC8",
  authDomain: "tomato-volcani.firebaseapp.com",
  projectId: "tomato-volcani",
  storageBucket: "tomato-volcani.firebasestorage.app",
  messagingSenderId: "244825797105",
  appId: "1:244825797105:web:ebccb150341d1ca0b3d450",
  measurementId: "G-QTPXWHZ06N"
};

// init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// 2. אתחל את האנליטיקס
const analytics = getAnalytics(app);

// 3. ייצא את האנליטיקס (analytics) החוצה
export { auth, db, storage, analytics };