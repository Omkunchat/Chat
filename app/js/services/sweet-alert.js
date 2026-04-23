
// FUNCTION START: createToastContainer
function createToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        // Tailwind classes for container position (top-end equivalent)
        container.className = 'fixed top-5 right-5 z-[9999] space-y-2';
        document.body.appendChild(container);
    }
    return container;
}
// FUNCTION END: createToastContainer
/**
 * 1. Shows a temporary, non-blocking toast notification.
 * @param {string} msg - Message to display.
 * @param {'success'|'error'|'warning'} type - Icon type.
 */
// FUNCTION START: showToast
export function showToast(msg, type = 'success') {
    const container = createToastContainer();
    const toast = document.createElement('div');
    
    let bgClass, iconClass;
    if (type === 'error' || type === 'warning') {
        bgClass = 'bg-red-600';
        iconClass = 'fas fa-exclamation-circle';
    } else {
        bgClass = 'bg-slate-800';
        iconClass = 'fas fa-check-circle';
    }

    // Toast styling
    toast.className = `flex items-center px-4 py-3 text-white rounded-lg shadow-xl ${bgClass} transform transition-all duration-300 translate-x-full opacity-0 min-w-[200px] max-w-xs`;
    toast.innerHTML = `<i class="${iconClass} mr-2"></i> <span class="text-sm font-medium">${msg}</span>`;
    
    container.appendChild(toast);
    
    // Animate In
    requestAnimationFrame(() => {
        toast.classList.remove('translate-x-full', 'opacity-0');
        toast.classList.add('translate-x-0', 'opacity-100');
    });

    // Animate Out and remove
    setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-x-0');
        toast.classList.add('opacity-0', 'translate-x-full');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
// FUNCTION END: showToast
// SECTION END: GLOBAL TOAST CONFIGURATION

// SECTION START: CUSTOM TAILWIND CONFIRM MODAL
let resolvePromise;

/**
 * 2. Shows a standardized Tailwind confirmation modal.
 * @param {string} title - The title of the modal (e.g., 'Delete Template?').
 * @param {string} text - Description/warning text.
 * @param {string} confirmButtonText - Text for the confirm button (e.g., 'Yes, Delete').
 * @returns {Promise<boolean>} - Resolves to true if confirmed, false otherwise.
 */
// FUNCTION START: showConfirm
export function showConfirm(title, text, confirmButtonText = 'Yes, Proceed!') {
    // Return a Promise that resolves when the user interacts
    return new Promise(resolve => {
        resolvePromise = resolve; // Store the resolve function globally

        const modalHtml = `
            <div id="custom-confirm-overlay" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[80] transition-opacity duration-300"></div>
            <div id="custom-confirm-modal" class="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full max-w-xs sm:max-w-sm bg-white rounded-xl shadow-2xl p-4 sm:p-6 z-[81] opacity-0 scale-90 transition-all duration-300">
                
                <div class="flex flex-col items-center">
                    <i class="fas fa-exclamation-triangle text-3xl text-red-500 mb-3"></i>
                    <h3 class="text-lg font-bold text-slate-800 mb-2 text-center">${title}</h3>
                    <p class="text-sm text-slate-600 text-center mb-6">${text}</p>
                </div>

                <div class="flex justify-end gap-3">
                    <button id="cancel-btn" class="bg-slate-200 hover:bg-slate-300 text-slate-700 font-medium py-2 px-4 rounded-lg transition-all active:scale-95 text-sm">Cancel</button>
                    <button id="confirm-btn" class="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg shadow-md transition-all active:scale-95 text-sm">${confirmButtonText}</button>
                </div>
            </div>
        `;

        // Append modal HTML to body
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const overlay = document.getElementById('custom-confirm-overlay');
        const modal = document.getElementById('custom-confirm-modal');
        const confirmBtn = document.getElementById('confirm-btn');
        const cancelBtn = document.getElementById('cancel-btn');

        // Animate in
        setTimeout(() => {
            overlay.classList.add('opacity-100');
            modal.classList.remove('opacity-0', 'scale-90');
            modal.classList.add('opacity-100', 'scale-100');
        }, 10);
        
        // Cleanup function
        const cleanup = () => {
            modal.classList.remove('opacity-100', 'scale-100');
            modal.classList.add('opacity-0', 'scale-90');
            overlay.classList.remove('opacity-100');
            setTimeout(() => {
                overlay.remove();
                modal.remove();
            }, 300);
        };

        // Event Listeners
        confirmBtn.onclick = () => {
            resolve(true);
            cleanup();
        };

        cancelBtn.onclick = () => {
            resolve(false);
            cleanup();
        };
        
        overlay.onclick = () => {
             resolve(false);
             cleanup();
        };

        // Focus the confirm button for accessibility (optional: focus cancel instead)
        confirmBtn.focus();
    });
}
// FUNCTION END: showConfirm
// SECTION END: CUSTOM TAILWIND CONFIRM MODAL