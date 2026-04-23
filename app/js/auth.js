// js/auth.js

import { auth, db, googleProvider } from "./firebase.js"; 
import { 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword, 
    signInWithPopup, 
    updateProfile, 
    onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    doc, setDoc, getDoc, serverTimestamp, collectionGroup, query, where, getDocs 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let isManualAuthInProgress = false;

// --- 1. HELPER: SYNC USER PROFILE (For Fast Indexing) ---
async function syncUserProfile(user, role, workspaceId, fullName) {
    const userRef = doc(db, "users", user.email.toLowerCase());
    
    // Pehle check karo ki kya user pehle se exist karta hai
    const existingSnap = await getDoc(userRef);
    let finalName = fullName || user.displayName || 'User';

    // AGAR USER PEHLE SE HAI: Toh uska purana name hi rehne do
    if (existingSnap.exists()) {
        const existingData = existingSnap.data();
        if (existingData.name) {
            finalName = existingData.name; // Database wala name priority lega
        }
    }

    await setDoc(userRef, {
        uid: user.uid,
        email: user.email.toLowerCase(),
        name: finalName, // Ab ye override nahi hoga
        role: role.toLowerCase(),
        sellerIds: [workspaceId],
        lastLogin: serverTimestamp()
    }, { merge: true });
}

// --- 2. SECURITY CHECK & ROUTING ---
onAuthStateChanged(auth, async (user) => {
    if (isManualAuthInProgress) return; 

    const currentPath = window.location.pathname;
    const isLoginPage = currentPath.includes('login.html');

    if (user && isLoginPage) {
        try {
            // Fast Check: Pehle 'users' collection se role dekhte hain
            const userDocSnap = await getDoc(doc(db, "users", user.email.toLowerCase()));
            
            if (userDocSnap.exists() && userDocSnap.data().role !== 'owner') {
                window.location.href = 'index.html#inbox'; // Agent Route
            } else {
                window.location.href = 'index.html'; // Owner Route
            }
        } catch (error) {
            console.error("Routing error:", error);
            window.location.href = 'index.html'; 
        }
    }
});

// --- 3. LOGIN / SIGNUP LOGIC (Email & Password) ---
window.handleAuth = async function(e) {
    e.preventDefault();
    isManualAuthInProgress = true; 
    
    const emailInput = document.getElementById('email');
    const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
    const password = document.getElementById('password').value;
    const submitBtn = document.getElementById('submitBtn');
    
    const isSignupMode = !window.isLoginMode; 

    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Processing...';
    submitBtn.disabled = true;

    try {
        if (isSignupMode) {
            // ==========================================
            // SIGN UP LOGIC
            // ==========================================
            const fullName = document.getElementById('fullName').value.trim();
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            await updateProfile(user, { displayName: fullName });

            const teamQ = query(collectionGroup(db, "team"), where("email", "==", email));
            const teamSnaps = await getDocs(teamQ);

            if (!teamSnaps.empty) {
                // INVITED AGENT: Index as Agent
                let workspaceId = "";
                let assignedRole = "chat"; // Default role from role.js

                for (const teamDoc of teamSnaps.docs) {
                    workspaceId = teamDoc.ref.parent.parent.id;
                    assignedRole = teamDoc.data().role || "chat";
                    await setDoc(teamDoc.ref, { uid: user.uid, status: "active", name: fullName }, { merge: true });
                }
                
                await syncUserProfile(user, assignedRole, workspaceId);
                window.location.href = 'index.html#inbox'; 
                
            } else {
                // 🚀 NAYA: 14-Day Trial Logic ke liye data set kar rahe hain
                await setDoc(doc(db, "sellers", user.uid), {
                    uid: user.uid,
                    businessName: fullName || user.displayName || "My Workspace", 
                    email: email,
                    plan: "Free Trial",
                    createdAt: serverTimestamp(), // Ye engine.js mein check hoga
                    totalMessagesThisMonth: 0,
                    teamCount: 1,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone 
                });
                
                await syncUserProfile(user, 'owner', user.uid);
                window.location.href = 'index.html'; 
            }
            
        } else {
            // ==========================================
            // LOGIN LOGIC
            // ==========================================
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Database se role aur workspace verify karke sync karo
            const sellerSnap = await getDoc(doc(db, "sellers", user.uid));
            if (sellerSnap.exists()) {
                await syncUserProfile(user, 'owner', user.uid);
                window.location.href = 'index.html';
            } else {
                // Agent login case
                const userDocSnap = await getDoc(doc(db, "users", email));
                const role = userDocSnap.exists() ? userDocSnap.data().role : 'chat';
                const wsId = userDocSnap.exists() ? userDocSnap.data().sellerIds[0] : user.uid;
                
                await syncUserProfile(user, role, wsId);
                window.location.href = 'index.html#inbox';
            }
        }
    } catch (error) {
        console.error("Auth Error:", error);
        isManualAuthInProgress = false; 
        let errorMsg = "Authentication failed. Please try again.";
        if (error.code === 'auth/email-already-in-use') errorMsg = "This email is already registered.";
        else if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') errorMsg = "Incorrect email or password.";
        alert(errorMsg);
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
};

// ==========================================
// GOOGLE LOGIN LOGIC
// ==========================================
window.handleGoogleLogin = async function() {
    isManualAuthInProgress = true; 
    
    try {
        const result = await signInWithPopup(auth, googleProvider);
        const user = result.user;
        const email = user.email.toLowerCase();

        const sellerSnap = await getDoc(doc(db, "sellers", user.uid));

        if (sellerSnap.exists()) {
            // EXISTING OWNER
            await syncUserProfile(user, 'owner', user.uid);
            window.location.href = 'index.html';

        } else {
            const teamQ = query(collectionGroup(db, "team"), where("email", "==", email));
            const teamSnaps = await getDocs(teamQ);

            if (!teamSnaps.empty) {
                // INVITED AGENT
                let workspaceId = "";
                let assignedRole = "chat";

                for (const teamDoc of teamSnaps.docs) {
                    workspaceId = teamDoc.ref.parent.parent.id;
                    assignedRole = teamDoc.data().role || "chat";
                    await setDoc(teamDoc.ref, { uid: user.uid, status: "active", name: user.displayName }, { merge: true });
                }
                
                await syncUserProfile(user, assignedRole, workspaceId);
                window.location.href = 'index.html#inbox';

            } else {
                // 🚀 NAYA: 14-Day Trial Logic ke liye data set kar rahe hain
                await setDoc(doc(db, "sellers", user.uid), {
                    uid: user.uid,
                    businessName: fullName || user.displayName || "My Workspace", 
                    email: email,
                    plan: "Free Trial",
                    createdAt: serverTimestamp(), // Ye engine.js mein check hoga
                    totalMessagesThisMonth: 0,
                    teamCount: 1,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone 
                });
                
                await syncUserProfile(user, 'owner', user.uid);
                window.location.href = 'index.html';
            }
        }
    } catch (error) {
        isManualAuthInProgress = false;
        if (error.code !== 'auth/popup-closed-by-user') alert("Google Login Failed: " + error.message);
    }
};