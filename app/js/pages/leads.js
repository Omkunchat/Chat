import { db, auth } from "../firebase.js";
import { collection, query, where, orderBy, onSnapshot, doc, updateDoc, getDoc, getDocs, collectionGroup, limit, writeBatch, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null, 
    role: "owner",     
    agentName: null,
    leads: [],
    availableAgents: [],
    selectedLeads: new Set(),
    view: 'board', 
    searchQuery: '',
    selectedCategory: 'all',
    sortBy: 'newest', // 🚀 NEW: Sorting state
    canEdit: false ,
    pricing: { symbol: '₹', locale: 'en-IN' }
};

async function detectCurrency() {
    try {
        const res = await fetch('https://ipapi.co/json/');
        const data = await res.json();
        if (data.country_code !== 'IN') {
            state.pricing = { symbol: '$', locale: 'en-US' };
        }
    } catch (e) { console.error("Currency error"); }
}

let leadsUnsubscribe = null;

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;
    const userEmail = state.user.email.toLowerCase();

    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    if (ownerDocSnap.exists()) {
        state.role = "owner";
        state.workspaceId = state.user.uid;
        state.agentName = "Owner"; // 🚀 NAYA: Owner ka naam set kiya
    } else {
        const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
        const teamSnapshot = await getDocs(teamQuery);
        if (!teamSnapshot.empty) {
            const agentDoc = teamSnapshot.docs[0]; 
            const agentData = agentDoc.data(); // 🚀 NAYA: Agent ka data nikala
            state.workspaceId = agentDoc.ref.parent.parent.id; 
            state.role = (agentData.role || 'chat').toLowerCase(); 
            // 🚀 NAYA: Agent ka wahi naam set kiya jo dropdown mein dikhta hai
            state.agentName = agentData.name || agentData.email.split('@')[0]; 
        } else {
            state.role = "owner";
            state.workspaceId = state.user.uid;
        }
    }

    if (!hasNavPermission(state.role, 'navLeads')) {
        const wrapper = document.getElementById('leads-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    state.canEdit = canEditFeature(state.role, 'leads');
    
    if (state.canEdit) {
        setupImportFeature();
    } else {
        const addBtn = document.getElementById('btn-add-manual-lead');
        if(addBtn) addBtn.style.display = 'none';
    }

    // Bind Global Functions
    window.exportLeadsCSV = exportLeadsCSV;
    window.switchView = switchView;
    window.filterCrm = filterCrm;
    window.sortCrm = sortCrm; // 🚀 NEW
    window.toggleLeadSelection = toggleLeadSelection;
    window.toggleAllLeads = toggleAllLeads;
    window.bulkUpdateStatus = bulkUpdateStatus;
    window.bulkAssignLeads = bulkAssignLeads; // 🚀 NEW
    window.bulkDeleteLeads = bulkDeleteLeads;
    
    await detectCurrency();
    loadPipelineData();
    loadAvailableAgents();
}

export function destroy() {
    if (leadsUnsubscribe) leadsUnsubscribe();
}

function loadPipelineData() {
    const leadsRef = collection(db, "leads");
    let q;

    // 1. Agar Owner ya Manager hai, toh saari leads ki query karein
    if (state.role === 'owner' || state.role === 'manager') {
        q = query(
            leadsRef, 
            where("sellerId", "==", state.workspaceId), 
            orderBy("updatedAt", "desc"),
            limit(1000)
        );
    } 
    // 2. Agar Support ya Chat agent hai, toh SIRF apni assigned leads ki query karein
    else {
        q = query(
            leadsRef, 
            where("sellerId", "==", state.workspaceId), 
            where("assignedTo", "==", state.agentName), // 🚀 NAYA: Backend Query Filter
            orderBy("updatedAt", "desc"),
            limit(1000)
        );
    }

    leadsUnsubscribe = onSnapshot(q, (snapshot) => {
        state.leads = [];
        // Ab frontend filtering ki zaroorat nahi, kyunki backend se hi filter hoke aayega
        snapshot.forEach(docSnap => { 
            state.leads.push({ id: docSnap.id, ...docSnap.data() }); 
        });
        
        updateDashStats();
        renderCurrentView();
    }, (error) => {
        // 🚀 NAYA: Error dekhne ke liye (Index Error yahan dikhega)
        console.error("Leads Load Error: ", error.message); 
    });
}

function setupImportFeature() {
    const fileInput = document.getElementById('hidden-csv-input');
    const importBtn = document.getElementById('btn-import-csv');

    if (fileInput && importBtn) {
        fileInput.removeEventListener('change', handleCSVUpload);
        fileInput.addEventListener('change', handleCSVUpload);
        importBtn.onclick = () => fileInput.click();
    }
}

async function handleCSVUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const importBtn = document.getElementById('btn-import-csv');
    const originalBtnHTML = importBtn.innerHTML;
    importBtn.innerHTML = `<i class="fas fa-spinner fa-spin text-xs"></i> <span class="text-[10px] font-black uppercase tracking-widest hidden md:inline">Reading File...</span>`;
    importBtn.disabled = true;

    try {
        if (typeof XLSX === 'undefined') throw new Error("Excel Library load nahi hui. Page refresh karein.");

        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, {type: 'array'});
                const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(worksheet, {header: 1}); 

                if (rows.length < 2) throw new Error("Sheet khali hai ya galat format mein hai.");

                const batchArray = [];
                let currentBatch = writeBatch(db);
                let operationCounter = 0;
                let totalValidRows = 0;

                // Create a Set of existing phones to prevent duplicates during import
                const existingPhones = new Set(state.leads.map(l => l.phone));

                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    const name = row[0] ? String(row[0]).trim() : '';
                    const phone = row[1] ? String(row[1]).replace(/\D/g, '') : '';
                    
                    if (!name && !phone) continue; 
                    if (existingPhones.has(phone)) continue; // 🚀 NEW: Skip duplicates

                    const newLeadRef = doc(collection(db, "leads"));
                    currentBatch.set(newLeadRef, {
                        sellerId: state.workspaceId,
                        name: name || 'Unknown Customer', 
                        phone: phone, 
                        category: row[2] ? String(row[2]).trim().toLowerCase() : 'clinic',
                        intent: row[3] ? String(row[3]).trim() : 'Cold Lead',
                        value: row[4] ? Number(row[4]) : 0,
                        status: 'new',
                        whatsappSent: false,
                        source: 'excel_import',
                        assignedTo: '', // 🚀 NEW
                        nextFollowUp: '', // 🚀 NEW
                        createdAt: new Date(),
                        updatedAt: new Date()
                    });
                    
                    operationCounter++;
                    totalValidRows++;
                    existingPhones.add(phone);

                    if (operationCounter === 490) {
                        batchArray.push(currentBatch);
                        currentBatch = writeBatch(db);
                        operationCounter = 0;
                    }
                }

                if (operationCounter > 0) batchArray.push(currentBatch);
                if (totalValidRows === 0) throw new Error("Sheet mein valid data nahi mila ya sab duplicates the.");

                for (let i = 0; i < batchArray.length; i++) {
                    let currentSave = Math.min((i + 1) * 490, totalValidRows);
                    importBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin text-xs"></i> <span class="text-[10px] font-black uppercase tracking-widest hidden md:inline">Saving ${currentSave} / ${totalValidRows}...</span>`;
                    await batchArray[i].commit(); 
                }

                showToast(`Success! ${totalValidRows} leads import hui. Duplicates skip kiye gaye.`, "success");

            } catch (batchError) {
                showToast("Upload fail: " + batchError.message, "error");
            } finally {
                importBtn.innerHTML = originalBtnHTML;
                importBtn.disabled = false;
                event.target.value = ''; 
            }
        };
        reader.readAsArrayBuffer(file);
    } catch (error) {
        showToast(error.message, "error");
        importBtn.innerHTML = originalBtnHTML;
        importBtn.disabled = false;
        event.target.value = ''; 
    }
}

function updateDashStats() {
    let total = state.leads.length;
    let won = 0;
    let pipelineValue = 0;

    state.leads.forEach(lead => {
        if (lead.status === 'won') won++;
        if (lead.status !== 'lost' && lead.value) pipelineValue += Number(lead.value);
    });

    const conversionRate = total > 0 ? Math.round((won / total) * 100) : 0;

    if(document.getElementById('display-total-leads')) document.getElementById('display-total-leads').innerText = total;
    if(document.getElementById('display-won-leads')) document.getElementById('display-won-leads').innerText = won;
    if(document.getElementById('display-pipeline-value')) document.getElementById('display-pipeline-value').innerText = `${state.pricing.symbol}${new Intl.NumberFormat(state.pricing.locale).format(pipelineValue)}`;
    if(document.getElementById('conversion-bar')) document.getElementById('conversion-bar').style.width = `${conversionRate}%`;
}

window.switchView = (viewType) => {
    state.view = viewType;
    state.selectedLeads.clear(); 
    
    const btnBoard = document.getElementById('btn-view-board');
    const btnList = document.getElementById('btn-view-list');
    
    if (viewType === 'board') {
        if(btnBoard) btnBoard.className = "flex-1 md:flex-none px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest bg-white text-blue-600 shadow-sm transition-all";
        if(btnList) btnList.className = "flex-1 md:flex-none px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800 transition-all";
    } else {
        if(btnList) btnList.className = "flex-1 md:flex-none px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest bg-white text-blue-600 shadow-sm transition-all";
        if(btnBoard) btnBoard.className = "flex-1 md:flex-none px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800 transition-all";
    }
    renderCurrentView();
};

window.filterCrm = () => {
    state.searchQuery = document.getElementById('crm-search')?.value.toLowerCase().trim() || '';
    state.selectedCategory = document.getElementById('crm-category-filter')?.value || 'all'; 
    renderCurrentView();
};

window.sortCrm = () => {
    state.sortBy = document.getElementById('crm-sort-filter')?.value || 'newest';
    renderCurrentView();
};

function renderCurrentView() {
    const container = document.getElementById('crm-view-container');
    if(!container) return;
    
    // 1. Filtering Logic
    let filteredLeads = state.leads.filter(l => {
        const searchString = `${l.name} ${l.phone} ${l.intent} ${l.assignedTo || ''}`.toLowerCase();
        const matchesSearch = searchString.includes(state.searchQuery);
        const leadCategory = l.category ? l.category.toLowerCase() : 'clinic'; 
        const matchesCategory = (state.selectedCategory === 'all' || !state.selectedCategory) ? true : (leadCategory === state.selectedCategory);
        return matchesSearch && matchesCategory;
    });

    // 2. Sorting Logic
    filteredLeads.sort((a, b) => {
        if (state.sortBy === 'value-high') return (b.value || 0) - (a.value || 0);
        if (state.sortBy === 'value-low') return (a.value || 0) - (b.value || 0);
        if (state.sortBy === 'oldest') return new Date(a.createdAt?.toDate() || 0) - new Date(b.createdAt?.toDate() || 0);
        return new Date(b.createdAt?.toDate() || 0) - new Date(a.createdAt?.toDate() || 0); // newest default
    });

    // 3. View Render Logic
    if (state.view === 'board') {
        container.innerHTML = generateBoardHTML(filteredLeads);
        if (state.canEdit) setupDragAndDrop();
    } else {
        container.innerHTML = generateListHTML(filteredLeads);
    }
}

function generateBoardHTML(leads) {
    const columns = {
        'new': { title: 'New Leads', color: 'blue', items: [] },
        'hot': { title: 'Hot Deals', color: 'orange', items: [] },
        'won': { title: 'Won (Closed)', color: 'emerald', items: [] },
        'lost': { title: 'Lost', color: 'slate', items: [] }
    };

    leads.forEach(lead => {
        const status = lead.status || 'new';
        if(columns[status]) columns[status].items.push(lead);
    });

    // 🚀 NEW: Mobile par flex + horizontal scroll (snap), Desktop par Grid
    let html = `<div class="flex flex-nowrap md:grid md:grid-cols-2 lg:grid-cols-4 gap-4 items-start w-max md:w-full pb-4">`;
    
    for (const [key, col] of Object.entries(columns)) {
        // 🚀 NEW: w-[85vw] for mobile card width, shrink-0 for scroll
        html += `
        <div class="bg-white/50 rounded-3xl border border-slate-200 p-3 min-h-[400px] w-[85vw] md:w-auto shrink-0 snap-center md:snap-align-none" data-status="${key}">
            <div class="flex justify-between items-center px-2 mb-3">
                <h3 class="text-[10px] font-black text-${col.color}-600 uppercase tracking-widest">${col.title}</h3>
                <span class="text-[9px] font-bold bg-white border border-slate-200 px-2 py-0.5 rounded-full text-slate-500 shadow-sm">${col.items.length}</span>
            </div>
            <div class="space-y-3 drop-zone min-h-[100px] rounded-2xl transition-colors" data-status="${key}">
                ${col.items.map(lead => createCardHTML(lead, col.color)).join('')}
            </div>
        </div>`;
    }
    html += `</div>`;
    return html;
}

function createCardHTML(lead, colorClass) {
    const val = lead.value ? `${state.pricing.symbol}${new Intl.NumberFormat(state.pricing.locale).format(lead.value)}` : '-';
    const dragAttr = state.canEdit ? 'draggable="true"' : 'draggable="false"';
    // 🚀 NEW: Follow-up Badge
    const followUpBadge = lead.nextFollowUp ? `<span class="text-[8px] bg-purple-100 text-purple-600 px-1 rounded font-bold"><i class="fa-regular fa-calendar"></i> ${lead.nextFollowUp}</span>` : '';
    
    return `
    <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md cursor-grab" ${dragAttr} data-id="${lead.id}">
        <div class="flex items-start justify-between mb-2">
            <div>
                <h4 class="text-[11px] font-black text-slate-800 uppercase">${lead.name || 'Unknown'}</h4>
                <p class="text-[9px] text-slate-400 font-bold">${lead.phone || '-'}</p>
            </div>
        </div>
        ${followUpBadge}
        <div class="flex justify-between items-center pt-2 mt-2 border-t border-slate-100">
            <span class="text-xs font-black text-slate-900">${val}</span>
            <button onclick="window.location.hash='#lead-form?id=${lead.id}'" class="text-[9px] font-black text-blue-600 bg-blue-50 px-2 py-1 rounded">Open</button>
        </div>
    </div>`;
}

function generateListHTML(leads) {
    if (leads.length === 0) return `<div class="text-center py-20 text-[10px] font-black text-slate-400 uppercase tracking-widest bg-white rounded-3xl border border-slate-200">No leads found</div>`;

    const allSelected = state.selectedLeads.size > 0 && state.selectedLeads.size === leads.length;

    let html = `
    <div class="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden relative">
        ${renderBulkActionBar()}
        
        <div class="overflow-x-auto custom-scrollbar">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-slate-50/50 border-b border-slate-100">
                        ${state.canEdit ? `<th class="p-4 w-10"><input type="checkbox" onchange="window.toggleAllLeads(this, '${leads.map(l=>l.id).join(',')}')" ${allSelected ? 'checked' : ''} class="rounded border-slate-300"></th>` : ''}
                        <th class="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
                        <th class="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest">Intent & Agent</th>
                        <th class="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest">Follow Up</th>
                        <th class="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest">Value</th>
                        <th class="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                        <th class="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest text-right">Action</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">`;

    leads.forEach(lead => {
        const val = lead.value ? `${state.pricing.symbol}${new Intl.NumberFormat(state.pricing.locale).format(lead.value)}` : '-';
        const isSelected = state.selectedLeads.has(lead.id);
        const intentBadge = `<span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[9px]">${lead.intent || '-'}</span>`;
        const agentBadge = lead.assignedTo ? `<span class="text-[8px] text-blue-500 font-bold block mt-1"><i class="fa-solid fa-user"></i> ${lead.assignedTo}</span>` : '';

        html += `
        <tr class="hover:bg-slate-50/50 transition-colors ${isSelected ? 'bg-blue-50/30' : ''}">
            ${state.canEdit ? `<td class="p-4"><input type="checkbox" value="${lead.id}" onchange="window.toggleLeadSelection('${lead.id}')" ${isSelected ? 'checked' : ''} class="rounded border-slate-300"></td>` : ''}
            <td class="p-4">
                <div class="cursor-pointer" onclick="window.location.hash='#lead-form?id=${lead.id}'">
                    <p class="text-[11px] font-black text-slate-800 uppercase tracking-tight">${lead.name || 'Unknown'}</p>
                    <p class="text-[9px] font-bold text-slate-400 mt-0.5">${lead.phone || '-'}</p>
                </div>
                <div class="mt-2 flex items-center gap-2">
                    <button onclick="window.openWhatsApp('${lead.id}', '${lead.phone}', '${lead.name}')" 
                            class="px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest flex items-center gap-1 transition-all ${lead.whatsappSent ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-green-500 text-white hover:bg-green-600 shadow-sm'}">
                        <i class="fab fa-whatsapp text-[11px]"></i> 
                        ${lead.whatsappSent ? 'Contacted' : 'Message'}
                    </button>
                </div>
            </td>
            <td class="p-4 text-[10px] font-black uppercase max-w-[150px]">${intentBadge}${agentBadge}</td>
            <td class="p-4 text-[10px] text-purple-600 font-bold">${lead.nextFollowUp || '-'}</td>
            <td class="p-4 text-xs font-black text-slate-900">${val}</td>
            <td class="p-4 text-center">
                <span class="px-3 py-1.5 text-[8px] font-black uppercase tracking-widest rounded-lg border bg-slate-50">${lead.status || 'new'}</span>
            </td>
            <td class="p-4 text-right">
                <button onclick="window.location.hash='#lead-form?id=${lead.id}'" class="text-blue-500 hover:text-blue-700 font-black text-[10px] uppercase">Edit</button>
            </td>
        </tr>`;
    });

    html += `</tbody></table></div></div>`;
    return html;
}

function renderBulkActionBar() {
    if (state.selectedLeads.size === 0) return '';
    return `
    <div class="absolute top-0 left-0 right-0 bg-blue-600 p-2 md:p-3 flex items-center z-10 shadow-lg text-white animate-fade-in-down">
        
        <div class="px-2 md:px-4 shrink-0 border-r border-blue-400/50 mr-2">
            <span class="text-[10px] md:text-[11px] font-black uppercase tracking-widest whitespace-nowrap">
                ${state.selectedLeads.size} Selected
            </span>
        </div>
        
        <div class="flex-1 overflow-x-auto flex items-center pr-2" style="scrollbar-width: none;">
            <div class="flex flex-nowrap items-center gap-2 w-max">
                
                <select id="bulk-assign-input" 
                    class="shrink-0 text-[10px] text-slate-800 px-3 py-1.5 rounded-lg font-bold border-0 w-28 md:w-32 outline-none cursor-pointer">
                    <option value="" disabled selected>Assign to...</option>
                    ${(state.availableAgents || []).map(agent => `<option value="${agent.name}">${agent.name}</option>`).join('')}
                </select>
                <button onclick="window.bulkAssignLeads()" 
                    class="shrink-0 bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-indigo-600">
                    Assign
                </button>
                
                <div class="w-px h-5 bg-blue-400/50 shrink-0 mx-0.5"></div>
                
                <select id="bulk-status-select" 
                    class="shrink-0 text-[10px] text-slate-800 px-3 py-1.5 rounded-lg font-bold border-0 outline-none">
                    <option value="hot">Mark Hot</option>
                    <option value="won">Mark Won</option>
                    <option value="lost">Mark Lost</option>
                </select>
                <button onclick="window.bulkUpdateStatus()" 
                    class="shrink-0 bg-white text-blue-600 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-slate-50">
                    Apply
                </button>
                
                <div class="w-px h-5 bg-blue-400/50 shrink-0 mx-0.5"></div>
                
                <button onclick="window.bulkDeleteLeads()" 
                    class="shrink-0 bg-red-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-red-600 border border-red-400">
                    <i class="fa-solid fa-trash"></i>
                </button>
                
            </div>
        </div>
        
    </div>`;
}

window.toggleLeadSelection = (id) => {
    if (state.selectedLeads.has(id)) state.selectedLeads.delete(id);
    else state.selectedLeads.add(id);
    renderCurrentView();
};

window.toggleAllLeads = (checkbox, idsString) => {
    const ids = idsString.split(',');
    if (checkbox.checked) ids.forEach(id => state.selectedLeads.add(id));
    else state.selectedLeads.clear();
    renderCurrentView();
};

window.bulkUpdateStatus = async () => {
    const newStatus = document.getElementById('bulk-status-select').value;
    if (state.selectedLeads.size === 0) return;
    const batch = writeBatch(db);
    state.selectedLeads.forEach(id => {
        batch.update(doc(db, "leads", id), { status: newStatus, updatedAt: new Date() });
    });
    try {
        await batch.commit();
        showToast(`${state.selectedLeads.size} leads updated!`, "success");
        state.selectedLeads.clear();
        renderCurrentView();
    } catch (e) { showToast("Bulk update failed", "error"); }
};

// 🚀 NEW: Bulk Assign Function
window.bulkAssignLeads = async () => {
    const agentName = document.getElementById('bulk-assign-input').value.trim();
    if (!agentName) return showToast("Please enter an agent name", "error");
    if (state.selectedLeads.size === 0) return;

    const batch = writeBatch(db);
    state.selectedLeads.forEach(id => {
        batch.update(doc(db, "leads", id), { assignedTo: agentName, updatedAt: new Date() });
    });
    try {
        await batch.commit();
        showToast(`Assigned to ${agentName}`, "success");
        state.selectedLeads.clear();
        renderCurrentView();
    } catch (e) { showToast("Bulk assign failed", "error"); }
};

window.bulkDeleteLeads = async () => {
    if(!confirm(`Are you sure you want to delete ${state.selectedLeads.size} leads permanently?`)) return;
    const batch = writeBatch(db);
    state.selectedLeads.forEach(id => batch.delete(doc(db, "leads", id)));
    try {
        await batch.commit();
        showToast("Leads deleted successfully!", "success");
        state.selectedLeads.clear();
        renderCurrentView();
    } catch (e) { showToast("Bulk delete failed", "error"); }
};

// 🚀 NEW: Export Only Selected Leads (If any selected)
function exportLeadsCSV() {
    let leadsToExport = state.leads;
    
    // Agar user ne kuch select kiya hai, toh sirf wahi export karo
    if (state.selectedLeads.size > 0) {
        leadsToExport = state.leads.filter(l => state.selectedLeads.has(l.id));
    }

    let csvContent = "data:text/csv;charset=utf-8,Name,Phone,Intent,Value,Status,AssignedTo,NextFollowUp,Source\n";
    leadsToExport.forEach(lead => {
        const name = (lead.name || 'Unknown').replace(/,/g, ''); 
        const intent = (lead.intent || '-').replace(/,/g, '');
        csvContent += `${name},${lead.phone||'-'},${intent},${lead.value||'0'},${lead.status||'new'},${lead.assignedTo||'-'},${lead.nextFollowUp||'-'},${lead.source||'manual'}\n`;
    });
    const link = document.createElement("a");
    link.href = encodeURI(csvContent);
    link.download = state.selectedLeads.size > 0 ? `selected_leads.csv` : `all_leads.csv`;
    link.click();
    showToast(`${leadsToExport.length} leads exported`, "success");
}

window.openWhatsApp = async (id, phone, name) => {
    const cleanPhone = phone.replace(/\D/g, ''); 
    const message = encodeURIComponent(`Hello ${name}, kya aapko apne business ke liye AI Chatbot ki requirement hai?`);
    window.open(`https://wa.me/${cleanPhone}?text=${message}`, '_blank');
    
    try {
        await updateDoc(doc(db, "leads", id), { whatsappSent: true, updatedAt: new Date() });
    } catch (error) { console.error(error); }
};

async function loadAvailableAgents() {
    try {
        const teamRef = collection(db, "sellers", state.workspaceId, "team");
        const snap = await getDocs(teamRef);
        
        state.availableAgents = [{ email: 'owner', name: 'Owner' }]; // Default
        
        snap.forEach(doc => {
            const data = doc.data();
            if(data.status !== 'revoked') {
                // Agar name available nahi hai, toh email ka pehla hissa use karega
                state.availableAgents.push({ 
                    email: data.email, 
                    name: data.name || data.email.split('@')[0] 
                });
            }
        });
        
        // Data aane ke baad UI ko wapas render karein taaki dropdown mein naam dikhein
        renderCurrentView(); 
    } catch (error) {
        console.error("Agents load karne mein error:", error);
    }
}

function setupDragAndDrop() {
    const cards = document.querySelectorAll('[draggable="true"]');
    const dropZones = document.querySelectorAll('.drop-zone');

    cards.forEach(card => {
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card.dataset.id); card.classList.add('opacity-50'); });
        card.addEventListener('dragend', () => card.classList.remove('opacity-50'));
    });

    dropZones.forEach(zone => {
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('bg-slate-100'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('bg-slate-100'));
        zone.addEventListener('drop', async (e) => {
            e.preventDefault(); zone.classList.remove('bg-slate-100');
            const leadId = e.dataTransfer.getData('text/plain');
            const newStatus = zone.dataset.status;
            try { await updateDoc(doc(db, "leads", leadId), { status: newStatus }); } catch(err) {}
        });
    });
}