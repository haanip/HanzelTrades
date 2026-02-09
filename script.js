// ================= CONFIGURATION =================
const API_URL = "https://script.google.com/macros/s/AKfycbz5JfXSYPLdZ4brYep0xNcy6OR8OJqNuMhYKcaCWbTij-LbxWIIkj0a-bNoVMhVkBnPmQ/exec";
const WIB_OFFSET_MS = 5 * 60 * 60 * 1000; // Server Time + 5 Hours

// ================= STATE MANAGEMENT =================
let globalData = { trades: [], transactions: [] };
let processedHistory = []; 
let chartInstance = null;

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    fetchData();
});

// ================= CORE LOGIC: DATA PROCESSING =================
function processData(trades, transactions) {
    // 1. Normalize Trades
    const tradeEvents = trades.map(t => {
        const openTime = new Date(t.openTime);
        const closeTime = new Date(t.closeTime);
        const wibOpen = new Date(openTime.getTime() + WIB_OFFSET_MS);

        // Pips Calculation
        let pips = 0;
        if (t.type === 'Buy') pips = (t.exitPrice - t.entryPrice) * 10;
        else if (t.type === 'Sell') pips = (t.entryPrice - t.exitPrice) * 10;

        // Duration
        const diffMs = closeTime - openTime;
        const h = Math.floor(diffMs / 3600000);
        const m = Math.floor((diffMs % 3600000) / 60000);

        // Session
        const hour = wibOpen.getHours();
        let session = "Pacific";
        if (hour >= 19 || hour < 4) session = "New York";
        else if (hour >= 14) session = "London";
        else if (hour >= 7) session = "Asia";

        return {
            category: 'TRADE',
            id: t.id,
            rawDate: closeTime, // Sort by close time
            wibDate: new Date(closeTime.getTime() + WIB_OFFSET_MS),
            data: t,
            netProfit: Number(t.netProfit),
            pips: pips.toFixed(1),
            duration: `${h}h ${m}m`,
            session: session
        };
    });

    // 2. Normalize Transactions
    const transEvents = transactions.map(t => {
        const dateObj = new Date(t.date);
        return {
            category: 'TRANSACTION',
            id: t.id,
            rawDate: dateObj,
            wibDate: new Date(dateObj.getTime() + WIB_OFFSET_MS),
            data: t,
            amount: Number(t.amount),
            allocation: t.allocation
        };
    });

    // 3. Merge & Sort (Oldest First for Calculation)
    const timeline = [...tradeEvents, ...transEvents].sort((a, b) => a.rawDate - b.rawDate);

    // 4. Calculate Running Balance
    let mainBal = 0;
    let tempBal = 0;

    timeline.forEach(item => {
        if (item.category === 'TRANSACTION') {
            const val = item.data.type === 'Deposit' ? item.amount : -item.amount;
            if (item.allocation === 'MAIN') mainBal += val;
            else tempBal += val;
        } else {
            // Trades profit goes to MAIN (Default assumption)
            mainBal += item.netProfit;
        }
        item.runningMain = mainBal;
        item.runningTemp = tempBal;
        item.runningTotal = mainBal + tempBal;
    });

    processedHistory = timeline;
    
    // Update UI
    updateDashboard('all');
    setupMonthFilter();
    renderHistory('all');
}

// ================= UI FUNCTIONS =================
function updateDashboard(monthFilter) {
    if (processedHistory.length === 0) return;

    // Filter Logic
    const filteredData = filterData(processedHistory, monthFilter);
    const lastItem = processedHistory[processedHistory.length - 1]; // Balance is always global cumulative

    // Update Balance Cards (Always Global)
    document.getElementById('totalEquity').innerText = formatCurrency(lastItem.runningTotal);
    document.getElementById('mainBalance').innerText = formatCurrency(lastItem.runningMain);
    document.getElementById('tempBalance').innerText = formatCurrency(lastItem.runningTemp);

    // Update Session Counters (Based on Filter)
    const counts = { Pacific: 0, Asia: 0, London: 0, 'New York': 0 };
    filteredData.forEach(d => {
        if (d.category === 'TRADE' && counts[d.session] !== undefined) {
            counts[d.session]++;
        }
    });
    
    document.getElementById('count-pacific').innerText = counts.Pacific;
    document.getElementById('count-asia').innerText = counts.Asia;
    document.getElementById('count-london').innerText = counts.London;
    document.getElementById('count-ny').innerText = counts['New York'];

    // Render Chart
    renderChart(processedHistory); // Chart usually shows full history trend
}

function renderHistory(monthFilter) {
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    
    // Reverse for display (Newest top)
    const displayData = filterData(processedHistory, monthFilter).reverse();

    if(displayData.length === 0) {
        list.innerHTML = '<div class="text-center text-slate-500 py-4 text-xs">No records found for this period.</div>';
        return;
    }

    displayData.forEach(item => {
        const el = document.createElement('div');
        el.className = `relative overflow-hidden bg-slate-800 rounded-xl p-4 border-l-4 shadow-sm flex justify-between items-center ${
            item.category === 'TRADE' 
                ? (item.netProfit >= 0 ? 'border-emerald-500' : 'border-rose-500') 
                : 'border-amber-400 bg-amber-900/5'
        }`;

        const dateStr = item.wibDate.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute:'2-digit' });

        if (item.category === 'TRADE') {
            const isWin = item.netProfit >= 0;
            el.innerHTML = `
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold text-white text-sm">${item.data.type.toUpperCase()}</span>
                        <span class="text-[10px] text-slate-400">${item.data.lots} Lots</span>
                        <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-medium">${item.session}</span>
                    </div>
                    <div class="text-[10px] text-slate-500 font-mono">Server: ${new Date(item.data.closeTime).toLocaleString().split(',')[1]} | WIB: ${item.wibDate.toLocaleTimeString()}</div>
                    <div class="text-[10px] text-slate-400 mt-1">⏳ ${item.duration}</div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-base ${isWin ? 'text-emerald-400' : 'text-rose-400'}">
                        ${isWin ? '+' : ''}$${item.netProfit}
                    </div>
                    <div class="text-[10px] text-slate-500">${item.pips} pips</div>
                </div>
            `;
        } else {
            // Transaction
            el.innerHTML = `
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold text-amber-400 text-sm">${item.data.type.toUpperCase()}</span>
                        <span class="text-[9px] px-1.5 py-0.5 rounded border border-amber-600 text-amber-500 font-bold">${item.allocation}</span>
                    </div>
                    <div class="text-[10px] text-slate-500">${dateStr}</div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-base text-white">$${item.amount}</div>
                </div>
            `;
        }
        list.appendChild(el);
    });
}

function renderChart(data) {
    const ctx = document.getElementById('equityChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    // Simplify chart points if data is huge
    const labels = data.map(d => d.wibDate.toLocaleDateString());
    const mainData = data.map(d => d.runningMain);
    const tempData = data.map(d => d.runningTemp);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Main',
                    data: mainData,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.3)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                },
                {
                    label: 'Temp',
                    data: tempData,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.3)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { display: false },
                y: { 
                    stacked: true, 
                    grid: { color: '#1e293b' },
                    ticks: { color: '#64748b' }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

// ================= API & HELPERS =================
async function fetchData() {
    try {
        const res = await fetch(API_URL);
        const json = await res.json();
        
        if (json.status === 'success') {
            globalData.trades = json.data.trades;
            globalData.transactions = json.data.transactions;
            processData(globalData.trades, globalData.transactions);
        }
    } catch (e) {
        console.error("Fetch Error", e);
        document.getElementById('totalEquity').innerText = "Error";
    }
}

async function submitData(action, payload) {
    try {
        // Generate ID
        payload.id = 'ID-' + Date.now();
        payload.action = action;

        const btn = action === 'addTrade' ? document.getElementById('btn-save-trade') : document.getElementById('btn-save-trans');
        const originalText = btn.innerText;
        btn.innerText = "Saving...";
        btn.disabled = true;

        await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        alert("Data Saved!");
        location.reload(); // Simple reload to refresh data
    } catch (e) {
        alert("Error saving data: " + e);
        location.reload();
    }
}

// ================= UTILITIES =================
function filterData(data, monthStr) {
    if (monthStr === 'all') return data;
    return data.filter(d => d.wibDate.toISOString().slice(0, 7) === monthStr);
}

function setupMonthFilter() {
    const select = document.getElementById('monthFilter');
    const months = [...new Set(processedHistory.map(d => d.wibDate.toISOString().slice(0, 7)))].sort().reverse();
    
    select.innerHTML = '<option value="all">All Time</option>';
    months.forEach(m => {
        const d = new Date(m + '-01');
        const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
        select.innerHTML += `<option value="${m}">${label}</option>`;
    });

    select.onchange = (e) => {
        updateDashboard(e.target.value);
        renderHistory(e.target.value);
    };
}

function initClock() {
    setInterval(() => {
        const now = new Date(); // Local Browser Time (Assume User is in WIB or convert if needed)
        // Strictly force WIB display based on offset if user is not in WIB
        // For simplicity, using local time but label as WIB based on requirement
        const h = now.getHours();
        const m = now.getMinutes().toString().padStart(2, '0');
        const s = now.getSeconds().toString().padStart(2, '0');
        
        document.getElementById('clock').innerText = `${h}:${m}:${s} WIB`;
        
        let greet = h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening";
        document.getElementById('greeting').innerText = greet + ", Trader";

        // Badge Update
        let sess = [];
        if (h >= 4 && h < 13) sess.push("Pacific");
        if (h >= 7 && h < 16) sess.push("Asia");
        if (h >= 14 && h < 23) sess.push("London");
        if (h >= 19 || h < 4) sess.push("NY");
        
        const badge = document.getElementById('sessionBadge');
        if (sess.length > 0) {
            badge.className = "px-3 py-1.5 rounded-full text-xs font-bold bg-emerald-900/30 border border-emerald-500/50 text-emerald-400";
            badge.innerText = "🟢 " + sess.join(" + ");
        } else {
            badge.className = "px-3 py-1.5 rounded-full text-xs font-bold bg-slate-800 border border-slate-700 text-slate-500";
            badge.innerText = "⚪ Market Closed";
        }
    }, 1000);
}

function switchView(view) {
    ['dashboard', 'history', 'input'].forEach(v => document.getElementById('view-'+v).classList.add('hidden'));
    document.getElementById('view-'+view).classList.remove('hidden');
    
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('nav-active', 'text-sky-500');
        b.classList.add('text-slate-500');
    });
    
    // Highlight logic
    const map = { 'dashboard': 0, 'input': 1, 'history': 2 };
    const btns = document.querySelectorAll('.nav-btn');
    btns[map[view]].classList.add('nav-active', 'text-sky-500');
    btns[map[view]].classList.remove('text-slate-500');
}

function switchForm(type) {
    document.getElementById('form-trade').classList.add('hidden');
    document.getElementById('form-transaction').classList.add('hidden');
    document.getElementById('form-'+type).classList.remove('hidden');
    
    document.getElementById('tab-trade').className = type === 'trade' 
        ? "flex-1 py-2 text-sm font-bold rounded-lg bg-sky-600 text-white shadow-lg transition-all"
        : "flex-1 py-2 text-sm font-bold rounded-lg text-slate-400 transition-all";
        
    document.getElementById('tab-transaction').className = type === 'transaction'
        ? "flex-1 py-2 text-sm font-bold rounded-lg bg-amber-600 text-white shadow-lg transition-all"
        : "flex-1 py-2 text-sm font-bold rounded-lg text-slate-400 transition-all";
}

function formatCurrency(num) {
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Event Listeners for Forms
document.getElementById('form-trade').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());
    submitData('addTrade', data);
});

document.getElementById('form-transaction').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());
    submitData('addTransaction', data);
});