import { db, auth } from "../firebase.js";
import { 
    collection, getDocs, query, doc, updateDoc, deleteDoc, limit, getDoc, collectionGroup, where 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js"; // 🚀 RBAC Import

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    canEdit: false,
    sellerConfig: null, 
    tickets: [] 
};

const STATUS_WEBHOOK_URL = "https://status-updater.chatkunhq.workers.dev/send-status"; 

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

    // 🛡️ 2. SECURITY CHECK
    if (!hasNavPermission(state.role, 'navSupportTickets')) {
        const wrapper = document.getElementById('support-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    // Check if user has permission to edit/resolve tickets
    // Assuming Owners, Managers, and Support agents can edit tickets
    state.canEdit = ['owner', 'manager', 'support'].includes(state.role);

    await loadSellerData(); 

    window.loadActiveTickets = loadActiveTickets;
    window.updateTicketStatus = updateTicketStatus;
    window.deleteTicket = deleteTicket;
    window.copyPhone = copyPhone;

    await loadActiveTickets();
}

export function destroy() {}

async function loadSellerData() {
    try {
        const snap = await getDoc(doc(db, "sellers", state.workspaceId)); // Used Workspace ID
        if(snap.exists()) state.sellerConfig = snap.data();
    } catch(e) { console.error("Error loading config"); }
}

async function loadActiveTickets() {
    const btn = document.querySelector('button[onclick="window.loadActiveTickets()"]');
    if(btn) btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Loading...`;

    try {
        const q = query(
            collection(db, "sellers", state.workspaceId, "tickets"), // Used Workspace ID
            limit(100) // Scale Protection
        );
        
        const snapshot = await getDocs(q);
        state.tickets = [];
        
        snapshot.forEach((docSnap) => {
            state.tickets.push({ id: docSnap.id, ...docSnap.data() });
        });

        state.tickets.sort((a, b) => {
            let dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt || 0);
            let dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
            return dateB - dateA;
        });
        
        renderKanban();
    } catch(e) {
        showToast("Error loading tickets", "error");
    } finally {
        if(btn) btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Refresh`;
    }
}

function renderKanban() {
    const colOpen = document.getElementById('col-open');
    const colProg = document.getElementById('col-progress');
    const colRes = document.getElementById('col-resolved');

    if (!colOpen || !colProg || !colRes) return;

    let htmlOpen = '', htmlProg = '', htmlRes = '';
    let cOpen = 0, cProg = 0, cRes = 0;

    state.tickets.forEach(t => {
        const rawDate = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt || Date.now());
        const date = rawDate.toLocaleDateString('en-IN', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
        
        // Hide delete button if no edit permission
        const deleteBtnHtml = state.canEdit ? `<button onclick="window.deleteTicket('${t.id}')" class="text-slate-300 hover:text-red-500 transition opacity-0 group-hover:opacity-100"><i class="fa-solid fa-trash text-[10px]"></i></button>` : '';

        const cardHtml = `
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group relative">
            <div class="flex justify-between items-start mb-2">
                <span class="text-[10px] font-black text-slate-800 bg-slate-100 px-2 py-1 rounded-md tracking-wider">${t.ticketId || 'TKT-000'}</span>
                ${deleteBtnHtml}
            </div>
            <p class="text-xs font-bold text-slate-600 mb-3 leading-relaxed line-clamp-3">${t.issue || 'No issue description'}</p>
            <div class="flex items-center gap-2 mb-4">
                <div class="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-600"><i class="fa-brands fa-whatsapp text-[10px]"></i></div>
                <div class="flex-1 cursor-pointer" onclick="window.copyPhone('${t.customerPhone}')" title="Click to copy">
                    <p class="text-[10px] font-black text-slate-800">${t.customerName || 'Customer'}</p>
                    <p class="text-[9px] font-bold text-slate-400 tracking-wider">${t.customerPhone || 'N/A'}</p>
                </div>
            </div>
            <div class="flex items-center justify-between border-t border-slate-100 pt-3">
                <span class="text-[8px] font-bold text-slate-400 uppercase tracking-widest">${date}</span>
                <div class="flex gap-1.5">
                    ${getCardButtons(t.id, t.status)}
                </div>
            </div>
        </div>`;

        const currentStatus = (t.status || 'open').toLowerCase();
        if (currentStatus === 'open') { htmlOpen += cardHtml; cOpen++; }
        else if (currentStatus === 'progress') { htmlProg += cardHtml; cProg++; }
        else { htmlRes += cardHtml; cRes++; }
    });

    colOpen.innerHTML = htmlOpen || `<p class="text-center text-[10px] font-bold text-slate-400 mt-10 uppercase tracking-widest">No Open Tickets</p>`;
    colProg.innerHTML = htmlProg || `<p class="text-center text-[10px] font-bold text-slate-400 mt-10 uppercase tracking-widest">None in progress</p>`;
    colRes.innerHTML = htmlRes || `<p class="text-center text-[10px] font-bold text-slate-400 mt-10 uppercase tracking-widest">No resolved tickets</p>`;

    document.getElementById('count-open').innerText = cOpen;
    document.getElementById('count-progress').innerText = cProg;
    document.getElementById('count-resolved').innerText = cRes;
}

function getCardButtons(id, status) {
    if (!state.canEdit) return ''; // Hide action buttons for unauthorized roles

    const currentStatus = (status || 'open').toLowerCase();
    if (currentStatus === 'open') {
        return `<button onclick="window.updateTicketStatus('${id}', 'progress')" class="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg text-[9px] font-black uppercase tracking-widest transition">Start</button>`;
    } else if (currentStatus === 'progress') {
        return `<button onclick="window.updateTicketStatus('${id}', 'resolved')" class="px-3 py-1.5 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 rounded-lg text-[9px] font-black uppercase tracking-widest transition">Resolve</button>`;
    } else {
        return `<button onclick="window.updateTicketStatus('${id}', 'open')" class="px-3 py-1.5 bg-slate-50 text-slate-500 hover:bg-slate-100 rounded-lg text-[9px] font-black uppercase tracking-widest transition">Reopen</button>`;
    }
}

async function updateTicketStatus(id, newStatus) {
    if (!state.canEdit) return showToast("Permission Denied", "error");

    const tIndex = state.tickets.findIndex(t => t.id === id);
    if(tIndex === -1) return;
    
    const ticket = state.tickets[tIndex];
    ticket.status = newStatus;
    renderKanban();

    try {
        await updateDoc(doc(db, "sellers", state.workspaceId, "tickets", id), { 
            status: newStatus, 
            updatedAt: new Date().toISOString() 
        });

        if(state.sellerConfig && state.sellerConfig.metaToken) {
            showToast("Notifying customer...", "info");
            
            await fetch(STATUS_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: "ticket_update",
                    sellerUid: state.workspaceId,
                    customerPhone: ticket.customerPhone,
                    customerName: ticket.customerName || 'Customer',
                    ticketId: ticket.ticketId || 'TKT',
                    newStatus: newStatus,
                    issue: ticket.issue,
                    businessName: state.sellerConfig.businessName,
                    metaToken: state.sellerConfig.metaToken,
                    metaPhoneId: state.sellerConfig.metaPhoneId
                })
            });
            showToast("Notification Sent! \u2705", "success");
        }

    } catch(e) {
        showToast("Error updating status", "error");
        loadActiveTickets(); 
    }
}

async function deleteTicket(id) {
    if (!state.canEdit) return showToast("Permission Denied", "error");
    if(!confirm("Delete this ticket permanently?")) return;
    try {
        await deleteDoc(doc(db, "sellers", state.workspaceId, "tickets", id));
        state.tickets = state.tickets.filter(t => t.id !== id);
        renderKanban();
        showToast("Ticket Deleted", "success");
    } catch(e) { showToast("Error deleting", "error"); }
}

function copyPhone(phone) {
    navigator.clipboard.writeText(phone);
    showToast("Phone number copied!", "success");
}