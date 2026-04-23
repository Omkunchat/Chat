import { db, auth } from "../firebase.js";
import { collection, addDoc, doc, getDoc, getDocs, updateDoc, deleteDoc, serverTimestamp, query, where, collectionGroup } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null, 
    role: "owner",     
    leadId: null,      
    canEdit: false     
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;
    const userEmail = state.user.email.toLowerCase();

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

    if (state.leadId) {
        const titleEl = document.getElementById('lf-page-title');
        if (titleEl) titleEl.innerText = state.canEdit ? "Edit Lead Record" : "View Lead Record";
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
        // 🚀 NEW: Added new fields to disabled list
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
            
            // 🚀 FIX 1: Category Blank Issue (Force lowercase and match)
            if(document.getElementById('lf-category')) {
                const savedCat = (data.category || 'clinic').toLowerCase().trim();
                const catSelect = document.getElementById('lf-category');
                // Check agar saved category options me exist karti hai, warna 'clinic' default kardo
                const optionExists = Array.from(catSelect.options).some(opt => opt.value === savedCat);
                catSelect.value = optionExists ? savedCat : 'clinic';
            }

            document.getElementById('lf-address').value = data.address || '';
            document.getElementById('lf-intent').value = data.intent || '';
            document.getElementById('lf-value').value = data.value || '';
            document.getElementById('lf-notes').value = data.notes || '';
            
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

    // 🚀 NAYA: Phone number se sirf digits extract karein taaki international format sahi se save ho
    const rawPhone = document.getElementById('lf-phone').value.trim();
    const phoneInput = rawPhone.replace(/\D/g, '');

    // 🚀 NAYA: International phone length validation (min 8 digits)
    if (phoneInput && phoneInput.length < 8) {
        return showToast("Enter valid WhatsApp number with Country Code", "error");
    }

    const btn = document.getElementById('btn-save-full-lead');
    const ogHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        // Duplicate check ab clean numbers par hoga
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
            name: document.getElementById('lf-name').value,
            phone: phoneInput, // 🚀 NAYA: Cleaned number hi database me save hoga
            category: document.getElementById('lf-category')?.value || 'clinic',
            address: document.getElementById('lf-address').value,
            intent: document.getElementById('lf-intent').value,
            value: Number(document.getElementById('lf-value').value) || 0,
            status: document.querySelector('input[name="lf-status"]:checked')?.value || 'new',
            notes: document.getElementById('lf-notes').value,
            assignedTo: document.getElementById('lf-assignedTo')?.value || '',
            nextFollowUp: document.getElementById('lf-nextFollowUp')?.value || '',
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