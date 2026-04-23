import { db, auth } from "../firebase.js";
import { 
    collection, addDoc, getDocs, query, where, orderBy, doc, deleteDoc, updateDoc, serverTimestamp, collectionGroup, getDoc, limit 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    canEdit: false,
    offers: [], // 🟢 Local Cache (Saves Firebase Reads - Extremely scalable)
    searchQuery: ''
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;
    
    const userEmail = state.user.email.toLowerCase();

    // 🚀 1. BULLETPROOF WORKSPACE & ROLE FINDER (Supports Team Members)
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
    } else {
        // Check if user is a team member
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);

        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0]; 
            state.workspaceId = agentDoc.ref.parent.parent.id; // Get Seller's UID
            state.role = (agentDoc.data().role || 'chat').toLowerCase(); 
        } else {
            state.role = "owner";
            state.workspaceId = state.user.uid;
        }
    }

    // 🛡️ 2. SECURITY & PERMISSION CHECK
    if (!hasNavPermission(state.role, 'navOffers')) {
        const grid = document.getElementById('offers-grid');
        if(grid) grid.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return; // Stop execution if no permission
    }

    // Only Owners, Managers, and Support can Create/Edit/Delete
    state.canEdit = ['owner', 'manager', 'support'].includes(state.role);

    // Secure UI Buttons based on Roles
    if (!state.canEdit) {
        const createBtn = document.getElementById('btn-open-offer-modal');
        if(createBtn) createBtn.style.display = 'none';
    }
    
    // Bind functions to window for HTML access
    window.openOfferModal = openOfferModal;
    window.closeOfferModal = closeOfferModal;
    window.saveOffer = saveOffer;
    window.deleteOffer = deleteOffer;
    window.toggleOfferStatus = toggleOfferStatus;
    window.handleOfferSearch = handleOfferSearch;
    window.generateRandomCode = generateRandomCode;

    await loadOffersOnce(); 
}

export function destroy() {
    // Cleanup if necessary when navigating away
    state.offers = [];
}

// 🟢 3. COST SAVING LOADER: Fetch once, limit to 100 for extreme scale
async function loadOffersOnce() {
    try {
        const q = query(
            collection(db, "offers"), 
            where("sellerId", "==", state.workspaceId), // Use workspaceId, not user.uid
            orderBy("createdAt", "desc"),
            limit(100) // Protection for 1Lakh+ scale (avoids massive document reads)
        );
        
        const snapshot = await getDocs(q);
        state.offers = [];
        
        snapshot.forEach((docSnap) => {
            state.offers.push({ id: docSnap.id, ...docSnap.data() });
        });
        
        renderOffers();
    } catch(e) {
        console.error("Error loading offers:", e);
        showToast("Error loading offers", "error");
    }
}

// 🟢 4. UI RENDERER
function renderOffers() {
    const grid = document.getElementById('offers-grid');
    if (!grid) return;

    let activeCount = 0;
    
    let filtered = state.offers.filter(o => {
        if(o.isActive) activeCount++;
        if(!state.searchQuery) return true;
        return o.name.toLowerCase().includes(state.searchQuery) || o.promoCode.toLowerCase().includes(state.searchQuery);
    });

    const statActive = document.getElementById('stat-active');
    const statTotal = document.getElementById('stat-total');
    if(statActive) statActive.innerText = activeCount;
    if(statTotal) statTotal.innerText = state.offers.length;

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-20 text-slate-400 bg-white rounded-3xl border border-slate-100">
                <i class="fa-solid fa-tags text-4xl mb-4 opacity-20"></i>
                <p class="text-[10px] font-black uppercase tracking-widest">No offers found</p>
            </div>`;
        return;
    }

    let html = '';
    filtered.forEach(offer => {
        const isExp = new Date(offer.expiryDate) < new Date();
        const statusColor = offer.isActive && !isExp ? 'text-emerald-500 bg-emerald-50' : 'text-slate-400 bg-slate-100';
        const statusText = isExp ? 'EXPIRED' : (offer.isActive ? 'ACTIVE' : 'PAUSED');

        // Render Action Buttons ONLY if user has edit permissions
        let actionButtons = '';
        if (state.canEdit) {
            actionButtons = `
                <div class="flex gap-2">
                    <button onclick="window.toggleOfferStatus('${offer.id}')" class="w-8 h-8 rounded-xl bg-slate-50 text-slate-500 hover:text-blue-600 flex items-center justify-center transition shadow-sm" title="Pause/Activate">
                        <i class="fa-solid ${offer.isActive ? 'fa-pause' : 'fa-play'} text-xs"></i>
                    </button>
                    <button onclick="window.deleteOffer('${offer.id}')" class="w-8 h-8 rounded-xl bg-slate-50 text-slate-500 hover:text-red-500 hover:bg-red-50 flex items-center justify-center transition shadow-sm">
                        <i class="fa-solid fa-trash text-xs"></i>
                    </button>
                </div>
            `;
        }

        html += `
        <div class="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm hover:shadow-xl transition-all flex flex-col relative group">
            <div class="flex justify-between items-start mb-3">
                <div class="inline-flex px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${statusColor}">
                    <i class="fa-solid fa-circle-dot text-[6px] mr-1 mb-0.5"></i> ${statusText}
                </div>
                ${actionButtons}
            </div>

            <h3 class="text-lg font-black text-slate-900 tracking-tight">${offer.name}</h3>
            <div class="mt-2 mb-4 inline-block px-3 py-1.5 border-2 border-dashed border-blue-200 bg-blue-50 text-blue-700 font-black text-sm tracking-wider rounded-xl uppercase w-max">
                ${offer.promoCode}
            </div>
            
            <p class="text-xs font-medium text-slate-500 leading-relaxed mb-4 flex-1">${offer.description}</p>
            
            <div class="pt-3 border-t border-slate-100 flex items-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                <i class="fa-regular fa-clock mr-1.5"></i> Valid till: ${new Date(offer.expiryDate).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'})}
            </div>
        </div>`;
    });
    grid.innerHTML = html;
}

// 🟢 5. ADD NEW OFFER (Secured)
async function saveOffer(e) {
    e.preventDefault();
    if (!state.canEdit) return showToast("Permission Denied", "error");

    const btn = document.getElementById('btn-save-offer');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Saving...`;
    btn.disabled = true;

    const offerData = {
        sellerId: state.workspaceId, // Save using Workspace ID, not User UID
        name: document.getElementById('offerName').value.trim(),
        promoCode: document.getElementById('offerCode').value.trim().toUpperCase(),
        description: document.getElementById('offerDesc').value.trim(),
        expiryDate: document.getElementById('offerExpiry').value,
        isActive: true,
        createdAt: serverTimestamp()
    };

    try {
        const docRef = await addDoc(collection(db, "offers"), offerData);
        
        // Push to local array directly to avoid re-fetching (Scale Strategy)
        offerData.id = docRef.id;
        offerData.createdAt = new Date(); 
        state.offers.unshift(offerData); 
        
        showToast("Offer Created & AI Trained! 🚀", "success");
        closeOfferModal();
        renderOffers();
    } catch(err) {
        showToast("Error saving offer", "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// 🟢 6. FAST ACTIONS (Secured)
async function deleteOffer(id) {
    if (!state.canEdit) return;
    if(!confirm("Are you sure? AI will stop offering this discount.")) return;
    
    try {
        await deleteDoc(doc(db, "offers", id));
        state.offers = state.offers.filter(o => o.id !== id);
        renderOffers();
        showToast("Offer Deleted", "success");
    } catch(e) { showToast("Error deleting", "error"); }
}

async function toggleOfferStatus(id) {
    if (!state.canEdit) return;
    const offerIndex = state.offers.findIndex(o => o.id === id);
    if(offerIndex === -1) return;
    
    const newStatus = !state.offers[offerIndex].isActive;
    
    try {
        await updateDoc(doc(db, "offers", id), { isActive: newStatus });
        state.offers[offerIndex].isActive = newStatus;
        renderOffers();
        showToast(newStatus ? "Offer Activated!" : "Offer Paused", "success");
    } catch(e) { showToast("Status update failed", "error"); }
}

// 🟢 7. UI UTILS
function handleOfferSearch() {
    state.searchQuery = document.getElementById('offerSearchInput').value.toLowerCase().trim();
    renderOffers();
}

function generateRandomCode() {
    if (!state.canEdit) return;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'SALE';
    for(let i=0; i<4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById('offerCode').value = code;
}

function openOfferModal() { 
    if (!state.canEdit) return showToast("Permission Denied", "error");
    document.getElementById('offerForm').reset();
    document.getElementById('offerModal').classList.remove('hidden'); 
    setTimeout(() => { document.querySelector('#offerModal > div').classList.remove('scale-95'); }, 10);
}

function closeOfferModal() { 
    const modalDiv = document.querySelector('#offerModal > div');
    if(modalDiv) modalDiv.classList.add('scale-95');
    setTimeout(() => { document.getElementById('offerModal').classList.add('hidden'); }, 150);
}