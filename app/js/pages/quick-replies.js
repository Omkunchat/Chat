import { db, auth } from "../firebase.js";
import { collection, query, onSnapshot, doc, deleteDoc, setDoc, addDoc, serverTimestamp, getDoc, collectionGroup, where, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";

let state = {
    user: null,
    workspaceId: null,
    replies: []
};

let unsub = null;

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    // Workspace ID nikalna (Owner ya Agent logic)
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    if (ownerDocSnap.exists()) {
        state.workspaceId = state.user.uid;
    } else {
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', state.user.email.toLowerCase()));
        const teamSnapshot = await getDocs(teamQuery);
        if (!teamSnapshot.empty) state.workspaceId = teamSnapshot.docs[0].ref.parent.parent.id;
    }

    if (!state.workspaceId) return;

    window.openQuickReplyModal = openQuickReplyModal;
    window.closeQuickReplyModal = closeQuickReplyModal;
    window.saveQuickReply = saveQuickReply;
    window.deleteQuickReply = deleteQuickReply;
    window.editQuickReply = editQuickReply;

    fetchData();
}

export function destroy() {
    if (unsub) unsub();
}

function fetchData() {
    const q = query(collection(db, "sellers", state.workspaceId, "quickReplies"));
    unsub = onSnapshot(q, (snapshot) => {
        state.replies = [];
        snapshot.forEach(doc => state.replies.push({ id: doc.id, ...doc.data() }));
        renderGrid();
    });
}

function renderGrid() {
    const grid = document.getElementById('quick-replies-grid');
    if (!grid) return;

    if (state.replies.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-16 text-[10px] font-black uppercase tracking-[0.3em] text-slate-300"><i class="fa-solid fa-bolt text-3xl mb-3 block opacity-50"></i> No quick replies found</div>`;
        return;
    }

    // 🚀 Exact Leads Page Card Layout
    grid.innerHTML = state.replies.map(qr => `
        <div class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 flex flex-col relative overflow-hidden transition-all hover:shadow-md">
            <div class="flex justify-between items-center mb-3">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 text-slate-400 flex items-center justify-center shrink-0">
                        <i class="fa-solid fa-bolt text-[10px]"></i>
                    </div>
                    <div>
                        <p class="text-[11px] font-black text-slate-800 uppercase tracking-widest line-clamp-1">SHORTCUT: ${qr.shortcut}</p>
                        <p class="text-[8px] text-slate-400 font-bold tracking-widest uppercase mt-0.5">QUICK REPLY</p>
                    </div>
                </div>
                <div class="px-3 py-1 bg-blue-50 text-blue-600 rounded-full text-[9px] font-black uppercase tracking-widest border border-blue-100">
                    /${qr.shortcut}
                </div>
            </div>
            
            <div class="bg-slate-50 rounded-xl p-3.5 mb-3 border border-slate-100 flex-1">
                <p class="text-[13px] font-medium text-slate-700 leading-snug whitespace-pre-wrap">"${qr.message}"</p>
            </div>
            
            <div class="flex gap-2 mt-auto">
                <button onclick="window.editQuickReply('${qr.id}')" class="flex-1 py-2.5 bg-white text-slate-600 hover:bg-slate-50 rounded-xl text-[10px] font-black uppercase tracking-widest transition border border-slate-200 shadow-sm flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button onclick="window.deleteQuickReply('${qr.id}')" class="w-12 py-2.5 bg-red-50 text-red-500 hover:bg-red-500 hover:text-white rounded-xl transition border border-red-100 shadow-sm flex items-center justify-center">
                    <i class="fa-solid fa-trash-can text-[11px]"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function openQuickReplyModal() {
    document.getElementById('qr-modal').classList.remove('hidden');
    document.getElementById('qr-shortcut').focus();
}

function closeQuickReplyModal() {
    document.getElementById('qr-modal').classList.add('hidden');
    document.getElementById('qr-edit-id').value = '';
    document.getElementById('qr-shortcut').value = '';
    document.getElementById('qr-message').value = '';
    document.getElementById('qr-modal-title').innerText = 'Add Quick Reply';
}

function editQuickReply(id) {
    const item = state.replies.find(r => r.id === id);
    if(!item) return;
    
    document.getElementById('qr-edit-id').value = item.id;
    document.getElementById('qr-shortcut').value = item.shortcut;
    document.getElementById('qr-message').value = item.message;
    document.getElementById('qr-modal-title').innerText = 'Edit Quick Reply';
    
    openQuickReplyModal();
}

async function saveQuickReply() {
    const id = document.getElementById('qr-edit-id').value;
    let shortcut = document.getElementById('qr-shortcut').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''); // Sirf text, no spaces/symbols
    const message = document.getElementById('qr-message').value.trim();
    const btn = document.getElementById('qr-save-btn');

    if (!shortcut || !message) {
        showToast("Shortcut and Message are required", "error");
        return;
    }

    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving...';
    btn.disabled = true;

    try {
        const payload = { shortcut, message, updatedAt: serverTimestamp() };
        
        if (id) {
            await setDoc(doc(db, "sellers", state.workspaceId, "quickReplies", id), payload, { merge: true });
            showToast("Updated successfully", "success");
        } else {
            payload.createdAt = serverTimestamp();
            await addDoc(collection(db, "sellers", state.workspaceId, "quickReplies"), payload);
            showToast("Added successfully", "success");
        }
        closeQuickReplyModal();
    } catch (e) {
        showToast("Error saving data", "error");
    } finally {
        btn.innerHTML = 'Save Reply';
        btn.disabled = false;
    }
}

async function deleteQuickReply(id) {
    if(confirm("Are you sure you want to delete this shortcut?")) {
        try {
            await deleteDoc(doc(db, "sellers", state.workspaceId, "quickReplies", id));
            showToast("Deleted", "success");
        } catch(e) { showToast("Error deleting", "error"); }
    }
}