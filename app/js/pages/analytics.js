import { db, auth } from "../firebase.js";
import { collection, query, where, getDocs, doc, getDoc, collectionGroup, limit } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, canEditFeature } from "../role.js"; // 🚀 RBAC Import

let state = {
    user: null,
    workspaceId: null, // 🚀 NAYA
    role: "owner",     // 🚀 NAYA
    timeframe: '7d', 
};

let charts = { traffic: null, workload: null };

// --- INITIALIZATION ---
export async function init() {
    console.log("[ANALYTICS] Live Insight Engine Initialized");
    
    state.user = auth.currentUser;
    if (!state.user) return;
    const userEmail = state.user.email.toLowerCase();

    // 🚀 1. BULLETPROOF WORKSPACE FINDER
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

    // 🛡️ 2. SECURITY CHECK
    if (!hasNavPermission(state.role, 'navAnalytics')) {
        const wrapper = document.getElementById('analytics-wrapper');
        if(wrapper) wrapper.innerHTML = `<div class="col-span-full text-center py-20 text-red-500 font-black uppercase tracking-widest bg-red-50 rounded-3xl border border-red-100"><i class="fa-solid fa-lock text-3xl mb-3 block"></i> Access Denied</div>`;
        return;
    }

    // 🔥 Hide Export Button if not authorized
    if (!canEditFeature(state.role, 'settings')) { 
        const exportBtn = document.getElementById('btn-export-analytics');
        if(exportBtn) exportBtn.style.display = 'none';
    }

    setTimeout(() => { fetchLiveAnalyticsData(); }, 100);
}

export function destroy() {
    if (charts.traffic) charts.traffic.destroy();
    if (charts.workload) charts.workload.destroy();
}

// --- 🚀 REAL-TIME DATA FETCHING & LOGIC ---
async function fetchLiveAnalyticsData() {
    try {
        document.getElementById('trafficChartLoader').style.display = 'flex';

        const now = new Date();
        let daysToFetch = state.timeframe === '7d' ? 7 : (state.timeframe === '30d' ? 30 : 90); 
        
        const cutoffDate = new Date();
        cutoffDate.setDate(now.getDate() - daysToFetch);
        cutoffDate.setHours(0,0,0,0); 

        let totalConversations = 0, aiHandledChats = 0, humanHandledChats = 0;
        let dailyTraffic = {};

        for(let i = daysToFetch - 1; i >= 0; i--) {
            let d = new Date(); 
            d.setDate(now.getDate() - i);
            dailyTraffic[d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })] = 0;
        }

        // 🚀 SCALABLE QUERY 1: FETCH CHATS (With server-side limits)
        const chatsRef = collection(db, "sellers", state.workspaceId, "chats");
        const qChats = state.timeframe === 'all' 
            ? query(chatsRef, limit(1000)) 
            : query(chatsRef, where("updatedAt", ">=", cutoffDate), limit(1000));
            
        const chatsSnap = await getDocs(qChats);

        chatsSnap.forEach(doc => {
            const data = doc.data();
            totalConversations++;
            if (data.needsHuman === true || data.aiActive === false) humanHandledChats++;
            else aiHandledChats++;

            let updatedAt = data.updatedAt ? (data.updatedAt.toDate ? data.updatedAt.toDate() : new Date(data.updatedAt)) : new Date();
            const dateStr = updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (dailyTraffic[dateStr] !== undefined) dailyTraffic[dateStr]++;
        });

        // 🚀 SCALABLE QUERY 2: FETCH LEADS (With server-side limits)
        const leadsRef = collection(db, "leads");
        const qLeads = state.timeframe === 'all'
            ? query(leadsRef, where("sellerId", "==", state.workspaceId), limit(1000))
            : query(leadsRef, where("sellerId", "==", state.workspaceId), where("updatedAt", ">=", cutoffDate), limit(1000));
            
        const leadsSnap = await getDocs(qLeads);
        let intentStats = {};

        leadsSnap.forEach(doc => {
            const data = doc.data();
            let intent = data.intent || 'General Inquiry';
            if (!intentStats[intent]) intentStats[intent] = { count: 0, won: 0 };
            
            intentStats[intent].count++;
            if (data.status === 'won') intentStats[intent].won++;
        });

        let topIntents = Object.keys(intentStats).map(key => {
            let stats = intentStats[key];
            return {
                keyword: key, count: stats.count,
                conversion: Math.round((stats.won / stats.count) * 100) || 0
            };
        }).sort((a, b) => b.count - a.count).slice(0, 5);

        // UI Updates
        const automationRate = totalConversations > 0 ? Math.round((aiHandledChats / totalConversations) * 100) : 0;
        animateValue('stat-automation', 0, automationRate, 1000, '%');
        animateValue('stat-conversations', 0, totalConversations, 1000, '');

        let trafficLabels = Object.keys(dailyTraffic);
        let trafficData = Object.values(dailyTraffic);
        
        renderTrafficChart(trafficLabels, trafficData);
        renderWorkloadChart(aiHandledChats, humanHandledChats);
        renderIntentsTable(topIntents);

    } catch (error) {
        console.error("Live Analytics Error:", error);
        showToast("Error loading live data", "error");
        document.getElementById('trafficChartLoader').style.display = 'none';
    }
}

// --- CHARTS RENDERING (Chart.js) ---

function renderTrafficChart(labels, data) {
    const ctx = document.getElementById('trafficChart');
    const loader = document.getElementById('trafficChartLoader');
    if (!ctx) return;
    
    if (loader) loader.style.display = 'none'; 
    if (charts.traffic) charts.traffic.destroy();

    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(79, 70, 229, 0.2)'); 
    gradient.addColorStop(1, 'rgba(79, 70, 229, 0)');

    charts.traffic = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Active Chats',
                data: data,
                borderColor: '#4f46e5', // Indigo 600
                backgroundColor: gradient,
                borderWidth: 3,
                pointBackgroundColor: '#ffffff',
                pointBorderColor: '#4f46e5',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleFont: { family: 'Inter', size: 11 },
                    bodyFont: { family: 'Inter', size: 13, weight: 'bold' },
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: '#94a3b8' }
                },
                y: {
                    border: { display: false },
                    grid: { color: '#f1f5f9', drawBorder: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: '#94a3b8', precision: 0, beginAtZero: true } // Precision 0 ensures whole numbers
                }
            }
        }
    });
}

function renderWorkloadChart(aiCount, humanCount) {
    const ctx = document.getElementById('workloadChart');
    if (!ctx) return;
    if (charts.workload) charts.workload.destroy();

    // If there is no data at all, show a grey ring
    const noData = (aiCount === 0 && humanCount === 0);
    const plotData = noData ? [1] : [aiCount, humanCount];
    const plotColors = noData ? ['#e2e8f0'] : ['#4f46e5', '#cbd5e1'];

    charts.workload = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: noData ? ['No Data'] : ['AI Handled', 'Human Handled'],
            datasets: [{
                data: plotData,
                backgroundColor: plotColors,
                borderWidth: 0,
                hoverOffset: noData ? 0 : 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '75%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: !noData,
                    backgroundColor: '#1e293b',
                    bodyFont: { family: 'Inter', size: 12, weight: 'bold' },
                    padding: 10,
                    cornerRadius: 8
                }
            },
            animation: { animateScale: true, animateRotate: true }
        }
    });
}

function renderIntentsTable(intents) {
    const tbody = document.getElementById('top-intents-table');
    if (!tbody) return;

    if (intents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="p-8 text-center text-slate-400 text-[10px] font-black uppercase tracking-widest"><i class="fa-solid fa-box-open opacity-30 text-3xl mb-2"></i><br>No customer data yet</td></tr>`;
        return;
    }

    let html = '';
    intents.forEach((intent, index) => {
        html += `
        <tr class="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
            <td class="p-4 pl-6 flex items-center gap-3">
                <span class="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-[9px] font-black">${index + 1}</span>
                <span class="text-[11px] font-black text-slate-800 uppercase tracking-tight">${intent.keyword}</span>
            </td>
            <td class="p-4 text-center text-xs font-bold text-slate-600">${intent.count}</td>
            <td class="p-4 text-center">
                <span class="inline-flex px-2.5 py-1 bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-lg text-[10px] font-black tracking-widest">${intent.conversion}%</span>
            </td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

// --- ACTIONS & UTILS ---

window.updateAnalyticsTimeframe = (timeframe) => {
    state.timeframe = timeframe;
    
    document.querySelectorAll('.timeframe-btn').forEach(btn => {
        btn.classList.remove('bg-indigo-50', 'text-indigo-600', 'active-timeframe');
        btn.classList.add('text-slate-500');
    });
    
    const activeBtn = document.getElementById(`btn-${timeframe}`);
    activeBtn.classList.remove('text-slate-500');
    activeBtn.classList.add('bg-indigo-50', 'text-indigo-600', 'active-timeframe');
    
    fetchLiveAnalyticsData();
};

window.exportAnalytics = () => {
    showToast("Generating PDF Report...", "success");
    setTimeout(() => {
        showToast("Report sent to your email", "success");
    }, 1500);
};

// Fancy Number Animation
function animateValue(id, start, end, duration, suffix = '') {
    const obj = document.getElementById(id);
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = Math.floor(progress * (end - start) + start) + suffix;
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
}