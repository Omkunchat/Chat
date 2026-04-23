import { auth, db } from "./firebase.js"; 
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { doc, getDoc, getDocs, collectionGroup, query, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js"; 

//  NAYA: Central Permissions System
import { hasNavPermission } from "./role.js";

// --- CONFIGURATION & CACHE ---
const CACHE = new Map(); 
let currentCleanup = null; 

// Chatkun AI WhatsApp Routes
const routes = {
    '#dashboard': { file: 'pages/dashboard.html', title: 'Chatkun | Dashboard', module: './pages/dashboard.js' },
    '#inbox':     { file: 'pages/inbox.html', title: 'Chatkun | Live Inbox', module: './pages/inbox.js' },
    '#leads':     { file: 'pages/leads.html', title: 'Chatkun | Leads & Orders', module: './pages/leads.js' },
    '#lead-form': { file: 'pages/lead-form.html', title: 'Chatkun | Lead Workspace', module: './pages/lead-form.js' },
    '#add-product': { file: 'pages/add-product.html', title: 'Chatkun | Item Workspace', module: './pages/add-product.js' },
    '#order':     { file: 'pages/order.html', title: 'Chatkun | Manage Orders', module: './pages/order.js' },
    '#catalog':   { file: 'pages/catalog.html', title: 'Chatkun | Catalog Manager', module: './pages/catalog.js' },
    '#campaigns': { file: 'pages/campaigns.html', title: 'Chatkun | Broadcast', module: './pages/campaigns.js' },
    '#send-campaigns': { file: 'pages/send-campaigns.html', title: 'Chatkun | Broadcast', module: './pages/send-campaigns.js' },
    '#analytics': { file: 'pages/analytics.html', title: 'Chatkun | Analytics', module: './pages/analytics.js' },
    '#settings':  { file: 'pages/settings.html', title: 'Chatkun | AI Training', module: './pages/settings.js' },
    '#bot-setup':  { file: 'pages/bot-setup.html', title: 'Chatkun | AI Training', module: './pages/bot-setup.js' },
    '#booking':  { file: 'pages/booking.html', title: 'Chatkun | AI Training', module: './pages/booking.js' },
    '#team':      { file: 'pages/team.html', title: 'Chatkun | Team Management', module: './pages/team.js' },
    '#offers':    { file: 'pages/offers.html', title: 'Chatkun | Offers & Coupons', module: './pages/offers.js' },
    '#bookings':  { file: 'pages/bookings.html', title: 'Chatkun | Bookings & Pickups', module: './pages/bookings.js' },
    '#support':   { file: 'pages/support.html', title: 'Chatkun | Support Tickets', module: './pages/support.js' },
    '#reviews':   { file: 'pages/reviews.html', title: 'Chatkun | Customer Reviews', module: './pages/reviews.js' },
    '#quotes':    { file: 'pages/quotes.html', title: 'Chatkun | B2B Custom Quotes', module: './pages/quotes.js' },
    '404':        { file: 'pages/404.html', title: 'Page Not Found' }
};

//  GATEKEEPER MAPPING:   (Route)        
const routeFeatures = {
    '#dashboard': 'navDashboard',
    '#leads': 'navLeads',
    '#catalog': 'navCatalog',
    '#offers': 'navOffers',
    '#campaigns': 'navBroadcast',
    '#analytics': 'navAnalytics',
    '#support': 'navSupportTickets',
    '#settings': 'navSettings',
    '#inbox': null // Inbox    
};

// --- ROUTER ENGINE ---
async function router() {
    if (!auth.currentUser) return; 

    const fullHash = window.location.hash || '#dashboard';
    const hash = fullHash.split('?')[0]; 
    const route = routes[hash] || routes['404'];

    document.title = route.title;
    updateActiveMenu(hash);
    
    const mainContent = document.getElementById('app-root');
    if(!mainContent) return;

    if (typeof currentCleanup === 'function') {
        try { currentCleanup(); } catch (e) {}
        currentCleanup = null;
    }

    window.scrollTo(0, 0);
    mainContent.innerHTML = `<div class="flex h-[60vh] items-center justify-center">
        <div class="flex flex-col items-center gap-3">
            <div class="animate-spin rounded-full h-10 w-10 border-b-4 border-blue-600"></div>
            <p class="text-slate-500 font-medium text-sm animate-pulse">Loading workspace...</p>
        </div>
    </div>`;

    try {
        let html;
        if (CACHE.has(route.file)) {
            html = CACHE.get(route.file);
        } else {
            const response = await fetch(route.file);
            if (!response.ok) throw new Error('Page not found');
            html = await response.text();
            CACHE.set(route.file, html); 
        }

        mainContent.innerHTML = html;

        if (route.module) {
            try {
                const pageModule = await import(route.module + `?v=${Date.now()}`); 
                if (pageModule.init) await pageModule.init();
                if (pageModule.destroy) currentCleanup = pageModule.destroy;
            } catch (err) {
                console.error(`Error loading script ${route.module}:`, err);
            }
        }
    } catch (error) {
        mainContent.innerHTML = `<div class="flex flex-col items-center justify-center h-[60vh] text-center">
            <i class="fa-solid fa-triangle-exclamation text-4xl text-red-400 mb-4"></i>
            <h2 class="text-xl font-bold text-slate-800">Error Loading Page</h2>
            <p class="text-slate-500 mt-2">${error.message}</p>
            <button onclick="window.location.reload()" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Refresh Page</button>
        </div>`;
    }

    if(window.innerWidth < 768) {
        const s = document.getElementById('sidebar');
        if(s && !s.classList.contains('-translate-x-full')) window.toggleSidebar(true);
    }
}

// --- MENU HIGHLIGHT LOGIC ---
function updateActiveMenu(hash) {
    const headerTitle = document.getElementById('header-title');

    document.querySelectorAll('.nav-item').forEach(link => {
        const linkHash = link.getAttribute('href');
        if (linkHash === hash) {
            link.classList.add('active-nav');
            link.classList.remove('text-slate-600', 'hover:bg-slate-50');
            if (headerTitle) headerTitle.textContent = link.getAttribute('data-title');
        } else {
            link.classList.remove('active-nav');
            link.classList.add('text-slate-600', 'hover:bg-slate-50');
        }
    });

    document.querySelectorAll('.nav-item-bottom').forEach(link => {
         const linkHash = link.getAttribute('href');
         if(linkHash === hash) {
             link.classList.add('text-blue-600');
             link.classList.remove('text-slate-400');
         } else {
             link.classList.remove('text-blue-600');
             link.classList.add('text-slate-400');
         }
    });
}

// --- GLOBAL UTILS ---
window.toggleSidebar = function(forceClose = false) {
    const s = document.getElementById('sidebar');
    const o = document.getElementById('sidebar-overlay');
    if (!s) return;
    
    const shouldClose = forceClose || !s.classList.contains('-translate-x-full');
    
    if (shouldClose) {
        s.classList.add('-translate-x-full');
        if(o) o.classList.add('hidden');
    } else {
        s.classList.remove('-translate-x-full');
        if(o) o.classList.remove('hidden');
    }
};

window.handleLogout = async function() {
    Swal.fire({
        title: 'Logging Out?',
        text: "Your WhatsApp bot will keep running in the background.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#2563EB',
        cancelButtonColor: '#d33',
        confirmButtonText: 'Yes, logout'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                await signOut(auth);
                window.location.href = 'login.html'; 
            } catch (error) {}
        }
    });
};

// --- CORE: PROFILE, ROLE & PERMISSIONS SYNC ---
async function initializeUserAndUI(user) {
    if (!user) return;

    // UI Elements
    const headerImg = document.getElementById('header-profile-img');
    const headerName = document.getElementById('header-user-name');
    const headerRole = document.getElementById('header-user-role');
    const headerWorkspace = document.getElementById('header-workspace-name');

    const userEmail = user.email ? user.email.toLowerCase() : '';
    let nameFallback = user.displayName || (userEmail ? userEmail.split('@')[0] : 'User');
    let finalImageUrl = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(nameFallback)}&background=2563EB&color=fff`;

    let role = 'owner'; 
    let workspaceId = user.uid; 
    let workspaceName = "My Workspace";

    try {
        // 1.  BULLETPROOF WORKSPACE FINDER (No dependency on 'users' collection)
        const ownerDocSnap = await getDoc(doc(db, "sellers", user.uid));
        
        if (ownerDocSnap.exists()) {
            role = "owner";
            workspaceId = user.uid;
        } else {
            const teamQuery = query(collectionGroup(db, 'team'), where('email', '==', userEmail));
            const teamSnapshot = await getDocs(teamQuery);

            if (!teamSnapshot.empty) {
                const agentDoc = teamSnapshot.docs[0]; 
                workspaceId = agentDoc.ref.parent.parent.id; 
                
                const aData = agentDoc.data();
                role = (aData.role || 'chat').toLowerCase(); 
                
                // Agent's personal details
                if (aData.name) nameFallback = aData.name;
                if (aData.avatarUrl) finalImageUrl = aData.avatarUrl;
            } else {
                role = "owner";
                workspaceId = user.uid;
            }
        }

        // 2.  FETCH SHOP DETAILS (For Workspace Name and API Status)
        const sellerDoc = await getDoc(doc(db, "sellers", workspaceId));
        if (sellerDoc.exists()) {
            const sellerData = sellerDoc.data();
            workspaceName = sellerData.businessName || "My Workspace";

            // Owner specific image handling
            if (role === 'owner') {
                if (sellerData.avatarUrl) {
                    finalImageUrl = sellerData.avatarUrl;
                } else if (sellerData.businessName && !user.photoURL) {
                    finalImageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(sellerData.businessName)}&background=0F172A&color=fff`;
                }
            }

            // Update API Status Badge
            const apiBadge = document.getElementById('header-api-status');
            if (apiBadge) {
                if (sellerData.metaToken && sellerData.metaPhoneId) {
                    apiBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span class="text-[10px] font-black uppercase tracking-widest text-emerald-700">API Live</span>`;
                    apiBadge.className = "hidden sm:flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-full shadow-sm";
                } else {
                    apiBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span><span class="text-[10px] font-black uppercase tracking-widest text-slate-600">Disconnected</span>`;
                    apiBadge.className = "hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full shadow-sm";
                }
            }
        }

        // 3.  UPDATE HEADER UI
        if (headerImg) headerImg.src = finalImageUrl;
        if (headerName) headerName.innerText = nameFallback;
        if (headerRole) headerRole.innerText = role.toUpperCase();
        if (headerWorkspace) headerWorkspace.innerText = workspaceName;

        // 4.  DYNAMIC MENU HIDING (Driven by roles.js)
        const featureElements = document.querySelectorAll('[data-feature]');
        featureElements.forEach(el => {
            const featureName = el.getAttribute('data-feature');
            if (!hasNavPermission(role, featureName)) {
                el.style.display = 'none'; // Hide forbidden buttons
            } else {
                el.style.display = '';
            }
        });

        // (Optional) Hide empty section titles in sidebar if all child links are hidden
        ['sidebar-store-management', 'sidebar-system'].forEach(groupId => {
            const group = document.getElementById(groupId);
            if (group) {
                const visibleLinks = Array.from(group.querySelectorAll('a')).filter(a => a.style.display !== 'none');
                const title = group.querySelector('.section-title');
                if (visibleLinks.length === 0 && title) {
                    title.style.display = 'none';
                } else if (title) {
                    title.style.display = '';
                }
            }
        });

        // 5.  ROUTE GATEKEEPER
        const currentHash = window.location.hash || '#dashboard';
        const hashBase = currentHash.split('?')[0];
        const requiredFeature = routeFeatures[hashBase];

        // If the user is trying to access a URL they don't have permission for, send to inbox
        if (requiredFeature && !hasNavPermission(role, requiredFeature)) {
            window.location.hash = '#inbox'; 
        }

    } catch (error) {
        console.error("Error fetching user data:", error);
    }
}

// --- INITIALIZATION ---
let isAppInitialized = false;

onAuthStateChanged(auth, async (user) => {
    if (user) {
        await initializeUserAndUI(user); 

        if (!isAppInitialized) {
            window.addEventListener('hashchange', router);
            isAppInitialized = true;
            router(); 
        }
    } else {
        window.location.href = 'login.html'; 
    }
});