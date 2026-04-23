import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, doc, deleteDoc,
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
    // 🚀 UPDATE: Removed hardcoded 1000, replaced with Infinity
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

    // 🚀 1. BULLETPROOF WORKSPACE FINDER
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
        
        // 🚀 UPDATE: Dynamic Fetch
        const data = ownerDocSnap.data();
        state.metaHealth.quality = data.metaQualityScore || 'GREEN';
        state.metaHealth.dailyLimit = data.metaDailyLimit || Infinity; 
        state.metaHealth.sentToday = data.messagesSentToday || 0; 
    } else {
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);
        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0]; 
            state.workspaceId = agentDoc.ref.parent.parent.id; 
            state.role = (agentDoc.data().role || 'chat').toLowerCase(); 
            
            // Fetch parent meta data
            const parentDoc = await getDoc(doc(db, "sellers", state.workspaceId));
            if(parentDoc.exists()) {
                const pData = parentDoc.data();
                state.metaHealth.quality = pData.metaQualityScore || 'GREEN';
                state.metaHealth.dailyLimit = pData.metaDailyLimit || Infinity;
                state.metaHealth.sentToday = pData.messagesSentToday || 0;
            }
        } else {
            state.role = "owner";
            state.workspaceId = state.user.uid;
        }
    }

    // 🛡️ 2. SECURITY CHECK
    if (!hasNavPermission(state.role, 'navBroadcast')) {
        const wrapper = document.getElementById('campaigns-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    state.canEdit = canEditFeature(state.role, 'broadcast');
    
    // RENDER META HEALTH DASHBOARD BEFORE LISTENER
    renderHealthDashboard();

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

function applyAntiBanRestrictions() {
    const createBtn = document.getElementById('btn-new-campaign');
    if (!createBtn) return;

    if (state.metaHealth.quality === 'RED') {
        createBtn.disabled = true;
        createBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Account Restricted by Meta`;
        createBtn.classList.replace('bg-blue-600', 'bg-red-400');
        createBtn.classList.replace('hover:bg-blue-700', 'hover:bg-red-400');
        createBtn.classList.add('cursor-not-allowed', 'opacity-70');
        showToast("Campaign creation locked! Your Meta Quality Rating is RED.", "error");
    } 
    // Yahan state.metaHealth.dailyLimit agar Infinity hai toh block nahi karega
    else if (state.metaHealth.sentToday >= state.metaHealth.dailyLimit) {
        createBtn.disabled = true;
        createBtn.innerHTML = `<i class="fa-solid fa-hourglass-end"></i> Daily Limit Reached`;
        createBtn.classList.replace('bg-blue-600', 'bg-slate-400');
        createBtn.classList.replace('hover:bg-blue-700', 'hover:bg-slate-400');
        createBtn.classList.add('cursor-not-allowed');
        showToast("You have reached your Meta daily sending limit.", "warning");
    }
}

// 🚀 NAYA: DYNAMIC UI FOR LIMITS
function renderHealthDashboard() {
    const healthContainer = document.getElementById('meta-health-dashboard');
    if(!healthContainer) return;

    const { quality, dailyLimit, sentToday } = state.metaHealth;
    
    // UI Handling for Infinity (jab limit unlimited ho ya fetch na hui ho)
    let usagePercent = 0;
    let displayLimit = "Unlimited (Syncing...)";
    
    if (dailyLimit !== Infinity) {
        usagePercent = Math.min((sentToday / dailyLimit) * 100, 100);
        displayLimit = dailyLimit.toLocaleString();
    }
    
    let qualityColor = 'text-emerald-500';
    let qualityBg = 'bg-emerald-50 border-emerald-200';
    let qualityText = 'HIGH (GREEN)';
    let warningMsg = 'All good! Your account health is perfect. Keep including "Stop" buttons to prevent bans.';

    if (quality === 'YELLOW') {
        qualityColor = 'text-yellow-500';
        qualityBg = 'bg-yellow-50 border-yellow-200';
        qualityText = 'MEDIUM (YELLOW)';
        warningMsg = '⚠️ Warning: Users are blocking your numbers. Send relevant messages only and avoid spam.';
    } else if (quality === 'RED') {
        qualityColor = 'text-red-500';
        qualityBg = 'bg-red-50 border-red-200';
        qualityText = 'LOW (RED) - RESTRICTED';
        warningMsg = '🚨 CRITICAL: Meta has restricted your account due to spam reports. Campaigns are paused.';
    }

    let progressColor = usagePercent > 90 ? 'bg-red-500' : (usagePercent > 70 ? 'bg-yellow-500' : 'bg-blue-500');

    healthContainer.innerHTML = `
        <div class="p-5 rounded-3xl border shadow-sm mb-4 ${qualityBg}">
            <div class="flex justify-between items-start mb-3">
                <div>
                    <h3 class="text-[11px] font-black uppercase tracking-widest text-slate-800 mb-1">
                        <i class="fa-brands fa-whatsapp ${qualityColor} text-sm"></i> WABA Health & Limits
                    </h3>
                    <p class="text-[10px] font-bold text-slate-500 leading-relaxed max-w-md">${warningMsg}</p>
                </div>
                <div class="text-right">
                    <span class="block text-[9px] font-black uppercase tracking-widest text-slate-400">Quality Rating</span>
                    <span class="text-xs font-black ${qualityColor}">${qualityText}</span>
                </div>
            </div>
            
            <div class="mt-4">
                <div class="flex justify-between text-[10px] font-bold mb-1">
                    <span class="text-slate-600">Daily Messaging Limit Usage</span>
                    <span class="${usagePercent >= 100 ? 'text-red-500' : 'text-slate-700'}">${sentToday.toLocaleString()} / ${displayLimit}</span>
                </div>
                <div class="w-full bg-white rounded-full h-2.5 shadow-inner border border-slate-200 overflow-hidden">
                    <div class="${progressColor} h-2.5 rounded-full transition-all duration-1000" style="width: ${usagePercent}%"></div>
                </div>
            </div>
        </div>
    `;
}

function setupCampaignsListener() {
    const campRef = collection(db, "campaigns");
    const q = query(
        campRef, 
        where("sellerId", "==", state.workspaceId), 
        orderBy("createdAt", "desc"),
        limit(100)
    );

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
            <button onclick="window.cloneCampaign('${camp.id}')" title="Duplicate Campaign" class="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center transition border border-blue-100">
                <i class="fa-solid fa-copy text-xs"></i>
            </button>
            <button onclick="window.deleteCampaign('${camp.id}')" title="Delete" class="w-8 h-8 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 flex items-center justify-center transition border border-red-100">
                <i class="fa-solid fa-trash text-xs"></i>
            </button>` : '';

        const delivered = camp.deliveredCount || camp.audienceCount || 0;
        const read = camp.readCount || Math.floor((camp.audienceCount || 0) * 0.8);

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
                 ${camp.status === 'scheduled' ? `<p class="text-[8px] font-bold text-slate-400 mt-1">${new Date(camp.scheduledAt).toLocaleString()}</p>` : ''}
            </div>
            <div class="col-span-2 w-full flex justify-end gap-2">
                ${actionBtn}
            </div>
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
    if (!camp) return;

    localStorage.setItem('chatkun_clone_campaign', JSON.stringify(camp));
    window.location.hash = '#send-campaigns';
}

async function deleteCampaign(id) {
    if(!confirm("Delete this campaign record?")) return;
    try {
        await deleteDoc(doc(db, "campaigns", id));
        showToast("Campaign Deleted", "success");
    } catch(e) { showToast("Error deleting", "error"); }
}