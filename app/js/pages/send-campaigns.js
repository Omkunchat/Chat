import { db, auth } from "../firebase.js";
import { 
    collection, query, where, doc, addDoc, updateDoc,
    serverTimestamp, getDocs, getDoc, collectionGroup, increment 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null, workspaceId: null, role: "owner",
    sellerConfig: null, templates: [], selectedTemplate: null,
    metaDailyLimit: Infinity, messagesSentToday: 0
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    // 🟢 WORKSPACE & ROLE FINDER
    const ownerSnap = await getDoc(doc(db, "sellers", state.user.uid));
    if (ownerSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
        state.sellerConfig = ownerSnap.data();
    } else {
        const teamQ = query(collectionGroup(db, 'team'), where('email', '==', state.user.email.toLowerCase()));
        const snap = await getDocs(teamQ);
        if(!snap.empty) {
            state.workspaceId = snap.docs[0].ref.parent.parent.id;
            state.role = (snap.docs[0].data().role || 'chat').toLowerCase();
            const pDoc = await getDoc(doc(db, "sellers", state.workspaceId));
            if(pDoc.exists()) state.sellerConfig = pDoc.data();
        }
    }

    if (!hasNavPermission(state.role, 'navBroadcast') || !canEditFeature(state.role, 'broadcast')) {
        window.location.hash = '#campaigns'; return;
    }

    // Load Data
    state.metaDailyLimit = state.sellerConfig?.metaDailyLimit || Infinity;
    state.messagesSentToday = state.sellerConfig?.messagesSentToday || 0;
    document.getElementById('preview-biz-name').innerText = state.sellerConfig?.businessName || "Chatkun Business";

    await loadApprovedTemplates();

    // Bindings
    window.handleTemplateChange = handleTemplateChange;
    window.toggleCsvUpload = toggleCsvUpload;
    window.handleSaveCampaign = handleSaveCampaign;
}

// 📚 FETCH APPROVED TEMPLATES ONLY
async function loadApprovedTemplates() {
    try {
        const tplRef = collection(db, "sellers", state.workspaceId, "templates");
        const q = query(tplRef, where("status", "==", "APPROVED"));
        const snap = await getDocs(q);
        
        state.templates = [];
        let html = '<option value="">-- SELECT APPROVED TEMPLATE --</option>';
        
        snap.forEach(d => {
            const t = { id: d.id, ...d.data() };
            state.templates.push(t);
            html += `<option value="${t.id}">${t.name.toUpperCase()}</option>`;
        });
        
        document.getElementById('templateSelect').innerHTML = html;
    } catch(e) { console.error("Error loading templates", e); }
}

function handleTemplateChange() {
    const id = document.getElementById('templateSelect').value;
    state.selectedTemplate = state.templates.find(t => t.id === id);
    
    const previewBody = document.getElementById('preview-body');
    const previewBtns = document.getElementById('preview-buttons');
    const varInfo = document.getElementById('variable-info');

    if(state.selectedTemplate) {
        // Body Preview with Variable replacement
        let text = state.selectedTemplate.body.replace(/{{1}}/g, '<b class="text-blue-600">John Doe</b>');
        previewBody.innerHTML = text;
        
        // Buttons Preview
        if(state.selectedTemplate.buttons) {
            previewBtns.innerHTML = state.selectedTemplate.buttons.map(b => `<div class="w-full bg-white text-blue-500 font-bold text-[10px] py-2 rounded-lg shadow-sm text-center border border-slate-100">${b.text}</div>`).join('');
        }
        
        // Variable mapping box
        varInfo.classList.toggle('hidden', !state.selectedTemplate.body.includes('{{1}}'));
    } else {
        previewBody.innerText = "Select a template to see preview...";
        previewBtns.innerHTML = "";
        varInfo.classList.add('hidden');
    }
}

function toggleCsvUpload() {
    const aud = document.getElementById('campAudience').value;
    document.getElementById('csv-upload-wrapper').classList.toggle('hidden', aud !== 'csv');
}

// 🕒 LAUNCH CAMPAIGN
async function handleSaveCampaign(e) {
    e.preventDefault();
    if (!state.selectedTemplate) return showToast("Please select a template first", "error");
    if (!state.sellerConfig?.metaToken) return showToast("Meta API not connected", "error");

    const name = document.getElementById('campName').value.trim();
    const audienceType = document.getElementById('campAudience').value;
    const aiReply = document.getElementById('campAiReply').checked;

    try {
        let contacts = [];
        Swal.fire({ title: 'Preparing Audience...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        if (audienceType === 'csv') {
            const f = document.getElementById('campCsvFile');
            if(!f.files[0]) throw new Error("Select a CSV file.");
            contacts = parseCSV(await f.files[0].text());
        } else {
            const snap = await getDocs(collection(db, "sellers", state.workspaceId, "chats"));
            snap.forEach(d => {
                if (audienceType === 'all' || (audienceType === 'hot' && d.data().leadStatus === 'hot')) {
                    contacts.push({ phone: d.id, name: d.data().customerName || 'Customer' });
                }
            });
        }

        if(contacts.length === 0) throw new Error("No contacts found.");

        // Check Daily Limit
        if (state.metaDailyLimit !== Infinity && contacts.length > (state.metaDailyLimit - state.messagesSentToday)) {
            throw new Error("Daily Meta Limit Exceeded.");
        }

        const confirm = await Swal.fire({
            title: 'Launch Broadcast?',
            text: `Send ${state.selectedTemplate.name} to ${contacts.length} users?`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#0F172A'
        });

        if(!confirm.isConfirmed) return;

        // 1. Create Campaign Record
        const campRef = await addDoc(collection(db, "campaigns"), {
            sellerId: state.workspaceId, name, status: 'processing',
            templateName: state.selectedTemplate.name, audienceCount: contacts.length, createdAt: serverTimestamp()
        });

        Swal.fire({ title: 'Broadcasting...', html: '<b><span id="queue-progress">0</span></b> / ' + contacts.length, allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        let successCount = 0;
        const CHUNK_SIZE = 25; 

        for (let i = 0; i < contacts.length; i += CHUNK_SIZE) {
            const chunk = contacts.slice(i, i + CHUNK_SIZE);
            successCount += await executeTemplateSend(chunk, state.selectedTemplate, campRef.id);
            document.getElementById('queue-progress').innerText = Math.min(i + CHUNK_SIZE, contacts.length);
            await new Promise(r => setTimeout(r, 1000));
        }

        // Final Updates
        await updateDoc(doc(db, "campaigns", campRef.id), { status: 'sent', audienceCount: successCount });
        await updateDoc(doc(db, "sellers", state.workspaceId), { messagesSentToday: increment(successCount) });

        await Swal.fire('Broadcast Finished! 🚀', `Delivered to ${successCount} users.`, 'success');
        window.location.hash = '#campaigns';

    } catch(err) { Swal.fire('Error', err.message, 'error'); }
}

async function executeTemplateSend(contacts, template, campaignId) {
    let success = 0;
    const { metaPhoneId, metaToken } = state.sellerConfig;

    const promises = contacts.map(async (contact) => {
        // Meta Template Payload
        const payload = {
            messaging_product: "whatsapp",
            to: contact.phone,
            type: "template",
            template: {
                name: template.name,
                language: { code: "en_US" },
                components: []
            },
            biz_opaque_callback_data: campaignId // For tracking delivered/read status
        };

        // Variable Mapping: Agar body me variables hain
        if(template.body.includes('{{1}}')) {
            payload.template.components.push({
                type: "body",
                parameters: [{ type: "text", text: contact.name || "Customer" }]
            });
        }

        try {
            const res = await fetch(`https://graph.facebook.com/v18.0/${metaPhoneId}/messages`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${metaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if(res.ok) success++;
        } catch(e) {}
    });

    await Promise.all(promises);
    return success;
}

function parseCSV(text) {
    return text.split('\n').map(line => {
        const row = line.split(',');
        if(row[0]) return { phone: row[0].replace(/\D/g, ''), name: row[1]?.trim() || 'Customer' };
    }).filter(c => c && c.phone.length >= 10);
}
