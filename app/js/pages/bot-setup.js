import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, serverTimestamp, collectionGroup, query, where, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    botData: {}
};

const MEDIA_API = "https://media-engine.chatkunhq.workers.dev";

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
        document.getElementById('btn-save-bot').style.display = 'none';
        showToast("Access Denied", "warning");
    }

    await loadBotSetup();

    // Global Functions for UI Elements
    window.saveBotSetup = saveBotSetup;
    window.addDripStep = addDripStep;
    window.removeDripStep = removeDripStep;
    window.addFaq = addFaq;
    window.removeFaq = removeFaq;
}

export function destroy() {}

async function loadBotSetup() {
    try {
        // Firebase se current workspace (seller) ka document fetch karo
        const docSnap = await getDoc(doc(db, "sellers", state.workspaceId));
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            const bot = data.botTraining || {};
            state.botData = bot;

            // ── 1. Global / Universal Settings ──
document.getElementById('ai_industry').value = bot.industry || "";
            // Agar root 'data' mein currency/timezone save hai, toh usko priority do warna 'bot' map se lo
            document.getElementById('ai_currency').value = data.currency || bot.currency || "INR";
            document.getElementById('ai_timezone').value = data.timezone || bot.timezone || "Asia/Kolkata";
            
            // ── 2. AI Identity & Fallback ──
            document.getElementById('ai_name').value = bot.name || data.aiName || "";
            document.getElementById('ai_tone').value = bot.tone || "professional";
            document.getElementById('ai_fallback').value = bot.fallbackMode || "assign_agent";
            document.getElementById('ai_customPrompt').value = bot.customPrompt || data.aiPrompt || "";
            
            // ── 3. CRM Intelligence Switches ──
            // Default true rakho agar pehli baar setup ho raha hai (undefined pe true)
            document.getElementById('ai_enableTagging').checked = bot.enableTagging !== false;
            document.getElementById('ai_enableSentiment').checked = bot.enableSentiment !== false;

            // ── 4. Smart Business Hours ──
            document.getElementById('ai_enableAwayMode').checked = bot.enableAwayMode || false;
            document.getElementById('ai_workDays').value = bot.workDays || "mon_sat";
            document.getElementById('ai_openTime').value = bot.openTime || "10:00";
            document.getElementById('ai_closeTime').value = bot.closeTime || "20:00";
            document.getElementById('ai_awayMsg').value = bot.awayMsg || "";

            // ── 5. Welcome Experience ──
            document.getElementById('ai_welcomeMsg').value = bot.welcomeMsg || "";
            if (bot.welcomeBtns && bot.welcomeBtns.length > 0) {
                document.getElementById('ai_btn1').value = bot.welcomeBtns[0] || "";
                document.getElementById('ai_btn2').value = bot.welcomeBtns[1] || "";
            }

            // ── 6. Load Smart FAQs (Zero-Cost Routing) ──
            const faqCont = document.getElementById('faq-container');
            if (faqCont) {
                faqCont.innerHTML = ""; // Container clear karo
                if (bot.faqs && bot.faqs.length > 0) {
                    bot.faqs.forEach(faq => {
                        // Naya FAQ render karo (question, keyword, answer)
                        addFaq(faq.question || "", faq.keyword || "", faq.answer || "");
                    });
                } else {
                    // Default example unke liye jo pehli baar setup kar rahe hain
                    addFaq(
                        "Pricing Inquiry", 
                        "price, cost, rate, charges, kitne ka", 
                        "Our pricing starts at $99. Please check our catalog for more details."
                    );
                }
            }

            // ── 7. Load Marketing Drip Sequences ──
            const dripCont = document.getElementById('drip-container');
            if (dripCont) {
                dripCont.innerHTML = ""; // Container clear karo
                if (bot.dripSteps && bot.dripSteps.length > 0) {
                    bot.dripSteps.forEach(step => {
                        addDripStep(step.hours, step.message);
                    });
                } else {
                    // Default example 24 ghante ke liye
                    addDripStep(24, "Hi! Just checking in to see if you have any more questions? 😊");
                }
            }
        }
    } catch (e) {
        console.error("Error loading Bot Setup:", e);
        if (typeof showToast === 'function') {
            showToast("Failed to load AI settings.", "error");
        }
    }
}

// ❓ Smart FAQ Builder Logic (Keywords added)
function addFaq(q = "", k = "", a = "") {
    const cont = document.getElementById('faq-container');
    const id = `faq_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    
    // UI mein Question, Keywords (comma separated) aur Answer ki fields
    const html = `
        <div id="${id}" class="faq-step bg-slate-50 border border-slate-200 p-3 rounded-xl relative group flex flex-col gap-2">
            <button onclick="window.removeFaq('${id}')" class="absolute top-2 right-2 text-slate-300 hover:text-red-500 transition"><i class="fa-solid fa-xmark"></i></button>
            
            <div>
                <input type="text" class="faq-q w-full bg-transparent text-[11px] font-black text-slate-700 outline-none pr-6" placeholder="Reference Question (e.g. What is the price?)" value="${q}">
            </div>
            
            <div class="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-1.5 focus-within:border-indigo-400 transition">
                <i class="fa-solid fa-key text-[10px] text-indigo-400 pl-1"></i>
                <input type="text" class="faq-k w-full bg-transparent text-[10px] font-bold text-indigo-900 outline-none placeholder-indigo-300" placeholder="Keywords (comma separated) e.g. price, cost, rate, kitne ka" value="${k}">
            </div>
            
            <textarea class="faq-a w-full bg-white border border-slate-200 rounded-lg text-[10px] font-medium p-2 text-slate-600 outline-none resize-none focus:border-indigo-400 transition" rows="2" placeholder="Exact AI Answer...">${a}</textarea>
        </div>
    `;
    cont.insertAdjacentHTML('beforeend', html);
}

function removeFaq(id) { document.getElementById(id)?.remove(); }

// 🕒 Add Marketing Drip Step
function addDripStep(hours = 24, msg = "") {
    const cont = document.getElementById('drip-container');
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

// 💾 Save All AI Settings
async function saveBotSetup() {
    const btn = document.getElementById('btn-save-bot');
    const loader = document.getElementById('bot-loader');
    btn.disabled = true; loader.classList.remove('hidden');

    try {
        // Collect FAQs properly
        const faqs = [];
        document.querySelectorAll('.faq-step').forEach(el => {
            const q = el.querySelector('.faq-q').value.trim();
            const k = el.querySelector('.faq-k').value.trim();
            const a = el.querySelector('.faq-a').value.trim();
            
            // Agar keyword aur answer hai, tabhi save karein
            if (k && a) {
                faqs.push({ question: q, keyword: k, answer: a });
            }
        });

        // Collect Drip steps
        const dripSteps = [];
        document.querySelectorAll('.drip-step').forEach(el => {
            const h = el.querySelector('.drip-hours').value;
            const m = el.querySelector('.drip-msg').value.trim();
            if (m) dripSteps.push({ hours: parseInt(h), message: m });
        });

        const currencyVal = document.getElementById('ai_currency').value;
        const timezoneVal = document.getElementById('ai_timezone').value;

        const botData = {
    industry: document.getElementById('ai_industry').value.trim(),
    currency: currencyVal,
    
            timezone: timezoneVal,
            name: document.getElementById('ai_name').value.trim(),
            tone: document.getElementById('ai_tone').value,
            fallbackMode: document.getElementById('ai_fallback').value,
            customPrompt: document.getElementById('ai_customPrompt').value.trim(),
            enableTagging: document.getElementById('ai_enableTagging').checked,
            enableSentiment: document.getElementById('ai_enableSentiment').checked,
            enableAwayMode: document.getElementById('ai_enableAwayMode').checked,
            workDays: document.getElementById('ai_workDays').value,
            openTime: document.getElementById('ai_openTime').value,
            closeTime: document.getElementById('ai_closeTime').value,
            awayMsg: document.getElementById('ai_awayMsg').value.trim(),
            welcomeMsg: document.getElementById('ai_welcomeMsg').value.trim(),
            welcomeBtns: [document.getElementById('ai_btn1').value.trim(), document.getElementById('ai_btn2').value.trim()].filter(Boolean),
            faqs: faqs, // Save new FAQ structure
            dripSteps: dripSteps,
            lastTrainedAt: serverTimestamp()
        };

        await setDoc(doc(db, "sellers", state.workspaceId), {
            botTraining: botData,
            aiName: botData.name,
            aiPrompt: botData.customPrompt,
            currency: currencyVal,
            timezone: timezoneVal
        }, { merge: true });

        showToast("Intelligence Deployed Successfully! 🚀", "success");
    } catch (e) {
        showToast("Deployment Failed", "error");
    } finally {
        btn.disabled = false; loader.classList.add('hidden');
    }
}

// 📄 PDF Knowledge Upload Logic
window.handleKnowledgeUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('pdf-status').innerText = "Analyzing file...";
    
    try {
        const res = await fetch(`${MEDIA_API}/get-presigned-url?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`);
        const { uploadUrl, publicUrl } = await res.json();
        
        await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }});
        
        await setDoc(doc(db, "sellers", state.workspaceId), {
            botTraining: { knowledgeUrl: publicUrl }
        }, { merge: true });

        document.getElementById('pdf-status').innerText = "✅ Knowledge Synced: " + file.name;
        showToast("Knowledge added to AI", "success");
    } catch (error) {
        document.getElementById('pdf-status').innerText = "❌ Sync Failed";
        showToast("Upload failed", "error");
    }
};

window.scrapeWebsite = () => {
    const url = document.getElementById('ai_webUrl').value.trim();
    if(!url) return showToast("Enter a valid URL", "warning");
    showToast("Website scraping started... AI will learn from it.", "info");
};