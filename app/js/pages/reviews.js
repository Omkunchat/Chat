import { db, auth } from "../firebase.js";
import { 
    collection, getDocs, query, where, orderBy, limit, getDoc, collectionGroup 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    reviews: [], 
    filter: 'all'
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();

    // 🚀 1. BULLETPROOF WORKSPACE FINDER
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
    } else {
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);

        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0]; 
            state.workspaceId = agentDoc.ref.parent.parent.id; 
            state.role = (agentDoc.data().role || 'chat').toLowerCase(); 
        } else {
            state.role = "owner";
            state.workspaceId = state.user.uid;
        }
    }

    // Since anyone with Analytics/Dashboard access can typically view reviews
    // We will just let it render. No destructive actions exist here anyway.
    
    window.loadReviews = loadReviews;
    window.filterReviews = filterReviews;
    window.replyToCustomer = replyToCustomer;

    await loadReviews();
}

export function destroy() {}

// 🟢 1. COST-SAVING FETCH (Only fetches latest 100 per workspace)
async function loadReviews() {
    const btn = document.querySelector('button[onclick="window.loadReviews()"]');
    if(btn) btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Loading...`;

    try {
        const q = query(
            collection(db, "reviews"), 
            where("sellerId", "==", state.workspaceId), // Used Workspace ID
            orderBy("createdAt", "desc"),
            limit(100) // Keeps Firebase reads extremely low for 1L+ users
        );
        
        const snapshot = await getDocs(q);
        state.reviews = [];
        
        snapshot.forEach((docSnap) => {
            state.reviews.push({ id: docSnap.id, ...docSnap.data() });
        });
        
        calculateStats();
        renderReviews();
    } catch(e) {
        console.error("Review Load Error:", e);
        showToast("Error loading reviews", "error");
    } finally {
        if(btn) btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Refresh Data`;
    }
}

// 🟢 2. CALCULATE ANALYTICS LOCALLY (Zero Extra DB Cost)
function calculateStats() {
    if (state.reviews.length === 0) {
        document.getElementById('stat-avg-rating').innerText = "0.0";
        document.getElementById('stat-total-reviews').innerText = "0";
        document.getElementById('stat-happy').innerText = "0";
        document.getElementById('stat-critical').innerText = "0";
        return;
    }

    let totalScore = 0;
    let happy = 0;
    let critical = 0;

    state.reviews.forEach(r => {
        const rating = Number(r.rating) || 5;
        totalScore += rating;
        if (rating >= 4) happy++;
        else critical++;
    });

    const avg = (totalScore / state.reviews.length).toFixed(1);

    document.getElementById('stat-avg-rating').innerText = avg;
    document.getElementById('stat-total-reviews').innerText = state.reviews.length;
    document.getElementById('stat-happy').innerText = happy;
    document.getElementById('stat-critical').innerText = critical;
}

// 🟢 3. RENDER CARDS
function renderReviews() {
    const list = document.getElementById('reviews-list');
    if (!list) return;

    let filtered = state.reviews.filter(r => {
        const rating = Number(r.rating) || 5;
        if (state.filter === 'happy') return rating >= 4;
        if (state.filter === 'critical') return rating <= 3;
        return true;
    });

    if (filtered.length === 0) {
        list.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-20 text-slate-400 bg-white rounded-3xl border border-slate-100">
                <i class="fa-regular fa-star-half-stroke text-4xl mb-4 opacity-20"></i>
                <p class="text-[10px] font-black uppercase tracking-widest">No reviews found</p>
            </div>`;
        return;
    }

    let html = '';
    filtered.forEach(r => {
        const rating = Number(r.rating) || 5;
        const date = new Date(r.createdAt).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
        
        let starsHtml = '';
        for(let i=1; i<=5; i++) {
            if(i <= rating) starsHtml += `<i class="fa-solid fa-star text-yellow-400 text-sm"></i>`;
            else starsHtml += `<i class="fa-regular fa-star text-slate-200 text-sm"></i>`;
        }

        const borderClass = rating <= 3 ? 'border-red-200 shadow-red-100/50' : 'border-slate-200';

        // Anyone who can view this page can click "Reply on WhatsApp"
        html += `
        <div class="bg-white p-5 rounded-3xl border ${borderClass} shadow-sm hover:shadow-md transition-shadow flex flex-col relative">
            <div class="flex justify-between items-center mb-3">
                <div class="flex gap-0.5">${starsHtml}</div>
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">${date}</span>
            </div>
            
            <p class="text-sm font-medium text-slate-700 leading-relaxed mb-4 flex-1">
                "${r.review || 'No written feedback provided.'}"
            </p>
            
            <div class="flex items-center justify-between border-t border-slate-100 pt-4 mt-auto">
                <div>
                    <p class="text-[10px] font-black text-slate-800">${r.customerName || 'Customer'}</p>
                    <p class="text-[9px] font-bold text-slate-400 tracking-wider">${r.customerPhone}</p>
                </div>
                <button onclick="window.replyToCustomer('${r.customerPhone}')" class="w-8 h-8 rounded-xl bg-green-50 text-green-600 hover:bg-green-100 flex items-center justify-center transition" title="Reply on WhatsApp">
                    <i class="fa-brands fa-whatsapp text-lg"></i>
                </button>
            </div>
        </div>`;
    });
    list.innerHTML = html;
}

window.filterReviews = () => {
    state.filter = document.getElementById('reviewFilter').value;
    renderReviews();
};

window.replyToCustomer = (phone) => {
    const cleanPhone = phone.replace(/\D/g, '');
    window.open(`https://wa.me/${cleanPhone}`, '_blank');
};