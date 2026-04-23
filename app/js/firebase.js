// --- 1. IMPORTS (LATEST VERSION 11.6.1) ---

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";

// Auth Imports
import { 
    getAuth, 
    GoogleAuthProvider,
    onAuthStateChanged, 
    signInWithEmailAndPassword, 
    signInWithPopup,
    signOut, 
    createUserWithEmailAndPassword, 
    updateProfile 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

// Firestore Imports
import { 
    getFirestore, 
    collection, 
    getDocs, 
    getDoc, 
    addDoc, 
    setDoc, 
    doc, 
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    orderBy, 
    limit, 
    serverTimestamp, 
    increment,
    arrayUnion,
    arrayRemove,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- 2. CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyD97D0E5WZkM6dvEyYGJyj8bV48bkmxEdY",
  authDomain: "chatkun-edd6b.firebaseapp.com",
  projectId: "chatkun-edd6b",
  storageBucket: "chatkun-edd6b.firebasestorage.app",
  messagingSenderId: "585623461902",
  appId: "1:585623461902:web:e7330dbb630d43a20c1c5f",
  measurementId: "G-5N2KX4S4VW"
};

// --- 3. INITIALIZATION ---
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// --- 4. EXPORTS ---
export { 
    // Core Instances
    app, 
    auth, 
    db, 
    googleProvider,

    // Auth Functions
    onAuthStateChanged, 
    signInWithEmailAndPassword, 
    signInWithPopup, 
    signOut, 
    createUserWithEmailAndPassword, 
    updateProfile,

    // Firestore Functions
    collection, 
    getDocs, 
    getDoc, 
    addDoc, 
    setDoc, 
    doc, 
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    orderBy, 
    limit, 
    serverTimestamp, 
    increment,
    arrayUnion,
    arrayRemove,
    onSnapshot
};
