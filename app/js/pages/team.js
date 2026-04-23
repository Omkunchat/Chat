import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp, collection, getDocs, collectionGroup, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { getSettingPermission } from "../role.js";

let state = {
    user: null,
    workspaceId: null,
    role: "chat",
    teamData: [],
    searchQuery: '',
    roleFilter: 'all',
    canEdit: false,
    // 🚀 NAYA: Pricing state added for dynamic currency alert
    pricing: {
        isIndia: true,
        symbol: '₹',
        extraAgentFee: 1000
    }
};

let teamUnsubscribe = null;

// 🚀 NAYA: Currency detect function to show $12 or ₹1000 correctly
async function detectCurrency() {
    try {
        const response = await fetch('https://ipapi.co/json/');
        const data = await response.json();
        
        if (data.country_code !== 'IN') {
            state.pricing = {
                isIndia: false,
                symbol: '$',
                extraAgentFee: 12
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
    } else {
        // 2. Agar Owner nahi hai, toh agent ka email 'team' sub-collection me dhundo
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);
        
        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0];
            const agentData = agentDoc.data();
            
            // Direct sellerId field use kar rahe hain
            state.workspaceId = agentData.sellerId; 
            
            // Role me Capital/Small ka issue na aaye, isliye toLowerCase()
            state.role = (agentData.role || 'chat').toLowerCase(); 
        } else {
            document.getElementById('team-wrapper').innerHTML = `<div class="text-center py-20 text-red-500 font-black uppercase tracking-widest">Access Denied: Not in any team</div>`;
            return;
        }
    }

    // 3. Strict RBAC Check
    const teamPerm = getSettingPermission(state.role, 'teamManagement');
    if (teamPerm === 'hide') {
        document.getElementById('team-wrapper').innerHTML = `<div class="text-center py-20 text-red-500 bg-red-50 rounded-3xl border border-red-100 font-black uppercase tracking-widest"><i class="fa-solid fa-lock text-2xl block mb-2"></i> Access Denied</div>`;
        return;
    }
    
    state.canEdit = (teamPerm === 'edit');
    if (!state.canEdit) {
        document.getElementById('team-action-btn-container').classList.add('hidden');
    }

    // 🚀 NAYA: UI load hone se pehle currency check karein
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
    // EXACT MATCH WITH YOUR DATABASE: sellers -> {workspaceId} -> team
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

function updateStats() {
    document.getElementById('stat-total-agents').innerText = state.teamData.length;
    document.getElementById('stat-active-agents').innerText = state.teamData.filter(t => t.status !== 'revoked').length;
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
    
    // Phone number extract karna aur validation
    const phoneInput = document.getElementById('invite-phone');
    const phone = phoneInput ? phoneInput.value.trim().replace(/\D/g, '') : ''; 
    
    if(!email) return showToast("Enter a valid email", "error");
    
    // 🚀 NAYA: International number validation (Length reduced to 8 to support shorter international numbers)
    if(!phone || phone.length < 8) return showToast("Enter valid WhatsApp number with Country Code (e.g., 12025550123 or 919876543210)", "error");

    const btn = document.getElementById('btn-send-invite');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btn.disabled = true;

    try {
        const teamRef = collection(db, "sellers", state.workspaceId, "team");
        const currentCount = state.teamData.length;

        if (currentCount >= 10) {
            // 🚀 NAYA: Dynamic Pricing Alert (₹1000 or $12)
            const config = state.pricing;
            if (!confirm(`10 Free seats limit reached. Adding ${email} will cost extra ${config.symbol}${config.extraAgentFee}/mo. Proceed?`)) {
                btn.innerHTML = "Send Invite"; btn.disabled = false; return;
            }
        }

        // Database mein "phone" save karna
        await setDoc(doc(teamRef, email), {
            email: email, 
            role: role, 
            phone: phone, // <-- Added here
            status: "invited", 
            sellerId: state.workspaceId, 
            invitedAt: serverTimestamp()
        });

        await setDoc(doc(db, "sellers", state.workspaceId), { teamCount: currentCount + 1 }, { merge: true });

        showToast(`Invite sent to ${email}`, "success");
        
        // Input box clear karna
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