import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, collectionGroup, query, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
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
        baseFee: 2000,
        perMessageRate: 0.5,
        extraAgentFee: 1000
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

    await detectCurrency();
    await loadSettings();
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

// 🚀 NAYA: Exact Landing Page wala IP-detection method
async function detectCurrency() {
    try {
        const response = await fetch('https://ipapi.co/json/');
        const data = await response.json();
        
        if (data.country_code !== 'IN') {
            // Agar bahar ka user hai, toh USD set kar do
            state.pricing = {
                isIndia: false,
                symbol: '$',
                locale: 'en-US',
                baseFee: 25,
                perMessageRate: 0.007,
                extraAgentFee: 12
            };
        }
    } catch (error) {
        console.error("Auto-currency detection failed. Defaulting to INR.");
    }
}

async function loadSettings() {
    try {
        const docRef = doc(db, "sellers", state.workspaceId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            state.settingsData = docSnap.data();
            
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

function calculateBillingUI(data) {
    const config = state.pricing; // 🚀 NAYA: State se IP wali config nikali
    
    const messagesUsed = data.totalMessagesThisMonth || 0;
    const currentTeamCount = data.teamCount || 1; 
    
    let extraAgentsCount = Math.max(0, currentTeamCount - 10);
    let totalExtraAgentFee = extraAgentsCount * config.extraAgentFee;
    
    // Calculation ab config ke hisaab se hoga
    const totalDue = config.baseFee + (messagesUsed * config.perMessageRate) + totalExtraAgentFee;

    document.getElementById('bill-msg-count').innerText = messagesUsed.toLocaleString(config.locale);
    const extraAgentUI = document.getElementById('bill-extra-agents');
    if(extraAgentUI) {
        extraAgentUI.innerText = extraAgentsCount > 0 
            ? `+ ${config.symbol}${totalExtraAgentFee.toLocaleString(config.locale)} (${extraAgentsCount} Extra Agents)` 
            : "10 Agents Included (Free)";
    }
    
    const amountEl = document.getElementById('bill-amount');
    const planTextEl = amountEl.previousElementSibling; 
    
    const nowMs = Date.now();
    let statusText = `Base Plan (${config.symbol}${config.baseFee}) + AI + Agents`;
    
    if (data.subscriptionEndsAt) {
        const subEndMs = data.subscriptionEndsAt.toMillis ? data.subscriptionEndsAt.toMillis() : new Date(data.subscriptionEndsAt).getTime();
        if (nowMs < subEndMs) {
            const daysLeft = Math.ceil((subEndMs - nowMs) / (1000 * 60 * 60 * 24));
            statusText = `<span class="text-emerald-400 font-bold">Active (${daysLeft} Days Left)</span> - Next Bill`;
        } else {
            statusText = `<span class="text-red-400 font-bold">Plan Expired</span> - Pay Now`;
        }
    } else if (data.createdAt) {
        const createdMs = data.createdAt.toMillis ? data.createdAt.toMillis() : new Date(data.createdAt).getTime();
        const trialEndMs = createdMs + (14 * 24 * 60 * 60 * 1000);
        
        if (nowMs < trialEndMs) {
            const daysLeft = Math.ceil((trialEndMs - nowMs) / (1000 * 60 * 60 * 24));
            statusText = `<span class="text-blue-400 font-bold">Free Trial (${daysLeft} Days Left)</span> - Pay anytime`;
        } else {
            statusText = `<span class="text-red-400 font-bold">Trial Expired</span> - Pay to activate`;
        }
    }
    
    if (planTextEl) planTextEl.innerHTML = statusText;
    
    // UI pe Amount render
    // Agar international hai toh decimal points dikhayenge, India hai toh direct ₹2,000
    amountEl.innerHTML = `${config.symbol}${totalDue.toLocaleString(config.locale, config.isIndia ? undefined : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

window.payBill = async () => {
    const btn = document.getElementById('btn-pay-bill');
    const ogHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Processing...`;
    btn.disabled = true;

    try {
        const response = await fetch(`${BILLING_API}/create-checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 🚀 NAYA: Yahan body me 'currency' pass kar rahe hain jo humne IP se detect ki thi
            body: JSON.stringify({ 
                sellerUid: state.workspaceId,
                currency: state.pricing.isIndia ? "INR" : "USD" 
            }) 
        });
        const data = await response.json();
        
        if(data.paymentUrl) window.location.href = data.paymentUrl; 
        else throw new Error(data.error || "Invalid payment link");
    } catch (e) {
        showToast("Error connecting to payment gateway", "error");
        btn.innerHTML = ogHtml; btn.disabled = false;
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

    if(document.getElementById('set_metaCatalogId')) document.getElementById('set_metaCatalogId').value = data.metaCatalogId || "";
    if(document.getElementById('set_paymentGatewayUrl')) document.getElementById('set_paymentGatewayUrl').value = data.paymentGatewayUrl || "";
    
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
            newData.metaPhoneId = document.getElementById('set_metaPhoneId')?.value.trim() || "";
            newData.metaToken = document.getElementById('set_metaToken')?.value.trim() || "";
            
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

function updateApiStatusUI() {
    const badge = document.getElementById('api-status-badge');
    const isLive = state.settingsData.metaPhoneId && state.settingsData.metaToken;
    badge.innerHTML = isLive ? 
        `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-[10px] font-bold text-emerald-600 border border-emerald-200"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> API Live</span>` :
        `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-100 text-[10px] font-bold text-slate-500 border border-slate-200"><span class="w-2 h-2 rounded-full bg-slate-400"></span> Disconnected</span>`;
}