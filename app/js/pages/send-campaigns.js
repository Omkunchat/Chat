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
    metaDailyLimit: Infinity, messagesSentToday: 0,
    mediaUrl: null // NAYA: Uploaded PDF/Image ka link store karne ke liye
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    // WORKSPACE & ROLE FINDER
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

    state.metaDailyLimit = state.sellerConfig?.metaDailyLimit || Infinity;
    state.messagesSentToday = state.sellerConfig?.messagesSentToday || 0;
    document.getElementById('preview-biz-name').innerText = state.sellerConfig?.businessName || "Chatkun Business";

    await loadApprovedTemplates();

    window.handleTemplateChange = handleTemplateChange;
    window.toggleCsvUpload = toggleCsvUpload;
    window.handleSaveCampaign = handleSaveCampaign;
    window.handleTestCampaign = handleTestCampaign; // Manual Testing Button
}

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
    const mediaWrapper = document.getElementById('media-upload-wrapper');
    const previewMedia = document.getElementById('preview-media');

    if(state.selectedTemplate) {
        // 🟢 NAYA: Meta Data Extract karne ka Safe Logic (Body ke liye)
        let rawBody = "";
        if (state.selectedTemplate.body) {
            rawBody = state.selectedTemplate.body;
        } else if (state.selectedTemplate.components) {
            const bodyComp = state.selectedTemplate.components.find(c => c.type === 'BODY' || c.type === 'body');
            if (bodyComp && bodyComp.text) rawBody = bodyComp.text;
        }
        
        let text = rawBody || "No body text available.";
        const hasVariable = text.includes('{{1}}');
        
        // Replace variable for preview
        text = text.replace(/{{1}}/g, '<b class="text-blue-600">Customer Name</b>');
        previewBody.innerHTML = text;
        
        // 🟢 NAYA: Meta Data Extract karne ka Safe Logic (Buttons ke liye)
        let btns = [];
        if (state.selectedTemplate.buttons) {
            btns = state.selectedTemplate.buttons;
        } else if (state.selectedTemplate.components) {
            const btnComp = state.selectedTemplate.components.find(c => c.type === 'BUTTONS' || c.type === 'buttons');
            if (btnComp && btnComp.buttons) btns = btnComp.buttons;
        }

        if(btns.length > 0) {
            previewBtns.innerHTML = btns.map(b => `<div class="w-full bg-white text-blue-500 font-bold text-[10px] py-2 rounded-lg shadow-sm text-center border border-slate-100">${b.text}</div>`).join('');
        } else {
            previewBtns.innerHTML = "";
        }
        
        varInfo.classList.toggle('hidden', !hasVariable);

        // 🟢 NAYA: Meta Data Extract karne ka Safe Logic (Header/Media ke liye)
        let hType = state.selectedTemplate.headerType || "NONE";
        if (state.selectedTemplate.components && hType === "NONE") {
            const headComp = state.selectedTemplate.components.find(c => c.type === 'HEADER' || c.type === 'header');
            if (headComp) hType = headComp.format || "NONE";
        }
        hType = hType.toUpperCase();

        if (hType === 'IMAGE' || hType === 'DOCUMENT' || hType === 'VIDEO') {
            mediaWrapper.classList.remove('hidden');
            previewMedia.classList.remove('hidden');
            document.getElementById('media-help-text').innerText = `Please attach a ${hType.toLowerCase()} file for this template.`;
        } else {
            mediaWrapper.classList.add('hidden');
            previewMedia.classList.add('hidden');
        }

    } else {
        previewBody.innerText = "Select a template to see preview...";
        previewBtns.innerHTML = "";
        varInfo.classList.add('hidden');
        mediaWrapper.classList.add('hidden');
        previewMedia.classList.add('hidden');
    }
}

function toggleCsvUpload() {
    const aud = document.getElementById('campAudience').value;
    document.getElementById('csv-upload-wrapper').classList.toggle('hidden', aud !== 'csv');
    document.getElementById('manual-number-wrapper').classList.toggle('hidden', aud !== 'manual');
}

// ===================================
// NAYA: File Uploader Logic (AWS/Worker)
// ===================================
async function uploadMediaFile() {
    const fileInput = document.getElementById('campMediaFile');
    if (!fileInput.files || fileInput.files.length === 0) return null;
    
    const file = fileInput.files[0];
    
    // AWS Worker Call (Jaise Chat mein karte hain)
    try {
        Swal.fire({ title: 'Uploading Media...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const presignedRes = await fetch(`https://media-engine.chatkunhq.workers.dev/get-presigned-url?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`);
        const { uploadUrl, publicUrl } = await presignedRes.json();
        
        const awsUpload = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }});
        if (!awsUpload.ok) throw new Error("Media Upload Failed!");
        
        return publicUrl;
    } catch (e) {
        throw new Error("Failed to upload media. Check file size.");
    }
}

// ===================================
// MANUAL TEST SEND FUNCTION
// ===================================
window.handleTestCampaign = async (e) => {
    e.preventDefault();
    if (!state.selectedTemplate) return showToast("Select a template", "error");
    
    const manualPhone = document.getElementById('campManualPhone')?.value.trim();
    if (!manualPhone || manualPhone.length < 10) return showToast("Enter a valid test phone number", "error");

    try {
        let uploadedUrl = null;
        if (!document.getElementById('media-upload-wrapper').classList.contains('hidden')) {
            uploadedUrl = await uploadMediaFile();
            if (!uploadedUrl) throw new Error("Media template selected but no file attached.");
        }

        Swal.fire({ title: 'Sending Test...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        const testContact = [{ phone: manualPhone, name: "Test User" }];
        await executeTemplateSend(testContact, state.selectedTemplate, "TEST_CAMPAIGN", uploadedUrl);

        Swal.fire('Test Sent!', 'Check your WhatsApp.', 'success');
    } catch(err) {
        Swal.fire('Test Failed', err.message, 'error');
    }
};

// ===================================
// LAUNCH MAIN CAMPAIGN
// ===================================
async function handleSaveCampaign(e) {
    e.preventDefault();
    if (!state.selectedTemplate) return showToast("Please select a template first", "error");
    if (!state.sellerConfig?.metaToken) return showToast("Meta API not connected", "error");

    const name = document.getElementById('campName').value.trim();
    const audienceType = document.getElementById('campAudience').value;

    if (!name && audienceType !== 'manual') return showToast("Campaign name is required", "error");

    try {
        let contacts = [];
        Swal.fire({ title: 'Preparing Audience...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        if (audienceType === 'csv') {
            const f = document.getElementById('campCsvFile');
            if(!f.files[0]) throw new Error("Select a CSV file.");
            contacts = parseCSV(await f.files[0].text());
        } else if (audienceType === 'manual') {
            const phone = document.getElementById('campManualPhone').value.trim();
            if(!phone) throw new Error("Enter manual number");
            contacts.push({ phone: phone, name: 'User' });
        } else {
            // CRM Pull
            const snap = await getDocs(collection(db, "sellers", state.workspaceId, "chats"));
            snap.forEach(d => {
                if (audienceType === 'all' || (audienceType === 'hot' && d.data().leadStatus === 'hot')) {
                    contacts.push({ phone: d.id, name: d.data().customerName || 'Customer' });
                }
            });
        }

        if(contacts.length === 0) throw new Error("No valid contacts found.");
        
        // 🚀 SCALABILITY LIMITS Check
        if (contacts.length > 100000) throw new Error("Max 1 Lakh contacts allowed per campaign block.");
        if (state.metaDailyLimit !== Infinity && contacts.length > (state.metaDailyLimit - state.messagesSentToday)) {
            throw new Error("Daily Meta Limit Exceeded.");
        }

        // Handle Media File
        let uploadedUrl = null;
        if (!document.getElementById('media-upload-wrapper').classList.contains('hidden')) {
            uploadedUrl = await uploadMediaFile();
            if (!uploadedUrl) throw new Error("Media template selected but no file attached.");
        }

        const confirm = await Swal.fire({
            title: 'Launch Broadcast?',
            text: `Send ${state.selectedTemplate.name} to ${contacts.length} users?`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#0F172A'
        });

        if(!confirm.isConfirmed) return;

        // Create Campaign Document First
        const campRef = await addDoc(collection(db, "campaigns"), {
            sellerId: state.workspaceId, name, status: 'processing',
            templateName: state.selectedTemplate.name, audienceCount: contacts.length, createdAt: serverTimestamp()
        });

        Swal.fire({ title: 'Broadcasting...', html: '<b><span id="queue-progress">0</span></b> / ' + contacts.length, allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        let successCount = 0;
        
        // 🚀 RATE LIMIT CHUNKING (50 requests per batch for Meta Graph API compliance)
        const CHUNK_SIZE = 50; 

        for (let i = 0; i < contacts.length; i += CHUNK_SIZE) {
            const chunk = contacts.slice(i, i + CHUNK_SIZE);
            successCount += await executeTemplateSend(chunk, state.selectedTemplate, campRef.id, uploadedUrl);
            document.getElementById('queue-progress').innerText = Math.min(i + CHUNK_SIZE, contacts.length);
            
            // Artificial delay to prevent API Throttling at 1 Lakh scale
            await new Promise(r => setTimeout(r, 800)); 
        }

        // Final Updates
        await updateDoc(doc(db, "campaigns", campRef.id), { status: 'sent', audienceCount: successCount });
        await updateDoc(doc(db, "sellers", state.workspaceId), { messagesSentToday: increment(successCount) });

        await Swal.fire('Broadcast Finished! 🚀', `Delivered to ${successCount} users.`, 'success');
        window.location.hash = '#campaigns';

    } catch(err) { Swal.fire('Error', err.message, 'error'); }
}

async function executeTemplateSend(contacts, template, campaignId, mediaUrl = null) {
    let success = 0;
    const { metaPhoneId, metaToken } = state.sellerConfig;

    // Safe Data Extraction
    let rawBody = "";
    if (template.body) rawBody = template.body;
    else if (template.components) {
        const bComp = template.components.find(c => c.type === 'BODY' || c.type === 'body');
        if (bComp && bComp.text) rawBody = bComp.text;
    }
    const hasVariable = rawBody.includes('{{1}}');

    let hType = template.headerType || "NONE";
    if (template.components && hType === "NONE") {
        const hComp = template.components.find(c => c.type === 'HEADER' || c.type === 'header');
        if (hComp) hType = hComp.format || "NONE";
    }
    hType = hType.toUpperCase();
    
    const langCode = template.language || "en_US"; // Dynamic language fallback

    const promises = contacts.map(async (contact) => {
        const payload = {
            messaging_product: "whatsapp",
            to: contact.phone,
            type: "template",
            template: {
                name: template.name,
                language: { code: langCode },
                components: []
            },
            biz_opaque_callback_data: campaignId // Tracking ID
        };

        // Header mapping (For Image / Document)
        if (mediaUrl) {
            const headerComponent = { type: "header", parameters: [] };
            if (hType === "IMAGE") {
                headerComponent.parameters.push({ type: "image", image: { link: mediaUrl } });
            } else if (hType === "DOCUMENT") {
                headerComponent.parameters.push({ type: "document", document: { link: mediaUrl, filename: "Attachment.pdf" } });
            }
            if (headerComponent.parameters.length > 0) {
                payload.template.components.push(headerComponent);
            }
        }

        // Body mapping for {{1}}
        if(hasVariable) {
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

// 🟢 CSV Parser Optimized
function parseCSV(text) {
    // Splits by new line, handles potential \r formatting issues from Excel
    const lines = text.split(/\r?\n/);
    const results = [];
    
    // Start from i=1 to skip Header row (assuming Col A = Phone, Col B = Name)
    for (let i = 1; i < lines.length; i++) {
        if(!lines[i].trim()) continue;
        const row = lines[i].split(',');
        if (row[0]) {
            const cleanPhone = row[0].replace(/\D/g, ''); // Removes non-numeric
            if(cleanPhone.length >= 10) {
                results.push({ phone: cleanPhone, name: row[1]?.trim() || 'Customer' });
            }
        }
    }
    return results;
}
// ===================================
// NAYA: Live Media Preview Function
// ===================================
window.handleMediaPreview = (event) => {
    const file = event.target.files[0];
    const placeholder = document.getElementById('preview-media-placeholder');
    const imgPreview = document.getElementById('preview-media-img');

    // Agar user ne file cancel kar di
    if (!file) {
        imgPreview.classList.add('hidden');
        imgPreview.src = '';
        placeholder.classList.remove('hidden');
        placeholder.innerHTML = `
            <i class="fa-solid fa-image text-slate-400 text-2xl mb-1"></i>
            <span class="text-[8px] font-bold text-slate-500 uppercase tracking-widest">Media Header</span>
        `;
        return;
    }

    // Agar Image upload ki hai
    if (file.type.startsWith('image/')) {
        const fileUrl = URL.createObjectURL(file); // Browser memory me temporary URL
        imgPreview.src = fileUrl;
        imgPreview.classList.remove('hidden');
        placeholder.classList.add('hidden');
    } 
    // Agar PDF upload ki hai
    else if (file.type === 'application/pdf') {
        imgPreview.classList.add('hidden');
        placeholder.classList.remove('hidden');
        placeholder.innerHTML = `
            <i class="fa-solid fa-file-pdf text-red-500 text-3xl mb-1"></i>
            <span class="text-[9px] font-bold text-slate-700 mt-1 truncate w-full px-2">${file.name}</span>
        `;
    }
};
