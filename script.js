// ================= CONFIGURATION =================
// PASTE URL GAS BARU KAMU DISINI
const API_URL = "https://script.google.com/macros/s/AKfycbz5JfXSYPLdZ4brYep0xNcy6OR8OJqNuMhYKcaCWbTij-LbxWIIkj0a-bNoVMhVkBnPmQ/exec";
const WIB_OFFSET_MS = 5 * 60 * 60 * 1000; // Server Time + 5 Hours

// ================= STATE MANAGEMENT =================
let globalData = { trades: [], transactions: [] };
let processedTimeline = []; 
let chartInstance = null;
let currentFilter = 'all'; // Default All Time

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    fetchData();
    setupInputs();
});

// ================= CORE LOGIC =================
function processData(trades, transactions) {
    // 1. Convert to unified timeline events
    const tradeEvents = trades.map(t => {
        const closeTime = new Date(t.closeTime);
        const wibTime = new Date(closeTime.getTime() + WIB_OFFSET_MS);
        
        // Commision Calc: $10 per 1.0 lot
        const commission = t.lots * 10;
        const netProfitReal = parseFloat(t.netProfit); // This assumes Backend already stores Net
        // Note: For display logic from Input, we will handle "Gross -> Net" in the form submit handler
        
        // Pips Logic
        let pips = 0;
        if (t.type === 'Buy') pips = (t.exitPrice - t.entryPrice) * 10;
        else if (t.type === 'Sell') pips = (t.entryPrice - t.exitPrice) * 10;

        // Session Logic with Colors & Overlap
        const h = wibTime.getHours();
        let session = "Pacific";
        let sessionClass = "sess-pacific";
        
        // Logic Overlap
        if (h >= 19 && h <= 23) { session = "London + NY"; sessionClass = "sess-overlap"; }
        else if (h >= 14 && h < 19) { session = "London"; sessionClass = "sess-london"; }
        else if (h >= 7 && h < 14) { session = "Asia"; sessionClass = "sess-asia"; }
        else if (h >= 0 && h < 4) { session = "New York"; sessionClass = "sess-ny"; } 

        return {
            category: 'TRADE',
            id: t.id,
            date: closeTime, // Sort key
            wibDate: wibTime,
            data: t,
            val: netProfitReal,
            pips: pips.toFixed(1),
            session: session,
            sessionClass: sessionClass
        };
    });

    const transEvents = transactions.map(t => {
        const dateObj = new Date(t.date);
        const wibTime = new Date(dateObj.getTime() + WIB_OFFSET_MS);
        const val = parseFloat(t.amount);
        return {
            category: 'TRANSACTION',
            id: t.id,
            date: dateObj,
            wibDate: wibTime,
            data: t,
            val: t.type === 'Deposit' ? val : -val,
            allocation: t.allocation // MAIN or TEMP
        };
    });

    // 2. Sort Chronologically
    const timeline = [...tradeEvents, ...transEvents].sort((a, b) => a.date - b.date);

    // 3. Calculation Loop (Proportional Logic)
    let mainBal = 0;
    let tempBal = 0;
    
    // Helper to calculate growth per trade
    let previousTotalBal = 0;

    timeline.forEach(item => {
        const currentTotal = mainBal + tempBal;
        item.startBal = currentTotal; // Saldo sebelum event ini terjadi
        
        if (item.category === 'TRANSACTION') {
            if (item.data.allocation === 'MAIN') mainBal += item.val;
            else tempBal += item.val;
        } else {
            // TRADE Logic: Distribute Profit/Loss based on Pocket Share
            // Jika saldo total 0, masukkan ke Main default
            let mainShare = 0;
            let tempShare = 0;

            if (currentTotal > 0) {
                mainShare = mainBal / currentTotal;
                tempShare = tempBal / currentTotal;
            } else {
                // Fallback jika saldo 0 atau minus, anggap 100% Main
                mainShare = 1; 
            }

            // Distribute
            mainBal += item.val * mainShare;
            tempBal += item.val * tempShare;
        }

        item.runningMain = mainBal;
        item.runningTemp = tempBal;
        item.runningTotal = mainBal + tempBal;
        
        // Growth % for this specific item (vs previous balance)
        item.growth = item.startBal > 0 ? ((item.runningTotal - item.startBal) / item.startBal) * 100 : 0;
    });

    processedTimeline = timeline;
    
    // Update UI
    setupMonthFilter();
    applyGlobalFilter();
}

// ================= FILTERING LOGIC =================
function applyGlobalFilter() {
    const filterVal = document.getElementById('globalFilter').value;
    currentFilter = filterVal;

    let filteredData = [];
    let startMain = 0;
    let startTemp = 0;

    if (filterVal === 'all') {
        filteredData = processedTimeline;
    } else {
        // Filter by Month (YYYY-MM)
        // Cari index data pertama di bulan ini
        const firstIndex = processedTimeline.findIndex(d => d.wibDate.toISOString().slice(0, 7) === filterVal);
        
        if (firstIndex >= 0) {
            filteredData = processedTimeline.slice(firstIndex);
            // Saldo awal adalah saldo AKHIR dari item SEBELUM index pertama bulan ini
            if (firstIndex > 0) {
                startMain = processedTimeline[firstIndex - 1].runningMain;
                startTemp = processedTimeline[firstIndex - 1].runningTemp;
            }
        } else {
            // Tidak ada data di bulan ini, tapi mungkin ada saldo dari bulan lalu
            // Cari data terakhir sebelum bulan ini
            const prevData = processedTimeline.filter(d => d.wibDate.toISOString().slice(0, 7) < filterVal);
            if (prevData.length > 0) {
                const last = prevData[prevData.length - 1];
                startMain = last.runningMain;
                startTemp = last.runningTemp;
            }
        }
    }

    // Update All Views
    updateDashboard(filteredData, startMain, startTemp);
    updateReport(filteredData);
    renderHistory(filteredData);
}

// ================= UI UPDATES: DASHBOARD =================
function updateDashboard(data, startMain, startTemp) {
    let lastItem = data.length > 0 ? data[data.length - 1] : { runningMain: startMain, runningTemp: startTemp, runningTotal: startMain + startTemp };
    
    // Balance Cards
    document.getElementById('totalEquity').innerText = formatCurrency(lastItem.runningTotal);
    document.getElementById('mainBalance').innerText = formatCurrency(lastItem.runningMain);
    document.getElementById('tempBalance').innerText = formatCurrency(lastItem.runningTemp);

    // Shares %
    const total = lastItem.runningTotal || 1; // avoid div by 0
    document.getElementById('mainShare').innerText = ((lastItem.runningMain / total) * 100).toFixed(1) + "% share";
    document.getElementById('tempShare').innerText = ((lastItem.runningTemp / total) * 100).toFixed(1) + "% share";

    // Growth Badge (Current Period vs Start of Period)
    const startTotal = startMain + startTemp;
    const growth = startTotal > 0 ? ((lastItem.runningTotal - startTotal) / startTotal) * 100 : 0;
    const badge = document.getElementById('growthBadge');
    badge.innerText = (growth >= 0 ? "+" : "") + growth.toFixed(2) + "%";
    badge.className = `text-[10px] px-2 py-0.5 rounded font-mono ${growth >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`;

    // Quick Stats (Dashboard)
    const tradesOnly = data.filter(d => d.category === 'TRADE');
    const wins = tradesOnly.filter(d => d.val > 0).length;
    const winRate = tradesOnly.length > 0 ? (wins / tradesOnly.length) * 100 : 0;
    const netProfit = tradesOnly.reduce((sum, t) => sum + t.val, 0);

    // Drawdown Calculation (Simple Peak-to-Valley for period)
    let peak = startTotal;
    let maxDD = 0;
    // Kita harus iterasi data + saldo awal
    let running = startTotal;
    data.forEach(d => {
        if (d.category === 'TRANSACTION') {
            if(d.data.allocation === 'MAIN') running += d.val; // Simplified for total
            else running += d.val;
        } else {
            running += d.val;
        }
        if (running > peak) peak = running;
        const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
        if (dd > maxDD) maxDD = dd;
    });

    document.getElementById('dashNetProfit').innerText = formatCurrency(netProfit);
    document.getElementById('dashNetProfit').className = `text-sm font-bold mt-1 ${netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    document.getElementById('dashWinRate').innerText = winRate.toFixed(1) + "%";
    document.getElementById('dashDrawdown').innerText = maxDD.toFixed(1) + "%";

    // Chart
    renderChart(data, startMain, startTemp);
}

// ================= UI UPDATES: CHART =================
function renderChart(data, startMain, startTemp) {
    const ctx = document.getElementById('equityChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    // Prepare Datapoints
    // Point 0: Start of Period
    let labels = ["Start"];
    let dataMain = [startMain];
    let dataTemp = [startTemp];

    data.forEach(d => {
        labels.push(d.wibDate.getDate()); // Just day number to save space
        dataMain.push(d.runningMain);
        dataTemp.push(d.runningTemp);
    });

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Main',
                    data: dataMain,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.5)',
                    fill: 'origin',
                    tension: 0.1,
                    pointRadius: 1
                },
                {
                    label: 'Temp',
                    data: dataTemp,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.5)',
                    fill: '-1', // Fill to previous dataset (Stacked Area effect)
                    tension: 0.1,
                    pointRadius: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: false },
                y: { grid: { color: '#334155' }, ticks: { color: '#94a3b8', font: {size: 9} }, stacked: true }
            },
            interaction: { mode: 'index', intersect: false }
        }
    });
}

// ================= UI UPDATES: REPORT (MQL5 Style) =================
function updateReport(data) {
    const trades = data.filter(d => d.category === 'TRADE');
    const trans = data.filter(d => d.category === 'TRANSACTION');

    // Basic Stats
    const totalTrades = trades.length;
    const wins = trades.filter(d => d.val > 0);
    const losses = trades.filter(d => d.val < 0);
    
    const grossProfit = wins.reduce((sum, t) => sum + t.val, 0);
    const grossLoss = losses.reduce((sum, t) => sum + t.val, 0); // Negative value
    
    const profitFactor = Math.abs(grossLoss) > 0 ? (grossProfit / Math.abs(grossLoss)).toFixed(2) : "∞";
    const expPayoff = totalTrades > 0 ? ((grossProfit + grossLoss) / totalTrades).toFixed(2) : "0.00";

    // Consecutives
    let maxConsWin = 0, currConsWin = 0;
    let maxConsLoss = 0, currConsLoss = 0;
    trades.forEach(t => {
        if (t.val > 0) {
            currConsWin++;
            currConsLoss = 0;
            if (currConsWin > maxConsWin) maxConsWin = currConsWin;
        } else {
            currConsLoss++;
            currConsWin = 0;
            if (currConsLoss > maxConsLoss) maxConsLoss = currConsLoss;
        }
    });

    // Averages
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    // Deposits
    const deps = trans.filter(t => t.data.type === 'Deposit');
    const withs = trans.filter(t => t.data.type === 'Withdraw');
    const totalDep = deps.reduce((sum, t) => sum + t.val, 0);
    const totalWith = withs.reduce((sum, t) => sum + Math.abs(t.val), 0);
    
    const depMain = deps.filter(t => t.data.allocation === 'MAIN').reduce((sum, t) => sum + t.val, 0);
    const depTemp = deps.filter(t => t.data.allocation === 'TEMP').reduce((sum, t) => sum + t.val, 0);

    // DOM Updates
    setText('rptTotalDeposit', formatCurrency(totalDep));
    setText('rptTotalWithdraw', formatCurrency(totalWith));
    setText('rptProfitFactor', profitFactor);
    setText('rptExpectedPayoff', expPayoff);
    setText('rptTotalTrades', totalTrades);
    setText('rptGrossProfit', formatCurrency(grossProfit));
    setText('rptGrossLoss', formatCurrency(grossLoss));
    setText('rptMaxConsecWins', maxConsWin);
    setText('rptMaxConsecLosses', maxConsLoss);
    setText('rptAvgWin', formatCurrency(avgWin));
    setText('rptAvgLoss', formatCurrency(avgLoss));

    // Bars
    setText('rptMainDep', formatCurrency(depMain));
    setText('rptTempDep', formatCurrency(depTemp));
    
    const totalDepSafe = totalDep || 1;
    document.getElementById('barMainDep').style.width = (depMain / totalDepSafe * 100) + "%";
    document.getElementById('barTempDep').style.width = (depTemp / totalDepSafe * 100) + "%";
}

// ================= UI UPDATES: HISTORY =================
function renderHistory(data) {
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    
    // Reverse for display (Newest top)
    const reversed = [...data].reverse();

    if(reversed.length === 0) {
        list.innerHTML = '<div class="text-center text-slate-500 py-10 text-xs">No records found.</div>';
        return;
    }

    reversed.forEach(item => {
        const el = document.createElement('div');
        
        if (item.category === 'TRADE') {
            const isWin = item.val >= 0;
            const growthSign = item.growth >= 0 ? "+" : "";
            
            // Session Color from Item logic
            el.className = `relative overflow-hidden rounded-r-xl border-l-4 shadow-sm flex justify-between items-center p-3 mb-2 ${item.sessionClass}`;
            
            el.innerHTML = `
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold text-white text-sm">${item.data.type.toUpperCase()}</span>
                        <span class="text-[10px] text-slate-400 bg-slate-800 px-1.5 rounded">${item.data.lots} Lot</span>
                        <span class="text-[9px] px-1.5 rounded bg-slate-800 text-slate-300 border border-slate-700">${item.session}</span>
                    </div>
                    <div class="text-[10px] text-slate-400 font-mono flex gap-2">
                        <span>Close: ${item.wibDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        <span class="text-slate-600">|</span>
                        <span>${item.wibDate.toLocaleDateString()}</span>
                    </div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-base ${isWin ? 'text-emerald-400' : 'text-rose-400'}">
                        ${isWin ? '+' : ''}$${item.val.toFixed(2)}
                    </div>
                    <div class="flex flex-col items-end">
                        <span class="text-[9px] text-slate-500">${item.pips} pips</span>
                        <span class="text-[9px] font-mono ${item.growth >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${growthSign}${item.growth.toFixed(2)}%</span>
                    </div>
                </div>
            `;
        } else {
            el.className = `relative overflow-hidden rounded-xl bg-slate-900 border border-slate-800 p-3 mb-2 flex justify-between items-center`;
            el.innerHTML = `
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold ${item.val > 0 ? 'text-blue-400' : 'text-amber-500'} text-xs">${item.data.type.toUpperCase()}</span>
                        <span class="text-[9px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 font-bold">${item.allocation}</span>
                    </div>
                    <div class="text-[10px] text-slate-500">${item.wibDate.toLocaleDateString()}</div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-sm text-white">$${Math.abs(item.val).toFixed(2)}</div>
                </div>
            `;
        }
        list.appendChild(el);
    });
}

// ================= HELPERS & SETUP =================
function setupMonthFilter() {
    const select = document.getElementById('globalFilter');
    const existingVal = select.value;
    
    // Get Unique Months from all data
    const months = [...new Set(processedTimeline.map(d => d.wibDate.toISOString().slice(0, 7)))].sort().reverse();
    
    select.innerHTML = '<option value="all">ALL TIME</option>';
    months.forEach(m => {
        const d = new Date(m + '-01');
        const label = d.toLocaleString('default', { month: 'short', year: 'numeric' }).toUpperCase();
        select.innerHTML += `<option value="${m}">${label}</option>`;
    });

    select.value = existingVal; // Restore selection if refreshed
    select.onchange = applyGlobalFilter;
}

function initClock() {
    setInterval(() => {
        const now = new Date(); 
        // Display as WIB (Assume user device is correct or offset needed. Simple approach: Show system time labeled as WIB)
        const h = now.getHours();
        const m = now.getMinutes().toString().padStart(2, '0');
        const s = now.getSeconds().toString().padStart(2, '0');
        document.getElementById('clock').innerText = `${h}:${m}:${s} WIB`;
        
        // Session Ticker Update
        renderSessionTicker(h);
    }, 1000);
}

function renderSessionTicker(h) {
    // Pacific 4-13, Asia 7-16, London 14-23, NY 19-4
    const sessions = [
        { name: "PACIFIC", start: 4, end: 13, color: "text-slate-400" },
        { name: "ASIA", start: 7, end: 16, color: "text-yellow-400" },
        { name: "LONDON", start: 14, end: 23, color: "text-green-400" },
        { name: "NEW YORK", start: 19, end: 28, color: "text-blue-400" } // 28 = 04 next day logic handled below
    ];

    let html = "";
    sessions.forEach(s => {
        let isActive = false;
        // Handle NY crossing midnight
        if (s.name === "NEW YORK") {
            if (h >= 19 || h < 4) isActive = true;
        } else {
            if (h >= s.start && h < s.end) isActive = true;
        }

        html += `
            <div class="px-2 py-1 rounded border ${isActive ? 'bg-slate-800 border-slate-600' : 'border-transparent opacity-30'} flex items-center gap-1">
                <div class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-current animate-pulse' : 'bg-slate-600'} ${s.color}"></div>
                <span class="text-[9px] font-bold ${s.color}">${s.name}</span>
            </div>
        `;
    });
    document.getElementById('sessionTicker').innerHTML = html;
}

// Calculator for Input Form
function setupInputs() {
    const lotsInput = document.getElementById('inputLots');
    const grossInput = document.getElementById('inputGross');
    const calcDisplay = document.getElementById('calcCommission');

    function updateCalc() {
        const lots = parseFloat(lotsInput.value) || 0;
        const gross = parseFloat(grossInput.value) || 0;
        const comm = lots * 10;
        const net = gross - comm;
        
        calcDisplay.innerHTML = `Comm: <b>$${comm.toFixed(2)}</b> | Net: <b class="${net >=0 ? 'text-emerald-400':'text-rose-400'}">$${net.toFixed(2)}</b>`;
    }

    lotsInput.addEventListener('input', updateCalc);
    grossInput.addEventListener('input', updateCalc);

    // Override Submit for Trades to Calculate Net
    document.getElementById('form-trade').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = Object.fromEntries(fd.entries());
        
        // Manual Calc Net Profit
        const lots = parseFloat(data.lots);
        const gross = parseFloat(data.netProfit); // Input name is still netProfit in HTML to match older structure, but treated as Gross visually
        const comm = lots * 10;
        data.netProfit = (gross - comm).toFixed(2); // Send NET to Backend

        submitData('addTrade', data);
    });

    document.getElementById('form-transaction').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = Object.fromEntries(fd.entries());
        submitData('addTransaction', data);
    });
}

// ================= API CALLS =================
async function fetchData() {
    try {
        const res = await fetch(`${API_URL}?action=getData`);
        const json = await res.json();
        if (json.status === 'success') {
            globalData = json.data;
            processData(globalData.trades, globalData.transactions);
        }
    } catch (e) {
        console.error(e);
        alert("Connection Error");
    }
}

async function submitData(action, payload) {
    try {
        payload.id = 'ID-' + Date.now();
        payload.action = action;
        
        const btn = document.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerText = "Processing...";

        await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        location.reload();
    } catch (e) {
        alert("Error: " + e);
        location.reload();
    }
}

// ================= UTILS =================
function switchView(view) {
    document.querySelectorAll('section').forEach(el => el.classList.add('hidden'));
    document.getElementById(`view-${view}`).classList.remove('hidden');
    
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active', 'text-sky-400'));
    const activeBtn = document.querySelector(`.nav-btn[onclick="switchView('${view}')"]`);
    if(activeBtn) {
        activeBtn.classList.add('active', 'text-sky-400');
        activeBtn.classList.remove('text-slate-500');
    }
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

function setText(id, val) {
    const el = document.getElementById(id);
    if(el) el.innerText = val;
}

function formatCurrency(num) {
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}