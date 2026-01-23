 
// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

// export to allow other files to use it
export { auth, db };