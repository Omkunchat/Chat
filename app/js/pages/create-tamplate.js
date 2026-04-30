import { db, auth } from "../firebase.js";
import { collection, doc, addDoc, setDoc, getDoc, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";

// --- GLOBAL STATE ---
const ENGINE_URL = "https://media-engine.chatkunhq.workers.dev"; 
let state = {
    user: null, 
    workspaceId: null, 
    sellerConfig: null,
    headerType: 'NONE', 
    buttons: [], 
    uploadedMediaUrl: null,
    isEditMode: false,
    editTemplateId: null,
    editTemplateMetaId: null
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    try {
        const ownerSnap = await getDoc(doc(db, "sellers", state.user.uid));
        if (ownerSnap.exists()) {
            state.workspaceId = state.user.uid;
            state.sellerConfig = ownerSnap.data();
        } else {
            state.workspaceId = state.user.uid;
        }

        // Bind Window Functions for HTML
        window.setTplHeader = setTplHeader;
        window.handleMediaUpload = handleMediaUpload;
        window.updatePreview = updatePreview;
        window.addButton = addButton;
        window.removeBtn = removeBtn;
        window.updateBtnType = updateBtnType;
        window.updateBtnText = updateBtnText;
        window.updateBtnValue = updateBtnValue;
        window.validateField = validateField;
        window.syncMetaTemplates = syncMetaTemplates; 

        const form = document.getElementById('adv-tpl-form');
        if(form) form.addEventListener('submit', submitToMeta);

        // Real-time Listeners for Inputs
        document.getElementById('tpl-name')?.addEventListener('input', () => validateField('tpl-name'));
        document.getElementById('tpl-body')?.addEventListener('input', () => { validateField('tpl-body'); updatePreview(); });
        document.getElementById('tpl-footer')?.addEventListener('input', () => { validateField('tpl-footer'); updatePreview(); });
        document.getElementById('header-text-input')?.addEventListener('input', () => { updatePreview(); });
        
        // URL se Edit Mode handle karna
        const urlParams = new URLSearchParams(window.location.search);
        if(urlParams.has('edit_id')) {
            await loadTemplateForEdit(urlParams.get('edit_id'));
        } else {
            updatePreview();
        }
    } catch (e) {
        console.error("Init Error:", e);
    }
}

// --- COMPLETE VALIDATION LOGIC ---
function validateField(id) {
    const input = document.getElementById(id);
    const errorEl = document.getElementById(`error-${id}`);
    if (!errorEl || !input) return true;

    let isValid = true;
    let msg = "";

    if (id === 'tpl-name') {
        const regex = /^[a-z0-9_]+$/;
        if (!input.value.trim()) { msg = "❌ Template name is required!"; isValid = false; }
        else if (!regex.test(input.value)) { msg = "❌ Only lowercase letters, numbers & underscores!"; isValid = false; }
    }

    if (id === 'tpl-body') {
        if (!input.value.trim()) { msg = "❌ Message body cannot be empty!"; isValid = false; }
        else if (input.value.length > 1024) { msg = "❌ Body too long (Max 1024 chars)!"; isValid = false; }
    }

    if (id === 'tpl-footer') {
        if (input.value.length > 60) { msg = "❌ Footer too long (Max 60 chars)!"; isValid = false; }
    }

    if (!isValid) {
        errorEl.innerText = msg;
        errorEl.classList.remove('hidden');
        input.classList.add('border-red-500', 'bg-red-50');
    } else {
        errorEl.classList.add('hidden');
        input.classList.remove('border-red-500', 'bg-red-50');
    }
    return isValid;
}

function validateForm() {
    const fields = ['tpl-name', 'tpl-body', 'tpl-footer'];
    let allOk = true;
    fields.forEach(f => { if (!validateField(f)) allOk = false; });

    state.buttons.forEach((b, i) => {
        if (!b.text.trim()) {
            showToast(`Button ${i+1} cannot be empty`, "error");
            allOk = false;
        } else if (b.text.length > 25) {
            showToast(`Button ${i+1} is too long (Max 25 chars)`, "error");
            allOk = false;
        }
    });

    if (['IMAGE', 'VIDEO'].includes(state.headerType) && !state.uploadedMediaUrl && !state.isEditMode) {
        showToast("Please upload media first!", "error");
        allOk = false;
    }
    return allOk;
}

// --- COMPLETE MEDIA UPLOAD LOGIC ---
async function handleMediaUpload(input) {
    const file = input.files[0];
    if(!file) return;

    const statusLabel = document.getElementById('upload-status');
    if(statusLabel) {
        statusLabel.innerHTML = `Uploading... <i class="fa-solid fa-spinner fa-spin"></i>`;
        statusLabel.className = "text-[9px] font-black text-blue-500 mt-3 block";
        statusLabel.classList.remove('hidden');
    }

    try {
        const res = await fetch(`${ENGINE_URL}/get-presigned-url?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`);
        if(!res.ok) throw new Error("Could not get upload URL");
        
        const { uploadUrl, publicUrl } = await res.json();
        
        const putRes = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
        if(!putRes.ok) throw new Error("AWS Upload Failed");

        state.uploadedMediaUrl = publicUrl;
        
        if(statusLabel) {
            statusLabel.innerHTML = "✅ MEDIA UPLOADED";
            statusLabel.className = "text-[9px] font-black text-emerald-500 mt-3 block";
        }

        if(file.type.startsWith('image')) {
            const preImg = document.getElementById('pre-img');
            const preIcon = document.getElementById('pre-icon');
            if(preImg) {
                preImg.src = URL.createObjectURL(file);
                preImg.classList.remove('hidden');
            }
            if(preIcon) preIcon.classList.add('hidden');
        }
    } catch (e) {
        if(statusLabel) {
            statusLabel.innerText = "❌ UPLOAD FAILED";
            statusLabel.className = "text-[9px] font-black text-red-500 mt-3 block";
        }
    }
}

// --- COMPLETE UI HELPERS ---
function setTplHeader(type) {
    state.headerType = type;
    const textInp = document.getElementById('header-text-input');
    const mediaBox = document.getElementById('media-upload-area');
    
    document.querySelectorAll('.header-btn').forEach(btn => {
        const isSel = btn.dataset.type === type;
        btn.className = isSel ? "header-btn px-4 py-2 rounded-xl bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest transition-all" : "header-btn px-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-slate-400 text-[9px] font-black uppercase tracking-widest transition-all";
    });

    if(textInp) textInp.classList.toggle('hidden', type !== 'TEXT');
    if(mediaBox) mediaBox.classList.toggle('hidden', !['IMAGE', 'VIDEO'].includes(type));
    updatePreview();
}

function updatePreview() {
    const bodyText = document.getElementById('tpl-body')?.value || "Your message preview here...";
    const footerText = document.getElementById('tpl-footer')?.value || "";
    const headerText = document.getElementById('header-text-input')?.value || "";

    const preBody = document.getElementById('pre-body');
    const preFooter = document.getElementById('pre-footer');
    const preHeaderText = document.getElementById('pre-header-text');
    const mediaBox = document.getElementById('pre-media-box');

    if(preBody) preBody.innerHTML = bodyText.replace(/\{\{\d+\}\}/g, m => `<b class="text-blue-600">${m}</b>`).replace(/\n/g, '<br>');
    if(preFooter) preFooter.innerText = footerText;
    if(preHeaderText) preHeaderText.innerText = state.headerType === 'TEXT' ? headerText : "";
    if(mediaBox) mediaBox.classList.toggle('hidden', !['IMAGE', 'VIDEO'].includes(state.headerType));

    renderPreviewButtons();
}

function addButton() {
    if(state.buttons.length >= 3) return showToast("Max 3 buttons allowed", "error");
    state.buttons.push({ id: Date.now(), type: 'QUICK_REPLY', text: '', value: '' });
    renderButtonsForm();
    updatePreview();
}

function renderButtonsForm() {
    const container = document.getElementById('btn-container');
    if(!container) return;
    container.innerHTML = state.buttons.map((b, idx) => `
        <div class="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-2xl mb-2">
            <div class="flex gap-2">
                <select onchange="window.updateBtnType(${b.id}, this.value)" class="bg-white border border-slate-100 rounded-xl text-[9px] font-black uppercase w-1/3 outline-none">
                    <option value="QUICK_REPLY" ${b.type === 'QUICK_REPLY'?'selected':''}>Quick Reply</option>
                    <option value="URL" ${b.type === 'URL'?'selected':''}>Visit Website</option>
                </select>
                <input type="text" placeholder="Button Label" value="${b.text}" onkeyup="window.updateBtnText(${b.id}, this.value)" class="flex-1 px-3 py-2 bg-white border border-slate-100 rounded-xl text-[11px] font-bold outline-none">
                <button type="button" onclick="window.removeBtn(${b.id})" class="text-red-400 px-2 hover:text-red-600"><i class="fa-solid fa-trash-can text-sm"></i></button>
            </div>
            ${b.type === 'URL' ? `<input type="url" placeholder="https://..." value="${b.value}" onkeyup="window.updateBtnValue(${b.id}, this.value)" class="w-full px-3 py-2 bg-white border border-slate-100 rounded-xl text-[10px] font-bold outline-none">` : ''}
        </div>
    `).join('');
}

function renderPreviewButtons() {
    const pre = document.getElementById('pre-buttons');
    if(!pre) return;
    pre.innerHTML = state.buttons.map(b => `<div class="w-full bg-white text-blue-500 font-bold text-[10px] py-2 mb-1 rounded-lg shadow-sm text-center border border-slate-100">${b.text || 'Action'}</div>`).join('');
}

function removeBtn(id) { state.buttons = state.buttons.filter(b => b.id !== id); renderButtonsForm(); updatePreview(); }
function updateBtnType(id, val) { const b = state.buttons.find(b => b.id === id); b.type = val; renderButtonsForm(); updatePreview(); }
function updateBtnText(id, val) { const b = state.buttons.find(b => b.id === id); b.text = val; updatePreview(); }
function updateBtnValue(id, val) { const b = state.buttons.find(b => b.id === id); b.value = val; }


// --- COMPLETE EDIT TEMPLATE PRE-FILL LOGIC ---
async function loadTemplateForEdit(docId) {
    try {
        const docSnap = await getDoc(doc(db, "sellers", state.workspaceId, "templates", docId));
        if(docSnap.exists()) {
            const tpl = docSnap.data();
            state.isEditMode = true;
            state.editTemplateId = docId;
            state.editTemplateMetaId = tpl.metaId; 
            
            // Name set karke disable kar do (Meta allows edit components, not name)
            const nameInput = document.getElementById('tpl-name');
            if(nameInput) {
                nameInput.value = tpl.name || "";
                nameInput.disabled = true;
                nameInput.classList.add('bg-slate-100', 'text-slate-400');
            }

            // Loop through components to fill form inputs
            if(tpl.components && Array.isArray(tpl.components)) {
                tpl.components.forEach(comp => {
                    if (comp.type === 'BODY') {
                        const bodyInput = document.getElementById('tpl-body');
                        if(bodyInput) bodyInput.value = comp.text || "";
                    }
                    if (comp.type === 'FOOTER') {
                        const footerInput = document.getElementById('tpl-footer');
                        if(footerInput) footerInput.value = comp.text || "";
                    }
                    if (comp.type === 'HEADER') {
                        setTplHeader(comp.format); // Trigger UI toggle
                        if (comp.format === 'TEXT') {
                            const headerInput = document.getElementById('header-text-input');
                            if(headerInput) headerInput.value = comp.text || "";
                        }
                    }
                    if (comp.type === 'BUTTONS') {
                        state.buttons = []; // Clear array
                        comp.buttons.forEach((b, index) => {
                            state.buttons.push({
                                id: Date.now() + index,
                                type: b.type,
                                text: b.text || '',
                                value: b.url || b.phone_number || ''
                            });
                        });
                        renderButtonsForm();
                    }
                });
            }
            
            updatePreview();
            showToast("Edit Mode Active", "info");
        }
    } catch(e) { 
        console.error("Load Template Error:", e); 
    }
}


// --- COMPLETE TEMPLATE SYNC LOGIC (FETCH ALL FROM META) ---
async function syncMetaTemplates() {
    const { metaWabaId, metaToken } = state.sellerConfig || {}; 
    if(!metaWabaId || !metaToken) {
        showToast("Missing WABA ID or Token in Settings", "error");
        return;
    }

    const syncBtn = document.getElementById('sync-btn');
    if(syncBtn) {
        syncBtn.innerText = "Syncing...";
        syncBtn.disabled = true;
    }
    
    showToast("Syncing templates from Meta...", "info");
    
    try {
        const res = await fetch(`https://graph.facebook.com/v19.0/${metaWabaId}/message_templates?limit=200`, {
            headers: { 'Authorization': `Bearer ${metaToken}` }
        });
        const data = await res.json();
        
        if(data.error) throw new Error(data.error.message);

        // Loop through all templates and update to Firestore
        const batchTemplates = data.data;
        for (const tpl of batchTemplates) {
            await setDoc(doc(db, "sellers", state.workspaceId, "templates", tpl.id), {
                name: tpl.name,
                metaId: tpl.id,
                status: tpl.status,
                language: tpl.language,
                category: tpl.category,
                components: tpl.components,
                lastSynced: serverTimestamp()
            }, { merge: true });
        }
        
        showToast("Sync Complete! All templates fetched.", "success");
    } catch (e) {
        console.error("Sync Error:", e);
        showToast("Sync failed: " + e.message, "error");
    } finally {
        if(syncBtn) {
            syncBtn.innerText = "Sync Templates";
            syncBtn.disabled = false;
        }
    }
}


// --- COMPLETE SUBMIT LOGIC (META UPLOAD + CORS BYPASS FIX) ---
async function submitToMeta(e) {
    e.preventDefault();
    if (!validateForm()) return;

    const btn = document.getElementById('submit-btn');
    const { metaWabaId, metaToken, metaAppId } = state.sellerConfig || {}; 
    
    if(!metaWabaId || !metaToken || !metaAppId) {
        return Swal.fire("Config Missing", "App ID, WABA ID or Token is missing in Settings.", "error");
    }

    btn.innerText = state.isEditMode ? "Updating Template..." : "Processing Media..."; 
    btn.disabled = true;

    try {
        let headerHandle = "";

        // --- STEP 1: UPLOAD TO META VIA CORS PROXY (THE MAGIC FIX) ---
        if(['IMAGE', 'VIDEO'].includes(state.headerType)) {
            const fileInput = document.getElementById('tpl-media-file');
            const file = fileInput.files[0];
            
            if(file) {
                btn.innerText = "Bypassing Meta Security...";
                
                // 1. Create Upload Session
                const sessionUrl = `https://graph.facebook.com/v19.0/${metaAppId}/uploads?file_length=${file.size}&file_type=${file.type}&access_token=${metaToken}`;
                const sessionRes = await fetch(sessionUrl, { method: 'POST' });
                const sessionData = await sessionRes.json();
                
                if(sessionData.error) throw new Error("Meta Session Error: " + sessionData.error.message);

                // 2. Upload Binary Data (CORS proxy wrapped to prevent browser block)
                const targetUploadUrl = `https://graph.facebook.com/v19.0/${sessionData.id}`;
                const proxyUploadUrl = `https://corsproxy.io/?${encodeURIComponent(targetUploadUrl)}`;

                const uploadRes = await fetch(proxyUploadUrl, {
                    method: 'POST',
                    headers: { 
                        'Authorization': `OAuth ${metaToken}`, 
                        'file_offset': '0' 
                    },
                    body: file
                });
                
                const uploadData = await uploadRes.json();
                if(uploadData.error) throw new Error("Meta Upload Error: " + uploadData.error.message);
                if(!uploadData.h) throw new Error("Meta Upload Failed: No handle returned");
                
                headerHandle = uploadData.h; 
            }
        }

        // --- STEP 2: BUILD COMPONENTS PAYLOAD ---
        btn.innerText = "Submitting Template...";
        let components = [];

        const bodyText = document.getElementById('tpl-body').value.trim();
        const bodyComp = { type: "BODY", text: bodyText };
        const vars = bodyText.match(/\{\{\d+\}\}/g);
        if (vars) { bodyComp.example = { body_text: [vars.map((_, i) => `Sample${i+1}`)] }; }
        components.push(bodyComp);

        if(state.headerType === 'TEXT') {
            components.push({ type: "HEADER", format: "TEXT", text: document.getElementById('header-text-input').value.trim() });
        } else if(['IMAGE', 'VIDEO'].includes(state.headerType) && headerHandle) {
            // Only header_handle is accepted here by Meta
            components.push({ type: "HEADER", format: state.headerType, example: { header_handle: [headerHandle] } });
        }

        const footer = document.getElementById('tpl-footer').value.trim();
        if(footer) components.push({ type: "FOOTER", text: footer });
        
        if(state.buttons.length > 0) {
            components.push({ type: "BUTTONS", buttons: state.buttons.map(b => ({ type: b.type, text: b.text.trim(), ...(b.type === 'URL' && { url: b.value.trim() }) })) });
        }

        // --- STEP 3: API CALL TO META ---
        let tplName = document.getElementById('tpl-name').value.toLowerCase().trim();
        let apiUrl = "";
        
        if (state.isEditMode && state.editTemplateMetaId) {
            apiUrl = `https://graph.facebook.com/v19.0/${state.editTemplateMetaId}`;
        } else {
            apiUrl = `https://graph.facebook.com/v19.0/${metaWabaId}/message_templates`;
            tplName = tplName + "_" + Date.now().toString().slice(-4); 
        }

        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${metaToken}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ 
                name: tplName, 
                language: "en_US", 
                category: document.getElementById('tpl-category')?.value || 'MARKETING', 
                components 
            })
        });

        const data = await res.json();
        if(data.error) throw new Error(data.error.error_user_title || data.error.message || "Rejected by Meta");

        // Save to Database
        const tplDocId = state.isEditMode ? state.editTemplateId : tplName;
        await setDoc(doc(db, "sellers", state.workspaceId, "templates", tplDocId), {
            name: tplName,
            metaId: data.id || state.editTemplateMetaId,
            status: 'PENDING',
            updatedAt: serverTimestamp(),
            ...( !state.isEditMode && { createdAt: serverTimestamp() } )
        }, { merge: true });

        Swal.fire("Success!", `Template ${state.isEditMode ? 'Updated' : 'Created'} Successfully!`, "success").then(() => window.location.hash='#tamplate');

    } catch (e) {
        console.error("DEBUG ERROR:", e);
        Swal.fire("Meta Error", e.message, "error");
    } finally {
        btn.innerText = state.isEditMode ? "Update Template" : "Submit for Meta Approval"; 
        btn.disabled = false;
    }
}
