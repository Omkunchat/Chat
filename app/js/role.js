// ==========================================
// ROLE BASED ACCESS CONTROL (RBAC) - CHATKUN
// ==========================================

export const ROLES = {
    OWNER: 'owner',
    MANAGER: 'manager',
    MARKETING: 'marketing',
    SUPPORT: 'support',
    CHAT: 'chat'
};

export const PERMISSIONS = {
    
    [ROLES.OWNER]: {
        navDashboard: true,
        navLeads: true,
        navCatalog: true,
        navOffers: true,
        navBroadcast: true,
        navAnalytics: true,
        navSupportTickets: true,
        navBooking: true,       // 🚀 Booking Desk Access
        navSettings: true,
        navTeam: true,          
        navBotSetup: true,      // 🚀 AI Studio Access

        settings: {
            shopDetails: 'edit',    
            billing: 'edit',
            teamManagement: 'edit',
            metaApi: 'edit',
            aiRules: 'edit'     // 🚀 AI Studio Edit Access
        }
    },

    [ROLES.MANAGER]: {
        navDashboard: true,
        navLeads: true,
        navCatalog: true,
        navOffers: true,
        navBroadcast: true,
        navAnalytics: true,
        navSupportTickets: true,
        navBooking: true,       // 🚀 Booking Desk Access
        navSettings: true,
        navTeam: true,          
        navBotSetup: true,      // 🚀 AI Studio Access

        settings: {
            shopDetails: 'edit',
            billing: 'hide',       
            teamManagement: 'edit',
            metaApi: 'hide',       
            aiRules: 'edit'     // 🚀 AI Studio Edit Access
        }
    },

    [ROLES.MARKETING]: {
        navDashboard: true,
        navLeads: true,
        navCatalog: true,       
        navOffers: true,        
        navBroadcast: true,     
        navAnalytics: true,     
        navSupportTickets: false, 
        navBooking: false,      // 🚫 No Access
        navSettings: false,
        navTeam: false,         
        navBotSetup: false,     // 🚫 No Access

        settings: {
            shopDetails: 'hide',
            billing: 'hide',
            teamManagement: 'hide',
            metaApi: 'hide',
            aiRules: 'hide'     // 🚫 Hidden from Marketing
        }
    },

    [ROLES.SUPPORT]: {
        navDashboard: false,
        navLeads: true,
        navCatalog: false,
        navOffers: true,        
        navBroadcast: false,
        navAnalytics: false,
        navSupportTickets: true,
        navBooking: true,       // 🚀 Support needs booking to manage Walk-ins
        navSettings: true,      
        navTeam: false,         
        navBotSetup: false,     // 🚫 No Access

        settings: {
            shopDetails: 'hide',
            billing: 'hide',
            teamManagement: 'hide',
            metaApi: 'hide',
            aiRules: 'hide'     // 🚫 Hidden from Support
        }
    },

    [ROLES.CHAT]: {
        navDashboard: false,
        navLeads: true,
        navCatalog: false,
        navOffers: false,
        navBroadcast: false,
        navAnalytics: false,
        navSupportTickets: false,
        navBooking: false,      // 🚫 No Access
        navSettings: true,      
        navTeam: false,         
        navBotSetup: false,     // 🚫 No Access

        settings: {
            shopDetails: 'hide',
            billing: 'hide',
            teamManagement: 'hide',
            metaApi: 'hide',
            aiRules: 'hide'     // 🚫 Hidden from Chat Agents
        }
    }
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

export function hasNavPermission(role, feature) {
    const normalizedRole = role ? role.toLowerCase() : 'chat';
    const rolePerms = PERMISSIONS[normalizedRole];
    return rolePerms ? !!rolePerms[feature] : false;
}

export function getSettingPermission(role, settingName) {
    const normalizedRole = role ? role.toLowerCase() : 'chat';
    const rolePerms = PERMISSIONS[normalizedRole];
    return rolePerms && rolePerms.settings ? (rolePerms.settings[settingName] || 'hide') : 'hide';
}

export function canEditFeature(role, featureName) {
    const normalizedRole = role ? role.toLowerCase() : 'chat';
    
    // 🚀 MASTER CONTROL MATRIX
    const featurePermissions = {
        'catalog':   ['owner', 'manager'],              
        'broadcast': ['owner', 'manager', 'marketing'], 
        'offers':    ['owner', 'manager', 'marketing'], 
        'orders':    ['owner', 'manager', 'support'],   
        'leads':     ['owner', 'manager', 'marketing'], 
        'analytics': ['owner', 'manager'],              
        'settings':  ['owner', 'manager'],
        'team':      ['owner', 'manager'],
        'booking':   ['owner', 'manager', 'support'],   // 🚀 Booking Desk Access
        'bot-setup': ['owner', 'manager']               // 🚀 NAYA: Sirf Owner aur Manager bot setup access kar sakte hain
    };

    const allowedRoles = featurePermissions[featureName] || ['owner']; 
    
    return allowedRoles.includes(normalizedRole);
}