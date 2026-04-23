import { db, auth } from "../firebase.js";
import { doc, getDoc, collection, query, where, orderBy, onSnapshot, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";

let state = {
    user: null,
    workspaceId: null,
    unsubscribe: null,
    allBookings: []
};

// ── Initialization ──
export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();
    const ownerDocSnap = await getDoc(doc(db, "sellers", state.user.uid));
    
    if (ownerDocSnap.exists()) {
        state.workspaceId = state.user.uid;
    } else {
        const q = query(collection(db, 'team_members_global'), where('email', '==', userEmail));
        showToast("Agent mode detected", "info");
    }

    const today = new Date().toLocaleDateString('en-CA'); 
    document.getElementById('calendar-date-picker').value = new Date().toISOString().split('T')[0];
    document.getElementById('walkin_date').value = new Date().toISOString().split('T')[0];

    startRealtimeListener();

    window.openBookingModal = () => {
        const modal = document.getElementById('booking-modal');
        modal.classList.remove('hidden');
        setTimeout(() => {
            modal.classList.remove('opacity-0');
            document.getElementById('modal-content').classList.remove('scale-95');
        }, 10);
    };
    
    window.closeBookingModal = () => {
        const modal = document.getElementById('booking-modal');
        modal.classList.add('opacity-0');
        document.getElementById('modal-content').classList.add('scale-95');
        setTimeout(() => {
            modal.classList.add('hidden');
            document.getElementById('conflict-warning').classList.add('hidden');
        }, 300);
    };
    
    window.saveWalkinBooking = saveWalkinBooking;
    window.filterByDate = renderAppointments;
    window.updateBookingStatus = updateBookingStatus;
    window.checkConflicts = checkConflicts;
}

export function destroy() {
    if (state.unsubscribe) state.unsubscribe();
}

// ── Real-Time Listener ──
function startRealtimeListener() {
    const ordersRef = collection(db, "sellers", state.workspaceId, "orders");
    const q = query(
        ordersRef, 
        where("jobType", "in", ["booking", "pickup"]),
        orderBy("createdAt", "desc")
    );

    state.unsubscribe = onSnapshot(q, (snapshot) => {
        state.allBookings = [];
        snapshot.forEach(doc => {
            state.allBookings.push({ id: doc.id, ...doc.data() });
        });
        renderAppointments();
    }, (error) => {
        console.error("Calendar Sync Error:", error);
        showToast("Error syncing live calendar.", "error");
    });
}

// ── Render UI & Smart Filter ──
function renderAppointments() {
    const listEl = document.getElementById('appointments-list');
    const selectedDateObj = new Date(document.getElementById('calendar-date-picker').value);
    const selectedDateFormatted = selectedDateObj.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }); 
    const selectedDateStr = document.getElementById('calendar-date-picker').value;

    listEl.innerHTML = "";
    let stats = { total: 0, pending: 0, confirmed: 0, completed: 0 };

    const filtered = state.allBookings.filter(b => {
        const itemText = (b.itemName || "").toLowerCase();
        const displayDate = b.displayDate || "";
        
        if (b.status === "Pending") return true;
        
        if (itemText.includes(selectedDateFormatted.toLowerCase()) || displayDate.includes(selectedDateStr) || itemText.includes("today")) {
            return true;
        }
        return false;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="p-12 text-center text-slate-400 text-sm font-bold">
            <div class="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-3 border border-slate-100 shadow-sm">
                <i class="fa-solid fa-mug-hot text-2xl text-slate-300"></i>
            </div>
            No bookings found for this date. You are free!
        </div>`;
    }

    filtered.forEach(booking => {
        stats.total++;
        if(booking.status === 'Pending') stats.pending++;
        if(booking.status === 'Confirmed') stats.confirmed++;
        if(booking.status === 'Completed') stats.completed++;

        // 🚀 FIX: Ab phone number nahi, address check karega
        const isAI = booking.address !== "Walk-in Customer";
        let badgeColor = 'slate';
        let icon = 'fa-calendar-day';
        
        switch(booking.status) {
            case 'Pending': badgeColor = 'amber'; icon = 'fa-clock'; break;
            case 'Confirmed': badgeColor = 'blue'; icon = 'fa-thumbs-up'; break;
            case 'Completed': badgeColor = 'emerald'; icon = 'fa-check-double'; break;
            case 'Cancelled': badgeColor = 'red'; icon = 'fa-ban'; break;
        }

        const formattedDate = new Date(booking.createdAt).toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true, month: 'short', day: 'numeric' });

        const html = `
            <div class="p-4 hover:bg-slate-50 transition flex flex-col md:flex-row md:items-center justify-between gap-4 group border-l-4 border-transparent hover:border-${badgeColor}-400">
                <div class="flex items-start gap-4 w-full md:w-auto overflow-hidden">
                    <div class="w-12 h-12 rounded-2xl bg-${badgeColor}-50 flex items-center justify-center text-${badgeColor}-500 text-xl shrink-0 border border-${badgeColor}-100 shadow-sm group-hover:scale-105 transition-transform">
                        <i class="fa-solid ${icon}"></i>
                    </div>
                    <div class="min-w-0">
                        <h4 class="text-sm font-black text-slate-800 flex items-center gap-2 truncate">
                            ${booking.customerName || 'Guest'}
                            ${isAI ? `<span class="bg-green-50 text-green-600 px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider border border-green-200" title="Booked via WhatsApp AI"><i class="fa-brands fa-whatsapp"></i> AI</span>` : `<span class="bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider border border-slate-200" title="Offline Walk-in"><i class="fa-solid fa-store"></i> Walk-in</span>`}
                        </h4>
                        <p class="text-xs font-bold text-slate-600 mt-0.5 truncate">${booking.itemName}</p>
                        <p class="text-[10px] font-bold text-slate-400 mt-1"><i class="fa-solid fa-phone mr-1"></i> +${booking.customerPhone}</p>
                    </div>
                </div>
                
                <div class="flex flex-row md:flex-col md:items-end justify-between items-center gap-2 shrink-0 border-t md:border-t-0 border-slate-100 pt-3 md:pt-0 mt-2 md:mt-0">
                    <div class="relative">
                        <select onchange="window.updateBookingStatus('${booking.id}', this.value)" class="appearance-none pl-3 pr-8 py-1.5 bg-${badgeColor}-50 text-${badgeColor}-700 border border-${badgeColor}-200 rounded-lg text-[10px] font-black uppercase tracking-wider outline-none cursor-pointer shadow-sm hover:bg-${badgeColor}-100 transition">
                            <option value="Pending" ${booking.status === 'Pending' ? 'selected' : ''}>Pending</option>
                            <option value="Confirmed" ${booking.status === 'Confirmed' ? 'selected' : ''}>Confirmed</option>
                            <option value="Completed" ${booking.status === 'Completed' ? 'selected' : ''}>Completed</option>
                            <option value="Cancelled" ${booking.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                        </select>
                        <i class="fa-solid fa-chevron-down absolute right-3 top-2.5 text-[8px] text-${badgeColor}-500 pointer-events-none"></i>
                    </div>
                    <span class="text-[9px] font-bold text-slate-400"><i class="fa-regular fa-clock mr-1"></i>${formattedDate}</span>
                </div>
            </div>
        `;
        listEl.insertAdjacentHTML('beforeend', html);
    });

    document.getElementById('stat-total').innerText = stats.total;
    document.getElementById('stat-pending').innerText = stats.pending;
    document.getElementById('stat-confirmed').innerText = stats.confirmed;
    document.getElementById('stat-completed').innerText = stats.completed;
}

// ── Real-time Status Update ──
async function updateBookingStatus(orderId, newStatus) {
    try {
        await updateDoc(doc(db, "sellers", state.workspaceId, "orders", orderId), {
            status: newStatus,
            lastUpdated: new Date().toISOString()
        });
        showToast(`Booking marked as ${newStatus}`, "success");
    } catch(e) {
        showToast("Error updating status", "error");
    }
}

// ── Conflict Checker ──
function checkConflicts() {
    const selectedDate = new Date(document.getElementById('walkin_date').value).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toLowerCase();
    const warningBox = document.getElementById('conflict-warning');
    
    const hasConflict = state.allBookings.some(b => 
        (b.status === "Pending" || b.status === "Confirmed") && 
        (b.itemName || "").toLowerCase().includes(selectedDate)
    );

    if (hasConflict) {
        warningBox.classList.remove('hidden');
    } else {
        warningBox.classList.add('hidden');
    }
}

// ── Save Walk-in Booking ──
async function saveWalkinBooking() {
    const name = document.getElementById('walkin_name').value.trim();
    const phone = document.getElementById('walkin_phone').value.trim() || "Walk-in";
    const service = document.getElementById('walkin_service').value.trim();
    const dateInput = document.getElementById('walkin_date').value;
    const timeInput = document.getElementById('walkin_time').value;

    if(!name || !service || !dateInput || !timeInput) {
        showToast("Please fill all required fields (*).", "error"); 
        return;
    }

    const btn = document.getElementById('btn-save-walkin');
    const loader = document.getElementById('walkin-loader');
    btn.disabled = true; loader.classList.remove('hidden');

    try {
        const orderId = `APT-W-${Date.now().toString().slice(-6)}`;
        
        const formattedDate = new Date(dateInput).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
        const [hour, min] = timeInput.split(':');
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const formattedHour = hour % 12 || 12;
        const timeString = `${formattedHour}:${min} ${ampm}`;
        
        const bookingDetails = `${service} on ${formattedDate} at ${timeString} (Offline)`;

        await setDoc(doc(db, "sellers", state.workspaceId, "orders", orderId), {
            sellerId: state.workspaceId,
            customerPhone: phone,
            customerName: name,
            jobType: "booking",
            itemName: bookingDetails,
            price: 0,
            address: "Walk-in Customer",
            paymentMethod: "N/A",
            status: "Confirmed", 
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            displayDate: dateInput
        });

        showToast("Offline Booking Added Successfully! ✅", "success");
        window.closeBookingModal();

        document.getElementById('walkin_name').value = '';
        document.getElementById('walkin_phone').value = '';
        document.getElementById('walkin_service').value = '';
        document.getElementById('walkin_time').value = '';

    } catch (e) {
        showToast("Failed to save booking.", "error");
    } finally {
        btn.disabled = false; loader.classList.add('hidden');
    }
}