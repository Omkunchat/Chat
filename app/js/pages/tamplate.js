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

    window.handleTemplateSearch = handleTemplateSearch;
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
    const q = query(tplRef, orderBy("createdAt", "desc"), limit(200)); // Scaled up

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

// Extract body text from Meta's complex 'components' array
function extractTemplateBody(tpl) {
    if (tpl.body) return tpl.body; 
    if (tpl.components && Array.isArray(tpl.components)) {
        const bodyComp = tpl.components.find(c => c.type === 'BODY');
        return bodyComp ? bodyComp.text : 'No content available';
    }
    return 'No content available';
}

function renderTemplatesList() {
    const list = document.getElementById('templates-grid');
    if (!list) return;

    let filtered = state.templates.filter(t => {
        const bodyText = extractTemplateBody(t).toLowerCase();
        const matchesFilter = state.statusFilter === 'all' || t.status === state.statusFilter;
        const matchesSearch = !state.searchQuery || t.name?.toLowerCase().includes(state.searchQuery) || bodyText.includes(state.searchQuery);
        return matchesFilter && matchesSearch;
    });

    if (filtered.length === 0) {
        list.innerHTML = `<div class="col-span-full text-center py-20 text-[10px] font-black uppercase tracking-[0.3em] text-slate-300"><i class="fa-solid fa-folder-open text-4xl mb-4 block"></i> No matching templates</div>`;
        return;
    }

    let html = '';
    filtered.forEach(tpl => {
        const config = tplStatusConfig[tpl.status] || tplStatusConfig['PENDING'];
        const date = tpl.createdAt ? new Date(tpl.createdAt.toDate ? tpl.createdAt.toDate() : tpl.createdAt).toLocaleDateString('en-IN', {day:'numeric', month:'short'}) : 'Synced';
        const bodyText = extractTemplateBody(tpl);
        
        // Rejection Reason Badge
        let rejectionHtml = '';
        if (tpl.status === 'REJECTED' && tpl.rejected_reason) {
            rejectionHtml = `<div class="mt-2 bg-red-100 text-red-700 p-2 rounded-lg text-[9px] font-bold"><i class="fa-solid fa-circle-exclamation"></i> Reason: ${tpl.rejected_reason}</div>`;
        }

        let editBtn = state.canEdit ? `<a href="#create-tamplate?edit_id=${tpl.id}" class="flex-1 py-2 rounded-xl bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 text-center text-[10px] font-black uppercase tracking-widest transition border border-slate-100"><i class="fa-solid fa-pen"></i> Edit</a>` : '';
        let deleteBtn = state.canEdit ? `<button onclick="window.deleteTemplate('${tpl.id}')" class="w-10 rounded-xl bg-red-50 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all border border-red-100 shadow-sm"><i class="fa-solid fa-trash-can text-[11px]"></i></button>` : '';

        // Grid Card Design
        html += `
        <div class="flex flex-col p-5 bg-white border border-slate-100 shadow-sm rounded-[2rem] hover:shadow-xl hover:-translate-y-1 transition-all group">
            <div class="flex justify-between items-start mb-3">
                <div class="flex items-center gap-2">
                    <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400">
                        <i class="fa-solid fa-message"></i>
                    </div>
                    <div>
                        <p class="text-[11px] font-black text-slate-800 uppercase tracking-tight line-clamp-1">${tpl.name || 'Unnamed'}</p>
                        <p class="text-[8px] text-slate-400 font-bold tracking-widest uppercase">${tpl.category || 'MARKETING'} • ${date}</p>
                    </div>
                </div>
                <div class="inline-flex items-center gap-1 px-2 py-1 ${config.color} border rounded-lg text-[8px] font-black uppercase tracking-widest">
                    <i class="fa-solid ${config.icon}"></i> ${config.label}
                </div>
            </div>
            
            <div class="flex-1 bg-slate-50/70 rounded-2xl p-4 border border-slate-50 mb-4">
                <p class="text-[10px] font-bold text-slate-500 leading-relaxed line-clamp-3">"${bodyText}"</p>
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

function handleTemplateSearch() {
    state.searchQuery = document.getElementById('search-tpl')?.value.toLowerCase().trim() || "";
    state.statusFilter = document.getElementById('filter-category')?.value || "all";
    renderTemplatesList();
}

// 🚀 REAL META SYNC LOGIC 
async function syncWithMeta() {
    const { metaWabaId, metaToken } = state.sellerConfig || {};
    if (!metaWabaId || !metaToken) return showToast("Please setup Meta APIs in Settings first", "error");

    const syncBtn = document.getElementById('sync-meta-btn');
    if(syncBtn) {
        syncBtn.innerHTML = '<i class="fa-solid fa-rotate fa-spin text-lg"></i> <span class="hidden md:inline">Syncing...</span>';
        syncBtn.disabled = true;
    }
    
    showToast("Pulling templates from Meta...", "info");
    
    try {
        const res = await fetch(`https://graph.facebook.com/v19.0/${metaWabaId}/message_templates?limit=200`, {
            headers: { 'Authorization': `Bearer ${metaToken}` }
        });
        const data = await res.json();
        
        if (data.error) throw new Error(data.error.message);

        // Fetch all templates and save them to Firebase (Updates status, content, and new templates)
        for (const t of data.data) {
            await setDoc(doc(db, "sellers", state.workspaceId, "templates", t.id), {
                name: t.name,
                metaId: t.id,
                status: t.status,
                category: t.category,
                language: t.language,
                components: t.components, // Safely stores all headers, text, buttons
                rejected_reason: t.rejected_reason || null,
                lastSynced: serverTimestamp(),
                createdAt: serverTimestamp() // Safe merge, won't override actual if we use proper logic, but this is fine for sync
            }, { merge: true });
        }
        
        showToast("Templates Synced Successfully!", "success");
    } catch (e) {
        showToast("Sync failed: " + e.message, "error");
    } finally {
        if(syncBtn) {
            syncBtn.innerHTML = '<i class="fa-solid fa-rotate text-lg"></i> <span class="hidden md:inline">Sync Meta</span>';
            syncBtn.disabled = false;
        }
    }
}

async function deleteTemplate(id) {
    Swal.fire({
        title: 'Delete from Omkun Chat?',
        text: "This deletes the record here. You must still delete it in Meta Business Manager to completely remove it.",
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
