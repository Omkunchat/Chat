import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, doc, deleteDoc, updateDoc,
    onSnapshot, getDocs, getDoc, collectionGroup, limit 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js"; 

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    canEdit: false,
    campaigns: [],
    searchQuery: '',
    statusFilter: 'all',
    sellerConfig: null,
    metaHealth: {
        quality: 'GREEN', 
        dailyLimit: Infinity, 
        sentToday: 0
    }
};

let campaignsUnsubscribe = null;

const campStatusConfig = {
    'sent': { color: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: 'fa-check-double', label: 'SENT' },
    'scheduled': { color: 'bg-blue-50 text-blue-600 border-blue-200', icon: 'fa-clock', label: 'SCHEDULED' },
    'draft': { color: 'bg-slate-100 text-slate-500 border-slate-200', icon: 'fa-pen', label: 'DRAFT' },
    'processing': { color: 'bg-yellow-50 text-yellow-600 border-yellow-200', icon: 'fa-spinner fa-spin', label: 'SENDING...' },
    'failed_policy': { color: 'bg-red-50 text-red-600 border-red-200', icon: 'fa-triangle-exclamation', label: 'BLOCKED BY META' }
};

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();

    // 🚀 1. WORKSPACE FINDER
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
        }
    }

    // 🚀 INITIAL STATE LOAD
    if (state.sellerConfig) {
        state.metaHealth.quality = state.sellerConfig.metaQualityScore || 'GREEN';
        state.metaHealth.dailyLimit = state.sellerConfig.metaDailyLimit || Infinity; 
        state.metaHealth.sentToday = state.sellerConfig.messagesSentToday || 0; 
    }

    // 🛡️ 2. SECURITY CHECK
    if (!hasNavPermission(state.role, 'navBroadcast')) {
        const wrapper = document.getElementById('campaigns-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    state.canEdit = canEditFeature(state.role, 'broadcast');
    
    // Initial Render
    refreshHealthUI();

    // 🚀 LIVE SYNC WITH META
    if (state.sellerConfig?.metaPhoneId && state.sellerConfig?.metaToken) {
        fetchWabaHealth();
    }

    if (!state.canEdit) {
        const createBtn = document.getElementById('btn-new-campaign');
        if(createBtn) createBtn.style.display = 'none';
    } else {
        applyAntiBanRestrictions(); 
    }

    setupCampaignsListener();

    window.handleCampaignSearch = handleCampaignSearch;
    window.deleteCampaign = deleteCampaign;
    window.cloneCampaign = cloneCampaign;
}

export function destroy() {
    if (campaignsUnsubscribe) campaignsUnsubscribe();
}

// 🚀 NAYA: PREMIUM GOOGLE-STYLE UI REFRESHER
function refreshHealthUI() {
    const { quality, dailyLimit, sentToday } = state.metaHealth;

    // 1. Quality Box Elements
    const qualityLabel = document.getElementById('waba-quality-label');
    const qualityDesc = document.getElementById('waba-quality-desc');
    const qualityDot = document.getElementById('quality-indicator-dot');

    // 2. Usage Box Elements
    const limitLabel = document.getElementById('waba-limit-label');
    const sentLabel = document.getElementById('waba-sent-today-label');
    const progressBar = document.getElementById('waba-progress-bar');

    // --- Update Quality Box ---
    if (qualityLabel && qualityDesc && qualityDot) {
        // Remove initial loading shimmer
        qualityLabel.classList.remove('text-slate-300', 'animate-pulse');
        qualityDot.classList.remove('bg-slate-200', 'animate-pulse');

        if (quality === 'GREEN' || quality === 'HIGH') {
            qualityLabel.innerText = "HIGH (GREEN)";
            qualityLabel.className = "text-2xl font-black text-emerald-500 tracking-tight uppercase";
            qualityDesc.innerText = "Account is healthy and fully active.";
            qualityDot.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
        } else if (quality === 'YELLOW' || quality === 'MEDIUM') {
            qualityLabel.innerText = "MEDIUM (YELLOW)";
            qualityLabel.className = "text-2xl font-black text-yellow-500 tracking-tight uppercase";
            qualityDesc.innerText = "Warning: Users are reporting your messages.";
            qualityDot.className = "w-2.5 h-2.5 rounded-full bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]";
        } else if (quality === 'RED' || quality === 'LOW') {
            qualityLabel.innerText = "LOW (RED)";
            qualityLabel.className = "text-2xl font-black text-red-500 tracking-tight uppercase";
            qualityDesc.innerText = "Critical: Meta has restricted your account.";
            qualityDot.className = "w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]";
        }
    }

    // --- Update Usage & Capacity Box ---
    if (limitLabel && sentLabel && progressBar) {
        // Remove initial loading shimmer
        sentLabel.classList.remove('animate-pulse');
        
        sentLabel.innerText = sentToday.toLocaleString();
        let displayLimit = dailyLimit === Infinity ? "Unlimited" : dailyLimit.toLocaleString();
        limitLabel.innerText = displayLimit;

        // Calculate and animate Progress Bar
        let usagePercent = 0;
        if (dailyLimit === Infinity) {
            usagePercent = sentToday > 0 ? 5 : 0; // Show a tiny sliver if unlimited but used
            progressBar.className = "bg-blue-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
        } else {
            usagePercent = Math.min((sentToday / dailyLimit) * 100, 100);
            // Smart color coding: turns yellow at 75%, red at 90%
            if (usagePercent > 90) {
                progressBar.className = "bg-red-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
            } else if (usagePercent > 75) {
                progressBar.className = "bg-yellow-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
            } else {
                progressBar.className = "bg-blue-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
            }
        }
        
        // Trigger animation
        setTimeout(() => {
            progressBar.style.width = `${usagePercent}%`;
        }, 100);
    }
}

async function fetchWabaHealth() {
    const phoneId = state.sellerConfig?.metaPhoneId; 
    const token = state.sellerConfig?.metaToken;

    if (!phoneId || !token) return;

    try {
        const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}?fields=quality_rating,messaging_limit_tier`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error.message);

        if (data.quality_rating) {
            state.metaHealth.quality = data.quality_rating;
            
            const tierMap = { 
                'TIER_250': 250, 'TIER_1K': 1000, 'TIER_10K': 10000, 
                'TIER_100K': 100000, 'TIER_UNLIMITED': Infinity 
            };
            state.metaHealth.dailyLimit = tierMap[data.messaging_limit_tier] || 250;

            refreshHealthUI();

            await updateDoc(doc(db, "sellers", state.workspaceId), {
                metaQualityScore: data.quality_rating,
                metaDailyLimit: state.metaHealth.dailyLimit
            });
        }
    } catch (e) {
        console.error("WABA Health Sync Failed:", e);
    }
}

function renderHealthDashboard() {
    const healthContainer = document.getElementById('meta-health-dashboard');
    if(!healthContainer) return;

    const { quality, dailyLimit, sentToday } = state.metaHealth;
    let usagePercent = dailyLimit === Infinity ? 0 : Math.min((sentToday / dailyLimit) * 100, 100);
    let displayLimit = dailyLimit === Infinity ? "Unlimited" : dailyLimit.toLocaleString();
    
    let qualityColor = 'text-emerald-500';
    let qualityBg = 'bg-emerald-50 border-emerald-200';
    let qualityText = 'HIGH (GREEN)';
    let warningMsg = 'Your account health is perfect. Keep including "Stop" buttons to prevent bans.';

    if (quality === 'YELLOW' || quality === 'MEDIUM') {
        qualityColor = 'text-yellow-500'; qualityBg = 'bg-yellow-50 border-yellow-200';
        qualityText = 'MEDIUM (YELLOW)'; warningMsg = 'Warning: Users are blocking your messages. Avoid spam.';
    } else if (quality === 'RED' || quality === 'LOW') {
        qualityColor = 'text-red-500'; qualityBg = 'bg-red-50 border-red-200';
        qualityText = 'LOW (RED)'; warningMsg = 'CRITICAL: Meta has restricted your account due to spam.';
    }

    healthContainer.innerHTML = `
        <div class="p-5 rounded-3xl border shadow-sm mb-4 ${qualityBg}">
            <div class="flex justify-between items-start mb-3">
                <div>
                    <h3 class="text-[11px] font-black uppercase tracking-widest text-slate-800 mb-1">WABA Health & Usage</h3>
                    <p class="text-[10px] font-bold text-slate-500 leading-relaxed max-w-md">${warningMsg}</p>
                </div>
            </div>
            <div class="mt-4">
                <div class="flex justify-between text-[10px] font-bold mb-1">
                    <span class="text-slate-600">Daily Messaging Limit</span>
                    <span class="text-slate-700">${sentToday.toLocaleString()} / ${displayLimit}</span>
                </div>
                <div class="w-full bg-white rounded-full h-2 shadow-inner border border-slate-200 overflow-hidden">
                    <div class="bg-blue-500 h-2 rounded-full transition-all duration-1000" style="width: ${usagePercent}%"></div>
                </div>
            </div>
        </div>
    `;
}

function setupCampaignsListener() {
    const campRef = collection(db, "campaigns");
    const q = query(campRef, where("sellerId", "==", state.workspaceId), orderBy("createdAt", "desc"), limit(100));

    campaignsUnsubscribe = onSnapshot(q, (snapshot) => {
        state.campaigns = [];
        snapshot.forEach((docSnap) => { state.campaigns.push({ id: docSnap.id, ...docSnap.data() }); });
        updateStats();
        renderCampaignsList();
    });
}

function updateStats() {
    let totalSent = 0;
    state.campaigns.forEach(c => { if (c.status === 'sent') totalSent += (c.audienceCount || 0); });
    
    const displaySent = document.getElementById('display-total-sent');
    const displayActive = document.getElementById('display-active-campaigns');
    const displayAudience = document.getElementById('display-audience-reach');
    
    if(displaySent) displaySent.innerText = new Intl.NumberFormat('en-IN').format(totalSent);
    if(displayActive) displayActive.innerText = state.campaigns.length;
    if(displayAudience) displayAudience.innerText = new Intl.NumberFormat('en-IN').format(totalSent);
}

function renderCampaignsList() {
    const list = document.getElementById('campaigns-list');
    if (!list) return;

    let filtered = state.campaigns.filter(c => {
        const matchesFilter = state.statusFilter === 'all' || c.status === state.statusFilter;
        const matchesSearch = !state.searchQuery || c.name.toLowerCase().includes(state.searchQuery);
        return matchesFilter && matchesSearch;
    });

    if (filtered.length === 0) {
        list.innerHTML = `<div class="text-center py-16 text-[10px] font-black uppercase tracking-widest text-slate-400">No campaigns found</div>`;
        return;
    }

    let html = '';
    filtered.forEach(camp => {
        const config = campStatusConfig[camp.status] || campStatusConfig['draft'];
        const date = camp.createdAt ? new Date(camp.createdAt.toDate()).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}) : 'Just now';
        
        let actionBtn = state.canEdit ? `
            <button onclick="window.cloneCampaign('${camp.id}')" class="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center transition border border-blue-100">
                <i class="fa-solid fa-copy text-xs"></i>
            </button>
            <button onclick="window.deleteCampaign('${camp.id}')" class="w-8 h-8 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 flex items-center justify-center transition border border-red-100">
                <i class="fa-solid fa-trash text-xs"></i>
            </button>` : '';

        const delivered = camp.deliveredCount || 0;
        const read = camp.readCount || 0;

        html += `
        <div class="flex flex-col md:grid md:grid-cols-12 gap-3 items-center p-4 bg-white border border-slate-200 shadow-sm rounded-2xl mb-2 hover:shadow-md transition">
            <div class="col-span-4 w-full">
                <p class="text-[11px] font-black text-slate-800 uppercase tracking-tight">${camp.name}</p>
                <p class="text-[9px] text-slate-400 font-bold tracking-widest mt-1"><i class="fa-solid ${config.icon} mr-1"></i> ${date}</p>
            </div>
            
            <div class="col-span-4 w-full flex justify-between text-center bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
                <div><p class="text-[8px] font-black uppercase tracking-widest text-slate-400">Sent</p><p class="text-[10px] font-bold text-slate-700">${camp.audienceCount || 0}</p></div>
                <div><p class="text-[8px] font-black uppercase tracking-widest text-slate-400">Delivered</p><p class="text-[10px] font-bold text-blue-600">${delivered}</p></div>
                <div><p class="text-[8px] font-black uppercase tracking-widest text-slate-400">Read</p><p class="text-[10px] font-bold text-emerald-600">${read}</p></div>
            </div>

            <div class="col-span-2 w-full text-center">
                 <span class="px-2 py-1 ${config.color} border rounded-lg text-[8px] font-black uppercase tracking-widest shadow-sm">${config.label}</span>
            </div>
            <div class="col-span-2 w-full flex justify-end gap-2">${actionBtn}</div>
        </div>`;
    });
    list.innerHTML = html;
}

function handleCampaignSearch() {
    state.searchQuery = document.getElementById('campaignSearchInput')?.value.toLowerCase().trim() || "";
    state.statusFilter = document.getElementById('campaignStatusFilter')?.value || "all";
    renderCampaignsList();
}

async function cloneCampaign(id) {
    if (!state.canEdit) return;
    const camp = state.campaigns.find(c => c.id === id);
    if (camp) {
        localStorage.setItem('chatkun_clone_campaign', JSON.stringify(camp));
        window.location.hash = '#send-campaigns';
    }
}

async function deleteCampaign(id) {
    if(!confirm("Delete this campaign?")) return;
    try {
        await deleteDoc(doc(db, "campaigns", id));
        showToast("Campaign Deleted", "success");
    } catch(e) { showToast("Error deleting", "error"); }
}

function applyAntiBanRestrictions() {
    const createBtn = document.getElementById('btn-new-campaign');
    if (!createBtn) return;
    if (state.metaHealth.quality === 'RED' || state.metaHealth.quality === 'LOW') {
        createBtn.disabled = true;
        createBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Account Restricted`;
        createBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
}
