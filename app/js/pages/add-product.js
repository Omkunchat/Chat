import { db, auth } from "../firebase.js"; 
import { collection, addDoc, doc, updateDoc, getDoc, serverTimestamp, getDocs, query, where, collectionGroup } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js"; 
import { showToast } from "../services/sweet-alert.js"; 
import { hasNavPermission } from "../role.js"; 

let state = {      
    user: null,     
    workspaceId: null,      
    role: "owner",     
    canEdit: false     
};

const MEDIA_API = "https://media-engine.chatkunhq.workers.dev";

export async function init() {     
    state.user = auth.currentUser;     
    if (!state.user) return;     
    
    const userEmail = state.user.email.toLowerCase();     
    
    // 🟢 BULLETPROOF WORKSPACE FINDER     
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

    // 🔒 SECURITY: Check Edit Permissions     
    const canAccessCatalog = hasNavPermission(state.role, 'navCatalog'); 
    state.canEdit = (canAccessCatalog && (state.role === 'owner' || state.role === 'manager'));     
    
    if (!state.canEdit) {         
        showToast("You don't have permission to add or edit items", "error");         
        window.location.hash = '#catalog';         
        return;     
    }     

    // Check URL parameters for Edit Mode (e.g. ?id=xyz123)     
    const hashString = window.location.hash;     
    let editId = null;     
    if (hashString.includes('?id=')) {         
        editId = hashString.split('?id=')[1];     
    }     
    
    if (editId) {         
        const titleEl = document.getElementById('page-title');         
        if (titleEl) titleEl.innerText = "Edit Item";         
        await loadProductData(editId);     
    } 
}

export function destroy() {} 

// ========================================== 
// 1. DATA LOADER (For Edit Mode) 
// ========================================== 
async function loadProductData(id) {     
    try {         
        const docRef = doc(db, "products", id);         
        const snap = await getDoc(docRef);                  
        
        if (snap.exists()) {             
            const product = snap.data();                          
            
            // 🔒 SECURITY: Check if product belongs to this workspace             
            if (product.sellerId !== state.workspaceId) {                 
                showToast("Product not found or access denied", "error");                 
                window.location.hash = '#catalog';                 
                return;             
            }             
            
            if(document.getElementById('editProductId')) document.getElementById('editProductId').value = snap.id;                          
            
            const typeRadio = document.querySelector(`input[name="itemType"][value="${product.type || 'product'}"]`);             
            if(typeRadio) typeRadio.checked = true;             
            
            if(document.getElementById('productName')) document.getElementById('productName').value = product.name || '';                          
            if(document.getElementById('productPrice')) document.getElementById('productPrice').value = product.price || '';                          
            if(document.getElementById('productComparePrice')) document.getElementById('productComparePrice').value = product.comparePrice || '';                          
            if(document.getElementById('productCategory')) document.getElementById('productCategory').value = product.category || '';                          
            if(document.getElementById('productSku')) document.getElementById('productSku').value = product.sku || '';                          
            if(document.getElementById('productVariants')) document.getElementById('productVariants').value = product.variants || '';                          
            if(document.getElementById('productDesc')) document.getElementById('productDesc').value = product.description || '';                          
            
            if(document.getElementById('productStock')) document.getElementById('productStock').checked = product.inStock !== false;             
            
            if(product.imageUrl) {                 
                const imgEl = document.getElementById('imagePreview');                 
                if(imgEl) {                     
                    imgEl.src = product.imageUrl;                     
                    imgEl.classList.remove('hidden');                 
                }                 
                const imgInput = document.getElementById('productImage');                 
                if(imgInput) imgInput.value = product.imageUrl;             
            }         
        } else {             
            showToast("Item not found", "error");             
            window.location.hash = '#catalog';         
        }     
    } catch (e) {         
        showToast("Error loading item data", "error");         
        console.error(e);     
    } 
}

// ========================================== 
// 2. REAL AWS S3 UPLOAD ENGINE (WITH COMPRESSION)
// ========================================== 
window.handleAWSUpload = async (e) => {     
    const originalFile = e.target.files[0];     
    if(!originalFile) return;     
    const imgEl = document.getElementById('imagePreview');     
    const uploadText = document.getElementById('upload-text');          
    
    // UI Feedback     
    if(imgEl) {         
        imgEl.src = URL.createObjectURL(originalFile);         
        imgEl.classList.remove('hidden');         
        imgEl.style.opacity = '0.5';     
    }     
    if(uploadText) uploadText.innerText = "Compressing...";     
    showToast("Compressing image size...", "info");     
    
    try {         
        // 🟢 NAYA: Image ko compress karein (Max 800px, 70% Quality)
        const compressedBlob = await compressImage(originalFile, 800, 800, 0.7);
        
        // Kyunki hum image ko 'image/jpeg' mein compress kar rahe hain, 
        // toh extension aur type wahi set karenge.
        const fileName = originalFile.name.replace(/\.[^/.]+$/, "") + ".jpg"; 
        const fileType = 'image/jpeg';

        if(uploadText) uploadText.innerText = "Uploading..."; 
        showToast("Uploading to secure storage...", "info");

        // Presigned URL mangwayein
        const fetchUrl = `${MEDIA_API}/get-presigned-url?filename=${encodeURIComponent(fileName)}&type=${encodeURIComponent(fileType)}&bucket=product`;                 
        const presignedRes = await fetch(fetchUrl);                 
        
        if (!presignedRes.ok) throw new Error(`Worker API Error`);         
        
        const { uploadUrl, publicUrl } = await presignedRes.json();         
        
        // 🟢 NAYA: Original file ki jagah 'compressedBlob' ko upload karein
        const awsUpload = await fetch(uploadUrl, {             
            method: 'PUT',             
            body: compressedBlob,             
            headers: { 'Content-Type': fileType }         
        });         
        
        if (!awsUpload.ok) throw new Error(`AWS S3 Rejected`);         
        
        const imgInput = document.getElementById('productImage');         
        if(imgInput) imgInput.value = publicUrl;                   
        
        showToast("Image Compressed & Uploaded! ✅", "success");         
        if(uploadText) uploadText.innerText = "Change Media";            
    } catch(err) {         
        console.error("🚨 [PRODUCT UPLOAD ERROR]", err);         
        showToast("Upload Failed (Check Console)", "error");         
        if(imgEl) imgEl.classList.add('hidden');         
        if(uploadText) uploadText.innerText = "Upload Media";     
    } finally {         
        if(imgEl) imgEl.style.opacity = '1';     
    } 
};

// ========================================== 
// 3. UNIVERSAL SAVE / UPDATE ENGINE 
// ========================================== 
window.handleSaveProduct = async (e) => {     
    if(e) e.preventDefault();          
    
    if (!state.canEdit) {         
        showToast("Permission denied", "error");         
        return;     
    }          
    
    const btn = document.getElementById('btn-save-product');     
    const ogHtml = btn ? btn.innerHTML : '';     
    if(btn) {         
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin text-sm"></i> Syncing to AI...`;         
        btn.disabled = true;     
    }     
    
    const idEl = document.getElementById('editProductId');     
    const productId = idEl ? idEl.value : null;          
    
    // 🌍 NAYA: Universal Data Format (E-Commerce, Grocery, Services, Doctors)
    const productData = {         
        sellerId: state.workspaceId, 
        type: document.querySelector('input[name="itemType"]:checked')?.value || 'product', // 'product' or 'service'
        sku: document.getElementById('productSku')?.value.trim() || `SKU-${Date.now().toString().slice(-6)}`,
        name: document.getElementById('productName')?.value.trim() || '',         
        price: Number(document.getElementById('productPrice')?.value) || 0,         
        comparePrice: Number(document.getElementById('productComparePrice')?.value) || 0, // Extra field for discounts
        category: document.getElementById('productCategory')?.value.trim() || '',         
        variants: document.getElementById('productVariants')?.value.trim() || '', // e.g. "S, M, L" or "500g, 1kg" or "30 mins"
        description: document.getElementById('productDesc')?.value.trim() || '',         
        imageUrl: document.getElementById('productImage')?.value || '',         
        inStock: document.getElementById('productStock')?.checked ?? true,         
        updatedAt: serverTimestamp()     
    };     
    
    try {         
        if (productId) {             
            // Update mode             
            await updateDoc(doc(db, "products", productId), productData);             
            showToast("Item Updated & AI Synced! ✅", "success");         
        } else {             
            // Create mode             
            productData.createdAt = serverTimestamp();             
            await addDoc(collection(db, "products"), productData);             
            showToast("New Item Added. AI Trained! 🤖", "success");         
        }                  
        
        // Redirect back to catalog list         
        setTimeout(() => { window.location.hash = "#catalog"; }, 800);              
    } catch(err) {          
        console.error("Firebase Save Error:", err);         
        showToast("Error saving to database", "error");      
    } finally {          
        if(btn) {             
            btn.innerHTML = ogHtml;              
            btn.disabled = false;          
        }     
    } 
}
// ========================================== 
// 4. IMAGE COMPRESSION ENGINE
// ========================================== 
async function compressImage(file, maxWidth = 800, maxHeight = 800, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Aspect ratio maintain karte hue size chhota karein
                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // JPEG format mein convert karke Blob return karein
                canvas.toBlob((blob) => {
                    resolve(blob);
                }, 'image/jpeg', quality); 
            };
            img.onerror = (error) => reject(error);
        };
        reader.onerror = (error) => reject(error);
    });
}