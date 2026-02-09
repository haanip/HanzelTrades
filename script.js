// ================= CONFIGURATION =================
const API_URL = "https://script.google.com/macros/s/AKfycbz5JfXSYPLdZ4brYep0xNcy6OR8OJqNuMhYKcaCWbTij-LbxWIIkj0a-bNoVMhVkBnPmQ/exec"; // Ganti URL kamu
const WIB_OFFSET_MS = 5 * 60 * 60 * 1000;

// ================= STATE MANAGEMENT =================
let globalData = { trades: [], transactions: [] };
let processedTimeline = []; 
let chartInstance = null;
let currentFilter = 'all';

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    fetchData();
    setupInputs();
});

// ================= CORE LOGIC =================
function processData(trades, transactions) {
    // 1. Convert to Unified Events
    const tradeEvents = trades.map(t => {
        const closeTime = new Date(t.closeTime);
        const wibTime = new Date(closeTime.getTime() + WIB_OFFSET_MS);
        
        let pips = 0;
        if (t.type === 'Buy') pips = (t.exitPrice - t.entryPrice) * 10;
        else if (t.type === 'Sell') pips = (t.entryPrice - t.exitPrice) * 10;

        // Session Logic
        const h = wibTime.getHours();
        let session = "Pacific";
        let sessionClass = "border-slate-500 bg-slate-900/50"; // Default
        
        if (h >= 19 || h < 4) { session = "New York"; sessionClass = "border-blue-500 bg-blue-900/10"; }
        else if (h >= 14) { session = "London"; sessionClass = "border-emerald-500 bg-emerald-900/10"; }
        else if (h >= 7) { session = "Asia"; sessionClass = "border-yellow-500 bg-yellow-900/10"; }

        return {
            category: 'TRADE',
            id: t.id,
            date: closeTime,
            wibDate: wibTime,
            data: t,
            val: parseFloat(t.netProfit),
            pips: parseFloat(pips.toFixed(1)),
            session: session,
            sessionClass: sessionClass,
            isWin: parseFloat(t.netProfit) >= 0
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
            allocation: t.allocation
        };
    });

    // 2. Sort Chronologically
    const timeline = [...tradeEvents, ...transEvents].sort((a, b) => a.date - b.date);

    // 3. Calculation Loop (Proportional Logic & Cumulative Stats)
    let mainBal = 0, tempBal = 0;
    let mainNet = 0, tempNet = 0;
    let totalDep = 0; 

    timeline.forEach(item => {
        const currentTotal = mainBal + tempBal;
        item.startBal = currentTotal;
        
        if (item.category === 'TRANSACTION') {
            if (item.data.type === 'Deposit') totalDep += item.val;
            
            if (item.data.allocation === 'MAIN') mainBal += item.val;
            else tempBal += item.val;
        } else {
            // TRADE: Distribute based on share
            let mainShare = currentTotal > 0 ? mainBal / currentTotal : 1;
            let tempShare = currentTotal > 0 ? tempBal / currentTotal : 0;
            if (currentTotal <= 0) { mainShare = 1; tempShare = 0; } // Fallback

            const profitMain = item.val * mainShare;
            const profitTemp = item.val * tempShare;

            mainBal += profitMain;
            tempBal += profitTemp;
            
            mainNet += profitMain;
            tempNet += profitTemp;
        }

        item.runningMain = mainBal;
        item.runningTemp = tempBal;
        item.runningTotal = mainBal + tempBal;
        item.cumulativeMainNet = mainNet;
        item.cumulativeTempNet = tempNet;
        item.cumulativeTotalDep = totalDep;
    });

    processedTimeline = timeline;
    setupMonthFilter();
    applyGlobalFilter();
}

function applyGlobalFilter() {
    const filterVal = document.getElementById('globalFilter').value;
    currentFilter = filterVal;

    let filteredData = [];
    let startMain = 0, startTemp = 0, startDep = 0, startMainNet = 0, startTempNet = 0;

    if (filterVal === 'all') {
        filteredData = processedTimeline;
    } else {
        const firstIndex = processedTimeline.findIndex(d => d.wibDate.toISOString().slice(0, 7) === filterVal);
        if (firstIndex >= 0) {
            filteredData = processedTimeline.slice(firstIndex);
            if (firstIndex > 0) {
                const prev = processedTimeline[firstIndex - 1];
                startMain = prev.runningMain;
                startTemp = prev.runningTemp;
                startDep = prev.cumulativeTotalDep;
                startMainNet = prev.cumulativeMainNet;
                startTempNet = prev.cumulativeTempNet;
            }
        }
    }

    updateDashboard(filteredData, startMain, startTemp, startDep, startMainNet, startTempNet);
    updateReport(filteredData);
    renderHistory(filteredData);
}

// ================= DASHBOARD =================
function updateDashboard(data, startMain, startTemp, startDep, startMainNet, startTempNet) {
    if (data.length === 0) return;
    const last = data[data.length - 1];

    // Balance
    setText('totalEquity', formatCurrency(last.runningTotal));
    setText('mainBalance', formatCurrency(last.runningMain));
    setText('tempBalance', formatCurrency(last.runningTemp));
    
    // Net Profit Split (Current Period)
    const currentMainNet = last.cumulativeMainNet - startMainNet;
    const currentTempNet = last.cumulativeTempNet - startTempNet;
    setText('mainNetProfit', (currentMainNet>=0?'+':'')+formatCurrency(currentMainNet));
    setText('tempNetProfit', (currentTempNet>=0?'+':'')+formatCurrency(currentTempNet));

    // Growth Fix: (Current Equity - Total Deposit) / Total Deposit * 100
    // For specific period: (EndEquity - StartEquity) / StartEquity * 100
    let growth = 0;
    const startTotal = startMain + startTemp;
    
    if (currentFilter === 'all') {
        const totalDep = last.cumulativeTotalDep;
        if (totalDep > 0) growth = ((last.runningTotal - totalDep) / totalDep) * 100;
    } else {
         if (startTotal > 0) growth = ((last.runningTotal - startTotal) / startTotal) * 100;
    }

    const badge = document.getElementById('growthBadge');
    badge.innerText = (growth >= 0 ? "+" : "") + growth.toFixed(2) + "%";
    badge.className = `text-[10px] px-2 py-0.5 rounded font-mono ${growth >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`;

    renderChart(data, startMain, startTemp);
}

function renderChart(data, startMain, startTemp) {
    const ctx = document.getElementById('equityChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    let labels = ["Start"];
    let dataMain = [startMain];
    let dataTemp = [startTemp];
    let pointColors = ['transparent'];
    let pointRadii = [0];

    data.forEach(d => {
        // Date Label logic
        const dateStr = d.wibDate.toLocaleDateString('id-ID', {day: 'numeric', month: 'short', year: '2-digit'});
        labels.push(dateStr);
        dataMain.push(d.runningMain);
        dataTemp.push(d.runningTemp);

        // Point Logic (Markers)
        if (d.category === 'TRANSACTION') {
            pointRadii.push(4);
            if (d.data.type === 'Deposit') pointColors.push('#3b82f6'); // Blue
            else pointColors.push('#facc15'); // Yellow
        } else {
            pointRadii.push(0); // Hide trade points to keep clean
            pointColors.push('transparent');
        }
    });

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Main Pocket',
                    data: dataMain,
                    borderColor: '#10b981', // Emerald
                    backgroundColor: 'rgba(16, 185, 129, 0.2)',
                    fill: 'origin',
                    tension: 0.1,
                    pointRadius: pointRadii,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: '#fff'
                },
                {
                    label: 'Temp Pocket',
                    data: dataTemp,
                    borderColor: '#ffffff', // White
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    fill: '-1', 
                    tension: 0.1,
                    pointRadius: 0 // Temp doesn't show transaction dots
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) label += formatCurrency(context.parsed.y);
                            return label;
                        },
                        footer: function(tooltipItems) {
                            let sum = 0;
                            tooltipItems.forEach(function(tooltipItem) {
                                sum += tooltipItem.parsed.y;
                            });
                            return 'Total Equity: ' + formatCurrency(sum);
                        }
                    }
                },
                legend: { display: false }
            },
            scales: {
                x: { display: false },
                y: { display: true, grid: {color: '#334155'}, ticks: {color: '#94a3b8'} }
            }
        }
    });
}

// ================= ADVANCED REPORT =================
function updateReport(data) {
    const trades = data.filter(d => d.category === 'TRADE');
    const trans = data.filter(d => d.category === 'TRANSACTION');

    // 1. Financials
    const totalDep = trans.filter(t => t.data.type === 'Deposit').reduce((a,b)=>a+b.val,0);
    const totalWith = trans.filter(t => t.data.type === 'Withdraw').reduce((a,b)=>a+Math.abs(b.val),0);
    const netProfit = trades.reduce((a,b)=>a+b.val,0);
    
    // Growth (Simple ROI for selected period)
    const growth = totalDep > 0 ? (netProfit / totalDep) * 100 : 0;

    setText('rptTotalDeposit', formatCurrency(totalDep));
    setText('rptTotalWithdraw', formatCurrency(totalWith));
    setText('rptNetProfit', formatCurrency(netProfit));
    setText('rptGrowth', (growth>=0?'+':'')+growth.toFixed(2)+'%');

    // Withdraw Allocation
    const mainWD = trans.filter(t => t.data.type === 'Withdraw' && t.data.allocation === 'MAIN').reduce((a,b)=>a+Math.abs(b.val),0);
    const tempWD = trans.filter(t => t.data.type === 'Withdraw' && t.data.allocation === 'TEMP').reduce((a,b)=>a+Math.abs(b.val),0);
    
    setText('rptMainWD', formatCurrency(mainWD));
    setText('rptTempWD', formatCurrency(tempWD));
    const safeWith = totalWith || 1;
    document.getElementById('barMainWD').style.width = (mainWD / safeWith * 100) + "%";
    document.getElementById('barTempWD').style.width = (tempWD / safeWith * 100) + "%";

    // 2. Directional
    const longTrades = trades.filter(t => t.data.type === 'Buy');
    const shortTrades = trades.filter(t => t.data.type === 'Sell');
    
    const longWin = longTrades.filter(t=>t.val>0).length;
    const shortWin = shortTrades.filter(t=>t.val>0).length;

    setText('longCount', longTrades.length + ' Trades');
    setText('shortCount', shortTrades.length + ' Trades');
    setText('longWinRate', (longTrades.length ? (longWin/longTrades.length*100).toFixed(1) : 0) + '%');
    setText('shortWinRate', (shortTrades.length ? (shortWin/shortTrades.length*100).toFixed(1) : 0) + '%');

    // 3. Best & Worst Records
    if (trades.length > 0) {
        // Sort copies
        const sortedByProfit = [...trades].sort((a,b) => b.val - a.val);
        const sortedByPips = [...trades].sort((a,b) => b.pips - a.pips);

        const bestUSD = sortedByProfit[0];
        const worstUSD = sortedByProfit[sortedByProfit.length-1];
        const bestPips = sortedByPips[0];
        const worstPips = sortedByPips[sortedByPips.length-1];

        const bestHTML = `
            ${renderMiniCard(bestUSD, 'Highest Profit', 'text-emerald-400')}
            ${renderMiniCard(bestPips, 'Highest Pips', 'text-emerald-400', true)}
        `;
        const worstHTML = `
            ${renderMiniCard(worstUSD, 'Max Drawdown (USD)', 'text-rose-400')}
            ${renderMiniCard(worstPips, 'Max Drawdown (Pips)', 'text-rose-400', true)}
        `;
        
        document.getElementById('bestRecordsList').innerHTML = bestHTML;
        document.getElementById('worstRecordsList').innerHTML = worstHTML;
    }
}

function renderMiniCard(item, label, colorClass, isPips = false) {
    if (!item) return '';
    const valDisplay = isPips ? item.pips + ' pips' : formatCurrency(item.val);
    return `
    <div class="bg-slate-800 p-2 rounded-lg flex justify-between items-center text-xs border border-slate-700 mb-1" onclick="openEditModal('${item.id}')">
        <div>
            <p class="text-[9px] text-slate-500 uppercase">${label}</p>
            <p class="font-bold text-white">${item.data.type} ${item.data.lots} Lot</p>
        </div>
        <div class="text-right">
            <p class="font-bold ${colorClass}">${valDisplay}</p>
            <p class="text-[9px] text-slate-500">${item.wibDate.toLocaleDateString()}</p>
        </div>
    </div>`;
}

// ================= HISTORY =================
function renderHistory(data) {
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    const reversed = [...data].reverse();

    reversed.forEach(item => {
        const el = document.createElement('div');
        el.onclick = () => openEditModal(item.id); // Click handler
        el.className = "cursor-pointer active:scale-95 transition-transform";

        if (item.category === 'TRADE') {
            const isWin = item.val >= 0;
            // Border left color based on Win/Loss for quick scanning
            el.innerHTML = `
            <div class="bg-slate-800 rounded-lg p-3 border-l-4 ${isWin ? 'border-emerald-500' : 'border-rose-500'} shadow-sm flex justify-between items-center relative overflow-hidden">
                <div class="absolute right-0 top-0 p-1 opacity-10 text-4xl font-bold">${item.data.type[0]}</div>
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold text-white text-sm">${item.data.type.toUpperCase()}</span>
                        <span class="text-[10px] text-slate-400 bg-slate-900 px-1.5 rounded">${item.data.lots} Lot</span>
                        <span class="text-[9px] px-1.5 rounded ${item.sessionClass}">${item.session}</span>
                    </div>
                    <div class="text-[10px] text-slate-500 font-mono">
                        ${item.wibDate.toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'})} WIB | ${item.wibDate.toLocaleDateString()}
                    </div>
                </div>
                <div class="text-right z-10">
                    <div class="font-bold text-base ${isWin ? 'text-emerald-400' : 'text-rose-400'}">
                        ${isWin ? '+' : ''}$${item.val.toFixed(2)}
                    </div>
                    <div class="text-[9px] text-slate-400">${item.pips} pips</div>
                </div>
            </div>`;
        } else {
            // Transaction
            const isDep = item.data.type === 'Deposit';
            el.innerHTML = `
            <div class="bg-slate-800 rounded-lg p-3 border-l-4 ${isDep ? 'border-blue-500' : 'border-yellow-500'} shadow-sm flex justify-between items-center">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold ${isDep ? 'text-blue-400' : 'text-yellow-400'} text-xs">${item.data.type.toUpperCase()}</span>
                        <span class="text-[9px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 font-bold">${item.allocation}</span>
                    </div>
                    <div class="text-[10px] text-slate-500">
                        ${item.wibDate.toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'})} WIB | ${item.wibDate.toLocaleDateString()}
                    </div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-sm text-white">$${Math.abs(item.val).toFixed(2)}</div>
                </div>
            </div>`;
        }
        list.appendChild(el);
    });
}

// ================= MODAL LOGIC =================
function openEditModal(id) {
    const item = processedTimeline.find(d => d.id === id);
    if (!item) return;

    document.getElementById('deleteId').value = id;
    document.getElementById('deleteType').value = item.category;
    
    // Simple Detail Show
    const detail = item.category === 'TRADE' 
        ? `${item.data.type} ${item.data.lots} Lot ($${item.val})` 
        : `${item.data.type} $${Math.abs(item.val)} (${item.data.allocation})`;
    
    document.getElementById('modalDetail').innerText = detail;

    const modal = document.getElementById('modalEdit');
    modal.classList.remove('opacity-0', 'pointer-events-none');
    document.body.classList.add('modal-active');
}

function closeModal() {
    const modal = document.getElementById('modalEdit');
    modal.classList.add('opacity-0', 'pointer-events-none');
    document.body.classList.remove('modal-active');
}

function deleteRecord() {
    if(!confirm("Are you sure you want to delete this record?")) return;
    
    const id = document.getElementById('deleteId').value;
    const type = document.getElementById('deleteType').value;
    const action = type === 'TRADE' ? 'deleteTrade' : 'deleteTransaction';
    
    submitData(action, { id: id });
}


// ================= HELPERS & SETUP =================
function initClock() {
    const update = () => {
        const now = new Date(); 
        const h = now.getHours();
        const m = now.getMinutes().toString().padStart(2, '0');
        const s = now.getSeconds().toString().padStart(2, '0');
        document.getElementById('clock').innerText = `${h}:${m}:${s} WIB`;
        
        let greet = h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening";
        document.getElementById('greeting').innerText = greet + ", Hanzel";
        
        renderSessionTicker(h);
    };
    setInterval(update, 1000);
    update();
}

function renderSessionTicker(h) {
    const sessions = [
        { name: "PACIFIC", start: 4, end: 13, color: "text-slate-400" },
        { name: "ASIA", start: 7, end: 16, color: "text-yellow-400" },
        { name: "LONDON", start: 14, end: 23, color: "text-emerald-400" },
        { name: "NEW YORK", start: 19, end: 28, color: "text-blue-400" }
    ];

    let html = "";
    sessions.forEach(s => {
        let isActive = (s.name === "NEW YORK") ? (h >= 19 || h < 4) : (h >= s.start && h < s.end);
        html += `
            <div class="px-2 py-1 rounded border ${isActive ? 'bg-slate-800 border-slate-600' : 'border-transparent opacity-30'} flex items-center gap-1 min-w-max">
                <div class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-current animate-pulse' : 'bg-slate-600'} ${s.color}"></div>
                <span class="text-[9px] font-bold ${s.color}">${s.name}</span>
            </div>
        `;
    });
    document.getElementById('sessionTicker').innerHTML = html;
}

function setupMonthFilter() {
    const select = document.getElementById('globalFilter');
    const existingVal = select.value;
    const months = [...new Set(processedTimeline.map(d => d.wibDate.toISOString().slice(0, 7)))].sort().reverse();
    
    select.innerHTML = '<option value="all">ALL TIME</option>';
    months.forEach(m => {
        const d = new Date(m + '-01');
        const label = d.toLocaleString('default', { month: 'short', year: 'numeric' }).toUpperCase();
        select.innerHTML += `<option value="${m}">${label}</option>`;
    });

    select.value = existingVal;
    select.onchange = applyGlobalFilter;
}

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
    document.getElementById('tab-trade').className = type === 'trade' ? "flex-1 py-2 text-sm font-bold rounded-lg bg-sky-600 text-white shadow-lg transition-all" : "flex-1 py-2 text-sm font-bold rounded-lg text-slate-400 transition-all";
    document.getElementById('tab-transaction').className = type === 'transaction' ? "flex-1 py-2 text-sm font-bold rounded-lg bg-amber-600 text-white shadow-lg transition-all" : "flex-1 py-2 text-sm font-bold rounded-lg text-slate-400 transition-all";
}

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
    if(lotsInput && grossInput) {
        lotsInput.addEventListener('input', updateCalc);
        grossInput.addEventListener('input', updateCalc);
    }

    document.getElementById('form-trade').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = Object.fromEntries(fd.entries());
        const lots = parseFloat(data.lots);
        const gross = parseFloat(data.netProfit);
        const comm = lots * 10;
        data.netProfit = (gross - comm).toFixed(2);
        submitData('addTrade', data);
    });

    document.getElementById('form-transaction').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = Object.fromEntries(fd.entries());
        submitData('addTransaction', data);
    });
}

function setText(id, val) { const el = document.getElementById(id); if(el) el.innerText = val; }
function formatCurrency(num) { return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function fetchData() {
    try {
        const res = await fetch(`${API_URL}?action=getData`);
        const json = await res.json();
        if (json.status === 'success') {
            globalData = json.data;
            processData(globalData.trades, globalData.transactions);
        }
    } catch (e) { console.error(e); }
}

async function submitData(action, payload) {
    try {
        if (!payload.id) payload.id = 'ID-' + Date.now();
        payload.action = action;
        
        // Visual Feedback only if button exists (delete might not have generic btn)
        const btn = document.querySelector('button[type="submit"]');
        if(btn) { btn.disabled = true; btn.innerText = "Processing..."; }

        await fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) });
        location.reload();
    } catch (e) { alert("Error: " + e); location.reload(); }
}