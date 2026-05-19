import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, doc, deleteDoc, updateDoc, addDoc,
    onSnapshot, getDocs, getDoc, collectionGroup, limit, serverTimestamp 
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
    statusFilter: 'all', // 🚀 Dynamic status filter for badges
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

    // 🚀 WORKSPACE FINDER
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

    // 🚨 THE BIG FIX: AUTOMATIC DAILY COUNTER RESET GUARD
    if (state.sellerConfig) {
        state.metaHealth.quality = state.sellerConfig.metaQualityScore || 'GREEN';
        state.metaHealth.dailyLimit = state.sellerConfig.metaDailyLimit || Infinity; 

        // Current Date nikalye string format me (YYYY-MM-DD)
        const todayStr = new Date().toISOString().split('T')[0]; 
        const lastResetDate = state.sellerConfig.lastBroadcastResetDate || "";

        if (lastResetDate !== todayStr) {
            // 🔄 Agar tareekh badal gayi hai (Naya din shuru hua hai), toh counter 0 karo
            state.metaHealth.sentToday = 0;
            
            // Database (Firestore) me bhi counter reset karke aaj ki date stamp kardo
            await updateDoc(doc(db, "sellers", state.workspaceId), {
                messagesSentToday: 0,
                lastBroadcastResetDate: todayStr
            }).catch(e => console.error("Database counter reset failed:", e));
        } else {
            // Agar din wahi hai, toh standard current running data load karo
            state.metaHealth.sentToday = state.sellerConfig.messagesSentToday || 0; 
        }
    }

    // SECURITY CHECK
    if (!hasNavPermission(state.role, 'navBroadcast')) {
        const wrapper = document.getElementById('campaigns-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    state.canEdit = canEditFeature(state.role, 'broadcast');
    
    // Initial UI Render
    refreshHealthUI();

    // LIVE SYNC WITH META
    if (state.sellerConfig?.metaPhoneId && state.sellerConfig?.metaToken) {
        fetchWabaHealth();
    }

    if (!state.canEdit) {
        const createBtn = document.getElementById('btn-new-campaign');
        // 🚀 BONUS BUG FIX: Aapke purane code me style.style.display double tha, use single property kiya
        if(createBtn) createBtn.style.display = 'none'; 
    } else {
        applyAntiBanRestrictions(); 
    }

    setupCampaignsListener();

    // Window Functions Bindings
    window.handleCampaignSearch = handleCampaignSearch;
    window.setCampaignStatusFilter = setCampaignStatusFilter; 
    window.deleteCampaign = deleteCampaign;
    window.cloneCampaign = cloneCampaign;
    window.retargetNonReaders = retargetNonReaders; 
    window.exportCampaignCSV = exportCampaignCSV; 
}

export function destroy() {
    if (campaignsUnsubscribe) campaignsUnsubscribe();
}

// 🚀 PREMIUM GOOGLE-STYLE UI REFRESHER (With Guard Suggestions)
function refreshHealthUI() {
    const { quality, dailyLimit, sentToday } = state.metaHealth;

    const qualityLabel = document.getElementById('waba-quality-label');
    const qualityDesc = document.getElementById('waba-quality-desc');
    const qualityDot = document.getElementById('quality-indicator-dot');

    const limitLabel = document.getElementById('waba-limit-label');
    const sentLabel = document.getElementById('waba-sent-today-label');
    const progressBar = document.getElementById('waba-progress-bar');

    if (qualityLabel && qualityDesc && qualityDot) {
        qualityLabel.classList.remove('text-slate-300', 'animate-pulse');
        qualityDot.classList.remove('bg-slate-200', 'animate-pulse');

        if (quality === 'GREEN' || quality === 'HIGH') {
            qualityLabel.innerText = "HIGH (GREEN)";
            qualityLabel.className = "text-2xl font-black text-emerald-500 tracking-tight uppercase";
            qualityDesc.innerText = "Account is healthy. Throttling Delay: 0.2s/msg safe.";
            qualityDot.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
        } else if (quality === 'YELLOW' || quality === 'MEDIUM') {
            qualityLabel.innerText = "MEDIUM (YELLOW)";
            qualityLabel.className = "text-2xl font-black text-yellow-500 tracking-tight uppercase";
            qualityDesc.innerText = "Warning: High user block rates. Auto Delay forced: 2s/msg.";
            qualityDot.className = "w-2.5 h-2.5 rounded-full bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]";
        } else if (quality === 'RED' || quality === 'LOW') {
            qualityLabel.innerText = "LOW (RED)";
            qualityLabel.className = "text-2xl font-black text-red-500 tracking-tight uppercase";
            qualityDesc.innerText = "Critical Restriction! Broadcast sending locked to protect number.";
            qualityDot.className = "w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]";
        }
    }

    if (limitLabel && sentLabel && progressBar) {
        sentLabel.classList.remove('animate-pulse');
        sentLabel.innerText = sentToday.toLocaleString();
        let displayLimit = dailyLimit === Infinity ? "Unlimited" : dailyLimit.toLocaleString();
        limitLabel.innerText = displayLimit;

        let usagePercent = dailyLimit === Infinity ? (sentToday > 0 ? 5 : 0) : Math.min((sentToday / dailyLimit) * 100, 100);
        if (usagePercent > 90) progressBar.className = "bg-red-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
        else if (usagePercent > 75) progressBar.className = "bg-yellow-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
        else progressBar.className = "bg-blue-500 h-1.5 rounded-full transition-all duration-1000 ease-out";
        
        setTimeout(() => { progressBar.style.width = `${usagePercent}%`; }, 100);
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
            const tierMap = { 'TIER_250': 250, 'TIER_1K': 1000, 'TIER_10K': 10000, 'TIER_100K': 100000, 'TIER_UNLIMITED': Infinity };
            state.metaHealth.dailyLimit = tierMap[data.messaging_limit_tier] || 250;

            refreshHealthUI();

            await updateDoc(doc(db, "sellers", state.workspaceId), {
                metaQualityScore: data.quality_rating,
                metaDailyLimit: state.metaHealth.dailyLimit
            });
        }
    } catch (e) { console.error("WABA Health Sync Failed:", e); }
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

// 🚀 NAYA: INTERACTIVE BADGE FILTER CONTROLLER
function setCampaignStatusFilter(status) {
    state.statusFilter = status;
    document.querySelectorAll('.camp-filter-badge').forEach(badge => badge.classList.remove('bg-slate-900', 'text-white'));
    const targetBadge = document.getElementById(`filter-badge-${status}`);
    if (targetBadge) targetBadge.classList.add('bg-slate-900', 'text-white');
    renderCampaignsList();
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
        list.innerHTML = `<div class="text-center py-16 text-[10px] font-black uppercase tracking-widest text-slate-400"><i class="fa-solid fa-folder-open text-2xl mb-2 block"></i> No campaigns found</div>`;
        return;
    }

    let html = '';
    filtered.forEach(camp => {
        const config = campStatusConfig[camp.status] || campStatusConfig['draft'];
        const date = camp.createdAt ? new Date(camp.createdAt.toDate()).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}) : 'Just now';
        
        const total = camp.audienceCount || 0;
        const delivered = camp.deliveredCount || 0;
        const read = camp.readCount || 0;

        // 🚀 SMART CALCULATION: Live conversion rates calculation
        const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 0;
        const readRate = delivered > 0 ? Math.round((read / delivered) * 100) : 0;

        // Action Buttons Grid (Added Retargeting & Export conditional items)
        let actionButtonsHtml = '';
        if (state.canEdit) {
            actionButtonsHtml += `
                <button onclick="window.cloneCampaign('${camp.id}')" title="Clone Campaign" class="w-7 h-7 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center justify-center transition shadow-sm">
                    <i class="fa-solid fa-copy text-[10px]"></i>
                </button>
                <button onclick="window.exportCampaignCSV('${camp.id}')" title="Export Analytics CSV" class="w-7 h-7 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 hover:bg-emerald-50 hover:text-emerald-600 flex items-center justify-center transition shadow-sm">
                    <i class="fa-solid fa-file-csv text-[11px]"></i>
                </button>
            `;
            
            // Retargeting button: Only active for fully sent campaigns with missing readers
            if (camp.status === 'sent' && (total - read) > 0) {
                actionButtonsHtml += `
                    <button onclick="window.retargetNonReaders('${camp.id}')" title="Retarget Non-Readers" class="w-7 h-7 rounded-lg bg-orange-50 border border-orange-200 text-orange-600 hover:bg-orange-500 hover:text-white flex items-center justify-center transition shadow-sm">
                        <i class="fa-solid fa-bullseye text-[10px]"></i>
                    </button>
                `;
            }

            actionButtonsHtml += `
                <button onclick="window.deleteCampaign('${camp.id}')" title="Delete" class="w-7 h-7 rounded-lg bg-red-50 border border-red-100 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition shadow-sm">
                    <i class="fa-solid fa-trash-can text-[10px]"></i>
                </button>
            `;
        }

        html += `
        <div class="flex flex-col md:grid md:grid-cols-12 gap-3 items-center p-4 bg-white border border-slate-100 shadow-sm rounded-2xl mb-2 hover:shadow-md transition">
            <div class="col-span-3 w-full">
                <p class="text-[11px] font-black text-slate-800 uppercase tracking-tight line-clamp-1">${camp.name}</p>
                <p class="text-[8px] text-slate-400 font-bold tracking-widest mt-0.5 uppercase"><i class="fa-solid ${config.icon} mr-1"></i> ${date}</p>
            </div>
            
            <div class="col-span-5 w-full flex justify-between items-center text-center bg-slate-50 rounded-xl px-4 py-2 border border-slate-100">
                <div>
                    <p class="text-[7px] font-black uppercase tracking-widest text-slate-400">Total Audience</p>
                    <p class="text-[11px] font-black text-slate-700">${total.toLocaleString()}</p>
                </div>
                <div class="border-l border-slate-200 h-6"></div>
                <div>
                    <p class="text-[7px] font-black uppercase tracking-widest text-slate-400">Delivered</p>
                    <p class="text-[11px] font-black text-blue-600">${delivered.toLocaleString()} <span class="text-[8px] font-bold text-slate-400">(${deliveryRate}%)</span></p>
                </div>
                <div class="border-l border-slate-200 h-6"></div>
                <div>
                    <p class="text-[7px] font-black uppercase tracking-widest text-slate-400">Read / Opened</p>
                    <p class="text-[11px] font-black text-emerald-600">${read.toLocaleString()} <span class="text-[8px] font-bold text-emerald-500">(${readRate}%)</span></p>
                </div>
            </div>

            <div class="col-span-2 w-full text-center">
                 <span class="px-2 py-1 ${config.color} border rounded-lg text-[7px] font-black uppercase tracking-widest shadow-inner">${config.label}</span>
            </div>
            <div class="col-span-2 w-full flex justify-end gap-1.5">${actionButtonsHtml}</div>
        </div>`;
    });
    list.innerHTML = html;
}

function handleCampaignSearch() {
    state.searchQuery = document.getElementById('campaignSearchInput')?.value.toLowerCase().trim() || "";
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

// 🚀 RETARGETING ENGINE MODULE: Automate smart duplicate targeting for un-open users
async function retargetNonReaders(id) {
    if (!state.canEdit) return;
    const camp = state.campaigns.find(c => c.id === id);
    if (!camp) return;

    Swal.fire({
        title: 'Retarget Un-opened Leads?',
        text: `This will launch a sub-campaign targeting only the users who haven't read the "${camp.name}" campaign yet.`,
        icon: 'info',
        showCancelButton: true,
        confirmButtonColor: '#f97316',
        confirmButtonText: '🎯 Create Retarget Blast'
    }).then(async (result) => {
        if (result.isConfirmed) {
            // Build intelligent segmented state representation
            const retargetConfig = {
                name: `${camp.name} (Retargeting Block)`,
                templateId: camp.templateId || "",
                components: camp.components || [],
                isRetargetQuery: true,
                parentCampaignId: id,
                targetAudienceFilter: "NON_READERS"
            };
            
            localStorage.setItem('chatkun_clone_campaign', JSON.stringify(retargetConfig));
            showToast("Audience Segments Loaded! Setup your reminder blast.", "success");
            window.location.hash = '#send-campaigns';
        }
    });
}

// 🚀 ANALYTICS DATA SHEET EXPORTER (CSV)
function exportCampaignCSV(id) {
    const camp = state.campaigns.find(c => c.id === id);
    if (!camp) return;

    // Build plain raw CSV representation matrix
    const rows = [
        ["Metric Log Field", "Value Counter"],
        ["Campaign Internal Name", camp.name],
        ["Status Code Context", camp.status.toUpperCase()],
        ["Launch Date", camp.createdAt ? new Date(camp.createdAt.toDate()).toLocaleString('en-IN') : "N/A"],
        ["Total Outbound Base", camp.audienceCount || 0],
        ["Confirmed Delivered", camp.deliveredCount || 0],
        ["Confirmed Read Log", camp.readCount || 0],
        ["Unread Remainder", (camp.audienceCount || 0) - (camp.readCount || 0)]
    ];

    let csvContent = "data:text/csv;charset=utf-8," + rows.map(e => e.join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Analytics_${camp.name.replace(/\s+/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("CSV Downloaded!", "success");
}

async function deleteCampaign(id) {
    if(!confirm("Are you sure you want to delete this campaign historical log?")) return;
    try {
        await deleteDoc(doc(db, "campaigns", id));
        showToast("Campaign Log Cleared", "success");
    } catch(e) { showToast("Error deleting", "error"); }
}

function applyAntiBanRestrictions() {
    const createBtn = document.getElementById('btn-new-campaign');
    if (!createBtn) return;
    if (state.metaHealth.quality === 'RED' || state.metaHealth.quality === 'LOW') {
        createBtn.disabled = true;
        createBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Broadcast Locked (Low Score)`;
        createBtn.classList.add('opacity-50', 'cursor-not-allowed', 'bg-red-500');
    }
}
