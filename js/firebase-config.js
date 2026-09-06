// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDaZoVnU8Yq9zDMTyANQm17RIoCL9znmJI",
  authDomain: "rsc-tgi-lzp.firebaseapp.com",
  projectId: "rsc-tgi-lzp",
  storageBucket: "rsc-tgi-lzp.firebasestorage.app",
  messagingSenderId: "422701013051",
  appId: "1:422701013051:web:43aa3f6d34562cc920e41e"
};

// init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// ברשתות ארגוניות עם פרוקסי או אנטי-וירוס (Check Point, Edge Tracking Prevention)
// חיבור ה-WebChannel הזורם נחסם ומחזיר Listen/channel 404 בלולאה, ואז getDocs
// נופל בשקט ל-cache ומציג נתונים חלקיים.
// experimentalAutoDetectLongPolling מזהה חסימה כזו ועובר ל-long-polling,
// ו-useFetchStreams:false מוציא מהמשוואה את שכבת ה-fetch-streaming שנופלת ראשונה.
// אם השגיאות ממשיכות, יש להחליף כאן ל-experimentalForceLongPolling: true.
const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false
});
const storage = getStorage(app);

export { auth, db, storage };