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

// 🚀 Currency Detector
async function detectCurrency() {
    try {
        const res = await fetch('https://ipapi.co/json/');
        const data = await res.json();
        if (data.country_code !== 'IN') {
            state.pricing = { symbol: '$', locale: 'en-US' };
        }
    } catch (e) { console.error("Currency error"); }
}

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
    if (!hasNavPermission(state.role, 'navDashboard')) {
        const container = document.getElementById('orders-container');
        if(container) container.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

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
    window.editOrderPrice = editOrderPrice; 
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
            btn.className = "flex-1 md:flex-none px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest bg-slate-900 text-white shadow-sm transition-all filter-btn whitespace-nowrap";
        } else {
            btn.className = "flex-1 md:flex-none px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 bg-white border border-slate-200 hover:bg-slate-50 transition-all filter-btn whitespace-nowrap";
        }
    });
    renderOrders();
}

function searchOrders() {
    state.searchQuery = document.getElementById('order-search').value.toLowerCase().trim();
    renderOrders();
}

// 🚀 UNIVERSAL QUEUE LOGIC 
function loadOrders() {
    const qOrders = query(collection(db, "sellers", state.workspaceId, "orders"), orderBy("lastUpdated", "desc"), limit(200));
    unsubOrders = onSnapshot(qOrders, (snapshot) => {
        state.dbOrders = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));
        mergeAndRender();
    });

    const qCust = query(collection(db, "sellers", state.workspaceId, "customers"), orderBy("lastUpdated", "desc"), limit(200));
    unsubCustomers = onSnapshot(qCust, (snapshot) => {
        state.dbCustomers = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));
        mergeAndRender();
    });
}

function mergeAndRender() {
    let combined = [];
    
    // Count orders per customer for badging
    const orderCounts = {};
    (state.dbOrders || []).forEach(o => {
        const phone = o.customerPhone || o.docId;
        orderCounts[phone] = (orderCounts[phone] || 0) + 1;
    });
    
    // 1. Add all physical/service Orders
    (state.dbOrders || []).forEach(o => {
        const phone = o.customerPhone || o.docId;
        combined.push({
            _type: 'order',
            _sortDate: o.lastUpdated?.toMillis ? o.lastUpdated.toMillis() : (o.createdAt?.toMillis ? o.createdAt.toMillis() : 0),
            docId: o.docId,
            customerPhone: phone,
            customerName: o.customerName || 'Customer',
            customerTotalOrders: orderCounts[phone] || 1,
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
                customerTotalOrders: 1,
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
                customerTotalOrders: 1,
                title: 'Appointment',
                timeString: c.appointmentDetails,
                address: c.addressDetails || '',
                status: c.lastOrderStatus || 'Pending',
                trackingLink: '',
                paymentMethod: 'N/A'
            });
        }
    });

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

// 🎨 PREMIUM UNIVERSAL CARD RENDERING
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
        container.innerHTML = `<div class="col-span-full text-center py-20 text-[11px] font-black text-slate-400 uppercase tracking-widest bg-white rounded-3xl border border-slate-200 shadow-sm"><i class="fa-solid fa-inbox text-4xl mb-4 opacity-20 block"></i> No Orders Found</div>`;
        return;
    }

    let html = `
    <div class="col-span-full flex justify-end mb-2">
        <button onclick="window.exportOrdersCSV()" class="text-[10px] font-bold text-slate-600 hover:text-emerald-600 bg-white border border-slate-200 hover:border-emerald-200 px-4 py-2 rounded-xl shadow-sm transition-all">
            <i class="fa-solid fa-file-csv mr-1"></i> Export Data
        </button>
    </div>
    `;
    
    filtered.forEach(order => {
        const initial = order.customerName ? order.customerName.charAt(0).toUpperCase() : '?';
        const domId = `${order._type}-${order.docId}`; 
        
        let paymentBadge = '';
        if (order._type === 'order') {
            if (order.paymentMethod.toLowerCase() === 'online') {
                paymentBadge = `<span class="bg-emerald-100 text-emerald-700 text-[9px] px-2 py-1 rounded-md font-black tracking-widest uppercase"><i class="fa-solid fa-check-circle mr-1"></i> Paid Online</span>`;
            } else {
                paymentBadge = `<span class="bg-orange-100 text-orange-700 text-[9px] px-2 py-1 rounded-md font-black tracking-widest uppercase"><i class="fa-solid fa-clock mr-1"></i> COD (Pending)</span>`;
            }
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
            <button onclick="window.updateOrderStatus('${order._type}', '${order.docId}', '${order.customerPhone}', '${order.customerName.replace(/'/g, "\\'")}', '${domId}')" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-black uppercase tracking-widest rounded-xl transition shadow-md active:scale-95 shrink-0">
                Update
            </button>` : '';
            
        const editPriceBtn = state.canEdit && order._type === 'order' ? `<button onclick="window.editOrderPrice('${order.docId}', ${order.price})" class="ml-2 text-slate-300 hover:text-blue-600 transition-colors"><i class="fa-solid fa-pen"></i></button>` : '';
        const billBtnHtml = (state.canEdit && order._type === 'order') ? `
            <button onclick="window.sendInvoice('${order.customerPhone}', '${order.customerName.replace(/'/g, "\\'")}', '${order.title.replace(/'/g, "\\'")}', ${order.price})" class="text-[9px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-lg transition shadow-sm">
                <i class="fa-solid fa-file-invoice-dollar mr-1"></i> Bill
            </button>` : '';

        html += `
        <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-all flex flex-col relative overflow-hidden group">
            
            <div class="flex justify-between items-start border-b border-slate-100 pb-3 mb-3">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-sm font-black text-slate-600 shrink-0">
                        ${initial}
                    </div>
                    <div>
                        <h3 class="text-sm font-black text-slate-800 tracking-tight">${order.customerName}</h3>
                        <p class="text-[10px] font-bold text-slate-500">${order.customerPhone}</p>
                    </div>
                </div>
                <div class="flex flex-col items-end gap-1">
                    <span class="px-2.5 py-1 ${sConf.bg} ${sConf.text} border ${sConf.border} rounded-lg text-[9px] font-black uppercase tracking-widest shadow-sm">
                        ${order.status}
                    </span>
                    ${order.customerTotalOrders > 1 ? `<span class="text-[9px] font-bold text-blue-500 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-100">📦 ${order.customerTotalOrders} Orders</span>` : ''}
                </div>
            </div>

            <div class="bg-slate-50 p-4 rounded-2xl border border-slate-100 mb-4 flex-1">
                <div class="flex justify-between items-start mb-2">
                    <div>
                        <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Order ID: ${order.docId}</p>
                        <p class="text-xs font-black text-slate-700 leading-tight">${order.title}</p>
                        ${order.timeString ? `<p class="text-[10px] font-bold text-purple-600 mt-1"><i class="fa-solid fa-clock"></i> ${order.timeString}</p>` : ''}
                    </div>
                    <div class="text-right shrink-0">
                        <p class="text-base font-black text-slate-800 flex items-center justify-end">${state.pricing.symbol}${order.price} ${editPriceBtn}</p>
                        <div class="mt-1">${paymentBadge}</div>
                    </div>
                </div>
                ${order.address && order.address !== "None" ? `<p class="text-[10px] font-medium text-slate-500 leading-tight mt-3 border-t border-slate-200 pt-2"><i class="fa-solid fa-map-location-dot text-slate-400 mr-1"></i> ${order.address}</p>` : ''}
            </div>

            <div class="space-y-3 mt-auto">
                <div class="flex gap-2">
                    <select id="status-${domId}" onchange="window.toggleTrackingInput('${domId}')" ${selectDisabled} class="flex-1 bg-white border border-slate-200 text-slate-700 text-[11px] font-black uppercase tracking-widest rounded-xl px-3 outline-none focus:border-blue-500 shadow-sm cursor-pointer">
                        <option value="Pending" ${order.status === 'Pending' ? 'selected' : ''}>Pending</option>
                        <option value="Processing" ${order.status === 'Processing' ? 'selected' : ''}>Processing</option>
                        <option value="Dispatched" ${order.status === 'Dispatched' ? 'selected' : ''}>Dispatched</option>
                        <option value="Delivered" ${order.status === 'Delivered' ? 'selected' : ''}>Delivered</option>
                        <option value="Cancelled" ${order.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    ${saveBtnHtml}
                </div>
                
                <input type="text" id="track-${domId}" placeholder="Tracking URL or AWB No..." ${selectDisabled} 
                       class="w-full text-[10px] font-bold text-slate-600 px-4 py-2.5 border border-blue-200 rounded-xl outline-none focus:border-blue-500 bg-blue-50 shadow-inner ${order.status === 'Dispatched' ? '' : 'hidden'}" value="${order.trackingLink || ''}">
                
                <div class="flex justify-between items-center pt-3 border-t border-slate-100">
                    <button onclick="window.viewHistory('${order.customerPhone}')" class="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-blue-600 transition flex items-center gap-1.5">
                        <i class="fa-solid fa-clock-rotate-left"></i> Full History
                    </button>
                    ${billBtnHtml}
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

async function updateOrderStatus(type, docId, customerPhone, customerName, domId) {
    if (!state.canEdit) return;
    
    const newStatus = document.getElementById(`status-${domId}`).value;
    const trackEl = document.getElementById(`track-${domId}`);
    const trackingLink = trackEl ? trackEl.value.trim() : "";
    
    if (!state.user || !state.sellerConfig) return;
    
    try {
        showToast("Updating order status...", "info");
        
        // 1. UPDATE ACTIVE ORDER (Jo main dashboard pe dikh raha hai)
        if (type === 'order') {
            const orderRef = doc(db, "sellers", state.workspaceId, "orders", docId);
            await updateDoc(orderRef, {
                status: newStatus,
                trackingLink: trackingLink || null,
                lastUpdated: serverTimestamp()
            });
            
            // 2. UPDATE HISTORY (Agar history mein bhi wahi order id hai)
            // Hum same ID wala order history mein bhi update karenge
            try {
                await updateDoc(orderRef, { status: newStatus });
            } catch (e) {
                console.log("History update skipped (not found in main collection)");
            }
            
            // 3. Update Customer Profile
            let custUpdates = { lastOrderStatus: newStatus, trackingLink: trackingLink || null, lastUpdated: serverTimestamp() };
            if (["Delivered", "Completed", "Cancelled"].includes(newStatus)) {
                custUpdates.activeOrderId = "None";
            }
            await updateDoc(doc(db, "sellers", state.workspaceId, "customers", customerPhone), custUpdates);
        }
        else {
            // Pickup/Booking logic
            let custUpdates = { lastOrderStatus: newStatus, lastUpdated: serverTimestamp() };
            if (["Delivered", "Completed", "Cancelled"].includes(newStatus)) {
                if (type === 'pickup') custUpdates.pickupTime = "None";
                if (type === 'booking') custUpdates.appointmentDetails = "None";
            }
            await updateDoc(doc(db, "sellers", state.workspaceId, "customers", docId), custUpdates);
        }
        
        // 4. Send WhatsApp Notification via Webhook
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
        
        showToast(`Order marked as ${newStatus}`, "success");
    } catch (e) {
        console.error("Update error:", e);
        showToast("Error updating status: " + e.message, "error");
    }
}

async function viewHistory(customerPhone) {
    if (!state.user) return;
    const content = document.getElementById('history-content');
    if (!content) return;
    
    content.innerHTML = '<div class="text-center py-10"><i class="fas fa-spinner fa-spin text-blue-500 text-3xl"></i></div>';
    document.getElementById('history-modal').classList.remove('hidden');
    
    try {
        const q = query(
            collection(db, "sellers", state.workspaceId, "orders"),
            where("customerPhone", "==", customerPhone),
            limit(50)
        );
        const snap = await getDocs(q);
        
        if (snap.empty) {
            content.innerHTML = '<div class="text-center text-slate-400 py-10 text-xs font-black uppercase tracking-widest">No past orders</div>';
            return;
        }
        
        let ordersList = [];
        snap.forEach(d => ordersList.push({ docId: d.id, ...d.data() }));
        ordersList.sort((a, b) => b.lastUpdated?.toMillis() - a.lastUpdated?.toMillis());
        
        let html = '<div class="space-y-4">';
        ordersList.forEach(o => {
            const domId = `hist-${o.docId}`; // Unique ID for modal inputs
            const isCanEdit = state.canEdit;
            
            html += `
            <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
                <div class="flex justify-between items-start mb-3">
                    <div>
                        <p class="text-[9px] font-black text-slate-400 uppercase">${o.displayDate || 'Recent'}</p>
                        <p class="text-xs font-black text-slate-800">${o.itemName || 'Item'}</p>
                    </div>
                    <p class="text-xs font-black text-blue-600">${state.pricing.symbol}${o.price || 0}</p>
                </div>
                
                <div class="flex gap-2 items-center mt-3 pt-3 border-t border-slate-100">
                    <select id="status-${domId}" ${!isCanEdit ? 'disabled' : ''} class="flex-1 bg-slate-50 border border-slate-200 text-[10px] font-black uppercase rounded-lg px-2 py-2 outline-none">
                        <option value="Pending" ${o.status === 'Pending' ? 'selected' : ''}>Pending</option>
                        <option value="Processing" ${o.status === 'Processing' ? 'selected' : ''}>Processing</option>
                        <option value="Dispatched" ${o.status === 'Dispatched' ? 'selected' : ''}>Dispatched</option>
                        <option value="Delivered" ${o.status === 'Delivered' ? 'selected' : ''}>Delivered</option>
                        <option value="Cancelled" ${o.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    
                    ${isCanEdit ? `
                    <button onclick="window.updateOrderStatus('order', '${o.docId}', '${o.customerPhone}', '${o.customerName}', '${domId}')" 
                            class="bg-blue-600 text-white px-4 py-2 rounded-lg text-[10px] font-black uppercase">
                        Save
                    </button>` : ''}
                </div>
            </div>`;
        });
        html += '</div>';
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div class="text-red-500 p-5 text-center text-xs">Failed to load history</div>';
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
    csvContent += "Type,Order ID,Customer Name,Phone,Item/Details,Price,Payment Method,Status\n";

    state.orders.forEach(o => {
        const type = o._type.toUpperCase();
        const id = o.docId || '-';
        const name = (o.customerName || 'Customer').replace(/,/g, '');
        const phone = o.customerPhone || '-';
        const item = (o.title || 'None').replace(/,/g, '') + ' ' + (o.timeString || '');
        const price = o.price || '0';
        const payment = o.paymentMethod || 'N/A';
        const status = o.status || 'Pending';
        
        csvContent += `${type},${id},${name},${phone},${item},${price},${payment},${status}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `orders_export_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Data Exported!", "success");
}

// 🚀 Premium Theme Matching Edit Price Function
async function editOrderPrice(docId, currentPrice) {
    if (!state.canEdit) return;
    
    const { value: newPrice } = await Swal.fire({
        title: 'Update Order Value',
        text: `Enter the new amount (${state.pricing.symbol}) for this order:`,
        input: 'number',
        inputValue: currentPrice,
        showCancelButton: true,
        confirmButtonText: 'Save Price',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#2563EB', 
        cancelButtonColor: '#94A3B8',  
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