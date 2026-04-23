import { db, auth } from "../firebase.js";
import { 
    collection, query, where, onSnapshot, orderBy, limit, getAggregateFromServer, count, doc, getDoc 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";

//  NAYA: Central Role System   
import { hasNavPermission, canEditFeature } from "../role.js";

// --- STATE ---
let state = {
    user: null,
    workspaceId: null, //     ID
    role: 'chat',      //    
    unsubscribes: []   //    
};

// --- INITIALIZATION ---
// --- INITIALIZATION ---
export async function init() {
    console.log("[DASHBOARD] Initializing Secure Overview");
    
    state.user = auth.currentUser;
    if (!state.user) return;

    let displayFullName = 'Manager'; 

    try {
        const userEmail = state.user.email.toLowerCase();
        
        // 1. PEHLE 'users' COLLECTION CHECK KARO (Naya System)
        const userDocSnap = await getDoc(doc(db, "users", userEmail));
        
        if (userDocSnap.exists()) {
            const userData = userDocSnap.data();
            state.role = (userData.role || 'chat').toLowerCase();
            state.workspaceId = (userData.sellerIds && userData.sellerIds.length > 0) 
                                ? userData.sellerIds[0] 
                                : state.user.uid;
            displayFullName = userData.name || state.user.displayName || 'User';
            console.log("[DASHBOARD] User index found:", state.role);

        } else {
            // 2. AGAR 'users' MEIN NAHI HAI, TOH 'sellers' MEIN CHECK KARO (Owner Fallback)
            // Yeh purane owners ke liye zaroori hai jinka data users collection mein nahi bana
            const sellerSnap = await getDoc(doc(db, "sellers", state.user.uid));
            
            if (sellerSnap.exists()) {
                state.role = 'owner'; // Force role as owner
                state.workspaceId = state.user.uid;
                displayFullName = sellerSnap.data().businessName || state.user.displayName || 'Owner';
                
                // OPTIONAL: Yahin par users collection sync kar do taaki agli baar fast ho
                // Iske liye aap auth.js ka syncUserProfile yahan bhi call kar sakte hain
                console.log("[DASHBOARD] Fallback to Sellers: Identified as Owner");
            } else {
                // Agar dono jagah nahi mila, toh Access Denied
                showToast("Profile not found. Please re-login.", "error");
                return;
            }
        }

        // 3. SECURITY CHECK (Using role.js)
        // Check karein ki kya state.role (jo 'owner' hona chahiye) ko permission hai
        if (!hasNavPermission(state.role, 'navDashboard')) {
            console.error("[SECURITY] Access Denied for role:", state.role);
            showToast("Access Denied: Permission Missing", "error");
            window.location.hash = '#inbox'; 
            return;
        }

        // 4. UI SETUP
        setGreeting();
        const nameEl = document.getElementById('user-name');
        if (nameEl) nameEl.innerText = displayFullName;

        // 5. DATA LISTENERS
        setupDashboardListeners();

    } catch (error) {
        console.error("[DASHBOARD] Init Error:", error);
        // Agar permission error aa raha hai toh yahan alert dikhayega
        if (error.code === 'permission-denied') {
            alert("Firestore Permission Denied. Check your Rules.");
        }
    }
}

export function destroy() {
    // 
    state.unsubscribes.forEach(unsub => unsub());
    state.unsubscribes = [];
}

// --- CORE LOGIC ---

function setupDashboardListeners() {
    const wsId = state.workspaceId; //    ID  

    // 1. Live Chats
    const chatsRef = collection(db, "sellers", wsId, "chats");
    const qChats = query(chatsRef, orderBy("updatedAt", "desc"), limit(5));
    
    const unsubChats = onSnapshot(qChats, (snapshot) => {
        const dashLiveChats = document.getElementById('dash-live-chats');
        if(dashLiveChats) dashLiveChats.innerText = snapshot.size; 
        renderActivityFeed(snapshot);
    });
    state.unsubscribes.push(unsubChats);

    // 2. Hot Leads
    const leadsRef = collection(db, "leads");
    const qHotLeads = query(leadsRef, where("sellerId", "==", wsId), where("status", "==", "hot"), orderBy("updatedAt", "desc"), limit(5));
    
    const unsubLeads = onSnapshot(qHotLeads, (snapshot) => {
        renderHotLeads(snapshot);
    });
    state.unsubscribes.push(unsubLeads);

    // 3. Recent Reviews
    const reviewsRef = collection(db, "reviews");
    const qReviews = query(reviewsRef, where("sellerId", "==", wsId), orderBy("createdAt", "desc"), limit(5));
    
    const unsubReviews = onSnapshot(qReviews, (snapshot) => {
        renderRecentReviews(snapshot);
    });
    state.unsubscribes.push(unsubReviews);

    // 4. Static Stats
    fetchStaticStats(wsId);
}

async function fetchStaticStats(wsId) {
    try {
        // Total Orders
        const customersRef = collection(db, "sellers", wsId, "customers");
        const snapshotOrders = await getAggregateFromServer(customersRef, { totalOrders: count() });
        const dashOrders = document.getElementById('dash-orders');
        if(dashOrders) dashOrders.innerText = snapshotOrders.data().totalOrders || 0;

        // Total Catalog Items
        const productsRef = collection(db, "products");
        const qProducts = query(productsRef, where("sellerId", "==", wsId));
        const snapshotProducts = await getAggregateFromServer(qProducts, { totalItems: count() });
        const dashCatalog = document.getElementById('dash-catalog-count');
        if(dashCatalog) dashCatalog.innerText = snapshotProducts.data().totalItems || 0;

        const dashAiRate = document.getElementById('dash-ai-rate');
        if(dashAiRate) dashAiRate.innerText = "88%";

    } catch (error) {
        console.error("Stats Fetch Error:", error);
    }
}

// --- UI RENDERING ---

function renderActivityFeed(snapshot) {
    const container = document.getElementById('recent-activity-list');
    if(!container) return;

    if (snapshot.empty) {
        container.innerHTML = `<div class="py-20 text-center"><p class="text-[10px] font-black text-slate-300 uppercase tracking-widest">No recent messages</p></div>`;
        return;
    }

    let html = '';
    snapshot.forEach(docSnap => {
        const chat = docSnap.data();
        const initial = chat.customerName ? chat.customerName.charAt(0).toUpperCase() : '?';
        const name = chat.customerName || `+${docSnap.id}`; 
        const msg = chat.lastMessage || 'Media File';
        
        let time = "Recently";
        if(chat.updatedAt) {
             const dateObj = chat.updatedAt.toDate ? chat.updatedAt.toDate() : new Date(chat.updatedAt);
             time = dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        }
        
        const aiBadge = chat.aiActive 
            ? `<span class="bg-blue-100 text-blue-600 text-[8px] px-1.5 py-0.5 rounded font-bold">AI</span>`
            : `<span class="bg-orange-100 text-orange-600 text-[8px] px-1.5 py-0.5 rounded font-bold">Agent</span>`;

        html += `
        <div onclick="window.location.hash='#inbox'" class="flex gap-3 items-start p-3 hover:bg-slate-50 rounded-2xl cursor-pointer transition-colors group">
            <div class="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 text-slate-600 font-bold flex items-center justify-center shrink-0">${initial}</div>
            <div class="flex-1 min-w-0 pt-0.5">
                <div class="flex justify-between items-center mb-1">
                    <p class="text-[11px] font-black text-slate-800 uppercase tracking-tight truncate">${name}</p>
                    <span class="text-[9px] text-slate-400 font-bold">${time}</span>
                </div>
                <p class="text-[11px] text-slate-500 truncate font-medium mb-1">${msg}</p>
                ${aiBadge}
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function renderHotLeads(snapshot) {
    const container = document.getElementById('hot-leads-list');
    if(!container) return;

    if (snapshot.empty) {
        container.innerHTML = `<div class="py-20 text-center"><p class="text-[10px] font-black text-slate-300 uppercase tracking-widest">No Hot Leads</p></div>`;
        return;
    }

    let html = '';
    snapshot.forEach(docSnap => {
        const lead = docSnap.data();
        const initial = lead.name ? lead.name.charAt(0).toUpperCase() : '?';
        const val = lead.value ? `${new Intl.NumberFormat('en-IN').format(lead.value)}` : 'TBD';

        html += `
        <div onclick="window.location.hash='#leads'" class="flex justify-between items-center p-4 bg-white hover:bg-orange-50/30 border border-slate-100 rounded-2xl transition-all cursor-pointer shadow-sm">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-orange-50 text-orange-600 flex items-center justify-center text-sm font-black shadow-inner border border-orange-100">${initial}</div>
                <div>
                    <p class="text-xs font-black text-slate-800 uppercase tracking-wide flex items-center gap-1.5">${lead.name || 'Unknown'} <i class="fa-solid fa-fire text-orange-500 text-[10px]"></i></p>
                    <p class="text-[10px] text-slate-400 font-bold tracking-widest mt-0.5">${lead.intent || 'Follow-up'}</p>
                </div>
            </div>
            <div class="text-right">
                <span class="text-xs font-black text-slate-900 tracking-tight block">${val}</span>
                <span class="text-[9px] font-black text-orange-500 uppercase tracking-widest">HOT</span>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function renderRecentReviews(snapshot) {
    const container = document.getElementById('recent-reviews-list');
    if(!container) return;

    if (snapshot.empty) {
        container.innerHTML = `<div class="py-20 text-center"><p class="text-[10px] font-black text-slate-300 uppercase tracking-widest">No reviews yet</p></div>`;
        return;
    }

    let html = '';
    snapshot.forEach(docSnap => {
        const reviewData = docSnap.data();
        const rating = Number(reviewData.rating) || 5;
        const name = reviewData.customerName || 'Customer';
        const text = reviewData.review || 'Rated via AI';
        
        let starsHtml = '';
        for(let i=1; i<=5; i++) {
            starsHtml += `<i class="fa-solid fa-star ${i <= rating ? 'text-yellow-400' : 'text-slate-200'} text-[10px]"></i>`;
        }

        const borderClass = rating <= 3 ? 'border-red-100 bg-red-50/30' : 'border-slate-100 hover:bg-slate-50';

        html += `
        <div onclick="window.location.hash='#reviews'" class="p-3 border ${borderClass} rounded-2xl transition-all cursor-pointer shadow-sm">
            <div class="flex justify-between items-start mb-1.5">
                <p class="text-[11px] font-black text-slate-800 uppercase tracking-wide truncate pr-2">${name}</p>
                <div class="flex gap-0.5 shrink-0">${starsHtml}</div>
            </div>
            <p class="text-[10px] text-slate-500 font-medium line-clamp-2">"${text}"</p>
        </div>`;
    });
    container.innerHTML = html;
}

// --- UTILS ---
function setGreeting() {
    const hour = new Date().getHours();
    let greeting = 'GOOD EVENING';
    if (hour < 12) greeting = 'GOOD MORNING';
    else if (hour < 17) greeting = 'GOOD AFTERNOON';
    
    const greetingEl = document.getElementById('greeting-time');
    if(greetingEl) greetingEl.innerText = greeting;
}