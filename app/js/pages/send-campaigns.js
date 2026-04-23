import { db, auth } from "../firebase.js";
import { 
    collection, addDoc, query, where, doc, updateDoc,
    serverTimestamp, getDocs, getDoc, collectionGroup, increment 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js"; // 🚀 NAYA: 'increment' import kiya
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    sellerConfig: null,
    products: [], 
    selectedCatalogImage: null, 
    pricing: { symbol: '₹', locale: 'en-IN' },
    metaDailyLimit: Infinity, // 🚀 NAYA: '1000' ki jagah 'Infinity' (Taaki Meta ki asli limit load hone tak faaltu block na kare)
    messagesSentToday: 0      // 🚀 NAYA: Track current usage
};

// 🚀 NAYA: Currency Detector
async function detectCurrency() {
    try {
        const res = await fetch('https://ipapi.co/json/');
        const data = await res.json();
        if (data.country_code !== 'IN') {
            state.pricing = { symbol: '$', locale: 'en-US' };
        }
    } catch (e) { console.error("Currency error"); }
}

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    // RBAC Setup
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

    if (!hasNavPermission(state.role, 'navBroadcast') || !canEditFeature(state.role, 'broadcast')) {
        window.location.hash = '#campaigns'; // Kick them back if no access
        return;
    }

    await loadSellerConfig();
    await detectCurrency();
    await loadCatalogProducts(); 
    loadDefaultButtons();
    checkCloneData();
    updateLivePreview(); // Run once to setup UI

    // Expose functions to window
    window.handleSaveCampaign = handleSaveCampaign;
    window.generateAITemplate = generateAITemplate;
    window.toggleCsvUpload = toggleCsvUpload;
    window.handleCatalogSelection = handleCatalogSelection;
    window.updateLivePreview = updateLivePreview;
    window.sendTestMessage = sendTestMessage;
}

export function destroy() {}

async function loadSellerConfig() {
    const snap = await getDoc(doc(db, "sellers", state.workspaceId));
    if(snap.exists()) {
        state.sellerConfig = snap.data();
        const bizName = state.sellerConfig.businessName || "Your Business";
        document.getElementById('preview-biz-name').innerText = bizName;
        
        // 🚀 UPDATE: Removed hardcoded 1000. 
        // Agar DB mein limit set nahi hai, toh temporarily Infinity (No Limit) manenge jab tak engine.js usko update na kar de.
        state.metaDailyLimit = state.sellerConfig.metaDailyLimit || Infinity; 
        state.messagesSentToday = state.sellerConfig.messagesSentToday || 0;
    }
}

async function loadCatalogProducts() {
    try {
        const q = query(collection(db, "products"), where("sellerId", "==", state.workspaceId));
        const snap = await getDocs(q);
        state.products = [];
        let optionsHtml = '<option value="">-- NO PRODUCT ATTACHED --</option>';
        snap.forEach(docSnap => {
            const p = docSnap.data();
            state.products.push({ id: docSnap.id, ...p });
            optionsHtml += `<option value="${docSnap.id}">${p.name} - ${state.pricing.symbol}${p.price}</option>`;
        });
        document.getElementById('campCatalogSelect').innerHTML = optionsHtml;
    } catch(e) {}
}

function loadDefaultButtons() {
    if (state.sellerConfig && state.sellerConfig.campDefaultBtns) {
        const btns = state.sellerConfig.campDefaultBtns;
        if (btns[0]) document.getElementById('campBtn1').value = btns[0];
        if (btns[1]) document.getElementById('campBtn2').value = btns[1];
        if (btns[2]) document.getElementById('campBtn3').value = btns[2];
    }
}

// 📱 REAL-TIME LIVE PREVIEW RENDERER
function updateLivePreview() {
    // 1. Update Text
    let text = document.getElementById('campMessage').value;
    text = text.replace(/{{name}}/gi, 'John Doe'); // Replace variable
    
    // Convert WhatsApp bold/italics for preview
    text = text.replace(/\*(.*?)\*/g, '<b>$1</b>');
    text = text.replace(/_(.*?)_/g, '<i>$1</i>');
    text = text.replace(/\n/g, '<br>');
    
    document.getElementById('preview-text').innerHTML = text || 'Your message will appear here...';

    // 2. Update Image
    const imgFile = document.getElementById('campImageFile').files[0];
    const imgContainer = document.getElementById('preview-image-container');
    const imgEl = document.getElementById('preview-image');

    if (imgFile) {
        imgEl.src = URL.createObjectURL(imgFile);
        imgContainer.classList.remove('hidden');
    } else if (state.selectedCatalogImage) {
        imgEl.src = state.selectedCatalogImage;
        imgContainer.classList.remove('hidden');
    } else {
        imgContainer.classList.add('hidden');
        imgEl.src = '';
    }

    // 3. Update Buttons
    const b1 = document.getElementById('campBtn1').value.trim();
    const b2 = document.getElementById('campBtn2').value.trim();
    const b3 = document.getElementById('campBtn3').value.trim();
    const btnContainer = document.getElementById('preview-buttons-container');
    
    const pb1 = document.getElementById('prev-btn-1');
    const pb2 = document.getElementById('prev-btn-2');
    const pb3 = document.getElementById('prev-btn-3');

    if (b1 || b2 || b3) {
        btnContainer.classList.remove('hidden');
        if (b1) { pb1.classList.remove('hidden'); pb1.querySelector('span').innerText = b1; } else { pb1.classList.add('hidden'); }
        if (b2) { pb2.classList.remove('hidden'); pb2.querySelector('span').innerText = b2; pb1.classList.remove('border-b-0'); pb1.classList.add('border-b'); } else { pb2.classList.add('hidden'); pb1.classList.remove('border-b'); }
        if (b3) { pb3.classList.remove('hidden'); pb3.querySelector('span').innerText = b3; pb2.classList.add('border-b'); } else { pb3.classList.add('hidden'); pb2.classList.remove('border-b'); }
    } else {
        btnContainer.classList.add('hidden');
    }
}

function handleCatalogSelection() {
    const selectedId = document.getElementById('campCatalogSelect').value;
    if(selectedId) {
        const prod = state.products.find(p => p.id === selectedId);
        if(prod && prod.imageUrl) {
            state.selectedCatalogImage = prod.imageUrl;
            document.getElementById('campImageFile').value = ''; // Clear manual file
        }
    } else {
        state.selectedCatalogImage = null;
    }
    updateLivePreview();
}

function toggleCsvUpload() {
    const aud = document.getElementById('campAudience').value;
    const csvWrap = document.getElementById('csv-upload-wrapper');
    if(aud === 'csv') csvWrap.classList.remove('hidden');
    else csvWrap.classList.add('hidden');
}

function generateAITemplate() {
    const msgBox = document.getElementById('campMessage');
    msgBox.value = "\u{1F389} *Special VIP Offer!* \u{1F389}\n\nHi {{name}},\n\nBecause you are a valued customer, we are giving you *Flat 30% OFF* on our new collection today!\n\nTap a button below to claim your offer. \u{1F447}";
    document.getElementById('campBtn1').value = "\u{1F6CD} Shop Now";
    document.getElementById('campBtn2').value = "🛑 Unsubscribe"; // 🚀 NAYA: AI template me by default Opt-out daal diya
    document.getElementById('campBtn3').value = "";
    updateLivePreview();
    showToast("Template Applied!", "success");
}

async function sendTestMessage() {
    const template = document.getElementById('campMessage').value;
    if (!template) { showToast("Message cannot be empty", "error"); return; }
    if (!state.sellerConfig?.metaToken) { showToast("Meta API not connected", "error"); return; }
    
    const { value: phone } = await Swal.fire({
        title: 'Send Test Preview',
        input: 'text',
        inputLabel: 'Enter WhatsApp Number (e.g. 919876543210)',
        showCancelButton: true,
        confirmButtonColor: '#2563EB'
    });

    if (phone) {
        showToast("Sending test...", "info");
        const b = [
            document.getElementById('campBtn1').value.trim(),
            document.getElementById('campBtn2').value.trim(),
            document.getElementById('campBtn3').value.trim()
        ].filter(x => x);
        
        let img = state.selectedCatalogImage;
        await executeMetaSend([{ phone: phone.replace(/\D/g, ''), name: "Test User" }], template, b, img, "test_message");
        showToast("Test Sent! Check WhatsApp.", "success");
    }
}

// 🕒 SEND OR SCHEDULE (THE CORE ENGINE)
async function handleSaveCampaign(e) {
    e.preventDefault();
    if (!state.sellerConfig?.metaToken) { showToast("WhatsApp API not connected!", "error"); return; }

    const name = document.getElementById('campName').value;
    const audienceType = document.getElementById('campAudience').value;
    const messageTemplate = document.getElementById('campMessage').value;
    const aiReply = document.getElementById('campAiReply').checked;
    const imgFile = document.getElementById('campImageFile').files[0];
    
    const buttonsRaw = [
        document.getElementById('campBtn1').value.trim(),
        document.getElementById('campBtn2').value.trim(),
        document.getElementById('campBtn3').value.trim()
    ].filter(b => b);

    // 🚀 NAYA: ANTI-SPAM OPT-OUT CHECKER
    const hasOptOut = buttonsRaw.some(b => b.toLowerCase().includes('stop') || b.toLowerCase().includes('unsubscribe') || b.toLowerCase().includes('opt-out'));
    if (!hasOptOut) {
        const confirmSpamRisk = await Swal.fire({
            title: '⚠️ Missing Opt-Out Button',
            text: 'Meta strictly recommends adding a "Stop" or "Unsubscribe" button in marketing messages. Sending without it may lead to account ban. Proceed anyway?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: 'Yes, Send Anyway',
            cancelButtonText: 'Let me add it'
        });
        if (!confirmSpamRisk.isConfirmed) return; // User ruk gaya add karne ke liye
    }

    try {
        let contacts = [];
        if (audienceType === 'csv') {
            const f = document.getElementById('campCsvFile');
            if(!f.files[0]) throw new Error("Select a CSV file.");
            contacts = parseCSV(await f.files[0].text());
        } else {
            Swal.fire({ title: 'Fetching CRM Contacts...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            if (audienceType === 'all' || audienceType === 'hot') {
                const snap = await getDocs(collection(db, "sellers", state.user.uid, "chats"));
                snap.forEach(d => {
                    if (audienceType === 'all' || (audienceType === 'hot' && d.data().leadStatus === 'hot')) {
                        contacts.push({ phone: d.id, name: d.data().customerName || 'Customer' });
                    }
                });
            } else if (audienceType === 'past') {
                const snap = await getDocs(collection(db, "sellers", state.user.uid, "customers"));
                snap.forEach(d => {
                    if (d.data().lastOrderName && d.data().lastOrderName !== "None") {
                        contacts.push({ phone: d.id, name: d.data().name || 'Customer' });
                    }
                });
            }
        }

        if(contacts.length === 0) throw new Error("No valid contacts found.");

        // 🚀 NAYA: DYNAMIC REAL-TIME LIMIT BLOCKER
        let availableLimit = Infinity;
        if (typeof state.metaDailyLimit === 'number' && state.metaDailyLimit !== Infinity) {
            availableLimit = state.metaDailyLimit - state.messagesSentToday;
        }

        if (contacts.length > availableLimit) {
            throw new Error(`Limit Exceeded! You are trying to send ${contacts.length} messages, but your remaining daily limit is only ${availableLimit}.`);
        }

        // Ask: Send Now or Schedule
        const schedResult = await Swal.fire({
            title: 'Broadcast Action',
            text: `Ready to reach ${contacts.length} users. Send now or schedule?`,
            icon: 'question',
            showDenyButton: true,
            showCancelButton: true,
            confirmButtonText: '<i class="fa-solid fa-paper-plane"></i> Send Now',
            denyButtonText: '<i class="fa-solid fa-clock"></i> Schedule Later',
            confirmButtonColor: '#2563EB',
            denyButtonColor: '#0F172A'
        });

        if (schedResult.isDismissed) return;

        let isScheduled = false;
        let scheduledTime = null;

        if (schedResult.isDenied) {
            const { value: dateStr } = await Swal.fire({
                title: 'Select Date & Time',
                html: '<input type="datetime-local" id="swal-sched-input" class="w-full p-3 border border-slate-200 rounded-xl mt-2">',
                preConfirm: () => document.getElementById('swal-sched-input').value
            });
            if (!dateStr) return;
            scheduledTime = new Date(dateStr).getTime();
            isScheduled = true;
        }

        let finalImageUrl = state.selectedCatalogImage || null;

        if (imgFile) {
            Swal.fire({ title: 'Uploading Media...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            const MEDIA_API = "https://media-engine.chatkunhq.workers.dev"; 
            const preRes = await fetch(`${MEDIA_API}/get-presigned-url?filename=${encodeURIComponent(imgFile.name)}&type=${encodeURIComponent(imgFile.type)}&bucket=marketing`);
            const { uploadUrl, publicUrl } = await preRes.json();
            await fetch(uploadUrl, { method: 'PUT', body: imgFile, headers: { 'Content-Type': imgFile.type }});
            finalImageUrl = publicUrl;
        }

        if (isScheduled) {
            await addDoc(collection(db, "campaigns"), {
                sellerId: state.user.uid, name, audienceType, message: messageTemplate,
                buttons: buttonsRaw, hasImage: !!finalImageUrl, aiReply, status: 'scheduled',
                scheduledAt: scheduledTime, audienceCount: contacts.length, createdAt: serverTimestamp()
            });
            await Swal.fire('Scheduled!', 'Your campaign is locked and loaded.', 'success');
            window.location.hash = '#campaigns';
        } else {
            const campRef = await addDoc(collection(db, "campaigns"), {
                sellerId: state.user.uid, name, audienceType, message: messageTemplate,
                buttons: buttonsRaw, status: 'processing', audienceCount: contacts.length, createdAt: serverTimestamp()
            });

            Swal.fire({
                title: 'Sending Campaign...',
                html: 'Queue Processing...<br><br><b><span id="queue-progress">0</span></b> / ' + contacts.length,
                allowOutsideClick: false, didOpen: () => Swal.showLoading()
            });

            let successCount = 0;
            const CHUNK_SIZE = 50; 
            for (let i = 0; i < contacts.length; i += CHUNK_SIZE) {
                const chunk = contacts.slice(i, i + CHUNK_SIZE);
                successCount += await executeMetaSend(chunk, messageTemplate, buttonsRaw, finalImageUrl, campRef.id);
                const pEl = document.getElementById('queue-progress');
                if(pEl) pEl.innerText = Math.min(i + CHUNK_SIZE, contacts.length);
                await new Promise(r => setTimeout(r, 1000));
            }

            await updateDoc(doc(db, "campaigns", campRef.id), {
                status: 'sent', 
                audienceCount: successCount, 
                lastUpdated: serverTimestamp()
            });

            // 🚀 NAYA: Update Global Daily Counter in Database Safely
            await updateDoc(doc(db, "sellers", state.workspaceId), {
                messagesSentToday: increment(successCount)
            });

            await Swal.fire('Broadcast Sent! 🎉', `Successfully sent to ${successCount} contacts.`, 'success');
            window.location.hash = '#campaigns'; 
        }
    } catch(err) { 
        Swal.fire('Error', err.message, 'error');
    }
}

async function executeMetaSend(contactsArray, template, buttons, imageUrl, campaignId) {
    let success = 0;
    const promises = contactsArray.map(async (contact) => {
        let msg = template.replace(/{{name}}/gi, contact.name || 'Customer');
        
        let payload = { 
            messaging_product: "whatsapp", 
            to: contact.phone,
            biz_opaque_callback_data: campaignId // 🚀 THE INVISIBLE TRACKER STAMP
        };

        if (buttons.length > 0) {
            payload.type = "interactive";
            payload.interactive = {
                type: "button", body: { text: msg },
                // 🚀 NAYA: Meta allows max 20 chars for buttons, enforced here
                action: { buttons: buttons.map((t, i) => ({ type: "reply", reply: { id: `btn_${i}`, title: t.substring(0, 20) } })) }
            };
            if (imageUrl) payload.interactive.header = { type: "image", image: { link: imageUrl } };
        } else if (imageUrl) {
            payload.type = "image"; payload.image = { link: imageUrl, caption: msg };
        } else {
            payload.type = "text"; payload.text = { body: msg, preview_url: true };
        }

        try {
            const res = await fetch(`https://graph.facebook.com/v18.0/${state.sellerConfig.metaPhoneId}/messages`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${state.sellerConfig.metaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if(res.ok) success++;
        } catch(err) {}
    });

    await Promise.all(promises);
    return success;
}

function parseCSV(text) {
    const lines = text.split('\n');
    const contacts = [];
    for(let i=0; i<lines.length; i++) {
        const row = lines[i].split(',');
        if(row[0] && row[0].trim()) {
            let phone = row[0].replace(/\D/g, ''); 
            let name = row[1] ? row[1].trim() : 'Customer';
            if(phone.length >= 10) contacts.push({phone, name});
        }
    }
    return contacts;
}

// 🐑 PRE-FILL CLONED CAMPAIGN DATA
function checkCloneData() {
    const cloneDataStr = localStorage.getItem('chatkun_clone_campaign');
    
    if (cloneDataStr) {
        try {
            const camp = JSON.parse(cloneDataStr);
            
            if (document.getElementById('campName')) document.getElementById('campName').value = camp.name + " (Copy)";
            if (document.getElementById('campAudience')) {
                document.getElementById('campAudience').value = camp.audienceType || 'all';
                window.toggleCsvUpload(); 
            }
            if (document.getElementById('campMessage')) document.getElementById('campMessage').value = camp.message || "";
            if (document.getElementById('campAiReply')) document.getElementById('campAiReply').checked = camp.aiReply !== false;
            
            if (camp.buttons && camp.buttons.length > 0) {
                if (document.getElementById('campBtn1')) document.getElementById('campBtn1').value = camp.buttons[0] || "";
                if (document.getElementById('campBtn2')) document.getElementById('campBtn2').value = camp.buttons[1] || "";
                if (document.getElementById('campBtn3')) document.getElementById('campBtn3').value = camp.buttons[2] || "";
            }

            showToast("Campaign Cloned Successfully!", "success");
        } catch (e) {
            console.error("Error loading clone data", e);
        } finally {
            localStorage.removeItem('chatkun_clone_campaign');
        }
    }
}