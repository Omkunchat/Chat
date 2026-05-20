    // 1. Single Fetch Setup: Yahan hum ab ek nayi file "components.html" ko fetch karenge
    fetch('/components/components.html')
        .then(r => r.text())
        .then(htmlString => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlString, 'text/html');
            
            document.getElementById('header-placeholder').innerHTML = doc.getElementById('global-header-source').innerHTML;
            document.getElementById('footer-placeholder').innerHTML = doc.getElementById('global-footer-source').innerHTML;
            document.getElementById('whatsapp-placeholder').innerHTML = doc.getElementById('global-whatsapp-source').innerHTML;
            
            setupAppMenu();
        })
        .catch(err => console.error("Components load karne me dikkat aayi:", err));

    // 2. Event Listeners
    function setupAppMenu() {
        const appBtn = document.getElementById('appMenuBtn');
        const appMenu = document.getElementById('appDropdownMenu');
        if (appBtn && appMenu) {
            appBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                appMenu.classList.toggle('hidden');
            });
            document.addEventListener('click', (e) => {
                if (!appMenu.classList.contains('hidden') && !appMenu.contains(e.target) && !appBtn.contains(e.target)) {
                    appMenu.classList.add('hidden');
                }
            });
        }
    }

    function toggleMenu() {
        const menu = document.getElementById('mobile-menu');
        const overlay = document.getElementById('menu-overlay');
        
        if (overlay && overlay.classList.contains('hidden')) {
            if(menu) menu.style.transform = "translateX(0%)";
            if(overlay) {
                overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
                overlay.classList.add('opacity-100');
            }
            document.body.style.overflow = 'hidden';
        } else {
            if(menu) menu.style.transform = "translateX(-100%)";
            if(overlay) {
                overlay.classList.remove('opacity-100');
                overlay.classList.add('hidden', 'opacity-0', 'pointer-events-none');
            }
            document.body.style.overflow = 'auto';
        }
    }

    // 3. Calculator
    let isIndia = true;
    
    function calculateBill() {
        if (!document.getElementById('calc-ai')) return;
        const sessionCount = parseInt(document.getElementById('calc-ai').value) || 0; 
        const teamCount = parseInt(document.getElementById('calc-team').value) || 0;
        const crmCount = parseInt(document.getElementById('calc-crm').value) || 0;
        const prodCount = parseInt(document.getElementById('calc-prod').value) || 0;
        const offerCount = parseInt(document.getElementById('calc-offer').value) || 0;
        const tplCount = parseInt(document.getElementById('calc-tpl').value) || 0;

        const rates = isIndia ? 
            { ai: 0.30, team: 500, crm: 0.5, prod: 1, offer: 2, tplFlat: 200, tplRate: 2, sym: '₹' } :
            { ai: 0.01, team: 10, crm: 0.01, prod: 0.05, offer: 0.10, tplFlat: 5, tplRate: 0.05, sym: '$' };

        const aiCost = sessionCount * rates.ai;
        const teamCost = Math.max(0, teamCount - 2) * rates.team; 
        const crmCost = Math.max(0, crmCount - 100) * rates.crm; 
        const prodCost = Math.max(0, prodCount - 50) * rates.prod; 
        const offerCost = Math.max(0, offerCount - 5) * rates.offer; 
        
        let tplCost = 0;
        if (tplCount > 5) {
            tplCost = (tplCount - 5) * rates.tplRate;
            if (tplCount >= 100) tplCost += rates.tplFlat;
        }

        const total = aiCost + teamCost + crmCost + prodCost + offerCost + tplCost;

        document.getElementById('out-ai').innerText = `${rates.sym}${aiCost.toFixed(2)}`;
        document.getElementById('out-team').innerText = `${rates.sym}${teamCost.toFixed(2)}`;
        document.getElementById('out-crm').innerText = `${rates.sym}${crmCost.toFixed(2)}`;
        document.getElementById('out-prod').innerText = `${rates.sym}${prodCost.toFixed(2)}`;
        document.getElementById('out-offer').innerText = `${rates.sym}${offerCost.toFixed(2)}`;
        document.getElementById('out-tpl').innerText = `${rates.sym}${tplCost.toFixed(2)}`;
        document.getElementById('out-total').innerText = `${rates.sym}${total.toFixed(2)}`;
    }
    window.toggleMenu = function() {
    const menu = document.getElementById('mobile-menu');
    const overlay = document.getElementById('menu-overlay');
    
    if (overlay && overlay.classList.contains('hidden')) {
        if(menu) menu.style.transform = "translateX(0%)";
        if(overlay) {
            overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
            overlay.classList.add('opacity-100');
        }
        document.body.style.overflow = 'hidden';
    } else {
        if(menu) menu.style.transform = "translateX(-100%)";
        if(overlay) {
            overlay.classList.remove('opacity-100');
            overlay.classList.add('hidden', 'opacity-0', 'pointer-events-none');
        }
        document.body.style.overflow = 'auto';
    }
};

    async function syncPricing() {
        try {
            const response = await fetch('https://ipapi.co/json/');
            const data = await response.json();
            if (data.country_code !== 'IN') {
                isIndia = false; 
                document.querySelectorAll('.price-spark, .price-blaze').forEach(el => el.innerText = '$12');
                document.querySelectorAll('.rate-ai').forEach(el => el.innerText = '$0.01');
                document.querySelectorAll('.rate-team').forEach(el => el.innerText = '$10');
                document.querySelectorAll('.rate-crm').forEach(el => el.innerText = '$0.01');
                document.querySelectorAll('.rate-prod').forEach(el => el.innerText = '$0.05');
                document.querySelectorAll('.rate-offer').forEach(el => el.innerText = '$0.10');
                document.querySelectorAll('.rate-ai-label').forEach(el => el.innerText = '$0.01/session');
                document.querySelectorAll('.price-comp-base').forEach(el => el.innerText = '$35');
                document.querySelectorAll('.price-comp-extra').forEach(el => el.innerText = '$75');
                document.querySelectorAll('.price-legacy-total').forEach(el => el.innerText = '$110+ /mo');
                document.querySelectorAll('.comp-omkun-team').forEach(el => el.innerText = '$80');
                document.querySelectorAll('.comp-omkun-total').forEach(el => el.innerText = '$80 /mo');
                document.querySelectorAll('.price-savings').forEach(el => el.innerText = '$30');
                document.querySelectorAll('a[href*="login.html"]').forEach(btn => {
                    btn.href = "https://chat.omkun.com/app?currency=USD";
                });
            } else {
                document.querySelectorAll('.rate-ai-label').forEach(el => el.innerText = '₹0.30/session');
                document.querySelectorAll('a[href*="login.html"]').forEach(btn => {
                    btn.href = "https://chat.omkun.com/app?currency=INR";
                });
            }
            calculateBill();
        } catch (error) {
            calculateBill();
        }
    }
    window.onload = syncPricing;