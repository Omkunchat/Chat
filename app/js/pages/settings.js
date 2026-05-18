import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, collectionGroup, query, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
// 🚀 NAYA: Update this import line at the top
import { signOut, sendPasswordResetEmail, verifyBeforeUpdateEmail, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { showToast } from "../services/sweet-alert.js"; 

import { getSettingPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null, 
    role: "owner",     
    settingsData: {},
    pricing: {
    isIndia: true,
    symbol: '₹',
    locale: 'en-IN',
    baseFee: 0, // Blaze Plan ki base fee free hai
    perSessionRate: 0.30, // 🚀 NAYA: 30 paise per session rate
    extraAgentFee: 500 // Landing page ke ₹500 matrix se match karne ke liye
}
};

const WORKER_API = "https://engine.chatkunhq.workers.dev"; 
const BILLING_API = "https://billing.chatkunhq.workers.dev"; 
const MEDIA_API = "https://media-engine.chatkunhq.workers.dev";

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();
    
    // BULLETPROOF WORKSPACE FINDER
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
    } 
    else {
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

    const webhookInput = document.getElementById('set_webhookUrl');
    if (webhookInput) webhookInput.value = `${WORKER_API}/webhook/${state.workspaceId}`;

    // Populate Razorpay & Stripe Webhook URLs
    const rzpWebhookInput = document.getElementById('set_razorpayWebhookUrl');
    if (rzpWebhookInput) rzpWebhookInput.value = `${WORKER_API}/razorpay-webhook`;

    const stripeWebhookInput = document.getElementById('set_stripeWebhookUrl');
    if (stripeWebhookInput) stripeWebhookInput.value = `${WORKER_API}/stripe-webhook`;

    // NAYA CODE: Dono functions ko ek sath (parallel) chalayega
    await Promise.all([
        detectCurrency(),
        loadSettings()
    ]);

    // Parallel loading me currency baad me aa sakti hai, isliye UI wapas update karna zaroori hai
    if (Object.keys(state.settingsData).length > 0) {
        calculateBillingUI(state.settingsData);
    }
    applyRolePermissions(); 
    
    window.inviteTeamMember = inviteTeamMember;
}

export function destroy() {}

window.handleLogout = async () => {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (e) {
        showToast("Error logging out", "error");
    }
}

async function detectCurrency() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); 

        const response = await fetch('https://ipapi.co/json/', { signal: controller.signal });
        clearTimeout(timeoutId); 
        
        const data = await response.json();
        
        if (data.country_code !== 'IN') {
    state.pricing = {
        isIndia: false,
        symbol: '$',
        locale: 'en-US',
        baseFee: 0,
        perSessionRate: 0.01, // 🚀 NAYA: $0.01 per session (Keval 1 cent)
        extraAgentFee: 10 // Landing page ke $10 price se match karne ke liye
    };
}
    } catch (error) {
        // NAYA CODE: Error ko smartly handle karne ke liye
        if (error.name === 'AbortError') {
            console.log("⏳ IP API slow thi, isliye timer ne request cancel kar di. Defaulting to INR.");
        } else {
            console.log("⚠️ IP detection failed. Defaulting to INR.");
        }
    }
}

async function loadSettings() {
    try {
        const docRef = doc(db, "sellers", state.workspaceId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            state.settingsData = docSnap.data();
            
            // 🚀 NAYA: Registered Email ko UI mein populate karna
            if(document.getElementById('set_userEmail')) {
                document.getElementById('set_userEmail').value = state.user.email || "";
            }

            // UI Update Functions
            populateForm(state.settingsData);
            updateApiStatusUI();
            calculateBillingUI(state.settingsData); // Ye automatically state.pricing se ₹/$ utha lega
            
            // --------------------------------------------------
            // 1. OWNER PROFILE UI SETUP
            // --------------------------------------------------
            if (state.role === "owner") {
                const displayName = state.settingsData.businessName || state.user.displayName || "My Workspace";
                document.getElementById('display-biz-name').innerText = displayName;
                
                // Owner ke liye 'O' set karein
                const roleBadge = document.getElementById('shop-role-initial');
                if (roleBadge) roleBadge.innerText = 'O';

                // Avatar setup
                const avatarEl = document.getElementById('shop-avatar');
                if (state.settingsData.avatarUrl) {
                    avatarEl.src = state.settingsData.avatarUrl;
                } else if (state.user.photoURL) {
                    avatarEl.src = state.user.photoURL;
                } else {
                    avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName.charAt(0))}&background=0F172A&color=fff`;
                }
            }
        }

        // --------------------------------------------------
        // 2. TEAM MEMBER (AGENT) PROFILE UI SETUP
        // --------------------------------------------------
        if (state.role !== "owner") {
            const agentDoc = await getDoc(doc(db, "sellers", state.workspaceId, "team", state.user.email.toLowerCase()));
            
            if (agentDoc.exists()) {
                const aData = agentDoc.data();
                const fallbackName = aData.name || state.user.displayName || state.user.email.split('@')[0];
                const avatarEl = document.getElementById('shop-avatar');
                
                // Avatar setup
                if (aData.avatarUrl) {
                    avatarEl.src = aData.avatarUrl;
                } else if (state.user.photoURL) {
                    avatarEl.src = state.user.photoURL;
                } else {
                    avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName.charAt(0))}&background=0F172A&color=fff`;
                }
                
                document.getElementById('display-biz-name').innerText = fallbackName;
                
                // Team role ka pahla akshar le kar usko uppercase me set karein (M, C, S etc.)
                const roleBadge = document.getElementById('shop-role-initial');
                if (roleBadge) {
                    roleBadge.innerText = state.role ? state.role.charAt(0).toUpperCase() : '?';
                }
            }
        }

    } catch (error) {
        console.error("Error loading settings:", error);
        showToast("Error loading settings", "error");
    }
}

function applyRolePermissions() {
    const togglesContainer = document.getElementById('master-toggles-container');
    if (togglesContainer) {
        if (canEditFeature(state.role, 'settings')) {
            togglesContainer.classList.remove('hidden');
        } else {
            togglesContainer.classList.add('hidden');
        }
    }

    if (state.role === 'owner') return;

    // 🚀 NAYA UPDATE: AI Studio Banner ko hide karne ka logic
    // Agar role.js mein aiRules: 'hide' set hai, toh banner dikhna band ho jayega
    if (getSettingPermission(state.role, 'aiRules') === 'hide') {
        hideElement('ai-studio-banner');
    }

    hideElement('meta-api-section');
    hideElement('billing-section');
    hideElement('owner-exclusive-section'); 

    const sections = {
        'teamManagement': 'team-management-section',
        'shopDetails': 'shop-details-section'
    };

    for (const [permKey, sectionId] of Object.entries(sections)) {
        const perm = getSettingPermission(state.role, permKey);
        if (perm === 'hide') hideElement(sectionId);
        else if (perm === 'view') disableInputsIn(sectionId);
    }

    if (!canEditFeature(state.role, 'settings')) {
        hideElement('btn-save-settings');
    }
}

function hideElement(id) {
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
}

function disableInputsIn(id) {
    const section = document.getElementById(id);
    if (!section) return;
    section.querySelectorAll('input, select, textarea').forEach(el => el.disabled = true);
}

// 🚀 NAYA: Updated logic for Spark vs Blaze in Settings UI
function calculateBillingUI(data) {
    const config = state.pricing || { symbol: '₹', locale: 'en-IN' };
    const rechargeInput = document.getElementById('recharge-amount');
    if (rechargeInput) {
        const minAmt = config.isIndia ? 500 : 10;
        rechargeInput.placeholder = `Amount (Min ${config.symbol}${minAmt})`;
    }
    const badgeEl = document.getElementById('plan-badge');
    const subtitleEl = document.getElementById('bill-subtitle');
    const amountEl = document.getElementById('bill-amount');
    const msgCountEl = document.getElementById('bill-msg-count');
    const dateLabelEl = document.getElementById('bill-date-label');
    const dateValueEl = document.getElementById('bill-date-value');

    const aiUsed = data.aiUsageThisMonth || data.totalMessagesThisMonth || 0;
    const currentPlan = data.planType || 'spark';
    const nowMs = Date.now();

    if (msgCountEl) msgCountEl.innerText = aiUsed.toLocaleString(config.locale);

    if (currentPlan === 'blaze') {
        // 🚀 NAYA: Show Wallet UI
        const walletUI = document.getElementById('wallet-recharge-ui');
        if (walletUI) walletUI.classList.remove('hidden');
        // --- BLAZE PLAN LOGIC (Shows Wallet Balance) ---
        if(badgeEl) {
            badgeEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse mr-1 inline-block"></span> BLAZE`;
            badgeEl.className = "px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest bg-blue-500/20 text-blue-400 border border-blue-500/30";
            badgeEl.classList.remove('hidden');
        }
        
        if(subtitleEl) subtitleEl.innerText = "Blaze Wallet Balance";
        
        const balance = data.walletBalance || 0;
        if(amountEl) amountEl.innerHTML = `${config.symbol}${balance.toLocaleString(config.locale, { minimumFractionDigits: 2 })}`;

        if(dateLabelEl) dateLabelEl.innerText = "Billing Type:";
        if(dateValueEl) {
            dateValueEl.innerText = "Pay as you go";
            dateValueEl.className = "text-blue-400";
        }

    } else {
        // --- SPARK PLAN LOGIC (Shows Expiry / Trial) ---
        const walletUI = document.getElementById('wallet-recharge-ui');
        if (walletUI) walletUI.classList.add('hidden');
        if(badgeEl) {
            badgeEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse mr-1 inline-block"></span> SPARK`;
            badgeEl.className = "px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
            badgeEl.classList.remove('hidden');
        }

        if(subtitleEl) subtitleEl.innerText = "Fixed Monthly Plan";
        if(amountEl) amountEl.innerHTML = `Active`;

        if(dateLabelEl) dateLabelEl.innerText = "Plan Expires On:";
        
        // Expiry Date check
        if (data.subscriptionEndsAt) {
            const endMs = data.subscriptionEndsAt.toMillis ? data.subscriptionEndsAt.toMillis() : new Date(data.subscriptionEndsAt).getTime();
            
            if (nowMs < endMs) {
                if(dateValueEl) {
                    dateValueEl.innerText = new Date(endMs).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                    dateValueEl.className = "text-emerald-400";
                }
            } else {
                if(amountEl) amountEl.innerHTML = `<span class="text-red-500">Expired</span>`;
                if(dateValueEl) {
                    dateValueEl.innerText = "Please Renew";
                    dateValueEl.className = "text-red-500";
                }
            }
        } else {
            // Free Trial Check
            const createdMs = data.createdAt ? (data.createdAt.toMillis ? data.createdAt.toMillis() : new Date(data.createdAt).getTime()) : nowMs;
            const trialEndMs = createdMs + (7 * 24 * 60 * 60 * 1000); 
            
            if (nowMs < trialEndMs) {
                const daysLeft = Math.ceil((trialEndMs - nowMs) / (1000 * 60 * 60 * 24));
                if(subtitleEl) subtitleEl.innerText = "Free Trial Active";
                if(dateValueEl) {
                    dateValueEl.innerText = `${daysLeft} Days Left`;
                    dateValueEl.className = "text-emerald-400";
                }
            } else {
                if(amountEl) amountEl.innerHTML = `<span class="text-red-500">Trial Ended</span>`;
                if(dateValueEl) {
                    dateValueEl.innerText = "Upgrade Required";
                    dateValueEl.className = "text-red-500";
                }
            }
        }
    }
}



async function inviteTeamMember() {
    const emailInput = document.getElementById('invite_agent_email');
    const roleInput = document.getElementById('invite_agent_role'); 
    const email = emailInput?.value.trim().toLowerCase();
    const role = roleInput?.value || "Chat"; 
    
    if(!email) { showToast("Please enter a valid email", "error"); return; }

    const btn = document.getElementById('btn-invite-agent');
    const ogHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Inviting...`;
    btn.disabled = true;

    try {
        const teamRef = collection(db, "sellers", state.workspaceId, "team");
        const teamSnap = await getDocs(teamRef);
        const currentCount = teamSnap.size; 

        if (currentCount >= 10) {
            const config = state.pricing; // 🚀 NAYA: Alert box ke liye IP based pricing
            if (!confirm(`You have reached your 10 free agent limit. Adding this agent will add ${config.symbol}${config.extraAgentFee} to your monthly bill. Proceed?`)) {
                btn.innerHTML = ogHtml; btn.disabled = false; return;
            }
        }

        await setDoc(doc(teamRef, email), {
            email: email, role: role.toLowerCase(), status: "invited", sellerId: state.workspaceId, invitedAt: serverTimestamp()
        });

        const newCount = currentCount + 1;
        await setDoc(doc(db, "sellers", state.workspaceId), { teamCount: newCount }, { merge: true });
        state.settingsData.teamCount = newCount;
        calculateBillingUI(state.settingsData);

        showToast(`Invitation sent to ${email}`, "success");
        if(emailInput) emailInput.value = '';
    } catch (error) {
        showToast("Error inviting team member", "error");
    } finally {
        btn.innerHTML = ogHtml; btn.disabled = false;
    }
}

window.toggleServiceArea = () => {
    const type = document.getElementById('set_serviceAreaType')?.value;
    const wrapStates = document.getElementById('wrap_states');
    const wrapPincodes = document.getElementById('wrap_pincodes');
    if (wrapStates) wrapStates.classList.toggle('hidden', type !== 'state_level');
    if (wrapPincodes) wrapPincodes.classList.toggle('hidden', type !== 'pincode_level');
};

function populateForm(data) {
    if(data.businessName) document.getElementById('set_bizName').value = data.businessName;
    if(data.industry) document.getElementById('set_bizIndustry').value = data.industry;
    if(data.address) document.getElementById('set_bizAddress').value = data.address;

    document.getElementById('set_serviceAreaType').value = data.serviceAreaType || 'pincode_level';
    document.getElementById('set_serviceableStates').value = data.serviceableStates || "";
    document.getElementById('set_serviceablePincodes').value = data.serviceablePincodes || "";
    window.toggleServiceArea();
    
    if(document.getElementById('set_metaAppId')) document.getElementById('set_metaAppId').value = data.metaAppId || "";
    if(document.getElementById('set_metaCatalogId')) document.getElementById('set_metaCatalogId').value = data.metaCatalogId || "";
    if(document.getElementById('set_paymentGatewayUrl')) document.getElementById('set_paymentGatewayUrl').value = data.paymentGatewayUrl || "";
    
    if(document.getElementById('set_metaWabaId')) 
    document.getElementById('set_metaWabaId').value = data.metaWabaId || "";
    
    // 🚀 NAYA: Payment Keys Populate (Razorpay + Stripe)
    if(document.getElementById('set_razorpayKeyId')) document.getElementById('set_razorpayKeyId').value = data.razorpayKeyId || "";
    if(document.getElementById('set_razorpayKeySecret')) document.getElementById('set_razorpayKeySecret').value = data.razorpayKeySecret || "";
    if(document.getElementById('set_stripeSecretKey')) document.getElementById('set_stripeSecretKey').value = data.stripeSecretKey || ""; 

    // 3rd Party Integrations Populate
    if(document.getElementById('set_outboundWebhookUrl')) document.getElementById('set_outboundWebhookUrl').value = data.outboundWebhookUrl || "";
    if(document.getElementById('set_shopifyAccessToken')) document.getElementById('set_shopifyAccessToken').value = data.shopifyAccessToken || "";

    document.getElementById('set_metaPhoneId').value = data.metaPhoneId || "";
    document.getElementById('set_metaToken').value = data.metaToken || "";
    
    document.getElementById('set_botActive').checked = data.botActive !== false;
    if(document.getElementById('set_codEnabled')) document.getElementById('set_codEnabled').checked = data.codEnabled !== false;
    if(document.getElementById('set_aiActive')) document.getElementById('set_aiActive').checked = data.aiActive !== false;
    
    if(document.getElementById('set_ownerWhatsApp')) document.getElementById('set_ownerWhatsApp').value = data.ownerWhatsApp || "";
    if(document.getElementById('set_aiBudgetLimit')) document.getElementById('set_aiBudgetLimit').value = data.aiBudgetLimit || "";
    if(document.getElementById('set_autoPauseAi')) document.getElementById('set_autoPauseAi').checked = data.autoPauseAi !== false;
}



// 🚀 NAYA: Instant Save function for Header Toggles
window.instantSaveToggle = async (field) => {
    if (!state.workspaceId) return;
    const isChecked = document.getElementById(`set_${field}`).checked;
    
    // Create update object dynamically
    const updateData = {};
    updateData[field] = isChecked;
    
    try {
        await setDoc(doc(db, "sellers", state.workspaceId), updateData, { merge: true });
        state.settingsData[field] = isChecked;
        
        const fieldName = field === 'botActive' ? 'Bot Status' : 'AI Response';
        showToast(`${fieldName} turned ${isChecked ? 'ON' : 'OFF'}`, "success");
    } catch (error) {
        showToast(`Failed to update ${field}`, "error");
        // Revert switch visually if DB fails
        document.getElementById(`set_${field}`).checked = !isChecked;
    }
};

window.saveAllSettings = async () => {
    const btn = document.getElementById('btn-save-settings');
    const loader = document.getElementById('settings-loader');
    if (loader) loader.classList.remove('hidden');
    if (btn) btn.disabled = true;

    try {
        const bName = document.getElementById('set_bizName')?.value.trim() || "";

        let newData = {
            businessName: bName,
            industry: document.getElementById('set_bizIndustry')?.value.trim() || "",
            address: document.getElementById('set_bizAddress')?.value.trim() || "",
            
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            
            serviceAreaType: document.getElementById('set_serviceAreaType')?.value || "pincode_level",
            serviceableStates: document.getElementById('set_serviceableStates')?.value.trim() || "",
            serviceablePincodes: document.getElementById('set_serviceablePincodes')?.value.trim() || "",
            
            metaCatalogId: document.getElementById('set_metaCatalogId')?.value.trim() || "",
            paymentGatewayUrl: document.getElementById('set_paymentGatewayUrl')?.value.trim() || "",
            
            // 🚀 NAYA: Payment Keys Save (Razorpay + Stripe)
            razorpayKeyId: document.getElementById('set_razorpayKeyId')?.value.trim() || "",
            razorpayKeySecret: document.getElementById('set_razorpayKeySecret')?.value.trim() || "",
            stripeSecretKey: document.getElementById('set_stripeSecretKey')?.value.trim() || "",
            
            outboundWebhookUrl: document.getElementById('set_outboundWebhookUrl')?.value.trim() || "",
            shopifyAccessToken: document.getElementById('set_shopifyAccessToken')?.value.trim() || "",
            
            codEnabled: document.getElementById('set_codEnabled')?.checked ?? true,
            aiActive: document.getElementById('set_aiActive')?.checked ?? true,
            botActive: document.getElementById('set_botActive')?.checked ?? true,
            
            updatedAt: serverTimestamp()
        };

        // SECURITY LOCK - Yeh data sirf Owner save kar sakta hai
        if (state.role === 'owner') {
            newData.metaAppId = document.getElementById('set_metaAppId')?.value.trim() || "";
            newData.metaPhoneId = document.getElementById('set_metaPhoneId')?.value.trim() || "";
            newData.metaToken = document.getElementById('set_metaToken')?.value.trim() || "";
            newData.metaWabaId = document.getElementById('set_metaWabaId')?.value.trim() || "";
            newData.ownerWhatsApp = document.getElementById('set_ownerWhatsApp')?.value.trim() || "";
            newData.aiBudgetLimit = Number(document.getElementById('set_aiBudgetLimit')?.value) || 0;
            newData.autoPauseAi = document.getElementById('set_autoPauseAi')?.checked ?? false;
        }

        await setDoc(doc(db, "sellers", state.workspaceId), newData, { merge: true });
        
        state.settingsData = { ...state.settingsData, ...newData };
        if (state.role === "owner" && bName) {
            const displayEl = document.getElementById('display-biz-name');
            if (displayEl) displayEl.innerText = bName;
        }
        
        updateApiStatusUI();
        showToast("Settings Saved Successfully! ✅", "success");

    } catch (error) {
        console.error("🔥 SETTINGS SAVE ERROR:", error);
        showToast("Error saving settings! Check console.", "error");
    } finally {
        if (loader) loader.classList.add('hidden');
        if (btn) btn.disabled = false;
    }
};

window.handleAvatarUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const avatarImg = document.getElementById('shop-avatar');
    const originalSrc = avatarImg.src;
    avatarImg.style.opacity = '0.5';
    showToast("Uploading...", "info");

    try {
        const res = await fetch(`${MEDIA_API}/get-presigned-url?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`);
        const { uploadUrl, publicUrl } = await res.json();
        await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }});
        avatarImg.src = publicUrl;
        
        const targetDoc = state.role === "owner" ? doc(db, "sellers", state.workspaceId) : doc(db, "sellers", state.workspaceId, "team", state.user.email.toLowerCase());
        await setDoc(targetDoc, { avatarUrl: publicUrl }, { merge: true });
        showToast("Profile Picture Updated!", "success");
    } catch (error) {
        avatarImg.src = originalSrc;
        showToast("Upload failed", "error");
    } finally { avatarImg.style.opacity = '1'; }
};

window.copyWebhook = () => {
    const input = document.getElementById('set_webhookUrl');
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast("Webhook URL Copied!", "success");
};

window.copyRzpWebhook = () => {
    const input = document.getElementById('set_razorpayWebhookUrl');
    if(input) {
        input.select();
        navigator.clipboard.writeText(input.value);
        showToast("Razorpay Webhook Copied!", "success");
    }
};

window.copyStripeWebhook = () => {
    const input = document.getElementById('set_stripeWebhookUrl');
    if(input) {
        input.select();
        navigator.clipboard.writeText(input.value);
        showToast("Stripe Webhook Copied!", "success");
    }
};

window.toggleTokenVisibility = () => {
    const input = document.getElementById('set_metaToken');
    const icon = document.getElementById('tokenEyeIcon');
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    icon.classList.replace(isPass ? 'fa-eye' : 'fa-eye-slash', isPass ? 'fa-eye-slash' : 'fa-eye');
};

// 🚀 NAYA: Wallet Recharge Logic
window.rechargeWallet = async () => {
    const amountInput = document.getElementById('recharge-amount');
    const btn = document.getElementById('btn-recharge');
    const amount = parseFloat(amountInput.value);
    
    // Check if India or Global from pricing state
    const isIndia = state.pricing.isIndia;
    const minAmount = isIndia ? 500 : 10;
    const currency = isIndia ? "INR" : "USD";

    if (!amount || amount < minAmount) {
        return showToast(`Minimum recharge amount is ${state.pricing.symbol}${minAmount}`, "error");
    }

    const ogHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    btn.disabled = true;

    try {
        const payload = {
            sellerUid: state.workspaceId, 
            amount: amount,
            currency: currency, 
            paymentType: "wallet_recharge" 
        };

        const res = await fetch("https://billing.chatkunhq.workers.dev/create-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.paymentUrl) {
            // Redirect to Razorpay/Stripe page
            window.location.href = data.paymentUrl;
        } else {
            showToast(data.error || "Payment Gateway Error", "error");
            btn.innerHTML = ogHtml;
            btn.disabled = false;
        }
    } catch (error) {
        console.error("Recharge Error:", error);
        showToast("Network Error. Check console.", "error");
        btn.innerHTML = ogHtml;
        btn.disabled = false;
    }
};

function updateApiStatusUI() {
    const badge = document.getElementById('api-status-badge');
    const isLive = state.settingsData.metaPhoneId && state.settingsData.metaToken;
    badge.innerHTML = isLive ? 
        `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-[10px] font-bold text-emerald-600 border border-emerald-200"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> API Live</span>` :
        `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-100 text-[10px] font-bold text-slate-500 border border-slate-200"><span class="w-2 h-2 rounded-full bg-slate-400"></span> Disconnected</span>`;
}
// 🚀 NAYA: Send Password Reset Link
window.handlePasswordReset = async () => {
    if (!state.user || !state.user.email) return;
    
    try {
        await sendPasswordResetEmail(auth, state.user.email);
        Swal.fire("Email Sent!", "A password reset link has been sent to your registered email.", "success");
    } catch (error) {
        showToast("Error sending reset email", "error");
        console.error(error);
    }
};

// 🚀 NAYA: Smart Email Change (with Auto Re-Authentication)
window.handleEmailChange = async () => {
    const { value: newEmail } = await Swal.fire({
        title: "Change Email Address",
        input: "email",
        inputLabel: "Enter your new email address",
        inputPlaceholder: "new@example.com",
        showCancelButton: true,
        confirmButtonText: "Next",
        confirmButtonColor: "#2563eb"
    });

    if (newEmail && newEmail !== state.user.email) {
        try {
            // Pehle direct try karega
            await verifyBeforeUpdateEmail(state.user, newEmail);
            Swal.fire("Verification Sent!", `Please check ${newEmail} to verify and complete the change.`, "success");
        } catch (error) {
            // Agar Firebase purana login hone ki wajah se rokta hai
            if (error.code === 'auth/requires-recent-login') {
                
                // User se wahi par uska current password mangenge
                const { value: password } = await Swal.fire({
                    title: 'Security Verification',
                    text: 'Please enter your current password to continue.',
                    input: 'password',
                    inputPlaceholder: 'Enter your password',
                    showCancelButton: true,
                    confirmButtonText: 'Verify & Change Email',
                    confirmButtonColor: "#2563eb"
                });

                if (password) {
                    try {
                        // Backend me chupchap re-authenticate karega
                        const credential = EmailAuthProvider.credential(state.user.email, password);
                        await reauthenticateWithCredential(state.user, credential);
                        
                        // Aur wapas email change request bhej dega
                        await verifyBeforeUpdateEmail(state.user, newEmail);
                        Swal.fire("Verification Sent!", `Please check ${newEmail} to verify and complete the change.`, "success");
                    } catch (reauthError) {
                        showToast("Incorrect password. Please try again.", "error");
                    }
                }
            } else {
                showToast("Error changing email", "error");
                console.error(error);
            }
        }
    }
};
