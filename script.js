// ================= CONFIGURATION =================
const API_URL = "https://script.google.com/macros/s/AKfycbz5JfXSYPLdZ4brYep0xNcy6OR8OJqNuMhYKcaCWbTij-LbxWIIkj0a-bNoVMhVkBnPmQ/exec";
const WIB_OFFSET_MS = 5 * 60 * 60 * 1000;

// ================= STATE =================
let globalData = { trades: [], transactions: [] };
let processedTimeline = []; 
let chartInstance = null;
let currentFilter = 'all';
let editingId = null; 

// ================= INIT =================
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    fetchData();
    setupInputs();
});

// ================= PROCESS DATA =================
function processData(trades, transactions) {
    // 1. Unified Events
    const tradeEvents = trades.map(t => {
        const closeTime = new Date(t.closeTime);
        const wibTime = new Date(closeTime.getTime() + WIB_OFFSET_MS);
        
        let pips = 0;
        if (t.type === 'Buy') pips = (t.exitPrice - t.entryPrice) * 10;
        else if (t.type === 'Sell') pips = (t.entryPrice - t.exitPrice) * 10;

        const h = wibTime.getHours();
        let session = "Pacific", sessionClass = "sess-pacific";
        if (h >= 19 || h < 4) { session = "New York"; sessionClass = "sess-ny"; }
        else if (h >= 14) { session = "London"; sessionClass = "sess-london"; }
        else if (h >= 7) { session = "Asia"; sessionClass = "sess-asia"; }

        return {
            category: 'TRADE',
            id: t.id,
            date: closeTime,
            wibDate: wibTime,
            data: t,
            val: parseFloat(t.netProfit),
            pips: parseFloat(pips.toFixed(1)),
            session: session,
            sessionClass: sessionClass
        };
    });

    const transEvents = transactions.map(t => {
        const dateObj = new Date(t.date);
        const val = parseFloat(t.amount);
        return {
            category: 'TRANSACTION',
            id: t.id,
            date: dateObj,
            wibDate: new Date(dateObj.getTime() + WIB_OFFSET_MS),
            data: t,
            val: t.type === 'Deposit' ? val : -val,
            allocation: t.allocation
        };
    });

    const timeline = [...tradeEvents, ...transEvents].sort((a, b) => a.date - b.date);

    // 2. Main Calculation (Chronological)
    let mainBal = 0, tempBal = 0;
    let totalDep = 0;

    timeline.forEach(item => {
        const currentTotal = mainBal + tempBal;
        
        if (item.category === 'TRANSACTION') {
            if (item.data.type === 'Deposit') totalDep += item.val;
            
            if (item.data.allocation === 'MAIN') mainBal += item.val;
            else tempBal += item.val;
        } else {
            // Profit Allocation Logic
            let mainShare = currentTotal > 0 ? mainBal / currentTotal : 1;
            let tempShare = currentTotal > 0 ? tempBal / currentTotal : 0;
            if (currentTotal <= 0) { mainShare = 1; tempShare = 0; }

            const profitMain = item.val * mainShare;
            const profitTemp = item.val * tempShare;

            mainBal += profitMain;
            tempBal += profitTemp;
        }

        item.runningMain = mainBal;
        item.runningTemp = tempBal;
        item.runningTotal = mainBal + tempBal;
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
    let startMain = 0, startTemp = 0;

    if (filterVal === 'all') {
        filteredData = processedTimeline;
    } else {
        // REVISI 1: Filter Strict (Hanya bulan yang dipilih)
        const startOfMonth = new Date(filterVal + "-01");
        const endOfMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0, 23, 59, 59);

        // Cari indeks pertama yang masuk dalam bulan ini
        const firstIndex = processedTimeline.findIndex(d => d.wibDate >= startOfMonth && d.wibDate <= endOfMonth);
        
        if (firstIndex >= 0) {
            // Ambil data hanya dalam range bulan ini
            filteredData = processedTimeline.filter(d => d.wibDate >= startOfMonth && d.wibDate <= endOfMonth);
            
            // Ambil saldo awal dari item SEBELUM firstIndex
            if (firstIndex > 0) {
                const prev = processedTimeline[firstIndex - 1];
                startMain = prev.runningMain;
                startTemp = prev.runningTemp;
            }
        }
    }

    updateDashboard(filteredData, startMain, startTemp);
    updateReport(filteredData);
    renderHistoryList(filteredData);
}

// ================= DASHBOARD =================
function updateDashboard(data, startMain, startTemp) {
    if (data.length === 0) return;
    const last = data[data.length - 1];

    setText('totalEquity', formatCurrency(last.runningTotal));
    setText('mainBalance', formatCurrency(last.runningMain));
    setText('tempBalance', formatCurrency(last.runningTemp));

    // REVISI 2: Restore Winrate & Net Profit (Period)
    const trades = data.filter(d => d.category === 'TRADE');
    const wins = trades.filter(d => d.val > 0).length;
    const netProfit = trades.reduce((a,b) => a + b.val, 0);
    const winRate = trades.length > 0 ? (wins / trades.length * 100) : 0;

    setText('dashNetProfit', formatCurrency(netProfit));
    document.getElementById('dashNetProfit').className = `text-sm font-bold mt-1 ${netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`; // REVISI 3: Color
    setText('dashWinRate', winRate.toFixed(1) + "%");

    // Net Profit Breakdown (Per Pocket)
    // Estimasi sederhana berdasarkan proporsi saldo akhir (karena alokasi dinamis per trade susah dilacak mundur di filter period)
    const totalBal = last.runningMain + last.runningTemp || 1;
    const mainProp = last.runningMain / totalBal;
    const tempProp = last.runningTemp / totalBal;
    
    // Tampilkan Share NetProfit (Visual saja)
    setText('mainNetProfit', formatCurrency(netProfit * mainProp));
    setText('tempNetProfit', formatCurrency(netProfit * tempProp));

    // REVISI 8: GROWTH LOGIC (Summation of Monthly Growth)
    let growth = calculateGrowth(currentFilter);
    
    const badge = document.getElementById('growthBadge');
    badge.innerText = (growth >= 0 ? "+" : "") + growth.toFixed(2) + "%";
    badge.className = `text-[10px] px-2 py-0.5 rounded font-mono ${growth >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`;

    renderChart(data, startMain, startTemp);
}

function calculateGrowth(filter) {
    // Helper: Group by Month
    const months = {};
    processedTimeline.forEach(d => {
        const mKey = d.wibDate.toISOString().slice(0, 7);
        if(!months[mKey]) months[mKey] = { trades: [], startEq: 0 };
        if(d.category === 'TRADE') months[mKey].trades.push(d);
    });

    // Find Start Equity for each month
    Object.keys(months).sort().forEach(mKey => {
        const firstIdx = processedTimeline.findIndex(d => d.wibDate.toISOString().slice(0, 7) === mKey);
        if(firstIdx > 0) {
            months[mKey].startEq = processedTimeline[firstIdx-1].runningTotal;
        } else {
            // Month 1 start from 0 or initial deposit
            // If strictly return on equity, define growth only after first deposit
            months[mKey].startEq = 0; 
        }
    });

    // Calculate Growth % Per Month
    let totalGrowth = 0;
    
    // If Filter is specific month
    if(filter !== 'all') {
        const mData = months[filter];
        if(!mData || mData.startEq === 0) return 0;
        const net = mData.trades.reduce((a,b)=>a+b.val,0);
        return (net / mData.startEq) * 100;
    }

    // If Filter ALL: Summation of all monthly growths
    Object.keys(months).forEach(mKey => {
        const mData = months[mKey];
        if(mData.startEq > 0) {
            const net = mData.trades.reduce((a,b)=>a+b.val,0);
            totalGrowth += (net / mData.startEq) * 100;
        }
    });
    
    return totalGrowth;
}

// REVISI 4: CHART TUMPUK + TITIK TRANSAKSI
function renderChart(data, startMain, startTemp) {
    const ctx = document.getElementById('equityChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    let labels = ["Start"];
    let dataMain = [startMain];
    let dataTemp = [startTemp];
    
    let pointRadiusMain = [0];
    let pointColorMain = ['transparent'];

    data.forEach(d => {
        labels.push(d.wibDate.toLocaleDateString('id-ID', {day: 'numeric', month: 'short'}));
        dataMain.push(d.runningMain);
        dataTemp.push(d.runningTemp);

        if(d.category === 'TRANSACTION') {
            pointRadiusMain.push(4);
            pointColorMain.push(d.data.type === 'Deposit' ? '#3b82f6' : '#facc15'); // Depo=Blue, WD=Yellow
        } else {
            pointRadiusMain.push(0);
            pointColorMain.push('transparent');
        }
    });

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Main',
                    data: dataMain,
                    borderColor: '#3b82f6', // Blue
                    backgroundColor: 'rgba(59, 130, 246, 0.2)',
                    fill: 'origin', // Stacked from bottom
                    tension: 0.1,
                    pointRadius: pointRadiusMain,
                    pointBackgroundColor: pointColorMain,
                    pointBorderColor: '#fff'
                },
                {
                    label: 'Temp',
                    data: dataTemp,
                    borderColor: '#facc15', // Yellow
                    backgroundColor: 'rgba(250, 204, 21, 0.2)',
                    fill: '-1', // Stacked on top of Main
                    tension: 0.1,
                    pointRadius: 0 // Clean line for temp
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: false },
                y: { stacked: true, grid: {color: '#334155'}, ticks: {color: '#94a3b8'} }
            }
        }
    });
}

// ================= REPORT =================
function updateReport(data) {
    const trades = data.filter(d => d.category === 'TRADE');
    const trans = data.filter(d => d.category === 'TRANSACTION');

    const totalDep = trans.filter(t => t.data.type === 'Deposit').reduce((a,b)=>a+b.val,0);
    const totalWith = trans.filter(t => t.data.type === 'Withdraw').reduce((a,b)=>a+Math.abs(b.val),0);
    
    const wins = trades.filter(t=>t.val>0);
    const losses = trades.filter(t=>t.val<0);
    const grossProfit = wins.reduce((a,b)=>a+b.val,0);
    const grossLoss = losses.reduce((a,b)=>a+b.val,0);
    const netProfit = grossProfit + grossLoss;
    
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;

    // REVISI 7: Max Consecutive
    let maxConsWin = 0, currConsWin = 0;
    let maxConsLoss = 0, currConsLoss = 0;
    trades.forEach(t => {
        if(t.val > 0) { currConsWin++; currConsLoss=0; if(currConsWin>maxConsWin) maxConsWin=currConsWin; }
        else { currConsLoss++; currConsWin=0; if(currConsLoss>maxConsLoss) maxConsLoss=currConsLoss; }
    });

    // Directional
    const long = trades.filter(t=>t.data.type==='Buy');
    const short = trades.filter(t=>t.data.type==='Sell');
    const longWin = long.filter(t=>t.val>0).length;
    const shortWin = short.filter(t=>t.val>0).length;

    setText('rptTotalDeposit', formatCurrency(totalDep));
    setText('rptTotalWithdraw', formatCurrency(totalWith));
    setText('rptGrossProfit', formatCurrency(grossProfit));
    setText('rptGrossLoss', formatCurrency(grossLoss));
    setText('rptAvgWin', formatCurrency(avgWin));
    setText('rptAvgLoss', formatCurrency(avgLoss));
    setText('rptMaxConsWin', maxConsWin);
    setText('rptMaxConsLoss', maxConsLoss);

    setText('longCount', long.length + " Trades");
    setText('shortCount', short.length + " Trades");
    setText('longWinRate', (long.length ? (longWin/long.length*100).toFixed(1) : 0) + "%");
    setText('shortWinRate', (short.length ? (shortWin/short.length*100).toFixed(1) : 0) + "%");

    updateAllocBar('Deposit', trans, 'rptMainDep', 'rptTempDep', 'barMainDep', 'barTempDep');
    
    // Best/Worst Records
    if (trades.length > 0) {
        const sortedProfit = [...trades].sort((a,b) => b.val - a.val);
        const sortedPips = [...trades].sort((a,b) => b.pips - a.pips);

        const bestList = document.getElementById('bestRecordsList');
        const worstList = document.getElementById('worstRecordsList');
        
        // REVISI 2: Duplicate cards allowed if same transaction
        bestList.innerHTML = `
            ${renderHistoryCardHTML(sortedProfit[0])}
            ${renderHistoryCardHTML(sortedPips[0])}
        `;
        worstList.innerHTML = `
            ${renderHistoryCardHTML(sortedProfit[sortedProfit.length-1])}
            ${renderHistoryCardHTML(sortedPips[sortedPips.length-1])}
        `;
    }
}

function updateAllocBar(type, trans, idMain, idTemp, barMain, barTemp) {
    const subset = trans.filter(t => t.data.type === type);
    const main = subset.filter(t => t.data.allocation === 'MAIN').reduce((a,b)=>a+Math.abs(b.val),0);
    const temp = subset.filter(t => t.data.allocation === 'TEMP').reduce((a,b)=>a+Math.abs(b.val),0);
    const total = main + temp || 1;
    setText(idMain, formatCurrency(main));
    setText(idTemp, formatCurrency(temp));
    document.getElementById(barMain).style.width = (main/total*100) + "%";
    document.getElementById(barTemp).style.width = (temp/total*100) + "%";
}

// ================= HISTORY =================
function renderHistoryList(data) {
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    const reversed = [...data].reverse();
    reversed.forEach(item => {
        list.innerHTML += renderHistoryCardHTML(item);
    });
}

// REVISI 5: Pips restored + Less cramped (p-4)
function renderHistoryCardHTML(item) {
    if (!item) return '';
    const clickAttr = `onclick="openEditModal('${item.id}')"`;
    
    if (item.category === 'TRADE') {
        const isWin = item.val >= 0;
        return `
        <div class="cursor-pointer active:scale-95 transition-transform bg-slate-800 rounded-xl p-4 border-l-4 ${isWin ? 'border-emerald-500' : 'border-rose-500'} shadow-sm flex justify-between items-center relative overflow-hidden" ${clickAttr}>
            <div class="absolute right-0 top-0 p-1 opacity-10 text-5xl font-bold">${item.data.type[0]}</div>
            <div>
                <div class="flex items-center gap-2 mb-2">
                    <span class="font-bold text-white text-sm">${item.data.type.toUpperCase()}</span>
                    <span class="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded">${item.data.lots} Lot</span>
                    <span class="text-[9px] px-2 py-0.5 rounded ${item.sessionClass}">${item.session}</span>
                </div>
                <div class="text-[10px] text-slate-500 font-mono">
                    ${item.wibDate.toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'})} WIB | ${item.wibDate.toLocaleDateString()}
                </div>
            </div>
            <div class="text-right z-10">
                <div class="font-bold text-lg ${isWin ? 'text-emerald-400' : 'text-rose-400'}">
                    ${isWin ? '+' : ''}$${item.val.toFixed(2)}
                </div>
                <div class="text-xs text-slate-400 mt-1">${item.pips} pips</div>
            </div>
        </div>`;
    } else {
        const isDep = item.data.type === 'Deposit';
        return `
        <div class="cursor-pointer active:scale-95 transition-transform bg-slate-800 rounded-xl p-4 border-l-4 ${isDep ? 'border-blue-500' : 'border-yellow-500'} shadow-sm flex justify-between items-center" ${clickAttr}>
            <div>
                <div class="flex items-center gap-2 mb-2">
                    <span class="font-bold ${isDep ? 'text-blue-400' : 'text-yellow-400'} text-sm">${item.data.type.toUpperCase()}</span>
                    <span class="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-500 font-bold">${item.data.allocation}</span>
                </div>
                <div class="text-[10px] text-slate-500">
                    ${item.wibDate.toLocaleDateString()}
                </div>
            </div>
            <div class="text-right">
                <div class="font-bold text-lg text-white">$${Math.abs(item.val).toFixed(2)}</div>
            </div>
        </div>`;
    }
}

// ================= MODAL & EDIT (REVISI 6: Fix) =================
// Fungsi ini harus ada di global scope agar onclick di HTML bisa akses
window.openEditModal = function(id) {
    const item = processedTimeline.find(d => d.id === id);
    if (!item) return;
    editingId = id;

    const content = document.getElementById('modalFormContent');
    content.innerHTML = '';

    if (item.category === 'TRADE') {
        const d = item.data;
        const comm = d.lots * 10;
        const gross = (parseFloat(d.netProfit) + comm).toFixed(2);
        
        content.innerHTML = `
            <div class="space-y-3">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-[10px] text-slate-400">Type</label>
                        <select id="editType" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                            <option value="Buy" ${d.type==='Buy'?'selected':''}>Buy</option>
                            <option value="Sell" ${d.type==='Sell'?'selected':''}>Sell</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-[10px] text-slate-400">Lots</label>
                        <input id="editLots" type="number" step="0.01" value="${d.lots}" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-[10px] text-slate-400">Entry</label>
                        <input id="editEntry" type="number" step="any" value="${d.entryPrice}" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                    </div>
                    <div>
                        <label class="text-[10px] text-slate-400">Exit</label>
                        <input id="editExit" type="number" step="any" value="${d.exitPrice}" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                    </div>
                </div>
                <div>
                    <label class="text-[10px] text-slate-400">Gross Profit ($)</label>
                    <input id="editGross" type="number" step="any" value="${gross}" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700 font-bold">
                </div>
                <input type="hidden" id="editOpenTime" value="${d.openTime}">
                <input type="hidden" id="editCloseTime" value="${d.closeTime}">
                <input type="hidden" id="editCategory" value="TRADE">
            </div>
        `;
    } else {
        const d = item.data;
        content.innerHTML = `
            <div class="space-y-3">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-[10px] text-slate-400">Type</label>
                        <select id="editType" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                            <option value="Deposit" ${d.type==='Deposit'?'selected':''}>Deposit</option>
                            <option value="Withdraw" ${d.type==='Withdraw'?'selected':''}>Withdraw</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-[10px] text-slate-400">Amount</label>
                        <input id="editAmount" type="number" step="any" value="${d.amount}" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                    </div>
                </div>
                <div>
                    <label class="text-[10px] text-slate-400">Allocation</label>
                    <select id="editAlloc" class="w-full bg-slate-800 p-2 rounded text-white border border-slate-700">
                        <option value="MAIN" ${d.allocation==='MAIN'?'selected':''}>MAIN</option>
                        <option value="TEMP" ${d.allocation==='TEMP'?'selected':''}>TEMP</option>
                    </select>
                </div>
                <input type="hidden" id="editDate" value="${d.date}">
                <input type="hidden" id="editCategory" value="TRANSACTION">
            </div>
        `;
    }

    document.getElementById('modalEdit').classList.remove('opacity-0', 'pointer-events-none');
    document.body.classList.add('modal-active');
};

window.closeModal = function() {
    document.getElementById('modalEdit').classList.add('opacity-0', 'pointer-events-none');
    document.body.classList.remove('modal-active');
};

window.updateRecord = function() {
    const category = document.getElementById('editCategory').value;
    const btn = document.querySelector('#modalEdit button.bg-sky-600');
    btn.innerText = "Saving...";
    
    if (category === 'TRADE') {
        const lots = parseFloat(document.getElementById('editLots').value);
        const gross = parseFloat(document.getElementById('editGross').value);
        const comm = lots * 10;
        const net = (gross - comm).toFixed(2);

        submitData('editTrade', {
            id: editingId,
            type: document.getElementById('editType').value,
            lots: lots,
            entryPrice: document.getElementById('editEntry').value,
            exitPrice: document.getElementById('editExit').value,
            netProfit: net,
            openTime: document.getElementById('editOpenTime').value,
            closeTime: document.getElementById('editCloseTime').value
        });
    } else {
        submitData('editTransaction', {
            id: editingId,
            type: document.getElementById('editType').value,
            amount: document.getElementById('editAmount').value,
            allocation: document.getElementById('editAlloc').value,
            date: document.getElementById('editDate').value
        });
    }
};

window.deleteRecord = function() {
    if(!confirm("Delete this record permanently?")) return;
    const cat = document.getElementById('editCategory').value;
    submitData(cat === 'TRADE' ? 'deleteTrade' : 'deleteTransaction', { id: editingId });
};


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
        
        // Ticker (Simple)
        const sessions = [{n:"PACIFIC",s:4,e:13,c:"text-slate-400"},{n:"ASIA",s:7,e:16,c:"text-yellow-400"},{n:"LONDON",s:14,e:23,c:"text-emerald-400"},{n:"NEW YORK",s:19,e:28,c:"text-blue-400"}];
        let html=""; sessions.forEach(ses=>{ let on=(ses.n==="NEW YORK")?(h>=19||h<4):(h>=ses.s&&h<ses.e); html+=`<div class="px-2 py-1 rounded border ${on?'bg-slate-800 border-slate-600':'border-transparent opacity-30'} flex items-center gap-1 min-w-max"><div class="w-1.5 h-1.5 rounded-full ${on?'bg-current animate-pulse':'bg-slate-600'} ${ses.c}"></div><span class="text-[9px] font-bold ${ses.c}">${ses.n}</span></div>`});
        document.getElementById('sessionTicker').innerHTML=html;
    };
    setInterval(update, 1000); update();
}

function setupMonthFilter() {
    const select = document.getElementById('globalFilter');
    const existingVal = select.value;
    const months = [...new Set(processedTimeline.map(d => d.wibDate.toISOString().slice(0, 7)))].sort().reverse();
    select.innerHTML = '<option value="all">ALL TIME</option>';
    months.forEach(m => {
        const d = new Date(m + '-01');
        select.innerHTML += `<option value="${m}">${d.toLocaleString('default', { month: 'short', year: 'numeric' }).toUpperCase()}</option>`;
    });
    select.value = existingVal;
    select.onchange = applyGlobalFilter;
}

function switchView(view) {
    document.querySelectorAll('section').forEach(el => el.classList.add('hidden'));
    document.getElementById(`view-${view}`).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active', 'text-sky-400'));
    document.querySelector(`.nav-btn[onclick="switchView('${view}')"]`).classList.add('active', 'text-sky-400');
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
    if(lotsInput) { lotsInput.addEventListener('input', updateCalc); grossInput.addEventListener('input', updateCalc); }
    document.getElementById('form-trade').addEventListener('submit', (e) => { e.preventDefault(); const fd = new FormData(e.target); const data = Object.fromEntries(fd.entries()); const comm = parseFloat(data.lots)*10; data.netProfit = (parseFloat(data.netProfit)-comm).toFixed(2); submitData('addTrade', data); });
    document.getElementById('form-transaction').addEventListener('submit', (e) => { e.preventDefault(); submitData('addTransaction', Object.fromEntries(new FormData(e.target).entries())); });
}

function setText(id, val) { const el = document.getElementById(id); if(el) el.innerText = val; }
function formatCurrency(num) { return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function fetchData() {
    try { const res = await fetch(`${API_URL}?action=getData`); const json = await res.json(); if (json.status === 'success') { globalData = json.data; processData(globalData.trades, globalData.transactions); } } catch (e) { console.error(e); }
}
async function submitData(action, payload) {
    try { if (!payload.id) payload.id = 'ID-' + Date.now(); payload.action = action; await fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) }); location.reload(); } catch (e) { alert("Error: " + e); location.reload(); }
}

// Make functions global for HTML onclick access
window.switchView = switchView;
window.switchForm = switchForm;
window.applyGlobalFilter = applyGlobalFilter;