(async () => {
    console.log(" מריץ בדיקת אבטחה: ניסיון הרשמה עם אישור עוקף...");

    const { getApp } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js");
    const { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js");
    const { getFirestore, doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");

    const auth = getAuth(getApp());
    const db = getFirestore(getApp());

    const testEmail = "test_security@example.com";
    const testPass = "123456";

    try {
        let user;
        try {
            const res = await createUserWithEmailAndPassword(auth, testEmail, testPass);
            user = res.user;
        } catch (e) {
            if (e.code === 'auth/email-already-in-use') {
                const res = await signInWithEmailAndPassword(auth, testEmail, testPass);
                user = res.user;
            } else { throw e; }
        }

        console.log(`מחובר כמשתמש: ${user.uid}. מנסה לפרוץ ל-Firestore...`);

        await setDoc(doc(db, "users", user.uid), {
            firstName: "HACKER Security",
            lastName: "Test",
            email: testEmail,
            isApproved: true // <--- הכללים אמורים לחסום את זה!
        });

        console.log("%cהפירצה עדיין קיימת! המשתמש הצליח לאשר את עצמו.", "color: red; font-weight: bold; font-size: 14px;");

    } catch (error) {
        if (error.code === 'permission-denied') {
            console.log("%cהבדיקה עברה בהצלחה: הגישה נחסמה על ידי ה-Rules.", "color: green; font-weight: bold; font-size: 14px;");
        } else {
            console.error(" שגיאה אחרת מסוג", error);
        }
    }
})();