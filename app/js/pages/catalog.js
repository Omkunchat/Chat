import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, doc, deleteDoc, onSnapshot, getDoc, getDocs, collectionGroup, limit 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";

// 🟢 NAYA: Central Permissions System
import { hasNavPermission, canEditFeature } from "../role.js";

// --- STATE MANAGER ---
let state = {
    user: null,
    workspaceId: null, // 🟢 असली दुकान की ID
    role: "owner",     // यूज़र का रोल
    canEdit: false,    // क्या ये यूज़र प्रोडक्ट एडिट/डिलीट कर सकता है?
    products: [],
    searchQuery: '',
    stockFilter: 'all',
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

let catalogUnsubscribe = null;

// --- INITIALIZATION ---
export async function init() {
    console.log("[CATALOG] Enterprise Knowledge Base Initialized");

    if (catalogUnsubscribe) catalogUnsubscribe();
    
    state.user = auth.currentUser;
    if (!state.user) return;

    const userEmail = state.user.email.toLowerCase();

    // 🟢 1. BULLETPROOF WORKSPACE FINDER
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
            state.role = "owner";
            state.workspaceId = state.user.uid;
        }
    }

    // 🟢 2. SECURITY: Check Catalog Permissions
    const canAccessCatalog = hasNavPermission(state.role, 'navCatalog');
    
    if (!canAccessCatalog) {
    window.location.hash = '#inbox'; // अगर देखने की इजाज़त नहीं है, तो भगा दो
    return;
}
    
// Master role matrix se check karein ki kya ye user product badal sakta hai
state.canEdit = canEditFeature(state.role, 'catalog');

    // 🟢 3. NEW FEATURE: Export to CSV Binding
    window.exportCatalogCSV = exportCatalogCSV;
    await detectCurrency();
    setupCatalogListener();
}

export function destroy() {
    if (catalogUnsubscribe) catalogUnsubscribe();
}

// --- CORE DATA LOGIC (REAL-TIME & SCALED FOR 1 LAKH USERS) ---
function setupCatalogListener() {
    const productsRef = collection(db, "products");
    
    // 🟢 BILLING SAVER: Limit to 300 to avoid massive read costs
    const q = query(
        productsRef, 
        where("sellerId", "==", state.workspaceId), // 🟢 Owner ID इस्तेमाल की
        orderBy("createdAt", "desc"),
        limit(300) 
    );

    catalogUnsubscribe = onSnapshot(q, (snapshot) => {
        state.products = [];
        snapshot.forEach((docSnap) => {
            state.products.push({ id: docSnap.id, ...docSnap.data() });
        });
        
        updateStats();
        renderProductsGrid();
    }, (error) => {
        console.error("Catalog Sync Error:", error);
        document.getElementById('products-grid').innerHTML = `<div class="col-span-full text-center text-red-400 py-10 text-xs font-bold">Failed to load catalog. Ensure Database rules are correct.</div>`;
    });
}

function updateStats() {
    const total = state.products.length;
    const categories = new Set();
    state.products.forEach(p => {
        if(p.category) categories.add(p.category.toLowerCase());
    });

    const totalEl = document.getElementById('display-total-products');
    if (totalEl) totalEl.innerText = total > 299 ? "300+" : total; // Limit Indicator

    const catEl = document.getElementById('display-categories');
    if (catEl) catEl.innerText = categories.size;
}

// --- RENDERING GRID ---
function renderProductsGrid() {
    const grid = document.getElementById('products-grid');
    if (!grid) return;

    let filteredProducts = state.products.filter(p => {
        const matchesSearch = !state.searchQuery || 
                              p.name.toLowerCase().includes(state.searchQuery) ||
                              p.category.toLowerCase().includes(state.searchQuery);
        
        let matchesStock = true;
        if (state.stockFilter === 'in_stock') matchesStock = p.inStock === true;
        if (state.stockFilter === 'out_of_stock') matchesStock = p.inStock === false;

        return matchesSearch && matchesStock;
    });

    if (filteredProducts.length === 0) {
        // 🟢 SECURITY: सिर्फ 'canEdit' वालों को ही "Add Item" बटन दिखेगा
        const addBtnHTML = state.canEdit ? `<a href="#add-product" class="mt-4 px-6 py-3 bg-white border border-slate-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-600 shadow-sm hover:bg-slate-50 transition">Add New Item</a>` : '';
        
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-20 text-slate-400">
                <i class="fa-solid fa-box-open text-5xl mb-4 opacity-20"></i>
                <p class="text-[10px] font-black uppercase tracking-widest">No items found</p>
                ${addBtnHTML}
            </div>`;
        return;
    }

    let html = '';
    
    // 🟢 NEW FEATURE: Export Button Top Bar
    html += `
    <div class="col-span-full flex justify-end mb-4">
        <button onclick="window.exportCatalogCSV()" class="text-[10px] font-bold text-slate-500 hover:text-blue-600 uppercase tracking-widest bg-white border border-slate-200 px-3 py-1.5 rounded-lg shadow-sm transition-colors">
            <i class="fa-solid fa-file-csv mr-1"></i> Export Catalog
        </button>
    </div>
    `;

    filteredProducts.forEach(product => {
        const price = `${state.pricing.symbol}${new Intl.NumberFormat(state.pricing.locale).format(product.price)}`;
        const imageSrc = product.imageUrl || 'https://placehold.co/400x400/f8fafc/94a3b8?text=No+Image';
        const typeIcon = product.type === 'service' ? '<i class="fa-solid fa-bell-concierge text-purple-600"></i>' : '<i class="fa-solid fa-box text-blue-600"></i>';
        
        const stockBadge = product.inStock 
            ? `<span class="bg-emerald-50 text-emerald-600 text-[9px] px-2 py-1 rounded-lg font-black uppercase tracking-widest border border-emerald-100">In Stock</span>`
            : `<span class="bg-red-50 text-red-500 text-[9px] px-2 py-1 rounded-lg font-black uppercase tracking-widest border border-red-100">Out of Stock</span>`;

        // 🟢 SECURITY: सिर्फ 'canEdit' वालों को ही Edit (Pen) और Delete (Trash) बटन दिखेंगे
        const actionButtonsHTML = state.canEdit ? `
            <div class="flex gap-2">
                <a href="#add-product?id=${product.id}" class="w-8 h-8 rounded-xl bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-blue-600 flex items-center justify-center transition shadow-sm border border-slate-100">
                    <i class="fa-solid fa-pen text-[10px]"></i>
                </a>
                <button onclick="window.deleteProduct('${product.id}')" class="w-8 h-8 rounded-xl bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition shadow-sm border border-slate-100">
                    <i class="fa-solid fa-trash text-[10px]"></i>
                </button>
            </div>
        ` : '';

        html += `
        <div class="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden group hover:shadow-xl hover:border-purple-200 transition-all duration-300 flex flex-col">
            
            <div class="aspect-square w-full relative overflow-hidden bg-slate-50">
                <img src="${imageSrc}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                <div class="absolute top-3 left-3">${stockBadge}</div>
                <div class="absolute top-3 right-3 w-8 h-8 bg-white/90 backdrop-blur rounded-full shadow-sm flex items-center justify-center">
                    ${typeIcon}
                </div>
            </div>

            <div class="p-5 flex-1 flex flex-col">
                <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 truncate">${product.category}</p>
                <h3 class="text-sm font-black text-slate-800 uppercase tracking-tight leading-tight mb-2 line-clamp-2 flex-1">${product.name}</h3>
                
                <div class="flex items-end justify-between mt-auto pt-4 border-t border-slate-50">
                    <span class="text-xl font-black text-slate-900 tracking-tighter">${price}</span>
                    ${actionButtonsHTML}
                </div>
            </div>
        </div>`;
    });
    grid.innerHTML = html;
}

// --- NEW FEATURE: EXPORT TO CSV ---
function exportCatalogCSV() {
    if (!state.products || state.products.length === 0) {
        showToast("No products to export", "info");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Name,Category,Type,Price,InStock\n";

    state.products.forEach(p => {
        const name = (p.name || 'Unknown').replace(/,/g, ''); // Remove commas
        const category = (p.category || '-').replace(/,/g, '');
        const type = p.type || 'product';
        const price = p.price || '0';
        const inStock = p.inStock ? 'Yes' : 'No';
        
        csvContent += `${name},${category},${type},${price},${inStock}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `catalog_export_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Catalog Downloaded!", "success");
}

// --- ACTIONS ---
window.handleProductSearch = () => {
    state.searchQuery = document.getElementById('productSearchInput').value.toLowerCase().trim();
    state.stockFilter = document.getElementById('stockFilter').value;
    renderProductsGrid();
};

window.deleteProduct = async (id) => {
    // 🟢 SECURITY: Console हैकिंग से बचने के लिए डबल चेक
    if (!state.canEdit) {
        showToast("You don't have permission to delete", "error");
        return;
    }

    if(!confirm("Delete this? Your AI will instantly stop offering it.")) return;
    try {
        await deleteDoc(doc(db, "products", id));
        showToast("Item Deleted", "success");
    } catch(e) { 
        showToast("Error deleting", "error"); 
    }
};