import { db, auth } from "../firebase.js";
import { collection, query, orderBy, where, onSnapshot, doc, updateDoc, serverTimestamp, getDoc, getDocs, collectionGroup, limit } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js";

let state = {
    user: null,
    workspaceId: null, 
    role: "owner",
    canEdit: false,    
    sellerConfig: null,
    orders: [], // Unified Array (Orders + Pickups + Bookings)
    dbOrders: [],
    dbCustomers: [],
    currentFilter: 'all',
    searchQuery: '',
pricing: { symbol: '₹', locale: 'en-IN' }
};

// 🚀 NAYA: Currency Detector
async function detectCurrency() {
    try {
        const res = await fetch('https://ipapi.co/json/');
        const data = await res.json();
        if (data.country_code !== 'IN') {
            state.pricing = { symbol: '$', locale: 'en-US' };
        }
    } catch (e) { console.error("Currency error"); }
};

let unsubOrders = null;
let unsubCustomers = null;
const STATUS_WEBHOOK_URL = "https://status-updater.chatkunhq.workers.dev/send-status"; 

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();

    // 1. BULLETPROOF WORKSPACE FINDER
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

    // 2. SECURITY Check      
    // Agar user ke paas Dashboard/Orders dekhne ki permission nahi hai toh block karo
    if (!hasNavPermission(state.role, 'navDashboard')) {
        const container = document.getElementById('orders-container');
        if(container) container.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    // role.js ke master matrix se pucho ki kya ye role status 'edit' kar sakta hai
    state.canEdit = canEditFeature(state.role, 'orders');
   await detectCurrency();
    await loadSellerData();
    loadOrders(); // Starts real-time universal queue

    window.setOrderFilter = setOrderFilter;
    window.updateOrderStatus = updateOrderStatus;
    window.toggleTrackingInput = toggleTrackingInput;
    window.viewHistory = viewHistory;
    window.closeHistoryModal = closeHistoryModal;
    window.sendInvoice = sendInvoice;
    window.searchOrders = searchOrders;
    window.exportOrdersCSV = exportOrdersCSV;
    window.editOrderPrice = editOrderPrice; // 🚀 NAYA: Price Edit Karne Ke Liye
}

export function destroy() {
    if (unsubOrders) unsubOrders(); 
    if (unsubCustomers) unsubCustomers();
}

async function loadSellerData() {
    const snap = await getDoc(doc(db, "sellers", state.workspaceId)); 
    if(snap.exists()) state.sellerConfig = snap.data();
}

function setOrderFilter(status) {
    state.currentFilter = status;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        if(btn.dataset.filter === status) {
            btn.className = "flex-1 md:flex-none px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest bg-white text-blue-600 shadow-sm transition-all filter-btn whitespace-nowrap";
        } else {
            btn.className = "flex-1 md:flex-none px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800 transition-all filter-btn whitespace-nowrap";
        }
    });
    renderOrders();
}

function searchOrders() {
    state.searchQuery = document.getElementById('order-search').value.toLowerCase().trim();
    renderOrders();
}

// 🚀 UNIVERSAL QUEUE LOGIC (No More Overwriting!)
function loadOrders() {
    // Listener 1: Real Orders Collection
    const qOrders = query(collection(db, "sellers", state.workspaceId, "orders"), orderBy("lastUpdated", "desc"), limit(200));
    unsubOrders = onSnapshot(qOrders, (snapshot) => {
        state.dbOrders = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));
        mergeAndRender();
    });

    // Listener 2: Customers Collection (For active Pickups/Bookings only)
    const qCust = query(collection(db, "sellers", state.workspaceId, "customers"), orderBy("lastUpdated", "desc"), limit(200));
    unsubCustomers = onSnapshot(qCust, (snapshot) => {
        state.dbCustomers = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));
        mergeAndRender();
    });
}

function mergeAndRender() {
    let combined = [];
    
    // 1. Add all physical/service Orders (Each order gets its own card)
    (state.dbOrders || []).forEach(o => {
        combined.push({
            _type: 'order',
            _sortDate: o.lastUpdated?.toMillis ? o.lastUpdated.toMillis() : (o.createdAt?.toMillis ? o.createdAt.toMillis() : 0),
            docId: o.docId,
            customerPhone: o.customerPhone || o.docId,
            customerName: o.customerName || 'Customer',
            title: o.itemName || 'Unknown Item',
            price: o.price || 0,
            address: o.address || '',
            status: o.status || 'Pending',
            trackingLink: o.trackingLink || '',
            paymentMethod: o.paymentMethod || 'COD'
        });
    });

    // 2. Add active Pickups and Bookings
    (state.dbCustomers || []).forEach(c => {
        const hasPickup = c.pickupTime && c.pickupTime !== "None";
        const hasBooking = c.appointmentDetails && c.appointmentDetails !== "None";

        if (hasPickup) {
            combined.push({
                _type: 'pickup',
                _sortDate: c.lastUpdated?.toMillis ? c.lastUpdated.toMillis() : 0,
                docId: c.docId, 
                customerPhone: c.docId,
                customerName: c.name || 'Customer',
                title: 'Scheduled Pickup',
                timeString: c.pickupTime,
                address: c.addressDetails || '',
                status: c.lastOrderStatus || 'Pending',
                trackingLink: c.trackingLink || '',
                paymentMethod: 'N/A'
            });
        }
        if (hasBooking) {
            combined.push({
                _type: 'booking',
                _sortDate: c.lastUpdated?.toMillis ? c.lastUpdated.toMillis() : 0,
                docId: c.docId,
                customerPhone: c.docId,
                customerName: c.name || 'Customer',
                title: 'Appointment',
                timeString: c.appointmentDetails,
                address: c.addressDetails || '',
                status: c.lastOrderStatus || 'Pending',
                trackingLink: '',
                paymentMethod: 'N/A'
            });
        }
    });

    // Sort all jobs by most recent
    combined.sort((a, b) => b._sortDate - a._sortDate);
    state.orders = combined;
    renderOrders();
}

function toggleTrackingInput(domId) {
    const statusSelect = document.getElementById(`status-${domId}`);
    const trackInput = document.getElementById(`track-${domId}`);
    if(statusSelect.value === 'Dispatched') {
        trackInput.classList.remove('hidden');
        trackInput.focus();
    } else {
        trackInput.classList.add('hidden');
        trackInput.value = ""; 
    }
}

// 🎨 UNIVERSAL CARD RENDERING
function renderOrders() {
    const container = document.getElementById('orders-container');
    if (!container) return;
    
    let filtered = state.orders.filter(o => {
        const matchesFilter = state.currentFilter === 'all' || o.status === state.currentFilter;
        const searchStr = `${o.customerName} ${o.customerPhone} ${o.docId} ${o.title} ${o.timeString || ''}`.toLowerCase();
        const matchesSearch = searchStr.includes(state.searchQuery);
        return matchesFilter && matchesSearch;
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-20 text-[10px] font-black text-slate-400 uppercase tracking-widest bg-white rounded-3xl border border-slate-200 shadow-sm"><i class="fa-solid fa-inbox text-3xl mb-3 opacity-20 block"></i> No Active Jobs Found</div>`;
        return;
    }

    let html = `
    <div class="col-span-full flex justify-end mb-2">
        <button onclick="window.exportOrdersCSV()" class="text-[10px] font-bold text-slate-500 hover:text-emerald-600 uppercase tracking-widest bg-white border border-slate-200 px-3 py-1.5 rounded-lg shadow-sm transition-colors">
            <i class="fa-solid fa-file-csv mr-1"></i> Export Data
        </button>
    </div>
    `;
    
    filtered.forEach(order => {
        const initial = order.customerName ? order.customerName.charAt(0).toUpperCase() : '?';
        const domId = `${order._type}-${order.docId}`; // Unique DOM ID
        const safeCustName = (order.customerName || 'Customer').replace(/'/g, "\\'");
        const safeTitle = (order.title || 'Item').replace(/'/g, "\\'");
        let badgesHtml = '';
        let detailsHtml = '';
        
        if (order._type === 'order') {
            badgesHtml += `<span class="px-2 py-1 bg-blue-50 text-blue-600 border border-blue-200 rounded-lg text-[8px] font-black uppercase tracking-widest shadow-sm mr-1"> Order</span>`;
            if (order.paymentMethod.toLowerCase() === 'online') {
                badgesHtml += `<span class="px-2 py-1 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-lg text-[8px] font-black uppercase tracking-widest shadow-sm mr-1"> Online Paid</span>`;
            } else {
                badgesHtml += `<span class="px-2 py-1 bg-orange-50 text-orange-600 border border-orange-200 rounded-lg text-[8px] font-black uppercase tracking-widest shadow-sm mr-1"> COD</span>`;
            }

            // 🚀 NAYA: Edit button sirf unhe dikhega jinke paas permission hai
            const editPriceBtn = state.canEdit ? `<button onclick="window.editOrderPrice('${order.docId}', ${order.price})" class="ml-2 text-slate-400 hover:text-blue-600 transition-colors"><i class="fa-solid fa-pen-to-square"></i></button>` : '';

            detailsHtml += `
    <div class="mb-2">
        <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 border-b border-slate-100 pb-1">
            <i class="fa-solid fa-hashtag mr-1"></i>ID: <span class="text-slate-600 user-select-all">${order.docId}</span>
        </p>
        <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest"><i class="fa-solid fa-cube mr-1"></i> ${order.title}</p>
        <p class="text-[10px] font-bold text-slate-700 flex items-center">Value: <span class="text-blue-600 ml-1">${state.pricing.symbol}${order.price}</span> ${editPriceBtn}</p>
    </div>`;
        }
        else if (order._type === 'pickup') {
            badgesHtml += `<span class="px-2 py-1 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg text-[8px] font-black uppercase tracking-widest shadow-sm mr-1"> Pickup</span>`;
            detailsHtml += `
                <div class="mb-2">
                    <p class="text-[10px] font-black text-purple-600 uppercase tracking-widest"><i class="fa-solid fa-clock mr-1"></i> Scheduled Pickup</p>
                    <p class="text-[11px] font-bold text-slate-700">${order.timeString}</p>
                </div>`;
        }
        else if (order._type === 'booking') {
            badgesHtml += `<span class="px-2 py-1 bg-pink-50 text-pink-600 border border-pink-200 rounded-lg text-[8px] font-black uppercase tracking-widest shadow-sm mr-1"> Booking</span>`;
            detailsHtml += `
                <div class="mb-2">
                    <p class="text-[10px] font-black text-pink-600 uppercase tracking-widest"><i class="fa-solid fa-calendar-check mr-1"></i> Appointment</p>
                    <p class="text-[11px] font-bold text-slate-700">${order.timeString}</p>
                </div>`;
        }

        const statusConfigs = {
            'Processing': { bg: 'bg-yellow-50', text: 'text-yellow-600', border: 'border-yellow-200' },
            'Dispatched': { bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-200' },
            'Delivered': { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' },
            'Completed': { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' },
            'Cancelled': { bg: 'bg-red-50', text: 'text-red-500', border: 'border-red-200' },
            'Pending': { bg: 'bg-slate-50', text: 'text-slate-500', border: 'border-slate-200' }
        };
        const sConf = statusConfigs[order.status] || statusConfigs['Pending'];

        const selectDisabled = state.canEdit ? '' : 'disabled';
        const saveBtnHtml = state.canEdit ? `
            <button onclick="window.updateOrderStatus('${order._type}', '${order.docId}', '${order.customerPhone}', '${order.customerName}', '${domId}')" class="px-4 py-2 bg-slate-900 hover:bg-black text-white text-[10px] font-black uppercase tracking-widest rounded-xl transition shadow-sm active:scale-95 shrink-0">
                Save
            </button>` : '';
            
        const billBtnHtml = (state.canEdit && order._type === 'order') ? `
            <button onclick="window.sendInvoice('${order.customerPhone}', '${order.customerName}', '${order.title}', ${order.price})" class="text-[9px] font-black uppercase tracking-widest text-emerald-600 hover:text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 px-3 py-1.5 rounded-xl transition flex items-center gap-1.5 shadow-sm">
                <i class="fa-solid fa-file-invoice-dollar text-sm"></i> Bill
            </button>` : '';

        html += `
        <div class="bg-white p-4 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-all flex flex-col h-full relative overflow-hidden group">
            
            <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-2 min-w-0 pr-2">
                    <div class="w-8 h-8 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-xs font-black text-slate-600 shrink-0">
                        ${initial}
                    </div>
                    <div class="min-w-0">
                        <h4 class="text-[11px] font-black text-slate-800 uppercase tracking-tight truncate">${order.customerName}</h4>
                        <p class="text-[9px] text-slate-400 font-bold">${order.customerPhone}</p>
                    </div>
                </div>
                <span class="px-2 py-1 ${sConf.bg} ${sConf.text} border ${sConf.border} rounded-lg text-[8px] font-black uppercase tracking-widest shrink-0 shadow-sm">
                    ${order.status}
                </span>
            </div>

            <div class="mb-3 flex gap-1 flex-wrap">
                ${badgesHtml}
            </div>

            <div class="bg-slate-50 p-3 rounded-2xl border border-slate-100 mb-3 flex-1 flex flex-col justify-center">
                ${detailsHtml}
                ${order.address && order.address !== "None" ? `<p class="text-[9px] font-bold text-slate-500 line-clamp-2 leading-tight mt-1 border-t border-slate-200 pt-2"><i class="fa-solid fa-map-pin mr-1 opacity-50"></i> ${order.address}</p>` : ''}
            </div>

            <div class="space-y-2 mt-auto">
                <div class="flex gap-2">
                    <select id="status-${domId}" onchange="window.toggleTrackingInput('${domId}')" ${selectDisabled} class="flex-1 bg-white border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-xl px-2 py-2 outline-none focus:border-blue-500 shadow-sm cursor-pointer">
                        <option value="Processing" ${order.status === 'Processing' ? 'selected' : ''}>Processing</option>
                        <option value="Dispatched" ${order.status === 'Dispatched' ? 'selected' : ''}>Dispatched</option>
                        <option value="Delivered" ${order.status === 'Delivered' ? 'selected' : ''}>Delivered (Product)</option>
                        <option value="Completed" ${order.status === 'Completed' ? 'selected' : ''}>Completed (Service)</option>
                        <option value="Cancelled" ${order.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    ${saveBtnHtml}
                </div>
                
                <input type="text" id="track-${domId}" placeholder="TRACKING URL OR AWB..." ${selectDisabled} 
                       class="w-full text-[9px] font-black uppercase tracking-widest px-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-blue-400 bg-slate-50 shadow-inner ${order.status === 'Dispatched' ? '' : 'hidden'}" value="${order.trackingLink || ''}">
                
                <div class="flex justify-between items-center pt-3 mt-2 border-t border-slate-100">
                    <button onclick="window.viewHistory('${order.customerPhone}')" class="text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-blue-600 transition flex items-center gap-1">
                        <i class="fa-solid fa-clock-rotate-left"></i> History
                    </button>
                    ${billBtnHtml}
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

// 🛠️ SMART UPDATE: Separates Order Logic from Pickups
async function updateOrderStatus(type, docId, customerPhone, customerName, domId) {
    if (!state.canEdit) return; 
    
    const newStatus = document.getElementById(`status-${domId}`).value;
    const trackEl = document.getElementById(`track-${domId}`);
    const trackingLink = trackEl ? trackEl.value.trim() : "";
    
    if(!state.user || !state.sellerConfig) return;

    try {
        showToast("Saving & Notifying user...", "info");

        if (type === 'order') {
            // Update Specific Order Document
            await updateDoc(doc(db, "sellers", state.workspaceId, "orders", docId), {
                status: newStatus,
                trackingLink: trackingLink || null,
                lastUpdated: serverTimestamp()
            });

            // Update Customer Profile (so AI knows state)
            let custUpdates = { lastOrderStatus: newStatus, trackingLink: trackingLink || null, lastUpdated: serverTimestamp() };
            
            // MAGIC: Clear lastOrderName so AI accepts NEW orders!
            if (newStatus === "Delivered" || newStatus === "Completed" || newStatus === "Cancelled") {
                custUpdates.lastOrderName = "None";
                custUpdates.activeOrderId = "None";
            }
            await updateDoc(doc(db, "sellers", state.workspaceId, "customers", customerPhone), custUpdates);
        } 
        else {
            // Update Pickup or Booking (Stored on Customer Profile)
            let custUpdates = { lastOrderStatus: newStatus, lastUpdated: serverTimestamp() };
            if (newStatus === "Delivered" || newStatus === "Completed" || newStatus === "Cancelled") {
                if (type === 'pickup') custUpdates.pickupTime = "None";
                if (type === 'booking') custUpdates.appointmentDetails = "None";
            }
            await updateDoc(doc(db, "sellers", state.workspaceId, "customers", docId), custUpdates);
        }

        // Send Status WhatsApp Message
        await fetch(STATUS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: "status_update",
                sellerUid: state.workspaceId, 
                customerPhone: customerPhone,
                customerName: customerName,
                newStatus: newStatus,
                trackingLink: trackingLink, 
                businessName: state.sellerConfig.businessName,
                metaToken: state.sellerConfig.metaToken,
                metaPhoneId: state.sellerConfig.metaPhoneId
            })
        });

        showToast(`Job marked as ${newStatus}`, "success");
    } catch (e) {
        showToast("Error updating status", "error");
    }
}

// HISTORY MODAL 
async function viewHistory(customerPhone) {
    if(!state.user) return;
    const content = document.getElementById('history-content');
    if(!content) return;
    
    content.innerHTML = '<div class="text-center py-10"><i class="fas fa-spinner fa-spin text-blue-500 text-xl"></i></div>';
    document.getElementById('history-modal').classList.remove('hidden');

    try {
        const q = query(
            collection(db, "sellers", state.workspaceId, "orders"), 
            where("customerPhone", "==", customerPhone),
            limit(50)
        );
        const snap = await getDocs(q);
        
        if(snap.empty) {
            content.innerHTML = '<div class="text-center text-slate-400 py-10 text-[10px] font-black uppercase tracking-widest"><i class="fa-solid fa-box-open opacity-40 text-2xl mb-2"></i><p>No past orders</p></div>';
            return;
        }

        let ordersList = [];
        snap.forEach(d => ordersList.push(d.data()));
        ordersList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        let html = '';
        ordersList.forEach(o => {
            const displayDate = o.displayDate || 'Unknown Date';
            const statusColors = { 'Processing':'text-yellow-600','Dispatched':'text-blue-600','Delivered':'text-emerald-600','Completed':'text-emerald-600','Cancelled':'text-red-500'};
            const statusClass = statusColors[o.status] || 'text-slate-500';

            html += `
            <div class="border-l-2 border-slate-200 pl-4 pb-4 relative">
                <div class="absolute w-3 h-3 bg-blue-500 rounded-full -left-[7px] top-0 shadow ring-4 ring-white"></div>
                <p class="text-[9px] font-black tracking-widest text-slate-400 uppercase mb-1">${displayDate}</p>
                <p class="text-[12px] font-black text-slate-800 uppercase tracking-tight leading-tight">${o.itemName || 'Item'}</p>
                <p class="text-[10px] font-bold text-slate-600 mt-1 uppercase">${state.pricing.symbol}${o.price || 0} <span class="mx-1 opacity-30">•</span> <span class="${statusClass}">${o.status || 'N/A'}</span></p>
            </div>`;
        });
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div class="text-center text-[10px] uppercase font-black text-red-500 py-10">Failed to load</div>';
    }
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.add('hidden');
}

// SEND INVOICE 
async function sendInvoice(customerPhone, customerName, itemName, price) {
    if(!state.canEdit) return; 
    if(!state.user || !state.sellerConfig) return;
    
    if(!confirm(`Send Bill to ${customerName} for ${itemName}?`)) return;

    try {
        showToast("Sending Invoice...", "info");
        
        await fetch(STATUS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: "send_invoice",
                sellerUid: state.workspaceId, 
                customerPhone: customerPhone,
                customerName: customerName,
                itemName: itemName,
                price: price,
                businessName: state.sellerConfig.businessName,
                metaToken: state.sellerConfig.metaToken,
                metaPhoneId: state.sellerConfig.metaPhoneId
            })
        });

        showToast(`Invoice sent successfully!`, "success");
    } catch (e) {
        showToast("Failed to send invoice", "error");
    }
}

// EXPORT TO CSV
function exportOrdersCSV() {
    if (!state.orders || state.orders.length === 0) {
        showToast("No jobs to export", "info");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Type,Customer Name,Phone,Item/Details,Price,Payment Method,Status\n";

    state.orders.forEach(o => {
        const type = o._type.toUpperCase();
        const name = (o.customerName || 'Customer').replace(/,/g, '');
        const phone = o.customerPhone || '-';
        const item = (o.title || 'None').replace(/,/g, '') + ' ' + (o.timeString || '');
        const price = o.price || '0';
        const payment = o.paymentMethod || 'N/A';
        const status = o.status || 'Pending';
        
        csvContent += `${type},${name},${phone},${item},${price},${payment},${status}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `jobs_export_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Jobs Exported!", "success");
}
// 🚀 NAYA: Premium Theme Matching Edit Price Function (SweetAlert2)
async function editOrderPrice(docId, currentPrice) {
    if (!state.canEdit) return;
    
    // 🎨 Theme-matching Premium Popup
    const { value: newPrice } = await Swal.fire({
        title: 'Update Order Value',
        text: `Enter the new amount (${state.pricing.symbol}) for this order:`,
        input: 'number',
        inputValue: currentPrice,
        showCancelButton: true,
        confirmButtonText: 'Save Price',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#2563EB', // Tailwind blue-600
        cancelButtonColor: '#94A3B8',  // Tailwind slate-400
        background: '#ffffff',
        customClass: {
            popup: 'rounded-3xl border border-slate-200 shadow-sm',
            title: 'text-lg font-black text-slate-800 tracking-tight font-sans',
            htmlContainer: 'text-sm font-medium text-slate-500 mb-4 font-sans',
            input: 'bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-blue-500 transition px-4 py-3 font-sans w-[80%] mx-auto',
            actions: 'gap-3',
            confirmButton: 'rounded-xl text-xs font-black uppercase tracking-widest px-6 py-3 shadow-sm active:scale-95 transition font-sans',
            cancelButton: 'rounded-xl text-xs font-black uppercase tracking-widest px-6 py-3 active:scale-95 transition font-sans'
        }
    });
    
    // Agar user ne naya price daala aur save kiya
    if (newPrice !== undefined && newPrice !== null && newPrice.toString().trim() !== "") {
        const parsedPrice = parseInt(newPrice);
        
        if (parsedPrice !== currentPrice) {
            try {
                showToast("Updating price...", "info");
                await updateDoc(doc(db, "sellers", state.workspaceId, "orders", docId), {
                    price: parsedPrice,
                    lastUpdated: serverTimestamp()
                });
                showToast("Price updated successfully! ✅", "success");
            } catch (e) {
                showToast("Failed to update price", "error");
            }
        }
    }
}