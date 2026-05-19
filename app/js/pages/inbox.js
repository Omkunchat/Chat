import { db, auth } from "../firebase.js";
import { 
    collection, query, where, orderBy, onSnapshot, doc, updateDoc, serverTimestamp, getDoc, addDoc, limit, getDocs, collectionGroup 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from "../services/sweet-alert.js";
import { hasNavPermission, getSettingPermission, canEditFeature } from "../role.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-messaging.js";

let state = {
    user: null,
    workspaceId: null, // 🟢 NAYA: मालिक की दुकान (Workspace) की ID
    role: 'chat',
    sellerConfig: null,
    chats: [],
    activeChatPhone: null,
    searchQuery: '',
    currentTab: 'all',
    
    // Notes & UI State
    isNoteMode: false,
    isEmojiOpen: false,
    
    // Recording States
    mediaRecorder: null,
    recordingTimer: null,
    secondsRecorded: 0
};

let unsubChats = null;
let unsubMessages = null;
let approvedTemplates = [];
let lastMessageDoc = null;       // Chat history load more ke liye
let isLoadingOldMessages = false; // Loading status track karne ke liye
let searchTimeout = null;        // Search debounce ke liye (DB hit bachane ke liye)
let quickRepliesArray = []; // Database se replies store karne ke liye
let quickReplySelectedIndex = -1; // Keyboard se select karne ke liye

const EMOJI_LIST = [
    // चेहरे और स्माइली (Faces)
    '\u{1F600}', '\u{1F603}', '\u{1F604}', '\u{1F601}', '\u{1F605}', 
    '\u{1F602}', '\u{1F923}', '\u{1F60A}', '\u{1F607}', '\u{1F642}', 
    '\u{1F643}', '\u{1F609}', '\u{1F60D}', '\u{1F970}', '\u{1F618}', 
    '\u{1F60B}', '\u{1F61B}', '\u{1F60E}', '\u{1F913}', '\u{1F973}',
    
    // हाथ के इशारे (Hands)
    '\u{1F44D}', '\u{1F44E}', '\u{270C}', '\u{1F91E}', '\u{1F91D}', 
    '\u{1F64F}', '\u{1F44F}', '\u{1F64C}',
    
    // सिंबल, दिल और स्टार (Symbols & Stars)
    '\u{2764}', '\u{1F494}', '\u{1F4AF}', '\u{2728}', '\u{1F525}', '\u{2B50}',
    
    // थंबनेल, फाइल्स, और बिज़नेस आइकन (Thumbnails & Work)
    '\u{1F4CC}', // पिन (Pin)
    '\u{1F4CE}', // पेपरक्लिप (Attachment)
    '\u{1F4C4}', // फाइल/डॉक्यूमेंट (Document)
    '\u{1F5BC}', // फोटो फ्रेम (Image)
    '\u{1F4F8}', // कैमरा (Camera)
    '\u{1F3A5}', // वीडियो कैमरा (Video)
    '\u{1F3A4}', // माइक (Mic)
    '\u{1F3B5}', // म्यूजिक (Music)
    '\u{1F514}', // घंटी (Bell)
    '\u{1F4A1}', // बल्ब/आइडिया (Idea)
    '\u{1F4B0}', // पैसे (Money)
    '\u{1F6D2}', // शॉपिंग कार्ट (Cart)
    '\u{1F381}', // गिफ्ट (Gift)
    '\u{2705}', // सही का निशान (Checkmark)
    '\u{274C}', // क्रॉस (Cross)
    '\u{26A0}'  // वार्निंग (Warning)
];

export async function init() {
    state.user = auth.currentUser;
    if (!state.user) return;
    
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        Notification.requestPermission();
    }
    const userEmail = state.user.email.toLowerCase();
    
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

    const roleUI = document.getElementById('current-agent-role');
    if (roleUI) roleUI.innerText = state.role.toUpperCase();

    // 🚀🚀 FIX 1: Order Button ko hide karne ka sahi logic yahan aayega
    const orderTabBtn = document.getElementById('tab-order');
    if (orderTabBtn) {
        if (state.role === 'chat') {
            orderTabBtn.style.display = 'none'; // CSS clash se bachne ke liye direct display none
        } else {
            orderTabBtn.style.display = 'flex'; // Owner ke liye wapas dikhao
        }
    }

    // 🟢 SECURITY: AI Toggle छुपाओ (Using roles.js)
    const aiPerm = getSettingPermission(state.role, 'aiRules');
    const aiToggleWrapper = document.getElementById('ai-toggle-wrapper');
    
    if (aiToggleWrapper) {
        if (aiPerm === 'view' || aiPerm === 'hide') {
            aiToggleWrapper.style.display = 'none';
            aiToggleWrapper.classList.add('hidden'); 
        } else {
            aiToggleWrapper.style.display = 'flex';
            aiToggleWrapper.classList.remove('hidden'); 
        }
    }

    await loadSellerMetaToken();
    
    const workspaceNameEl = document.getElementById('current-workspace-name');
    if (workspaceNameEl && state.sellerConfig && state.sellerConfig.businessName) {
        workspaceNameEl.innerText = state.sellerConfig.businessName;
    }

    loadChatsList();
    initEmojiPicker();
    setupToggleListener();
    setupPushNotifications();
    await loadApprovedTemplates();
    await loadQuickRepliesFromDB();
setupQuickReplyListener();

    const msgInput = document.getElementById('msg-input');
    if(msgInput) {
        msgInput.addEventListener('keypress', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                window.handleMainAction(e);
            }
        });
    }
}

export function destroy() { 
    if (unsubChats) unsubChats(); 
    if (unsubMessages) unsubMessages(); 
}

async function loadSellerMetaToken() {
    const docRef = doc(db, "sellers", state.workspaceId); //  workspaceId
    const snap = await getDoc(docRef);
    if (snap.exists()) state.sellerConfig = snap.data();
}

async function loadApprovedTemplates() {
    const tplRef = collection(db, "sellers", state.workspaceId, "templates");
    const q = query(tplRef, where("status", "==", "APPROVED")); 
    
    try {
        const snapshot = await getDocs(q);
        approvedTemplates = [];
        
        snapshot.forEach(doc => {
            approvedTemplates.push(doc.data());
        });
        
        const selector = document.getElementById('template-selector');
        if(selector) {
            selector.innerHTML = `<option value="">Select a template...</option>`;
            approvedTemplates.forEach(tpl => {
                selector.innerHTML += `<option value="${tpl.name}" data-lang="${tpl.language || 'en_US'}">${tpl.name}</option>`;
            });
        }
    } catch (err) {
        console.error("Error loading approved templates:", err);
    }
}

// ==========================================
// 1. CHAT LIST & TABS (OPTIMIZED FOR 1 LAKH USERS)
// ==========================================
window.setTab = (tabName) => {
    state.currentTab = tabName;
    const tabs = ['all', 'hot', 'starred', 'agent']; 
    tabs.forEach(tab => {
        const el = document.getElementById(`tab-${tab}`);
        if(tab === tabName) {
            el.className = "px-4 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold whitespace-nowrap shadow-sm transition-colors flex items-center gap-1.5";
        } else {
            el.className = "px-4 py-2 bg-white/60 text-slate-600 hover:bg-white border border-slate-200/60 rounded-xl text-xs font-bold whitespace-nowrap transition-colors flex items-center gap-1.5";
        }
    });
    renderChatList();
}

window.searchChats = () => {
    // Pichla timer clear karein (Debounce logic)
    clearTimeout(searchTimeout);
    
    // Typing rukne ke 500ms baad ye chalega
    searchTimeout = setTimeout(async () => {
        const text = document.getElementById('inboxSearch').value.trim();
        const container = document.getElementById('chat-list-container');
        
        // Agar box khali ho gaya, toh regular chats (loadChatsList) wapas le aao
        if (text === '') {
            state.searchQuery = '';
            loadChatsList(); 
            return;
        }

        // Search shuru hui, loading dikhao
        container.innerHTML = `<div class="flex flex-col items-center justify-center h-24 text-slate-500"><i class="fas fa-circle-notch fa-spin text-xl mb-2 text-blue-500"></i><p class="text-[10px] font-bold uppercase tracking-widest">Searching Database...</p></div>`;

        // 🟢 NAYA: Firestore DB Query for Search (Case Sensitive Prefix Search)
        // Note: Firestore search Case-Sensitive hoti hai. Isliye agar customer ka naam capital se hai toh capital dalna padega, ya backend mein ek 'searchName' (lowercase) field save karna padega.
        
        // Check if searching by phone (starts with number/+)
        const isPhoneSearch = text.startsWith('+') || !isNaN(text.charAt(0));
        let q;

        if (isPhoneSearch) {
            // Document ID (Phone number) se search
            const cleanPhone = text.replace('+', '');
            q = query(collection(db, "sellers", state.workspaceId, "chats"), 
                where('__name__', '>=', cleanPhone),
                where('__name__', '<=', cleanPhone + '\uf8ff'),
                limit(30)
            );
        } else {
            // Name se search
            q = query(collection(db, "sellers", state.workspaceId, "chats"), 
                where('customerName', '>=', text),
                where('customerName', '<=', text + '\uf8ff'),
                limit(30)
            );
        }

        try {
            const snapshot = await getDocs(q);
            state.chats = []; // State clear karo
            snapshot.forEach(doc => state.chats.push({ id: doc.id, ...doc.data() }));
            
            // Ab results ko UI mein render karo
            state.searchQuery = ''; // UI filter ko batane ke liye ki in-memory search bypass karni hai
            renderChatList();

        } catch (error) {
            console.error("Search failed: ", error);
            container.innerHTML = `<div class="p-8 text-center text-xs font-bold text-red-400">Search Error occurred</div>`;
        }

    }, 500); // 500ms tak ruko user ke typing finish karne ka
};

function loadChatsList() {
    let q;
    
    // 🟢 AGENT PRIVACY: Agar role 'chat' hai toh sirf uski assigned chats dikhao
    if (state.role === 'chat') {
        const agentName = state.user.displayName || "Agent";
        q = query(
            collection(db, "sellers", state.workspaceId, "chats"), 
            where("assignedTo", "==", agentName), // Sirf assigned chats
            orderBy("updatedAt", "desc"), 
            limit(150)
        );
    } else {
        // Owner ya baaki roles sab dekh sakte hain
        q = query(
            collection(db, "sellers", state.workspaceId, "chats"), 
            orderBy("updatedAt", "desc"), 
            limit(150)
        );
    }
    
    unsubChats = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "modified" || change.type === "added") {
                const chatData = change.doc.data();
                if (chatData.needsHuman === true && chatData.isUnread === true) {
                    if (state.activeChatPhone !== change.doc.id) {
                        playAgentAlert(chatData.customerName || '+' + change.doc.id, chatData.lastMessage || 'Waiting for reply...');
                    }
                }
            }
        });

        state.chats = [];
        snapshot.forEach(d => state.chats.push({ id: d.id, ...d.data() }));
        renderChatList();
        
        if(state.activeChatPhone) {
            const activeChatData = state.chats.find(c => c.id === state.activeChatPhone);
            if(activeChatData) updateHeaderVisuals(activeChatData);
        }
    });
}

function renderChatList() {
    const container = document.getElementById('chat-list-container');
    let filtered = state.chats.filter(c => (c.customerName || c.id || '').toLowerCase().includes(state.searchQuery));

    if (state.currentTab === 'hot') filtered = filtered.filter(c => c.leadStatus === 'hot');
    if (state.currentTab === 'starred') filtered = filtered.filter(c => c.isStarred === true);
    if (state.currentTab === 'agent') filtered = filtered.filter(c => c.needsHuman === true); 

    if (filtered.length === 0) {
        container.innerHTML = `<div class="p-8 text-center text-xs font-bold text-slate-400">No chats found in this view</div>`;
        return;
    }

    let html = '';
    filtered.forEach(chat => {
        const isSelected = state.activeChatPhone === chat.id;
        const bgClass = isSelected ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'bg-white/40 hover:bg-white/80';
        const initial = chat.customerName ? chat.customerName.charAt(0).toUpperCase() : '?';
        const time = chat.updatedAt ? new Date(chat.updatedAt.toDate()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
        
        const starredIcon = chat.isStarred ? `<i class="fa-solid fa-star text-yellow-400 text-xs"></i>` : '';
        const fireIcon = chat.leadStatus === 'hot' ? `<i class="fa-solid fa-fire text-orange-500 text-xs"></i>` : '';
        
        const unreadDot = chat.isUnread ? `<div class="w-2.5 h-2.5 bg-green-500 rounded-full shrink-0 shadow-sm animate-pulse"></div>` : '';
        const needsAgentBadge = chat.needsHuman ? `<span class="bg-red-100 text-red-600 text-[8px] px-1.5 py-0.5 rounded border border-red-200 font-black uppercase tracking-widest shrink-0 shadow-sm">Agent</span>` : '';

        const nameClass = chat.isUnread ? 'font-black text-slate-900' : 'font-bold text-slate-800';
        const msgClass = chat.isUnread ? 'font-bold text-slate-800' : 'font-medium text-slate-500';

        let lastMsgPreview = chat.lastMessage || '...';
        if(lastMsgPreview.includes('http')) lastMsgPreview = ' Media File';

        html += `
        <div onclick="window.openChat('${chat.id}', '${chat.customerName || chat.id}', ${chat.aiActive})" 
             class="flex items-center gap-3 p-3 rounded-2xl cursor-pointer ${bgClass} transition-all">
            <div class="w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-lg font-bold shrink-0 shadow-inner">
                ${initial}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center mb-0.5">
                    <div class="flex items-center gap-1.5 overflow-hidden">
                        <h4 class="text-[15px] ${nameClass} truncate">${chat.customerName || '+' + chat.id}</h4>
                        ${needsAgentBadge}
                    </div>
                    <span class="text-[10px] text-slate-500 font-medium shrink-0 ml-2">${time}</span>
                </div>
                <div class="flex justify-between items-center gap-2">
                    <p class="text-[13px] ${msgClass} truncate flex-1">${lastMsgPreview}</p>
                    <div class="flex items-center gap-1.5 shrink-0">${unreadDot} ${starredIcon} ${fireIcon}</div>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

// ==========================================
// 2. CHAT WINDOW & MESSAGES 
// ==========================================
window.openChat = (phone, name, isAiActive) => {
    state.activeChatPhone = phone; 
    
    // 1. हमेशा 'Empty State' को छुपा दो
    document.getElementById('chat-empty-state').classList.add('hidden');
    
    // 2. डेस्कटॉप और मोबाइल दोनों के लिए Chat Window को Visible कर दो
    const chatWindow = document.getElementById('chat-window-panel');
    chatWindow.classList.remove('hidden');
    chatWindow.classList.add('flex');
    
    // 3. मोबाइल के लिए स्पेशल: लिस्ट को छुपाओ
    if (window.innerWidth < 768) { 
        document.getElementById('chat-list-panel').classList.add('hidden');
        document.body.style.overflow = 'hidden'; 
    }

    // 4. हेडर अपडेट करो
    document.getElementById('chat-header-name').innerText = name;
    document.getElementById('chat-header-phone').innerText = "+" + phone;
    document.getElementById('chat-header-initial').innerText = name.charAt(0).toUpperCase();
    document.getElementById('ai-toggle-btn').checked = isAiActive !== false; 

    const chatData = state.chats.find(c => c.id === phone);
    if(chatData) {
        updateHeaderVisuals(chatData);
        if(chatData.isUnread) {
            updateDoc(doc(db, "sellers", state.workspaceId, "chats", phone), { isUnread: false }); 
        }
        window.check24HourRule(chatData);
    }

    if(state.isEmojiOpen) window.toggleEmojiPicker();
    listenToChatMessages(phone, chatData);
    renderChatList(); 
};

window.check24HourRule = (chatData) => {
    const inputWrapper = document.getElementById('input-wrapper');
    const templateWrapper = document.getElementById('template-wrapper');
    
    // Ideal Case Check: Agar customer ke message ka alag timestamp hai toh wo lo, nahi toh updatedAt lo
    const targetTimestamp = chatData.customerLastMessageAt || chatData.updatedAt;
    
    if (!targetTimestamp) return; 
    
    const lastUpdateDate = targetTimestamp.toDate ? targetTimestamp.toDate() : new Date(targetTimestamp);
    const now = new Date();
    
    const diffHours = (now - lastUpdateDate) / (1000 * 60 * 60);
    
    if (diffHours >= 24) {
        if(inputWrapper) inputWrapper.classList.add('hidden');
        if(templateWrapper) templateWrapper.classList.remove('hidden');
        showToast("24-hour window closed. Template required.", "info");
    } else {
        if(inputWrapper) inputWrapper.classList.remove('hidden');
        if(templateWrapper) templateWrapper.classList.add('hidden');
    }
}

window.closeChatMobile = () => {
    // लिस्ट वापस दिखाओ
    document.getElementById('chat-list-panel').classList.remove('hidden');
    
    // चैट विंडो छुपाओ
    const chatWindow = document.getElementById('chat-window-panel');
    chatWindow.classList.add('hidden');
    chatWindow.classList.remove('flex');
    
    document.body.style.overflow = ''; 
    state.activeChatPhone = null;
    
    // डेस्कटॉप के लिए 'Empty State' वापस ले आओ
    document.getElementById('chat-empty-state').classList.remove('hidden');
    
    if (unsubMessages) unsubMessages(); 
    renderChatList(); 
};

function listenToChatMessages(customerPhone, currentChatData) {
    if (unsubMessages) unsubMessages();
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    
    // Scroll listener attach karna infinite scroll ke liye
    container.onscroll = () => {
        if (container.scrollTop === 0 && !isLoadingOldMessages && lastMessageDoc) {
            loadOlderMessages(customerPhone);
        }
    };

    const q = query(
        collection(db, "sellers", state.workspaceId, "chats", customerPhone, "messages"), 
        orderBy("timestamp", "desc"), 
        limit(50)
    );

    unsubMessages = onSnapshot(q, (snapshot) => {
        // UI reset karna
        container.innerHTML = `<div id="load-more-spinner" class="hidden w-full flex justify-center py-2"><i class="fas fa-circle-notch fa-spin text-blue-500"></i></div>`; 
        appendSecurityBubble(container);

        if (currentChatData && currentChatData.needsHuman) {
            container.innerHTML += `<div class="flex justify-center mb-4 w-full"><div class="bg-red-50 text-red-600 border border-red-200 text-[11px] font-bold py-1.5 px-3 rounded-lg shadow-sm text-center flex items-center gap-1.5"><i class="fa-solid fa-headset animate-pulse"></i> AI Transferred this chat to you. Please reply.</div></div>`;
        }

        if (snapshot.empty) {
             container.innerHTML += `<div class="text-center text-xs font-bold text-slate-400 mt-10">Say hi to start the conversation!</div>`;
             lastMessageDoc = null;
        } else {
            // Pagination track karne ke liye last document save karna (descending order mein last matlab sabse purana message)
            lastMessageDoc = snapshot.docs[snapshot.docs.length - 1];

            const messagesArray = [];
            snapshot.forEach(doc => messagesArray.push(doc.data()));
            messagesArray.reverse(); 

            messagesArray.forEach((msg) => {
                const contentText = msg.message || msg.text || '';
                if (!contentText) return; 
                
                let parsedTime = new Date();
                if (msg.timestamp) {
                    parsedTime = typeof msg.timestamp === 'number' ? new Date(msg.timestamp > 9999999999 ? msg.timestamp : msg.timestamp * 1000) : msg.timestamp.toDate();
                }
                const formattedTime = parsedTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

                appendBubble(contentText, msg.type === 'note' ? 'note' : (msg.sender === 'User' ? 'left' : 'right'), msg.type === 'note' ? 'note' : (msg.sender || '').toLowerCase(), formattedTime, false);
            });
        }
        // First load par ekdum niche scroll karna
        setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
    });
}

function appendBubble(text, side, type, timeStr) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    
    if (!text) return;

    const isImage = text.startsWith('http') && (text.includes('.jpg') || text.includes('.png') || text.includes('.jpeg') || text.includes('images') || text.includes('imgbb') || text.includes('w3schools') || text.includes('amazonaws'));
    let formattedContent = text.replace(/\*(.*?)\*/g, '<strong>$1</strong>');

    if (type === "note") {
        div.className = "flex justify-center my-2 w-full";
        // Tailwind CSS directly applied for Internal Note
        div.innerHTML = `
            <div class="bg-[#FFF3C4] border border-[#FDE047] rounded-lg shadow-sm px-3 py-1.5 max-w-[85%] text-center relative">
                <p class="text-[12px] font-medium text-[#854D0E]"><i class="fa-solid fa-eye-slash mr-1 opacity-70"></i> ${formattedContent}</p>
            </div>`;
    } 
    else if (side === "left") {
        div.className = "flex justify-start w-full";
        if (isImage) {
            // NAYA: onclick="window.openImageModal('${text}')" add kiya image zoom ke liye
            div.innerHTML = `
                <div class="bg-white p-1 rounded-tr-xl rounded-br-xl rounded-bl-xl shadow-sm relative group max-w-[75%] md:max-w-[50%] border border-slate-100">
                    <img src="${text}" onclick="window.openImageModal('${text}')" class="w-full max-h-[300px] object-cover rounded-xl cursor-pointer hover:opacity-90 transition">
                    <div class="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/40 backdrop-blur-sm rounded-full text-[10px] text-white font-medium">
                        ${timeStr}
                    </div>
                </div>`;
        } else {
            // Tailwind CSS directly applied for Customer Message
            div.innerHTML = `
                <div class="bg-white rounded-tr-xl rounded-br-xl rounded-bl-xl shadow-sm border border-slate-100 px-2.5 pt-2 pb-1.5 max-w-[85%] md:max-w-[70%] relative group">
                    <div class="text-[14.5px] text-slate-800 leading-[20px] whitespace-pre-wrap">${formattedContent}<span class="inline-block w-12 opacity-0">.</span></div>
                    <div class="absolute bottom-1 right-2 text-[10px] text-slate-400 font-medium">${timeStr}</div>
                </div>`;
        }
    } 
    else {
        div.className = "flex justify-end w-full";
        const aiIcon = type === "ai" ? '<i class="fa-solid fa-robot text-[9px] mr-1 text-emerald-800/80"></i>' : '<i class="fa-solid fa-user-tie text-[9px] mr-1 text-emerald-800/80"></i>';
        
        // NAYA: Read Receipt icon yahan se control hoga (Blue Ticks)
        const tickIcon = `<i class="fa-solid fa-check-double text-[#53bdeb]"></i>`;
        
        if (isImage) {
            // NAYA: onclick="window.openImageModal('${text}')" add kiya
            div.innerHTML = `
                <div class="bg-[#D9FDD3] p-1 rounded-tl-xl rounded-bl-xl rounded-br-xl shadow-sm relative group max-w-[75%] md:max-w-[50%] border border-[#c3f7bc]">
                    <img src="${text}" onclick="window.openImageModal('${text}')" class="w-full max-h-[300px] object-cover rounded-xl cursor-pointer hover:opacity-90 transition">
                    <div class="absolute bottom-2 right-2 px-2 py-0.5 bg-black/40 backdrop-blur-sm rounded-full text-[10px] text-white font-medium flex items-center gap-1 shadow-sm">
                        ${aiIcon}${timeStr} <span class="ml-0.5">${tickIcon}</span>
                    </div>
                </div>`;
        } else {
            // Tailwind CSS directly applied for Agent/AI Message
            div.innerHTML = `
                <div class="bg-[#D9FDD3] rounded-tl-xl rounded-bl-xl rounded-br-xl shadow-sm border border-[#c3f7bc] px-2.5 pt-2 pb-1.5 max-w-[85%] md:max-w-[70%] relative group">
                    <div class="text-[14.5px] text-[#111b21] leading-[20px] whitespace-pre-wrap">${formattedContent}<span class="inline-block w-16 opacity-0">.</span></div>
                    <div class="absolute bottom-1 right-2 flex items-center text-[10px] text-emerald-700 font-medium gap-1">
                        ${aiIcon}${timeStr} <span class="ml-0.5">${tickIcon}</span>
                    </div>
                </div>`;
        }
    }
    container.appendChild(div);
}

function appendSecurityBubble(container) {
     const div = document.createElement('div');
     div.className = "flex justify-center mb-4 w-full";
     div.innerHTML = `<div class="bg-[#FFEECD] text-[#54432A] text-[11px] font-medium py-1.5 px-3 rounded-lg shadow-sm text-center flex items-center gap-1.5"><i class="fa-solid fa-lock text-[10px]"></i> End-to-end encrypted</div>`;
     container.appendChild(div);
}

function appendLoadingBubble(id) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.id = id;
    div.className = "flex justify-end my-2 w-full";
    div.innerHTML = `
        <div class="bg-blue-50 border border-blue-100 rounded-2xl px-4 py-2 shadow-sm flex items-center gap-3">
            <i class="fas fa-circle-notch fa-spin text-blue-500"></i>
            <span class="text-xs text-blue-700 font-bold">Sending...</span>
        </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// ==========================================
// 3. INTERNAL NOTE, INPUT & EMOJI
// ==========================================
window.setNoteMode = (isNote) => {
    state.isNoteMode = isNote;
    const wrapper = document.getElementById('input-wrapper');
    const inputArea = document.getElementById('msg-input');
    
    document.getElementById('tab-mode-msg').className = isNote ? 
        "px-4 py-1.5 bg-transparent rounded-t-xl text-xs font-bold text-slate-500 hover:bg-[#FFF3C4]/50 transition-colors z-10 border border-transparent" : 
        "px-4 py-1.5 bg-white rounded-t-xl text-xs font-bold text-blue-600 shadow-sm z-20";
        
    document.getElementById('tab-mode-note').className = isNote ? 
        "px-4 py-1.5 bg-[#FFF3C4] rounded-t-xl text-xs font-bold text-[#854D0E] shadow-sm z-20 border border-yellow-200 border-b-0" : 
        "px-4 py-1.5 bg-transparent rounded-t-xl text-xs font-medium text-slate-500 hover:bg-[#FFF3C4]/50 transition-colors z-10 border border-transparent";

    if(isNote) {
        wrapper.classList.replace('bg-[#F0F2F5]', 'bg-[#FFF3C4]');
        inputArea.placeholder = "Type private internal note...";
    } else {
        wrapper.classList.replace('bg-[#FFF3C4]', 'bg-[#F0F2F5]');
        inputArea.placeholder = "Type a message...";
    }
    window.checkTypingStatus();
}

function initEmojiPicker() {
    const grid = document.getElementById('emoji-grid');
    
    // 🚀 NAYA: Null Check (Crash Protection)
    // Agar HTML abhi tak load nahi hua hai, toh function aage nahi badhega.
    if (!grid) return; 

    // Ek chhota sa fix: Pehle se agar emoji load hain toh double na hon
    grid.innerHTML = ''; 

    EMOJI_LIST.forEach(emp => {
        grid.innerHTML += `<button type="button" onclick="window.addEmoji('${emp}')" class="hover:bg-slate-100 p-2 rounded-xl transition-colors text-center cursor-pointer active:scale-95">${emp}</button>`;
    });
}

window.toggleEmojiPicker = () => {
    state.isEmojiOpen = !state.isEmojiOpen;
    const picker = document.getElementById('emoji-picker');
    const icon = document.querySelector('#emoji-btn i');
    if(state.isEmojiOpen) {
        picker.classList.remove('hidden');
        icon.className = "fa-solid fa-keyboard text-xl text-blue-500";
    } else {
        picker.classList.add('hidden');
        icon.className = "fa-regular fa-face-smile text-xl";
    }
}

window.addEmoji = (emoji) => {
    const input = document.getElementById('msg-input');
    input.value += emoji;
    window.checkTypingStatus();
}

window.checkTypingStatus = () => {
    const input = document.getElementById('msg-input').value.trim();
    const icon = document.getElementById('action-icon');
    const cameraBtn = document.getElementById('btn-camera');
    const btn = document.getElementById('btn-action');
    
    if(input.length > 0) {
        icon.className = "fa-solid fa-paper-plane text-xl translate-x-[-2px]";
        cameraBtn.classList.add('hidden');
        
        if(state.isNoteMode) {
            btn.className = "w-11 h-11 flex-shrink-0 bg-yellow-500 text-white rounded-full flex items-center justify-center shadow-md hover:bg-yellow-600 active:scale-95 transition-all";
        } else {
            btn.className = "w-11 h-11 flex-shrink-0 bg-[#00A884] text-white rounded-full flex items-center justify-center shadow-md hover:bg-[#008f6f] active:scale-95 transition-all";
        }
    } else {
        icon.className = "fa-solid fa-microphone text-xl";
        cameraBtn.classList.remove('hidden');
        btn.className = "w-11 h-11 flex-shrink-0 bg-[#00A884] text-white rounded-full flex items-center justify-center shadow-md hover:bg-[#008f6f] active:scale-95 transition-all";
    }
}

// ==========================================
// 4. MAIN ACTION: HUMAN REPLY WITH PREFIX & TIMER
// ==========================================
window.handleMainAction = async (e) => {
    if(e) e.preventDefault();
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    
    if(!text) {
        if(state.mediaRecorder && state.mediaRecorder.state === "recording") {
            window.stopAndPrepareSend(); 
        } else {
            startRecordingUI();
        }
        return; 
    }
    
    if (!state.activeChatPhone || !state.sellerConfig?.metaToken) return;

    input.value = '';
    input.style.height = 'auto';
    window.checkTypingStatus();
    if(state.isEmojiOpen) window.toggleEmojiPicker();

    const chatRef = doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone);
    const messagesSubRef = collection(db, "sellers", state.workspaceId, "chats", state.activeChatPhone, "messages");
    
    const agentName = state.user.displayName || "Agent";

    if(state.isNoteMode) {
        addDoc(messagesSubRef, { 
            sender: agentName, 
            agentUid: state.user.uid,
            message: text, 
            timestamp: Math.floor(Date.now() / 1000), // 🚀 FIX: Sync sequence with AI Number format
            type: "note" 
        });
        
        window.setNoteMode(false); 
        showToast("Note saved internally", "success");
        
    } else {
        const finalWhatsappPayload = text;

        try {
            await fetch(`https://graph.facebook.com/v18.0/${state.sellerConfig.metaPhoneId}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${state.sellerConfig.metaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ messaging_product: "whatsapp", to: state.activeChatPhone, text: { body: finalWhatsappPayload } })
            });

            await updateDoc(chatRef, {
                lastMessage: `You: ${text.substring(0, 20)}`,
                aiActive: false,            
                needsHuman: false,          
                aiPausedAt: serverTimestamp(), 
                assignedTo: agentName, 
                updatedAt: serverTimestamp() // Chat list ke liye serverTimestamp theek hai
            });

            addDoc(messagesSubRef, { 
                sender: agentName, 
                agentUid: state.user.uid, 
                message: text, 
                timestamp: Math.floor(Date.now() / 1000), // 🚀 FIX: Sync sequence with AI Number format
                type: "text" 
            });

        } catch (error) { 
            console.error("Agent Reply Error:", error);
            showToast("Delivery failed", "error"); 
        }
    }
};

window.sendTemplateMessage = async () => {
    const selector = document.getElementById('template-selector');
    if(!selector) return;
    
    const selectedOption = selector.options[selector.selectedIndex];
    const templateName = selectedOption.value;
    const templateLang = selectedOption.getAttribute('data-lang');
    
    if(!templateName) {
        showToast("Please select a template first", "error");
        return;
    }
    
    if (!state.activeChatPhone || !state.sellerConfig?.metaToken) return;

    const tempId = "uploading-" + Date.now();
    appendLoadingBubble(tempId);
    
    try {
        const agentName = state.user.displayName || "Agent";

        const payload = {
            messaging_product: "whatsapp",
            to: state.activeChatPhone,
            type: "template",
            template: {
                name: templateName,
                language: { code: templateLang || "en_US" }
            }
        };

        const response = await fetch(`https://graph.facebook.com/v19.0/${state.sellerConfig.metaPhoneId}/messages`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${state.sellerConfig.metaToken}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        if (result.error) throw new Error(result.error.message);

        const chatRef = doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone);
        await updateDoc(chatRef, {
            lastMessage: `Template: ${templateName}`,
            aiActive: false,
            needsHuman: false,
            updatedAt: serverTimestamp() // Agent ke template bhejte hi updatedAt update hoga
        });

        const messagesSubRef = collection(db, "sellers", state.workspaceId, "chats", state.activeChatPhone, "messages");
        await addDoc(messagesSubRef, { 
            sender: agentName, 
            agentUid: state.user.uid,
            message: `Template Sent: ${templateName}`, 
            timestamp: Math.floor(Date.now() / 1000),
            type: "template" 
        });

        document.getElementById(tempId)?.remove();
        showToast("Template sent successfully!", "success");
        
        // Template jane ke baad window update karne ke liye fake object se re-check
        const updatedChatMock = { ...state.chats.find(c => c.id === state.activeChatPhone), updatedAt: new Date() };
        window.check24HourRule(updatedChatMock);

    } catch (error) {
        document.getElementById(tempId)?.remove();
        showToast("Failed to send template: " + error.message, "error");
    }
}

// ==========================================
//  ATTACHMENTS (DOCS / IMAGES)
// ==========================================
window.handleAttachment = async (event) => {
    const file = event.target.files[0];
    if(!file) return;

    if (!state.activeChatPhone || !state.sellerConfig?.metaToken) return;

    const tempId = "uploading-" + Date.now();
    appendLoadingBubble(tempId);

    try {
        showToast("Uploading to Server...", "info");
        
        const presignedRes = await fetch(`https://engine.chatkunhq.workers.dev/get-presigned-url?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`);
        const { uploadUrl, publicUrl } = await presignedRes.json();

        const awsUpload = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }});
        if (!awsUpload.ok) throw new Error("AWS Upload Failed!");
        
        const fileUrl = publicUrl; 
        let messagePayload = { messaging_product: "whatsapp", to: state.activeChatPhone };
        const isImage = file.type.startsWith('image/');
        
        const agentName = state.user.displayName || "Agent";
        
        if (isImage) {
            messagePayload.type = "image";
            messagePayload.image = { link: fileUrl }; 
        } else {
            messagePayload.type = "document";
            messagePayload.document = { link: fileUrl, filename: file.name };
        }

        await fetch(`https://graph.facebook.com/v18.0/${state.sellerConfig.metaPhoneId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.sellerConfig.metaToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(messagePayload)
        });

        const chatRef = doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone);
        await updateDoc(chatRef, {
            lastMessage: `You sent a ${isImage ? 'photo' : 'document'}`,
            aiActive: false,
            updatedAt: serverTimestamp()
        });

        const messagesSubRef = collection(db, "sellers", state.workspaceId, "chats", state.activeChatPhone, "messages");
        
        await addDoc(messagesSubRef, { 
            sender: agentName, 
            agentUid: state.user.uid, 
            message: fileUrl, 
            fileName: file.name, 
            timestamp: Math.floor(Date.now() / 1000), // 🚀 FIX: Sync sequence with AI Number format
            type: isImage ? "image" : "document" 
        });

        document.getElementById(tempId)?.remove();
        showToast("File Sent Successfully!", "success");

    } catch (error) {
        document.getElementById(tempId)?.remove();
        showToast("Failed to send media", "error");
    } finally {
        event.target.value = ''; 
    }
};

// ==========================================
//  RECORDING LOGIC
// ==========================================
window.stopAndPrepareSend = async () => {
    clearInterval(state.recordingTimer);
    state.mediaRecorder = null;
    
    const timeStr = document.getElementById('record-timer').innerText;
    const textMsg = `🎤 Voice Note (${timeStr})`;
    
    document.getElementById('recording-ui').classList.remove('flex');
    document.getElementById('recording-ui').classList.add('hidden');
    document.getElementById('standard-ui').classList.remove('hidden');
    window.checkTypingStatus(); 

    try {
        const agentName = state.user.displayName || "Agent";
        const finalWhatsappPayload = textMsg;

        await fetch(`https://graph.facebook.com/v18.0/${state.sellerConfig.metaPhoneId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.sellerConfig.metaToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: "whatsapp", to: state.activeChatPhone, text: { body: finalWhatsappPayload } })
        });

        const chatRef = doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone);
        await updateDoc(chatRef, {
            lastMessage: `You: ${textMsg}`,
            aiActive: false, 
            updatedAt: serverTimestamp()
        });

        const messagesSubRef = collection(db, "sellers", state.workspaceId, "chats", state.activeChatPhone, "messages");
        
        addDoc(messagesSubRef, { 
            sender: agentName, 
            agentUid: state.user.uid,
            message: textMsg, 
            timestamp: Math.floor(Date.now() / 1000), // 🚀 FIX: Sync sequence with AI Number format
            type: "text" 
        });

    } catch (error) { showToast("Delivery failed", "error"); }
}

// ==========================================
// 7. VISUAL ACTIONS (Stars & Leads)
// ==========================================
function updateHeaderVisuals(chatData) {
    const starBtn = document.getElementById('btn-star-header');
    const hotBtn = document.getElementById('btn-hot-header');

    // 🗑️ FIX 2: Yahan se galat order button ki checking hata di gayi hai

    if(chatData.isStarred) {
        starBtn.innerHTML = `<i class="fa-solid fa-star text-yellow-500 text-lg"></i>`;
        starBtn.classList.add('bg-white');
    } else {
        starBtn.innerHTML = `<i class="fa-regular fa-star text-lg"></i>`;
        starBtn.classList.remove('bg-white');
    }

    if(chatData.leadStatus === 'hot') {
        hotBtn.innerHTML = `<i class="fa-solid fa-fire text-orange-500 text-lg animate-pulse"></i>`;
        hotBtn.classList.add('bg-white');
    } else {
        hotBtn.innerHTML = `<i class="fa-solid fa-fire text-lg"></i>`;
        hotBtn.classList.remove('bg-white');
    }
}

window.toggleStarred = async () => {
    if(!state.activeChatPhone) return;
    const currentChat = state.chats.find(c => c.id === state.activeChatPhone);
    const newValue = !currentChat.isStarred;
    try {
        //  workspaceId
        await updateDoc(doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone), { isStarred: newValue });
        showToast(newValue ? "Starred \u{2B50}" : "Unstarred", "success");
    } catch(e) {}
}

window.toggleHotLeadManual = async () => {
    if(!state.activeChatPhone) return;
    const currentChat = state.chats.find(c => c.id === state.activeChatPhone);
    const newValue = currentChat.leadStatus === 'hot' ? 'normal' : 'hot';
    try {
        //  workspaceId
        await updateDoc(doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone), { leadStatus: newValue });
        showToast(newValue === 'hot' ? "Hot Lead \u{1F525}" : "Removed Hot tag", "success");
    } catch(e) {}
}

function setupToggleListener() {
    document.getElementById('ai-toggle-btn').addEventListener('change', async (e) => {
        if (!state.activeChatPhone) return;

        // 🛡️ SECURITY: Double check karein ki kya role ke paas AI rules badalne ki permission hai
        const aiPerm = getSettingPermission(state.role, 'aiRules');
        if (aiPerm !== 'edit') {
            e.preventDefault();
            e.target.checked = !e.target.checked; // UI Toggle ko wapas waise hi kar do
            showToast("Access Denied: You cannot change AI settings.", "error");
            return;
        }

        try { 
            await updateDoc(doc(db, "sellers", state.workspaceId, "chats", state.activeChatPhone), { aiActive: e.target.checked }); 
            showToast(`AI is now ${e.target.checked ? 'ON' : 'OFF'} for this chat`, "success");
        } catch (error) { 
            showToast("Failed to update AI status", "error");
        }
    });
}
// ==========================================
// 2. NAYA FUNCTION: SOUND AUR NOTIFICATION KE LIYE (Fixed for Mobile/PWA)
// ==========================================
function playAgentAlert(customerName, lastMessage) {
    // 1. Sound Play Karein
    try {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.play().catch(e => console.log("Browser blocked auto-play sound"));
    } catch(e) {}

    // 2. Screen par Push Notification Bhejein
    if ("Notification" in window && Notification.permission === "granted") {
        const title = `🚨 Human Support Needed!`;
        const options = {
            body: `${customerName} needs your help.\nMessage: ${lastMessage}`,
            icon: "https://cdn-icons-png.flaticon.com/512/4712/4712010.png",
            tag: 'chat-alert', // Ek sath 10 message aaye toh sirf 1 notification dikhega
            requireInteraction: true
        };

        try {
            // 🚀 Try 1: Desktop Browsers ke liye
            const notification = new Notification(title, options);
            notification.onclick = function() {
                window.focus();
                this.close();
            };
        } catch (e) {
            // 🚀 Try 2: Mobile Browsers / Android Chrome ke liye (Service Worker Fallback)
            if (navigator.serviceWorker) {
                navigator.serviceWorker.ready.then(function(registration) {
                    registration.showNotification(title, options);
                }).catch(err => console.log("Service Worker Notification Failed:", err));
            } else {
                // Agar Service Worker nahi hai, toh browser native alert de dega (optional fallback)
                console.log("Notification Fallback:", title, options.body);
            }
        }
    }
}
async function setupPushNotifications() {
    if (!('serviceWorker' in navigator)) return;

    try {
        const messaging = getMessaging();
        
        // 1. Service Worker register hone ka wait karein
        const registration = await navigator.serviceWorker.ready;

        // 2. FCM Token generate karein
        // ⚠️ 'YOUR_PUBLIC_VAPID_KEY' ko Firebase Console -> Project Settings -> Cloud Messaging se badlein
        const currentToken = await getToken(messaging, { 
            vapidKey: 'BA74y3Oic1nbEZsbfLB5BueIUp1P9uLkG2dPH3AXnAb3pVF5oXOQcW4dsBR-YuoUWutoW55HgKO_t3DmhEatA24', 
            serviceWorkerRegistration: registration 
        });

        if (currentToken) {
            console.log("✅ FCM Token Generated:", currentToken);
            
            // 3. Token ko Database mein Agent ki file mein save karein
            const agentRef = doc(db, "sellers", state.workspaceId, "team", state.user.email.toLowerCase());
            await updateDoc(agentRef, { fcmToken: currentToken });
        } else {
            console.log('No registration token available. Request permission to generate one.');
        }
    } catch (err) {
        console.log('❌ FCM Setup Error:', err);
    }
}

// New function for Image Modal
window.openImageModal = (src) => {
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('modal-image-src');
    const downloadBtn = document.getElementById('modal-download-btn');
    
    modalImg.src = src;
    downloadBtn.href = src; // User can click to download
    
    modal.classList.remove('hidden');
};

window.closeImageModal = () => {
    const modal = document.getElementById('image-modal');
    modal.classList.add('hidden');
    document.getElementById('modal-image-src').src = '';
};
// New function for Quick Replies
window.sendQuickReply = (text) => {
    const inputArea = document.getElementById('msg-input');
    inputArea.value = text;
    window.checkTypingStatus();
    // Simulate Enter key/Send button click
    window.handleMainAction();
};
// 🚀 NAYA: Fetch older messages on scroll up
import { startAfter } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js"; // Top import list mein startAfter add karna zaroori hai

async function loadOlderMessages(customerPhone) {
    if (!lastMessageDoc || isLoadingOldMessages) return;

    isLoadingOldMessages = true;
    const container = document.getElementById('messages-container');
    const spinner = document.getElementById('load-more-spinner');
    
    if(spinner) spinner.classList.remove('hidden'); // Spinner dikhao

    // Previous scroll height note karo taaki naye message load hone par jump na ho
    const previousScrollHeight = container.scrollHeight;

    const q = query(
        collection(db, "sellers", state.workspaceId, "chats", customerPhone, "messages"),
        orderBy("timestamp", "desc"),
        startAfter(lastMessageDoc), // Jahan aakhri message tha, wahan se shuru karo
        limit(50)
    );

    const snapshot = await getDocs(q);
    
    if (snapshot.empty) {
        lastMessageDoc = null; // Aur messages nahi hain
        if(spinner) spinner.innerHTML = `<span class="text-[10px] font-bold text-slate-400">No older messages</span>`;
    } else {
        lastMessageDoc = snapshot.docs[snapshot.docs.length - 1]; // Update last doc
        
        // Reverse array for display
        const oldMessages = [];
        snapshot.forEach(doc => oldMessages.push(doc.data()));
        oldMessages.reverse();

        // Temporary div banakar usme purane messages format karenge
        let tempDiv = document.createElement('div');
        
        oldMessages.forEach(msg => {
            const contentText = msg.message || msg.text || '';
            if (!contentText) return; 
            
            let parsedTime = new Date();
            if (msg.timestamp) {
                parsedTime = typeof msg.timestamp === 'number' ? new Date(msg.timestamp > 9999999999 ? msg.timestamp : msg.timestamp * 1000) : msg.timestamp.toDate();
            }
            const formattedTime = parsedTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

            // Direct innerHTML me add karenge temporarily
            createBubbleHTML(tempDiv, contentText, msg.type === 'note' ? 'note' : (msg.sender === 'User' ? 'left' : 'right'), msg.type === 'note' ? 'note' : (msg.sender || '').toLowerCase(), formattedTime);
        });

        // Naye messages ko container ke shuru mein (spinner ke baad) insert karein
        spinner.insertAdjacentHTML('afterend', tempDiv.innerHTML);

        // UI Jump theek karne ke liye scroll adjust karein
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = newScrollHeight - previousScrollHeight;
        
        if(spinner) spinner.classList.add('hidden');
    }

    isLoadingOldMessages = false;
}
async function loadQuickRepliesFromDB() {
    try {
        const qRef = collection(db, "sellers", state.workspaceId, "quickReplies");
        // Snapshot use karenge taaki background me update hote rahe
        onSnapshot(qRef, (snapshot) => {
            quickRepliesArray = [];
            snapshot.forEach(doc => quickRepliesArray.push({ id: doc.id, ...doc.data() }));
        });
    } catch (e) { console.error("Error loading quick replies", e); }
}

function setupQuickReplyListener() {
    const input = document.getElementById('msg-input');
    if(!input) return;

    input.addEventListener('input', (e) => {
        const text = e.target.value;
        const popup = document.getElementById('quick-reply-popup');
        
        // Agar input '/' se shuru hota hai
        if (text.startsWith('/')) {
            const searchTerm = text.substring(1).toLowerCase(); // '/' ke baad ka text
            renderQuickReplyPopup(searchTerm);
            popup.classList.remove('hidden');
        } else {
            popup.classList.add('hidden');
            quickReplySelectedIndex = -1;
        }
    });

    // Keyboard Arrow Keys support for Quick Replies
    input.addEventListener('keydown', (e) => {
        const popup = document.getElementById('quick-reply-popup');
        if (popup.classList.contains('hidden')) return;

        const items = document.querySelectorAll('.qr-item');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            quickReplySelectedIndex = (quickReplySelectedIndex + 1) % items.length;
            updateQuickReplyHighlight(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            quickReplySelectedIndex = (quickReplySelectedIndex - 1 + items.length) % items.length;
            updateQuickReplyHighlight(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (quickReplySelectedIndex >= 0) {
                items[quickReplySelectedIndex].click();
            } else {
                items[0].click(); // Default select first
            }
        }
    });
}

function renderQuickReplyPopup(searchTerm) {
    const list = document.getElementById('quick-reply-list');
    let filtered = quickRepliesArray.filter(qr => 
        (qr.shortcut && qr.shortcut.toLowerCase().includes(searchTerm)) || 
        (qr.message && qr.message.toLowerCase().includes(searchTerm))
    );

    if (filtered.length === 0) {
        list.innerHTML = `<div class="p-3 text-center text-xs text-slate-400 font-medium">No replies found</div>`;
        return;
    }

    list.innerHTML = filtered.map((qr, index) => `
        <button type="button" onclick="window.selectQuickReply('${btoa(unescape(encodeURIComponent(qr.message)))}')" 
                class="qr-item w-full text-left p-2 hover:bg-blue-50 rounded-lg transition-colors flex flex-col gap-0.5 border border-transparent hover:border-blue-100 ${index === 0 ? 'bg-blue-50/50' : ''}">
            <span class="text-[11px] font-bold text-blue-600">/${qr.shortcut}</span>
            <span class="text-[13px] text-slate-700 truncate w-full">${qr.message}</span>
        </button>
    `).join('');
    
    quickReplySelectedIndex = -1; // reset index
}

function updateQuickReplyHighlight(items) {
    items.forEach((item, index) => {
        if (index === quickReplySelectedIndex) {
            item.classList.add('bg-blue-50', 'border-blue-100');
        } else {
            item.classList.remove('bg-blue-50', 'border-blue-100');
            item.classList.remove('bg-blue-50/50'); // remove default first item highlight
        }
    });
}

window.selectQuickReply = (base64Message) => {
    const message = decodeURIComponent(escape(atob(base64Message)));
    const input = document.getElementById('msg-input');
    
    input.value = message;
    document.getElementById('quick-reply-popup').classList.add('hidden');
    
    // Auto adjust height and status
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    window.checkTypingStatus();
    input.focus(); // Cursor wapas le aao
}
