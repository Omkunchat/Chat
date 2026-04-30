import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, doc, deleteDoc, 
    onSnapshot, getDocs, getDoc, collectionGroup, limit 
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
    statusFilter: 'all',
    sellerConfig: null
};

let templatesUnsubscribe = null;

// UI Config for Status Badges
const tplStatusConfig = {
    'APPROVED': { color: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: 'fa-check-double', label: 'APPROVED' },
    'PENDING': { color: 'bg-yellow-50 text-yellow-600 border-yellow-200', icon: 'fa-hourglass-half', label: 'PENDING' },
    'REJECTED': { color: 'bg-red-50 text-red-600 border-red-200', icon: 'fa-ban', label: 'REJECTED' }
};

// --- INITIALIZE DASHBOARD ---
export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();

    // 1. WORKSPACE & ROLE FINDER (Chatkun Multi-agent Logic)
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

    // 2. PERMISSION CHECK
    if (!hasNavPermission(state.role, 'navBroadcast')) {
        const wrapper = document.getElementById('templates-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    state.canEdit = canEditFeature(state.role, 'broadcast');

    // Bind Functions to Window
    window.handleTemplateSearch = handleTemplateSearch;
    window.deleteTemplate = deleteTemplate;
    window.syncWithMeta = syncWithMeta;

    // Start Real-time listener
    setupTemplatesListener();
}

// Cleanup on page switch
export function destroy() {
    if (templatesUnsubscribe) templatesUnsubscribe();
}

// --- DATA LISTENER ---
function setupTemplatesListener() {
    if (!state.workspaceId) return;

    const tplRef = collection(db, "sellers", state.workspaceId, "templates");
    // Limit to 100 for fast initial load
    const q = query(tplRef, orderBy("createdAt", "desc"), limit(100));

    templatesUnsubscribe = onSnapshot(q, (snapshot) => {
        state.templates = [];
        snapshot.forEach((docSnap) => { 
            state.templates.push({ id: docSnap.id, ...docSnap.data() }); 
        });
        updateStats();
        renderTemplatesList();
    });
}

// --- CALCULATE STATS ---
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

// --- RENDER ENGINE ---
function renderTemplatesList() {
    const list = document.getElementById('templates-list');
    if (!list) return;

    let filtered = state.templates.filter(t => {
        const matchesFilter = state.statusFilter === 'all' || t.status === state.statusFilter;
        const matchesSearch = !state.searchQuery || t.name.toLowerCase().includes(state.searchQuery) || t.body.toLowerCase().includes(state.searchQuery);
        return matchesFilter && matchesSearch;
    });

    if (filtered.length === 0) {
        list.innerHTML = `<div class="text-center py-20 text-[10px] font-black uppercase tracking-[0.3em] text-slate-300"><i class="fa-solid fa-folder-open text-4xl mb-4 block"></i> No matching templates</div>`;
        return;
    }

    let html = '';
    filtered.forEach(tpl => {
        const config = tplStatusConfig[tpl.status] || tplStatusConfig['PENDING'];
        const date = tpl.createdAt ? new Date(tpl.createdAt.toDate()).toLocaleDateString('en-IN', {day:'numeric', month:'short'}) : 'Now';
        
        let deleteBtn = state.canEdit ? `
            <button onclick="window.deleteTemplate('${tpl.id}')" class="w-9 h-9 rounded-xl bg-red-50 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all border border-red-100 shadow-sm">
                <i class="fa-solid fa-trash-can text-[11px]"></i>
            </button>` : '';

        // Responsive Card Structure
        html += `
        <div class="flex flex-col md:grid md:grid-cols-12 gap-4 items-center p-5 bg-white border border-slate-100 shadow-sm rounded-[1.8rem] hover:shadow-xl hover:border-blue-100 transition-all group animate-slide-up">
            <div class="col-span-3 w-full">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                        <i class="fa-solid fa-file-code"></i>
                    </div>
                    <div>
                        <p class="text-[11px] font-black text-slate-800 uppercase tracking-tight line-clamp-1">${tpl.name}</p>
                        <p class="text-[8px] text-slate-400 font-bold tracking-widest mt-0.5 uppercase">${tpl.category} • ${date}</p>
                    </div>
                </div>
            </div>
            
            <div class="col-span-5 w-full bg-slate-50/50 rounded-2xl px-5 py-3 border border-slate-50 group-hover:bg-white group-hover:border-slate-100 transition-all">
                <p class="text-[10px] font-bold text-slate-500 leading-relaxed line-clamp-2 italic">"${tpl.body}"</p>
            </div>

            <div class="col-span-2 w-full text-center">
                 <div class="inline-flex items-center gap-1.5 px-3 py-1.5 ${config.color} border rounded-xl text-[9px] font-black uppercase tracking-widest shadow-sm">
                    <i class="fa-solid ${config.icon} text-[8px]"></i> ${config.label}
                 </div>
            </div>
            
            <div class="col-span-2 w-full flex justify-end gap-2">
                <button onclick="Swal.fire('Preview', '${tpl.body}', 'info')" class="w-9 h-9 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all border border-slate-100 shadow-sm">
                    <i class="fa-solid fa-eye text-[11px]"></i>
                </button>
                ${deleteBtn}
            </div>
        </div>`;
    });
    list.innerHTML = html;
}

// --- SEARCH & SYNC LOGIC ---
function handleTemplateSearch() {
    state.searchQuery = document.getElementById('templateSearchInput')?.value.toLowerCase().trim() || "";
    state.statusFilter = document.getElementById('templateStatusFilter')?.value || "all";
    renderTemplatesList();
}

async function syncWithMeta() {
    const syncBtn = document.querySelector('button[onclick="window.syncWithMeta()"]');
    syncBtn.classList.add('fa-spin');
    
    // Yahan aap Meta API se fresh statuses fetch karke Firestore update karne ka logic dalenge
    showToast("Syncing with Meta Cloud...", "info");
    
    setTimeout(() => {
        syncBtn.classList.remove('fa-spin');
        showToast("Dashboard Synced Successfully", "success");
    }, 1500);
}

async function deleteTemplate(id) {
    Swal.fire({
        title: 'Are you sure?',
        text: "This will only remove the record from Chatkun. Meta templates must be deleted from Business Manager.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#64748b',
        confirmButtonText: 'Yes, remove it'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                await deleteDoc(doc(db, "sellers", state.workspaceId, "templates", id));
                showToast("Template record removed", "success");
            } catch(e) { 
                showToast("Error removing record", "error"); 
            }
        }
    });
}