 
// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAgEewkujHd6YJC74Eox2SWIrIItjN6zp4",
  authDomain: "tomato-project-volcani.firebaseapp.com",
  projectId: "tomato-project-volcani",
  storageBucket: "tomato-project-volcani.firebasestorage.app",
  messagingSenderId: "223654534825",
  appId: "1:223654534825:web:bc9821fb555c38ad8c93b8",
  measurementId: "G-TSCP200SGR"
};

// init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// export to allow other files to use it
export { auth, db };