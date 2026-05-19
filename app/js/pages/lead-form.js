import { db, auth } from "../firebase.js";
import { collection, addDoc, doc, getDoc, getDocs, updateDoc, deleteDoc, serverTimestamp, query, where, collectionGroup } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null, 
    role: "owner",     
    leadId: null,      
    canEdit: false,
    sellerConfig: null
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
        } else {
            state.role = "owner";
            state.workspaceId = state.user.uid;
        }
    }

    if (!hasNavPermission(state.role, 'navLeads')) {
        window.location.hash = '#inbox';
        return;
    }
    
    state.canEdit = canEditFeature(state.role, 'leads');
    const urlParams = new URLSearchParams(window.location.hash.split('?')[1]);
    state.leadId = urlParams.get('id');

    window.handleSaveFullLead = handleSaveFullLead;
    window.handleDeleteLead = handleDeleteLead; 

    if (state.leadId && state.canEdit) {
        setupDeleteButton();
    }

    // 🚀 1. THE BIG FIX: Sabse pehle active team members ko dropdown me fill karein
    // Isse options DOM me pehle hi ready ho jayenge
    await loadAvailableAgentsToDropdown();

    if (state.leadId) {
        const titleEl = document.getElementById('lf-page-title');
        if (titleEl) titleEl.innerText = state.canEdit ? "Edit Lead Record" : "View Lead Record";
        
        // 🚀 2. Options ready hone ke baad jab lead data load hoga, toh saved value easily select ho jayegi
        await loadLeadData(state.leadId);
    } else {
        if (!state.canEdit) {
            showToast("You don't have permission to create leads", "error");
            window.location.hash = '#leads';
            return;
        }
    }

    applyFormPermissions(); 
}

// 🚀 NAYA CORNERSTONE FUNCTION: Fetch agents directly from workspace subcollection
async function loadAvailableAgentsToDropdown() {
    const selectEl = document.getElementById('lf-assignedTo');
    if (!selectEl) return;

    try {
        const teamRef = collection(db, "sellers", state.workspaceId, "team");
        const snap = await getDocs(teamRef);
        
        // Reset and inject standard fallback default item
        selectEl.innerHTML = `<option value="">Owner (Unassigned)</option>`;
        
        snap.forEach(docSnap => {
            const data = docSnap.data();
            // Sirf un agents ko lein jinka access revoke nahi kiya gaya hai
            if (data.status !== 'revoked') {
                // Agar dynamic display name save nahi hai, toh email parse baseline use karein
                const agentName = data.name || data.email.split('@')[0];
                
                const optionNode = document.createElement('option');
                optionNode.value = agentName;
                optionNode.innerText = agentName.toUpperCase(); // High visibility design accent
                selectEl.appendChild(optionNode);
            }
        });
        console.log(`🎯 CRM Form Dropdown updated with ${selectEl.options.length - 1} team agents.`);
    } catch (error) {
        console.error("Critical error building form team elements:", error);
    }
}

function setupDeleteButton() {
    const actionsContainer = document.querySelector('.lf-actions-container') || document.getElementById('btn-save-full-lead')?.parentElement;
    if (actionsContainer && !document.getElementById('btn-delete-lead')) {
        const delBtn = document.createElement('button');
        delBtn.id = 'btn-delete-lead';
        delBtn.type = 'button';
        delBtn.innerHTML = '<i class="fa-solid fa-trash mr-2"></i> Delete Lead';
        delBtn.className = 'px-6 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest text-red-500 bg-red-50 border border-red-100 hover:bg-red-500 hover:text-white transition-colors mr-3';
        delBtn.onclick = window.handleDeleteLead;
        actionsContainer.prepend(delBtn);
    }
}

function applyFormPermissions() {
    if (!state.canEdit) {
        const inputs = document.querySelectorAll('#lf-name, #lf-phone, #lf-address, #lf-intent, #lf-value, #lf-notes, #lf-assignedTo, #lf-nextFollowUp, input[name="lf-status"]');
        inputs.forEach(el => el.disabled = true);
        const saveBtn = document.getElementById('btn-save-full-lead');
        if(saveBtn) saveBtn.style.display = 'none'; 
    }
}

async function loadLeadData(id) {
    try {
        const docRef = doc(db, "leads", id);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (data.sellerId !== state.workspaceId) {
                showToast("Lead not found", "error");
                window.location.hash = '#leads';
                return;
            }
            
            document.getElementById('lf-name').value = data.name || '';
            document.getElementById('lf-phone').value = data.phone || '';
            
            if(document.getElementById('lf-category')) {
                const savedCat = (data.category || 'clinic').toLowerCase().trim();
                const catSelect = document.getElementById('lf-category');
                const optionExists = Array.from(catSelect.options).some(opt => opt.value === savedCat);
                catSelect.value = optionExists ? savedCat : 'clinic';
            }

            document.getElementById('lf-address').value = data.address || '';
            document.getElementById('lf-intent').value = data.intent || '';
            document.getElementById('lf-value').value = data.value || '';
            document.getElementById('lf-notes').value = data.notes || '';
            
            // Saved variables assignment mapped against freshly generated DOM options array
            if(document.getElementById('lf-assignedTo')) document.getElementById('lf-assignedTo').value = data.assignedTo || '';
            if(document.getElementById('lf-nextFollowUp')) document.getElementById('lf-nextFollowUp').value = data.nextFollowUp || '';
            
            const statusRadio = document.querySelector(`input[name="lf-status"][value="${data.status || 'new'}"]`);
            if(statusRadio) statusRadio.checked = true;
        } else {
            showToast("Lead not found", "error");
            window.location.hash = '#leads';
        }
    } catch (error) { showToast("Error loading lead", "error"); }
}

async function handleSaveFullLead(e) {
    if(e) e.preventDefault();
    if (!state.canEdit) return showToast("Permission denied", "error");

    const rawPhone = document.getElementById('lf-phone').value.trim();
    const phoneInput = rawPhone.replace(/\D/g, '');
    const assignedAgent = document.getElementById('lf-assignedTo')?.value || '';
    const followUpTime = document.getElementById('lf-nextFollowUp')?.value || '';
    const leadName = document.getElementById('lf-name').value;

    if (phoneInput && phoneInput.length < 8) {
        return showToast("Enter valid WhatsApp number with Country Code", "error");
    }

    const btn = document.getElementById('btn-save-full-lead');
    const ogHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        if (!state.leadId && phoneInput) {
            const duplicateQuery = query(
                collection(db, "leads"), 
                where("sellerId", "==", state.workspaceId),
                where("phone", "==", phoneInput)
            );
            const duplicateSnap = await getDocs(duplicateQuery);
            if (!duplicateSnap.empty) {
                showToast("Lead with this phone number already exists!", "error");
                btn.innerHTML = ogHtml; 
                btn.disabled = false;
                return; 
            }
        }

        const leadData = {
            sellerId: state.workspaceId,
            name: leadName,
            phone: phoneInput, 
            category: document.getElementById('lf-category')?.value || 'clinic',
            address: document.getElementById('lf-address').value,
            intent: document.getElementById('lf-intent').value,
            value: Number(document.getElementById('lf-value').value) || 0,
            status: document.querySelector('input[name="lf-status"]:checked')?.value || 'new',
            notes: document.getElementById('lf-notes').value,
            assignedTo: assignedAgent,
            nextFollowUp: followUpTime,
            
            // 🚀 TIME REMINDER ALIGNMENT CAP: Setup targets for our cron scheduler micro-worker
            reminderSent: false,
            reminderScheduledAt: followUpTime ? new Date(followUpTime).toISOString() : null,
            
            updatedAt: serverTimestamp()
        };

        if (state.leadId) {
            await updateDoc(doc(db, "leads", state.leadId), leadData);
            showToast("Lead Updated!", "success");
        } else {
            leadData.source = 'manual';
            leadData.createdAt = serverTimestamp();
            await addDoc(collection(db, "leads"), leadData);
            showToast("New Lead Created!", "success");
        }
        setTimeout(() => window.location.hash = '#leads', 800);

    } catch(err) { 
        console.error("Save Error:", err);
        showToast("Error saving record", "error"); 
    } finally { 
        btn.innerHTML = ogHtml; 
        btn.disabled = false; 
    }
}

async function handleDeleteLead() {
    if (!confirm("Are you sure you want to delete this lead? This action cannot be undone.")) return;
    try {
        await deleteDoc(doc(db, "leads", state.leadId));
        showToast("Lead Deleted", "success");
        setTimeout(() => window.location.hash = '#leads', 500);
    } catch (error) {
        showToast("Error deleting lead", "error");
    }
}
