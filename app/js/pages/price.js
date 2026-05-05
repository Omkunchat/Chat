import { db, auth } from "../firebase.js";
import { doc, getDoc, collectionGroup, getDocs, query, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";

let state = {
    user: null,
    workspaceId: null,
    role: "owner",
    sellerData: {},
    pricing: {
        symbol: '₹',
        sparkMonthly: 599,
        blazeSetup: 599
    }
};

const BILLING_API = "https://billing.chatkunhq.workers.dev"; 

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;
    const userEmail = state.user.email.toLowerCase();

    // WORKSPACE FINDER & SECURITY CHECK
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
            showToast("Workspace not found", "error");
            return;
        }
    }

    if (state.role !== 'owner') {
        document.querySelector('.max-w-7xl').innerHTML = `<div class="text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Only Owners can access Billing</div>`;
        return;
    }

    await loadBillingData();

    window.activateSpark = activateSpark;
    window.activateBlaze = activateBlaze;
    window.calculateBill = calculateBill;

    calculateBill();
}

export function destroy() {}

async function loadBillingData() {
    try {
        const docRef = doc(db, "sellers", state.workspaceId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            state.sellerData = docSnap.data();
            updatePricingUI();
        }
    } catch (e) {
        showToast("Failed to load billing details", "error");
    }
}

// 🚀 UI UPDATE FIX (Buttons disabled state)
function updatePricingUI() {
    const data = state.sellerData;
    const nowMs = Date.now();
    const currentPlan = data.planType || 'spark'; 
    
    const btnSpark = document.getElementById('btn-activate-spark');
    const btnBlaze = document.getElementById('btn-activate-blaze');

    if (currentPlan === 'blaze') {
        document.getElementById('card-blaze').classList.add('ring-2', 'ring-blue-500', 'scale-[1.02]');
        document.getElementById('badge-blaze').classList.remove('hidden');
        document.getElementById('badge-blaze').classList.add('inline-flex');
        
        // Blaze Button UI
        if(btnBlaze) {
            btnBlaze.innerText = "Blaze Active";
            btnBlaze.disabled = true;
            btnBlaze.classList.replace('bg-white', 'bg-slate-800');
            btnBlaze.classList.replace('text-black', 'text-slate-400');
            btnBlaze.classList.add('cursor-not-allowed', 'opacity-75');
            btnBlaze.classList.remove('hover:bg-slate-200', 'active:scale-95');
        }

        // Disable Spark Button if Blaze is active
        if(btnSpark) {
            btnSpark.innerText = "Switched to Blaze";
            btnSpark.disabled = true;
            btnSpark.classList.add('cursor-not-allowed', 'opacity-50');
            btnSpark.classList.remove('hover:bg-black', 'active:scale-95');
        }
    } 
    else {
        document.getElementById('card-spark').classList.add('ring-2', 'ring-emerald-500', 'scale-[1.02]');
        document.getElementById('badge-spark').classList.remove('hidden');
        document.getElementById('badge-spark').classList.add('inline-flex');

        // Spark Expiry Check
        if (data.subscriptionEndsAt) {
            const endMs = data.subscriptionEndsAt.toMillis ? data.subscriptionEndsAt.toMillis() : new Date(data.subscriptionEndsAt).getTime();
            if (nowMs < endMs && btnSpark) {
                btnSpark.innerText = "Active Subscription";
                btnSpark.disabled = true;
                btnSpark.classList.add('cursor-not-allowed', 'opacity-50');
                btnSpark.classList.remove('hover:bg-black', 'active:scale-95');
            }
        }
    }
}

function calculateBill() {
    const aiCount = parseInt(document.getElementById('calc-ai').value) || 0;
    const teamCount = parseInt(document.getElementById('calc-team').value) || 0;
    const crmCount = parseInt(document.getElementById('calc-crm').value) || 0;
    const prodCount = parseInt(document.getElementById('calc-prod').value) || 0;
    const offerCount = parseInt(document.getElementById('calc-offer').value) || 0;
    const tplCount = parseInt(document.getElementById('calc-tpl').value) || 0;

    const aiCost = aiCount * 0.30;
    const teamCost = Math.max(0, teamCount - 2) * 500;
    const crmCost = Math.max(0, crmCount - 100) * 0.5;
    const prodCost = Math.max(0, prodCount - 50) * 1;
    const offerCost = Math.max(0, offerCount - 5) * 2;
    
    let tplCost = 0;
    if (tplCount > 5) {
        tplCost = (tplCount - 5) * 2;
        if (tplCount >= 100) tplCost += 200;
    }

    const total = aiCost + teamCost + crmCost + prodCost + offerCost + tplCost;

    document.getElementById('out-ai').innerText = `₹${aiCost.toFixed(2)}`;
    document.getElementById('out-team').innerText = `₹${teamCost.toFixed(2)}`;
    document.getElementById('out-crm').innerText = `₹${crmCost.toFixed(2)}`;
    document.getElementById('out-prod').innerText = `₹${prodCost.toFixed(2)}`;
    document.getElementById('out-offer').innerText = `₹${offerCost.toFixed(2)}`;
    document.getElementById('out-tpl').innerText = `₹${tplCost.toFixed(2)}`;
    document.getElementById('out-total').innerText = `₹${total.toFixed(2)}`;
}

async function activateSpark() {
    startCheckout('spark', state.pricing.sparkMonthly);
}

async function activateBlaze() {
    startCheckout('blaze_setup', state.pricing.blazeSetup);
}

// 🚀 API DEBUGGING FIX (Find out exactly why the Gateway fails)
async function startCheckout(type, amount) {
    const btnId = type === 'spark' ? 'btn-activate-spark' : 'btn-activate-blaze';
    const btn = document.getElementById(btnId);
    if (btn && btn.disabled) return; // Prevent click if already active

    showToast("Processing payment request...", "info");
    
    try {
        const payload = {
            sellerUid: state.workspaceId,
            amount: amount,
            currency: "INR",
            paymentType: type
        };
        
        console.log("🚀 Payload sent to Worker:", payload);

        const response = await fetch(`${BILLING_API}/create-checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Agar Worker क्रैश होता है या 500 एरर देता है
        if (!response.ok) {
            const errText = await response.text();
            console.error("❌ Worker Error Response:", errText);
            throw new Error(`Server API Error: ${response.status}`);
        }

        const data = await response.json();

        if (data.paymentUrl) {
            window.location.href = data.paymentUrl; 
        } else {
            console.error("❌ Invalid Gateway Data:", data);
            throw new Error(data.error || "Payment link missing in response");
        }
    } catch (e) {
        console.error("🔥 Checkout Error details:", e);
        showToast("Gateway error. Check console.", "error");
    }
}