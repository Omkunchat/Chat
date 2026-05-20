import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, serverTimestamp, collectionGroup, query, where, getDocs, collection } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    botData: {}
};

const MEDIA_API = "https://media-engine.chatkunhq.workers.dev";

// --- SAFE UI HELPERS (CRASH PROTECTION) ---
const safeSetVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
const safeSetCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
const safeGetVal = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
const safeGetCheck = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    // Workspace Finding Logic
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

    if (!canEditFeature(state.role, 'settings')) {
        const saveBtn = document.getElementById('btn-save-bot');
        if(saveBtn) saveBtn.style.display = 'none';
        showToast("Access Denied", "warning");
    }

    // 🚀 Load DB Templates into Dropdowns first
    await populateTemplatesDropdown();
    
    // Then load the saved settings
    await loadBotSetup();

    // Global Functions for UI Elements
    window.saveBotSetup = saveBotSetup;
    window.addDripStep = addDripStep;
    window.removeDripStep = removeDripStep;
    window.addFaq = addFaq;
    window.removeFaq = removeFaq;
    window.scrapeWebsite = scrapeWebsite;
    window.handleKnowledgeUpload = handleKnowledgeUpload;
}

export function destroy() {}

// 🚀 Fetch Templates from Firebase and Fill Dropdowns
async function populateTemplatesDropdown() {
    try {
        const tplRef = collection(db, "sellers", state.workspaceId, "templates");
        const tplSnap = await getDocs(tplRef);
        
        let optionsHtml = '<option value="">-- No Template Selected --</option>';
        let approvedCount = 0;

        tplSnap.forEach(doc => {
            const tpl = doc.data();
            // Show all templates, highlight APPROVED ones
            if (tpl.status === 'APPROVED') {
                optionsHtml += `<option value="${tpl.name}">${tpl.name} ✅</option>`;
                approvedCount++;
            } else {
                optionsHtml += `<option value="${tpl.name}">${tpl.name} (${tpl.status})</option>`;
            }
        });

        if (tplSnap.empty) {
            optionsHtml = '<option value="">⚠️ No templates found. Sync first!</option>';
        }

        // 🚀 FIX: Apply options to ALL select boxes safely, including the new reactivation dropdown
        ['tpl_agentAssign', 'tpl_abandonedCart', 'tpl_weeklyReport', 'tpl_reactivation'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.innerHTML = optionsHtml;
        });

    } catch (error) {
        console.error("Error loading templates list:", error);
    }
}

async function loadBotSetup() {
    try {
        const docSnap = await getDoc(doc(db, "sellers", state.workspaceId));
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            const bot = data.botTraining || {};
            state.botData = bot;

            // ── 1. Global Settings ──
            safeSetVal('ai_industry', bot.industry || "");
            safeSetVal('ai_currency', data.currency || bot.currency || "INR");
            safeSetVal('ai_timezone', bot.timezone || "Asia/Kolkata");
            
            // ── 2. AI Identity ──
            safeSetVal('ai_name', bot.name || data.aiName || "");
            safeSetVal('ai_tone', bot.tone || "professional");
            safeSetVal('ai_fallback', bot.fallbackMode || "assign_agent");
            safeSetVal('ai_customPrompt', bot.customPrompt || data.aiPrompt || "");
            
            // ── 3. CRM Intelligence ──
            safeSetCheck('ai_enableTagging', bot.enableTagging !== false);
            safeSetCheck('ai_enableSentiment', bot.enableSentiment !== false);

            // ── 4. Smart Business Hours ──
            safeSetCheck('ai_enableAwayMode', bot.enableAwayMode || false);
            safeSetVal('ai_workDays', bot.workDays || "mon_sat");
            safeSetVal('ai_openTime', bot.openTime || "10:00");
            safeSetVal('ai_closeTime', bot.closeTime || "20:00");
            safeSetVal('ai_awayMsg', bot.awayMsg || "");

            // ── 5. Welcome Experience ──
            safeSetVal('ai_welcomeMsg', bot.welcomeMsg || "");
            if (bot.welcomeBtns && bot.welcomeBtns.length > 0) {
                safeSetVal('ai_btn1', bot.welcomeBtns[0] || "");
                safeSetVal('ai_btn2', bot.welcomeBtns[1] || "");
            }

            // ── 6. LOAD META TEMPLATES ──
            safeSetVal('tpl_agentAssign', data.tplAgentAssign || "");
            safeSetVal('tpl_abandonedCart', data.tplAbandonedCart || "");
            safeSetVal('tpl_weeklyReport', data.tplWeeklyReport || "");
            safeSetVal('tpl_reactivation', data.tplReactivation || ""); // 🚀 NAYA: Smart Reactivation Load
            safeSetVal('tpl_language', data.tplLanguage || "en_US");

            // ── 7. Smart FAQs ──
            const faqCont = document.getElementById('faq-container');
            if (faqCont) {
                faqCont.innerHTML = ""; 
                if (bot.faqs && bot.faqs.length > 0) {
                    bot.faqs.forEach(faq => addFaq(faq.question || "", faq.keyword || "", faq.answer || ""));
                } else {
                    addFaq("Pricing Inquiry", "price, cost, rate, charges", "Our pricing starts at $99. Check our catalog.");
                }
            }

            // ── 8. Drip Sequences ──
            const dripCont = document.getElementById('drip-container');
            if (dripCont) {
                dripCont.innerHTML = ""; 
                if (bot.dripSteps && bot.dripSteps.length > 0) {
                    bot.dripSteps.forEach(step => addDripStep(step.hours, step.message));
                } else {
                    addDripStep(24, "Hi! Just checking in to see if you have any more questions? 😊");
                }
            }
        }
    } catch (e) {
        console.error("Error loading Bot Setup:", e);
        if (typeof showToast === 'function') showToast("Failed to load AI settings.", "error");
    }
}

// ❓ Smart FAQ Builder
function addFaq(q = "", k = "", a = "") {
    const cont = document.getElementById('faq-container');
    if(!cont) return;
    const id = `faq_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    
    const html = `
        <div id="${id}" class="faq-step bg-slate-50 border border-slate-200 p-3 rounded-xl relative group flex flex-col gap-2">
            <button onclick="window.removeFaq('${id}')" class="absolute top-2 right-2 text-slate-300 hover:text-red-500 transition"><i class="fa-solid fa-xmark"></i></button>
            <div>
                <input type="text" class="faq-q w-full bg-transparent text-[11px] font-black text-slate-700 outline-none pr-6" placeholder="Reference Question (e.g. What is the price?)" value="${q}">
            </div>
            <div class="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-1.5 focus-within:border-indigo-400 transition">
                <i class="fa-solid fa-key text-[10px] text-indigo-400 pl-1"></i>
                <input type="text" class="faq-k w-full bg-transparent text-[10px] font-bold text-indigo-900 outline-none placeholder-indigo-300" placeholder="Keywords (comma separated) e.g. price, cost, rate" value="${k}">
            </div>
            <textarea class="faq-a w-full bg-white border border-slate-200 rounded-lg text-[10px] font-medium p-2 text-slate-600 outline-none resize-none focus:border-indigo-400 transition" rows="2" placeholder="Exact AI Answer...">${a}</textarea>
        </div>
    `;
    cont.insertAdjacentHTML('beforeend', html);
}
function removeFaq(id) { document.getElementById(id)?.remove(); }

// 🕒 Add Drip Step
function addDripStep(hours = 24, msg = "") {
    const cont = document.getElementById('drip-container');
    if(!cont) return;
    const id = `drip_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const html = `
        <div id="${id}" class="drip-step bg-white/5 p-3 rounded-2xl border border-white/10 flex flex-col gap-2">
            <div class="flex justify-between items-center">
                <div class="flex items-center gap-2">
                    <span class="text-[9px] font-black uppercase text-indigo-300">Wait</span>
                    <input type="number" class="drip-hours w-12 bg-white/10 border-0 rounded-lg text-[10px] font-bold p-1 outline-none text-white text-center" value="${hours}">
                    <span class="text-[9px] font-black uppercase text-indigo-300">Hours</span>
                </div>
                <button onclick="window.removeDripStep('${id}')" class="text-white/40 hover:text-red-400"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div>
            <textarea class="drip-msg w-full bg-white/10 border-0 rounded-xl text-[10px] font-medium p-2 text-white outline-none resize-none" rows="2" placeholder="Type follow-up message...">${msg}</textarea>
        </div>
    `;
    cont.insertAdjacentHTML('beforeend', html);
}
function removeDripStep(id) { document.getElementById(id)?.remove(); }

// 💾 Save All AI Settings (UPDATED WITH GEMINI VECTOR SYNC)
async function saveBotSetup() {
    const btn = document.getElementById('btn-save-bot');
    const loader = document.getElementById('bot-loader');
    if (btn) btn.disabled = true;
    if (loader) loader.classList.remove('hidden');
    
    try {
        const faqs = [];
        document.querySelectorAll('.faq-step').forEach(el => {
            const q = el.querySelector('.faq-q').value.trim();
            const k = el.querySelector('.faq-k').value.trim();
            const a = el.querySelector('.faq-a').value.trim();
            if (k && a) faqs.push({ question: q, keyword: k, answer: a });
        });
        
        const dripSteps = [];
        document.querySelectorAll('.drip-step').forEach(el => {
            const h = el.querySelector('.drip-hours').value;
            const m = el.querySelector('.drip-msg').value.trim();
            if (m) dripSteps.push({ hours: parseInt(h), message: m });
        });
        
        const currencyVal = safeGetVal('ai_currency');
        const timezoneVal = safeGetVal('ai_timezone');
        
        const botData = {
            industry: safeGetVal('ai_industry'),
            currency: currencyVal,
            timezone: timezoneVal,
            name: safeGetVal('ai_name'),
            tone: safeGetVal('ai_tone'),
            fallbackMode: safeGetVal('ai_fallback'),
            customPrompt: safeGetVal('ai_customPrompt'),
            enableTagging: safeGetCheck('ai_enableTagging'),
            enableSentiment: safeGetCheck('ai_enableSentiment'),
            enableAwayMode: safeGetCheck('ai_enableAwayMode'),
            workDays: safeGetVal('ai_workDays'),
            openTime: safeGetVal('ai_openTime'),
            closeTime: safeGetVal('ai_closeTime'),
            awayMsg: safeGetVal('ai_awayMsg'),
            welcomeMsg: safeGetVal('ai_welcomeMsg'),
            welcomeBtns: [safeGetVal('ai_btn1'), safeGetVal('ai_btn2')].filter(Boolean),
            faqs: faqs,
            dripSteps: dripSteps,
            lastTrainedAt: serverTimestamp()
        };
        
        // 🚀 SAVE META TEMPLATES DATA
        const tplAgentAssign = safeGetVal('tpl_agentAssign');
        const tplAbandonedCart = safeGetVal('tpl_abandonedCart');
        const tplWeeklyReport = safeGetVal('tpl_weeklyReport');
        const tplReactivation = safeGetVal('tpl_reactivation');
        const tplLanguage = safeGetVal('tpl_language') || "en_US";
        
        // 1. Firebase mein save karein (Existing Logic)
        await setDoc(doc(db, "sellers", state.workspaceId), {
            botTraining: botData,
            aiName: botData.name,
            aiPrompt: botData.customPrompt,
            currency: currencyVal,
            tplAgentAssign: tplAgentAssign,
            tplAbandonedCart: tplAbandonedCart,
            tplWeeklyReport: tplWeeklyReport,
            tplReactivation: tplReactivation,
            tplLanguage: tplLanguage
        }, { merge: true });
        
        // =========================================================
        // 🚀 2. AUTO-SYNC WITH CLOUDFLARE GEMINI VECTOR DB
        // =========================================================
        // Yahan 'engine.chatkunhq.workers.dev' ko apne worker URL se verify kar lein
        const ENGINE_API_URL = "https://engine.chatkunhq.workers.dev/api/admin/add-faq";
        
        for (let i = 0; i < faqs.length; i++) {
            const faq = faqs[i];
            try {
                // Vector DB ko bhej rahe hain
                await fetch(ENGINE_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: `faq-${state.workspaceId}-${i}`, // Unique ID for each FAQ
                        text: `${faq.question} ${faq.keyword}`, // Gemini dono padh kar matlab samjhega
                        answer: faq.answer
                    })
                });
            } catch (err) {
                console.error("Vector DB Sync Failed for FAQ:", err);
            }
        }
        // =========================================================
        
        showToast("Intelligence Deployed & Gemini Brain Updated! 🚀", "success");
    } catch (e) {
        showToast("Deployment Failed", "error");
        console.error(e);
    } finally {
        if (btn) btn.disabled = false;
        if (loader) loader.classList.add('hidden');
    }
}

// 📄 Real PDF Parser Trigger
async function handleKnowledgeUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const statusLabel = document.getElementById('pdf-status');
    if(statusLabel) statusLabel.innerText = "Uploading file to Cloud Storage...";
    
    try {
        // 1. Storage me upload karein
        const res = await fetch(`${MEDIA_API}/get-presigned-url?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`);
        const { uploadUrl, publicUrl } = await res.json();
        await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }});
        
        if(statusLabel) statusLabel.innerText = "📑 Extracting PDF structural text...";

        // 2. Naye Knowledge Worker ko call karein text extract karne ke liye
        const processRes = await fetch("https://knowledge-engine.chatkunhq.workers.dev/process-pdf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sellerUid: state.workspaceId, targetUrl: publicUrl })
        });
        
        const processResult = await processRes.json();

        if(processResult.success) {
            if(statusLabel) statusLabel.innerText = "✅ PDF Knowledge Synced: " + file.name;
            showToast("PDF document read & fed into AI Brain! 🧠", "success");
        } else {
            throw new Error(processResult.error);
        }
    } catch (error) {
        console.error(error);
        if(statusLabel) statusLabel.innerText = "❌ PDF Extraction Failed";
        showToast("Upload or extraction failed", "error");
    }
}

// 🌐 Real Website Scraper Trigger
async function scrapeWebsite() {
    const url = safeGetVal('ai_webUrl');
    if(!url) return showToast("Enter a valid URL", "warning");
    
    const statusLabel = document.getElementById('pdf-status');
    if(statusLabel) statusLabel.innerText = "🕵️‍♂️ AI is crawling website content...";
    showToast("Website scraping started... AI is learning from it.", "info");

    try {
        // Call your new Knowledge Engine Worker directly
        const res = await fetch("https://knowledge-engine.chatkunhq.workers.dev/scrape", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sellerUid: state.workspaceId, targetUrl: url })
        });
        
        const result = await res.json();

        if (result.success) {
            if(statusLabel) statusLabel.innerText = `✅ Website Knowledge Synced (${result.bytesProcessed} bytes)`;
            showToast("Website content successfully added to AI Knowledge Base! 🧠", "success");
            safeSetVal('ai_webUrl', '');
        } else {
            throw new Error(result.error);
        }
    } catch (e) {
        console.error("Scraping error:", e);
        if(statusLabel) statusLabel.innerText = "❌ Sync Failed";
        showToast("Failed to scrape website. Ensure URL is public.", "error");
    }
}
