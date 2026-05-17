import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp, collection, getDocs, collectionGroup, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { getSettingPermission } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "chat",
    planType: "spark", // 🚀 NAYA: Check current plan
    teamData: [],
    searchQuery: '',
    roleFilter: 'all',
    canEdit: false,
    pricing: {
        isIndia: true,
        symbol: '₹',
        extraAgentFee: 500 // 🚀 NAYA: 1000 se 500 kar diya
    }
};

let teamUnsubscribe = null;

async function detectCurrency() {
    try {
        const response = await fetch('https://ipapi.co/json/');
        const data = await response.json();
        
        if (data.country_code !== 'IN') {
            state.pricing = {
                isIndia: false,
                symbol: '$',
                extraAgentFee: 10 // 🚀 NAYA: USD equivalent
            };
        }
    } catch (error) {
        console.error("Auto-currency detection failed. Defaulting to INR.");
    }
}

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;
    const userEmail = state.user.email.toLowerCase();

    // 1. Check if user is the Owner
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
        state.planType = ownerDocSnap.data().planType || "spark"; // Get Plan
    } else {
        // 2. Agent Finder
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);
        
        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0];
            const agentData = agentDoc.data();
            
            state.workspaceId = agentData.sellerId; 
            state.role = (agentData.role || 'chat').toLowerCase(); 
            
            // Get Plan for Agent view
            const sDoc = await getDoc(doc(db, "sellers", state.workspaceId));
            if(sDoc.exists()) state.planType = sDoc.data().planType || "spark";

        } else {
            document.getElementById('team-wrapper').innerHTML = `<div class="text-center py-20 text-red-500 font-black uppercase tracking-widest">Access Denied: Not in any team</div>`;
            return;
        }
    }

    const teamPerm = getSettingPermission(state.role, 'teamManagement');
    if (teamPerm === 'hide') {
        document.getElementById('team-wrapper').innerHTML = `<div class="text-center py-20 text-red-500 bg-red-50 rounded-3xl border border-red-100 font-black uppercase tracking-widest"><i class="fa-solid fa-lock text-2xl block mb-2"></i> Access Denied</div>`;
        return;
    }
    
    state.canEdit = (teamPerm === 'edit');
    if (!state.canEdit) {
        document.getElementById('team-action-btn-container').classList.add('hidden');
    }

    await detectCurrency();

    window.inviteNewAgent = inviteNewAgent;
    window.filterTeam = filterTeam;
    window.updateAgentRole = updateAgentRole;
    window.removeAgent = removeAgent;

    loadTeamData();
}

export function destroy() {
    if (teamUnsubscribe) teamUnsubscribe();
}

function loadTeamData() {
    const teamRef = collection(db, "sellers", state.workspaceId, "team");
    
    teamUnsubscribe = onSnapshot(teamRef, (snapshot) => {
        state.teamData = [];
        snapshot.forEach(docSnap => {
            state.teamData.push({ id: docSnap.id, ...docSnap.data() });
        });
        
        if(!state.teamData.find(t => t.role === 'owner')) {
             state.teamData.unshift({ email: 'Owner', role: 'owner', name: 'Workspace Owner', status: 'active' });
        }
        
        updateStats();
        renderTeam();
    }, (error) => {
        console.error("Team sync error:", error);
        showToast("Error syncing team data", "error");
    });
}

// 🚀 NAYA: Dynamic HTML Update Logic for Spark vs Blaze
function updateStats() {
    document.getElementById('stat-total-agents').innerText = state.teamData.length;
    document.getElementById('stat-active-agents').innerText = state.teamData.filter(t => t.status !== 'revoked').length;

    const limitEl = document.getElementById('stat-billing-limit');
    const warningEl = document.getElementById('invite-warning-text');
    
    if (state.planType === 'blaze') {
        // Blaze Plan: Unlimited seats (Pay-as-you-go)
        if (limitEl) limitEl.innerHTML = `<i class="fa-solid fa-infinity text-lg"></i>`;
        if (warningEl) warningEl.innerHTML = `<i class="fa-solid fa-circle-info"></i> First 2 agents are free. Extra agents will be billed at ${state.pricing.symbol}${state.pricing.extraAgentFee}/month.`;
    } else {
        // Spark Plan: Fixed limit of 2
        if (limitEl) limitEl.innerText = "2";
        if (warningEl) warningEl.innerHTML = `<i class="fa-solid fa-circle-info text-amber-500"></i> Spark plan allows max 2 agents. Upgrade to Blaze for unlimited seats.`;
    }
}

window.filterTeam = () => {
    state.searchQuery = document.getElementById('team-search').value.toLowerCase().trim();
    state.roleFilter = document.getElementById('team-role-filter').value;
    renderTeam();
}

function renderTeam() {
    const tbody = document.getElementById('team-list-body');
    if(!tbody) return;

    let filtered = state.teamData.filter(member => {
        const searchStr = `${member.name || ''} ${member.email}`.toLowerCase();
        const matchesSearch = searchStr.includes(state.searchQuery);
        const memberRole = (member.role || 'chat').toLowerCase();
        const matchesRole = state.roleFilter === 'all' || memberRole === state.roleFilter;
        return matchesSearch && matchesRole;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-[10px] font-black text-slate-400 uppercase tracking-widest">No agents found</td></tr>`;
        return;
    }

    let html = '';
    filtered.forEach(agent => {
        const isOwner = agent.role === 'owner';
        const initial = agent.name ? agent.name.charAt(0) : agent.email.charAt(0);
        const avatar = agent.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(initial)}&background=4F46E5&color=fff`;
        const roleSafe = (agent.role || 'chat').toLowerCase(); 
        
        const roleBadgeColor = isOwner ? 'bg-purple-100 text-purple-700' : 
                               roleSafe === 'manager' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600';

        const statusBadge = agent.status === 'invited' ? `<span class="px-2 py-1 rounded bg-yellow-50 text-yellow-600 border border-yellow-200">Invited</span>` :
                            agent.status === 'revoked' ? `<span class="px-2 py-1 rounded bg-red-50 text-red-600 border border-red-200">Revoked</span>` :
                            `<span class="px-2 py-1 rounded bg-emerald-50 text-emerald-600 border border-emerald-200">Active</span>`;

        const actionHtml = (!state.canEdit || isOwner) ? `-` : `
            <div class="flex justify-end gap-2">
                <select onchange="window.updateAgentRole('${agent.email}', this.value)" class="text-[9px] px-2 py-1 rounded bg-slate-50 border border-slate-200 outline-none uppercase font-bold cursor-pointer">
                    <option value="manager" ${roleSafe === 'manager' ? 'selected' : ''}>Manager</option>
                    <option value="marketing" ${roleSafe === 'marketing' ? 'selected' : ''}>Marketing</option>
                    <option value="support" ${roleSafe === 'support' ? 'selected' : ''}>Support</option>
                    <option value="chat" ${roleSafe === 'chat' ? 'selected' : ''}>Chat</option>
                </select>
                <button onclick="window.removeAgent('${agent.email}')" class="text-red-500 hover:text-red-700 px-2 py-1 bg-red-50 rounded transition"><i class="fa-solid fa-trash text-[10px]"></i></button>
            </div>
        `;

        html += `
        <tr class="hover:bg-slate-50/50 transition">
            <td class="p-3 md:p-4">
                <div class="flex items-center gap-3">
                    <img src="${avatar}" class="w-8 h-8 rounded-full shadow-sm object-cover border border-slate-200">
                    <div>
                        <p class="text-[11px] font-black text-slate-800 uppercase">${agent.name || 'Pending Join'}</p>
                        <p class="text-[9px] font-bold text-slate-400 lowercase">${agent.email}</p>
                    </div>
                </div>
            </td>
            <td class="p-3 md:p-4">
                <span class="px-2 py-1 text-[8px] font-black uppercase tracking-widest rounded ${roleBadgeColor}">${roleSafe}</span>
            </td>
            <td class="p-3 md:p-4 text-center text-[9px] font-black uppercase tracking-widest">
                ${statusBadge}
            </td>
            <td class="p-3 md:p-4 text-right">
                ${actionHtml}
            </td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

// --- CORE ACTIONS ---

async function inviteNewAgent() {
    if (!state.canEdit) return;
    const email = document.getElementById('invite-email').value.trim().toLowerCase();
    const role = document.getElementById('invite-role').value; 
    
    const phoneInput = document.getElementById('invite-phone');
    const phone = phoneInput ? phoneInput.value.trim().replace(/\D/g, '') : ''; 
    
    if(!email) return showToast("Enter a valid email", "error");
    if(!phone || phone.length < 8) return showToast("Enter valid WhatsApp number with Country Code", "error");

    const btn = document.getElementById('btn-send-invite');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btn.disabled = true;

    try {
        const teamRef = collection(db, "sellers", state.workspaceId, "team");
        const currentCount = state.teamData.length;

        // 🚀 NAYA: Strict Logic based on Spark (Max 2) vs Blaze (Pay extra)
        if (currentCount >= 2) {
            if (state.planType !== 'blaze') {
                showToast("Spark Plan allows max 2 Agents. Upgrade to Blaze to add more.", "error");
                btn.innerHTML = "Send Invite"; btn.disabled = false;
                return;
            } else {
                const config = state.pricing;
                if (!confirm(`Adding ${email} will cost an extra ${config.symbol}${config.extraAgentFee}/mo. Proceed?`)) {
                    btn.innerHTML = "Send Invite"; btn.disabled = false; return;
                }
            }
        }

        await setDoc(doc(teamRef, email), {
            email: email, 
            role: role, 
            phone: phone,
            status: "invited", 
            sellerId: state.workspaceId, 
            invitedAt: serverTimestamp()
        });

        await setDoc(doc(db, "sellers", state.workspaceId), { teamCount: currentCount + 1 }, { merge: true });

        showToast(`Invite sent to ${email}`, "success");
        
        document.getElementById('invite-email').value = '';
        if(phoneInput) phoneInput.value = '';
        document.getElementById('invite-section').classList.add('hidden');
        
    } catch (e) {
        showToast("Error inviting agent", "error");
    } finally {
        btn.innerHTML = "Send Invite"; btn.disabled = false;
    }
}

async function updateAgentRole(email, newRole) {
    try {
        await setDoc(doc(db, "sellers", state.workspaceId, "team", email), { role: newRole }, { merge: true });
        showToast(`Role updated to ${newRole}`, "success");
    } catch (e) { showToast("Failed to update role", "error"); }
}

async function removeAgent(email) {
    if(!confirm(`Are you sure you want to remove ${email}? They will lose all access.`)) return;
    try {
        await deleteDoc(doc(db, "sellers", state.workspaceId, "team", email));
        const newCount = Math.max(0, state.teamData.length - 1);
        await setDoc(doc(db, "sellers", state.workspaceId), { teamCount: newCount }, { merge: true });
        showToast("Agent removed", "success");
    } catch (e) { showToast("Failed to remove agent", "error"); }
}
