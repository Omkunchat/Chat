import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, doc, deleteDoc, setDoc,
    onSnapshot, getDocs, getDoc, collectionGroup, limit, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

// --- GLOBAL STATE ---
let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    canEdit: false,
    templates: [],
    searchQuery: '',
    // 🚀 NAYA: Badges filter state
    statusFilter: 'all',
    sellerConfig: null
};

let templatesUnsubscribe = null;

const tplStatusConfig = {
    'APPROVED': { color: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: 'fa-check-double', label: 'APPROVED' },
    'PENDING': { color: 'bg-yellow-50 text-yellow-600 border-yellow-200', icon: 'fa-hourglass-half', label: 'PENDING' },
    'REJECTED': { color: 'bg-red-50 text-red-600 border-red-200', icon: 'fa-ban', label: 'REJECTED' }
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();

    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
        state.sellerConfig = ownerDocSnap.data();
    } else {
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);
        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0]; 
            state.workspaceId = agentDoc.ref.parent.parent.id; 
            state.role = (agentDoc.data().role || 'chat').toLowerCase(); 
            const parentDoc = await getDoc(doc(db, "sellers", state.workspaceId));
            if(parentDoc.exists()) state.sellerConfig = parentDoc.data();
        }
    }

    if (!hasNavPermission(state.role, 'navBroadcast')) {
        const wrapper = document.getElementById('templates-dashboard');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    state.canEdit = canEditFeature(state.role, 'broadcast');

    // Rebind all window functions including new status filter
    window.handleTemplateSearch = handleTemplateSearch;
    window.setStatusFilter = setStatusFilter;
    window.deleteTemplate = deleteTemplate;
    window.syncWithMeta = syncWithMeta;

    setupTemplatesListener();
}

export function destroy() {
    if (templatesUnsubscribe) templatesUnsubscribe();
}

function setupTemplatesListener() {
    if (!state.workspaceId) return;

    const tplRef = collection(db, "sellers", state.workspaceId, "templates");
    const q = query(tplRef, orderBy("createdAt", "desc"), limit(200)); // Scaled up for modern usage

    templatesUnsubscribe = onSnapshot(q, (snapshot) => {
        state.templates = [];
        snapshot.forEach((docSnap) => { 
            state.templates.push({ id: docSnap.id, ...docSnap.data() }); 
        });
        updateStats();
        renderTemplatesList();
    });
}

function updateStats() {
    let approved = 0, pending = 0, rejected = 0;
    
    state.templates.forEach(t => { 
        if (t.status === 'APPROVED') approved++;
        else if (t.status === 'PENDING') pending++;
        else if (t.status === 'REJECTED') rejected++;
    });
    
    document.getElementById('display-total-templates').innerText = state.templates.length;
    document.getElementById('display-approved-templates').innerText = approved;
    document.getElementById('display-pending-templates').innerText = pending;
    document.getElementById('display-rejected-templates').innerText = rejected;
}

// 🚀 MAJOR FIX: Advanced extraction for complex Meta component arrays
// Ise advanced aur robust banaya gaya hai taaki No Content Available na dikhe
function extractTemplateBody(tpl) {
    if (tpl.bodyText) return tpl.bodyText; // If flat field exists locally
    if (tpl.body) return tpl.body; // Old local field

    // Check Meta synced components
    if (tpl.components && Array.isArray(tpl.components)) {
        const bodyComp = tpl.components.find(c => c.type === 'BODY');
        
        if (bodyComp) {
            // Case 1: Pure text
            if (bodyComp.text) return bodyComp.text;
            
            // Case 2: Deeply nested example text (fallback for specific API versions)
            if (bodyComp.example && bodyComp.example.body_text && bodyComp.example.body_text[0]) {
                 return bodyComp.example.body_text[0][0] + " (Example text)";
            }
        }
    }
    return 'View details in edit'; // Friendly fallback
}

// 🚀 NAYA: Modern badge filter logic
function setStatusFilter(status) {
    state.statusFilter = status;
    
    // Update active UI state for badges
    document.querySelectorAll('.status-badge').forEach(badge => {
        badge.classList.remove('active');
    });
    
    const filterContainer = document.getElementById('status-filter-badges');
    if(filterContainer){
        // Find the badge based on onclick attribute text
        const targetBadge = filterContainer.querySelector(`button[onclick="window.setStatusFilter('${status}')"]`);
        if(targetBadge) targetBadge.classList.add('active');
    }

    renderTemplatesList();
}

function handleTemplateSearch() {
    state.searchQuery = document.getElementById('search-tpl')?.value.toLowerCase().trim() || "";
    renderTemplatesList();
}

// ... existing code ...

function renderTemplatesList() {
    const list = document.getElementById('templates-grid');
    if (!list) return;

    let filtered = state.templates.filter(t => {
        const matchesFilter = state.statusFilter === 'all' || t.status === state.statusFilter;
        const bodyText = extractTemplateBody(t).toLowerCase();
        const matchesSearch = !state.searchQuery || t.name?.toLowerCase().includes(state.searchQuery) || bodyText.includes(state.searchQuery);
        return matchesFilter && matchesSearch;
    });

    if (filtered.length === 0) {
        list.innerHTML = `<div class="col-span-full text-center py-16 text-[10px] font-black uppercase tracking-[0.3em] text-slate-300"><i class="fa-solid fa-folder-open text-3xl mb-3 block"></i> No matching templates</div>`;
        return;
    }

    let html = '';
    filtered.forEach(tpl => {
        const config = tplStatusConfig[tpl.status] || tplStatusConfig['PENDING'];
        const date = tpl.createdAt ? new Date(tpl.createdAt.toDate ? tpl.createdAt.toDate() : tpl.createdAt).toLocaleDateString('en-IN', {day:'numeric', month:'short'}) : 'Synced';
        const bodyText = extractTemplateBody(tpl);
        
        let rejectionHtml = '';
        if (tpl.status === 'REJECTED' && tpl.rejected_reason) {
            rejectionHtml = `<div class="mt-2 bg-red-50 text-red-700 p-2 rounded-lg text-[8px] font-bold border border-red-100 flex items-start gap-1.5"><i class="fa-solid fa-circle-exclamation mt-0.5"></i> <span>${tpl.rejected_reason}</span></div>`;
        }

        // Compact Buttons
        let editBtn = state.canEdit ? `<a href="#create-tamplate?edit_id=${tpl.id}" class="flex-1 py-2 rounded-lg bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 text-center text-[9px] font-black uppercase tracking-widest transition border border-slate-100 shadow-sm"><i class="fa-solid fa-pen"></i> Edit</a>` : '';
        let deleteBtn = state.canEdit ? `<button onclick="window.deleteTemplate('${tpl.id}')" class="w-10 rounded-lg bg-red-50 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition border border-red-100 shadow-sm"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : '';

        // 🚀 FIX: Compact Card Design
        html += `
        <div class="flex flex-col p-4 bg-white border border-slate-100 shadow-sm rounded-[1.5rem] hover:shadow-md hover:-translate-y-0.5 transition-all group">
            <div class="flex justify-between items-start mb-3 border-b border-slate-50 pb-3">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400 group-hover:text-blue-500 transition shrink-0">
                        <i class="fa-solid fa-message-captions text-[10px]"></i>
                    </div>
                    <div>
                        <p class="text-[10px] font-black text-slate-900 uppercase tracking-tight line-clamp-1">${tpl.name || 'Unnamed'}</p>
                        <p class="text-[7px] text-slate-400 font-bold tracking-widest uppercase mt-0.5">${tpl.category || 'MARKETING'} • ${date}</p>
                    </div>
                </div>
                <!-- Status Badge (Pending is overflowing fix) -->
                <div class="inline-flex items-center gap-1 px-2 py-1 ${config.color} border rounded-full text-[7px] font-black uppercase tracking-widest shadow-inner shrink-0 ml-2">
                    <i class="fa-solid ${config.icon}"></i> ${config.label}
                </div>
            </div>
            
            <div class="flex-1 bg-slate-50/50 rounded-xl p-3 border border-slate-50 mb-3">
                <p class="text-[9px] font-bold text-slate-500 leading-relaxed line-clamp-3">"${bodyText}"</p>
                ${rejectionHtml}
            </div>
            
            <div class="flex gap-2 mt-auto">
                ${editBtn}
                ${deleteBtn}
            </div>
        </div>`;
    });
    list.innerHTML = html;
}

// 🚀 REAL META SYNC LOGIC (Flattening bodyText for instant UI rendering)
async function syncWithMeta() {
    const { metaWabaId, metaToken } = state.sellerConfig || {};
    if (!metaWabaId || !metaToken) return showToast("Please setup Meta APIs in Settings first", "error");

    const syncBtn = document.getElementById('sync-meta-btn');
    if(syncBtn) {
        syncBtn.innerHTML = '<i class="fa-solid fa-rotate fa-spin text-base"></i> <span class="hidden md:inline">Syncing...</span>';
        syncBtn.disabled = true;
    }
    
    showToast("Pulling templates from Meta...", "info");
    
    try {
        const res = await fetch(`https://graph.facebook.com/v19.0/${metaWabaId}/message_templates?limit=250`, {
            headers: { 'Authorization': `Bearer ${metaToken}` }
        });
        const data = await res.json();
        
        if (data.error) throw new Error(data.error.message);

        // 🚀 Helper Function: Firebase ke 'Nested Array' error ko theek karne ke liye
        function makeFirestoreSafe(data) {
            if (data === undefined) return null;
            if (Array.isArray(data)) {
                return data.map(item => {
                    if (Array.isArray(item)) return Object.assign({}, makeFirestoreSafe(item));
                    if (item !== null && typeof item === 'object') return makeFirestoreSafe(item);
                    return item;
                });
            }
            if (data !== null && typeof data === 'object') {
                const result = {};
                for (let key in data) result[key] = makeFirestoreSafe(data[key]);
                return result;
            }
            return data;
        }

        // Fetch all templates and save them to Firebase
        for (const t of data.data) {
            try {
                const componentsArray = Array.isArray(t.components) ? t.components : [];
                const bodyComp = componentsArray.find(c => c.type === 'BODY');
                const flattenedBody = (bodyComp && bodyComp.text) ? bodyComp.text : "";

                // Naye function se data ko pass karein
                const safeComponents = makeFirestoreSafe(componentsArray);

                // Meta Status Normalization
                let metaStatus = t.status ? String(t.status).toUpperCase() : "PENDING";
                if (metaStatus === "ACTIVE") metaStatus = "APPROVED";

                // Build data
                let templateData = {
                    name: t.name ? String(t.name) : "unnamed_template",
                    metaId: t.id ? String(t.id) : "",
                    status: metaStatus, 
                    category: t.category ? String(t.category) : "MARKETING",
                    language: t.language ? String(t.language) : "en_US",
                    components: safeComponents, 
                    bodyText: String(flattenedBody),
                    lastSynced: serverTimestamp(),
                    createdAt: serverTimestamp() // 👈 YAHI MISSING THA! Iske bina naye template screen par nahi aate
                };

                if (t.rejected_reason) {
                    templateData.rejected_reason = String(t.rejected_reason);
                }

                // Safely save to Firestore
                if (templateData.name) {
                    await setDoc(doc(db, "sellers", state.workspaceId, "templates", templateData.name), templateData, { merge: true });
                }
            } catch (err) {
                console.error("Template save failed for:", t.name, err);
            }
        }
        
        
        showToast("Templates Synced Successfully!", "success");
    } catch (e) {
        showToast("Sync failed: " + e.message, "error");
    } finally {
        if(syncBtn) {
            syncBtn.innerHTML = '<i class="fa-solid fa-rotate text-base"></i> <span class="hidden md:inline">Sync Meta</span>';
            syncBtn.disabled = false;
        }
    }
}

async function deleteTemplate(id) {
    // 🚀 1. Pehle state array se template ka real name dhoondhein
    const tpl = state.templates.find(t => t.id === id);
    const tplName = tpl ? tpl.name : null;
    
    // Settings se Meta configuration fetch karein
    const { metaWabaId, metaToken } = state.sellerConfig || {};

    Swal.fire({
        title: 'Delete Template?',
        text: "This will delete the template from Omkun Chat and also permanently remove it from Meta WhatsApp!",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#cbd5e1',
        confirmButtonText: 'Yes, delete everywhere'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                // 🚀 2. REAL-TIME META API DELETE CALL
                if (metaWabaId && metaToken && tplName) {
                    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${metaWabaId}/message_templates?name=${encodeURIComponent(tplName)}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${metaToken}` }
                    });
                    
                    const metaData = await metaRes.json();
                    if (metaData.error) {
                        console.error("Meta Sync Delete Warning:", metaData.error.message);
                        // Agar Meta par template nahi mila ya koi issue hai toh warning show karega, crash nahi karega
                    }
                }

                // 🚀 3. Local Firebase Database se record clear karna
                await deleteDoc(doc(db, "sellers", state.workspaceId, "templates", id));
                showToast("Template deleted from everywhere! 💥", "success");
                
            } catch(e) { 
                showToast("Error removing record", "error"); 
                console.error(e);
            }
        }
    });
}
