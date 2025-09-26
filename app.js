/*
  永续合约“滚仓”收益模拟器
  模型（多头）：
  - 价格路径：P_k = P_0 * (1 + s)^k
  - 第 k 步（从 1 开始）在 P_{k-1} 开仓名义 N_k = L * E_{k-1}
  - 持仓数量 Q_k = N_k / P_{k-1}
  - 本步平仓价 P_k，盈亏 PNL_k = Q_k * (P_k - P_{k-1})
  - 手续费：
      feeClose_k = t * (P_k * Q_k)  // 平
      funding_k  = f * N_k          // 资金费
      E_k' = E_{k-1} + PNL_k - feeClose_k - funding_k
      feeOpen_{k+1} = t * (L * E_k') // 以全部权益重开
      E_k = E_k' - feeOpen_{k+1}
  - 若为最后一步且选择“结束时平仓”，再扣一次终平手续费：t * (L * E_K) 近似等于按名义价值收取
  说明：忽略强平细节、滑点、资金费方向变化，仅做策略级粗估。
*/

/** @typedef {Object} StepRow */
/** @typedef {Object} SimInput */
/** @typedef {Object} SimOutput */

const $ = (sel) => document.querySelector(sel);
let lastOut = null;
let debounceTimer = null;

// 防抖函数
function debounce(func, wait) {
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(debounceTimer);
      func(...args);
    };
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(later, wait);
  };
}

function fmt(n, digits = 2) {
  if (!isFinite(n)) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function readInputs() {
  const initialCapital = Number($('#initialCapital').value);
  const leverage = Number($('#leverage').value);
  const entryPrice = Number($('#entryPrice').value);
  const stepPct = Number($('#stepPct').value) / 100;
  const steps = Number($('#steps').value);
  const takerFee = Number($('#takerFee').value);
  const fundingPerStep = Number($('#fundingPerStep').value);
  const mmr = Number($('#mmr').value);
  const closeAtEnd = $('#closeAtEnd').checked;

  const logScale = !!$('#toggleLog')?.checked;
  const markers = !!$('#toggleMarkers')?.checked;

  return { initialCapital, leverage, entryPrice, stepPct, steps, takerFee, fundingPerStep, mmr, closeAtEnd, logScale, markers };
}

function validateInputs(inp) {
  const errs = [];
  if (!(inp.initialCapital > 0)) errs.push('初始本金需大于 0');
  if (!(inp.leverage >= 1)) errs.push('杠杆需 ≥ 1');
  if (!(inp.entryPrice > 0)) errs.push('入场价格需大于 0');
  if (!(inp.stepPct > 0)) errs.push('每步阈值需大于 0%');
  if (!(Number.isInteger(inp.steps) && inp.steps > 0)) errs.push('步数需为正整数');
  if (inp.takerFee < 0) errs.push('手续费率不能为负');
  if (inp.fundingPerStep < 0) errs.push('资金费率不能为负');
  if (inp.mmr < 0) errs.push('MMR 不能为负');
  return errs;
}

function renderErrors(errs) {
  const box = $('#formErrors');
  if (!box) return;
  if (!errs.length) {
    box.style.display = 'none';
    box.innerHTML = '';
  } else {
    box.style.display = '';
    box.innerHTML = '<ul>' + errs.map(e => `<li>${e}</li>`).join('') + '</ul>';
  }
}

function stateToQuery(inp) {
  const params = new URLSearchParams();
  params.set('initialCapital', String(inp.initialCapital));
  params.set('leverage', String(inp.leverage));
  params.set('entryPrice', String(inp.entryPrice));
  params.set('stepPct', String(inp.stepPct * 100));
  params.set('steps', String(inp.steps));
  params.set('takerFee', String(inp.takerFee));
  params.set('fundingPerStep', String(inp.fundingPerStep));
  params.set('mmr', String(inp.mmr));
  params.set('closeAtEnd', inp.closeAtEnd ? '1' : '0');
  params.set('logScale', inp.logScale ? '1' : '0');
  params.set('markers', inp.markers ? '1' : '0');
  return params.toString();
}

function applyStateToUI(inp) {
  $('#initialCapital').value = String(inp.initialCapital ?? 100);
  $('#leverage').value = String(inp.leverage ?? 10);
  $('#entryPrice').value = String(inp.entryPrice ?? 100);
  $('#stepPct').value = String((inp.stepPct ?? 0.1) * 100);
  $('#steps').value = String(inp.steps ?? 10);
  $('#takerFee').value = String(inp.takerFee ?? 0.0006);
  $('#fundingPerStep').value = String(inp.fundingPerStep ?? 0);
  $('#mmr').value = String(inp.mmr ?? 0.004);
  $('#closeAtEnd').checked = !!inp.closeAtEnd;
  if ($('#toggleLog')) $('#toggleLog').checked = !!inp.logScale;
  if ($('#toggleMarkers')) $('#toggleMarkers').checked = !!inp.markers;
}

function readStateFromUrlOrStorage() {
  const url = new URL(window.location.href);
  const p = url.searchParams;
  const fromUrl = p.has('initialCapital');
  const raw = fromUrl ? Object.fromEntries(p.entries()) : JSON.parse(localStorage.getItem('rolling_perp_state') || 'null');
  if (!raw) return null;
  try {
    return {
      initialCapital: Number(raw.initialCapital ?? raw.E0 ?? 100),
      leverage: Number(raw.leverage ?? 10),
      entryPrice: Number(raw.entryPrice ?? 100),
      stepPct: Number(raw.stepPct ?? 10) / 100,
      steps: Number(raw.steps ?? 10),
      takerFee: Number(raw.takerFee ?? 0.0006),
      fundingPerStep: Number(raw.fundingPerStep ?? 0),
      mmr: Number(raw.mmr ?? 0.004),
      closeAtEnd: (raw.closeAtEnd ?? '1') === '1' || !!raw.closeAtEnd,
      logScale: (raw.logScale ?? '0') === '1' || !!raw.logScale,
      markers: (raw.markers ?? '0') === '1' || !!raw.markers,
    };
  } catch { return null; }
}

function persistState(inp) {
  const q = stateToQuery(inp);
  const url = new URL(window.location.href);
  url.search = q;
  history.replaceState(null, '', url.toString());
  localStorage.setItem('rolling_perp_state', JSON.stringify(inp));
}

/**
 * 运行滚仓模拟
 * @param {SimInput} inp
 * @returns {SimOutput}
 */
function runSimulation(inp) {
  const { initialCapital: E0, leverage: L, entryPrice: P0, stepPct: s, steps: K, takerFee: t, fundingPerStep: f, closeAtEnd, mmr } = inp;

  const prices = [P0];
  for (let k = 1; k <= K; k++) prices.push(P0 * Math.pow(1 + s, k));

  /** @type {Array<any>} */
  const rows = [];
  const equitySeries = [E0];
  let Eprev = E0;
  let totalFees = 0;

  let minDistPct = Infinity;
  let minLiqPrice = Infinity;
  for (let k = 1; k <= K; k++) {
    const Pprev = prices[k - 1];
    const Pk = prices[k];

    const nominalOpen = L * Eprev; // N_k
    const qty = nominalOpen / Pprev; // Q_k
    const pnl = qty * (Pk - Pprev); // PNL_k

    const feeClose = t * (Pk * qty);
    const funding = f * nominalOpen;
    const EkPrime = Eprev + pnl - feeClose - funding;

    const feeOpenNext = t * (L * EkPrime);
    let Ek = EkPrime - feeOpenNext;

    totalFees += feeClose + feeOpenNext + funding;

    // 如果是最后一步且需要在结束时平仓，再扣一次按名义价值估算的平仓费
    let endCloseFee = 0;
    if (k === K && closeAtEnd) {
      const nominalAtEnd = L * Ek;
      endCloseFee = t * nominalAtEnd;
      Ek -= endCloseFee;
      totalFees += endCloseFee;
    }

    const liqPrice = Pprev * (1 - 1 / L + mmr);
    const distPct = (Pk > 0) ? Math.max(0, (Pk - liqPrice) / Pk * 100) : 0;
    if (isFinite(distPct) && distPct < minDistPct) {
      minDistPct = distPct;
      minLiqPrice = liqPrice;
    }

    rows.push({
      step: k,
      price: Pk,
      liqPrice,
      distPct,
      entryAtStep: Pprev,
      nominalOpen,
      qty,
      pnl,
      feeClose,
      feeOpenNext,
      funding,
      endCloseFee,
      equityEnd: Ek,
    });

    Eprev = Ek;
    equitySeries.push(Ek);
  }

  const finalEquity = Eprev;
  const roi = (finalEquity - E0) / E0;

  return { prices, equitySeries, rows, finalEquity, roi, totalFees, minDistPct, minLiqPrice };
}

function renderKPIs(out, inp) {
  $('#kpiFinalEquity').textContent = `${fmt(out.finalEquity, 2)} USDT`;
  
  // ROI 显示带颜色
  const roiElement = $('#kpiRoi');
  const roiValue = out.roi * 100;
  roiElement.textContent = `${fmt(roiValue, 2)}%`;
  roiElement.className = 'kpi-value';
  if (roiValue > 0) roiElement.classList.add('positive');
  else if (roiValue < 0) roiElement.classList.add('negative');
  
  $('#kpiFees').textContent = `${fmt(out.totalFees, 2)} USDT`;
  $('#kpiSteps').textContent = `${inp.steps}`;
  
  // 强平距离警告
  const minDistElement = $('#kpiMinDist');
  if (minDistElement) {
    if (isFinite(out.minDistPct)) {
      minDistElement.textContent = `${fmt(out.minDistPct, 2)}%`;
      minDistElement.className = 'kpi-value';
      if (out.minDistPct <= 5) {
        minDistElement.classList.add('danger');
      } else if (out.minDistPct <= 15) {
        minDistElement.classList.add('warning');
      }
    } else {
      minDistElement.textContent = '-';
    }
  }
  
  if ($('#kpiMinLiq')) $('#kpiMinLiq').textContent = isFinite(out.minLiqPrice) ? `${fmt(out.minLiqPrice, 4)}` : '-';
  
  // 添加风险警告横幅
  updateRiskWarning(out, inp);
}

function updateRiskWarning(out, inp) {
  let existingWarning = $('#riskWarning');
  if (existingWarning) existingWarning.remove();
  
  const warnings = [];
  
  // 检查强平风险
  if (isFinite(out.minDistPct) && out.minDistPct <= 10) {
    if (out.minDistPct <= 5) {
      warnings.push(`⚠️ 极高风险：最小强平距离仅 ${fmt(out.minDistPct, 1)}%，建议降低杠杆或增加加仓阈值`);
    } else {
      warnings.push(`⚠️ 高风险：最小强平距离 ${fmt(out.minDistPct, 1)}%，请谨慎操作`);
    }
  }
  
  // 检查极端杠杆
  if (inp.leverage >= 50) {
    warnings.push(`⚠️ 极高杠杆：${inp.leverage}× 杠杆风险极大，市场小幅波动即可能强平`);
  }
  
  // 检查小阈值高杠杆组合
  if (inp.leverage >= 20 && inp.stepPct <= 0.05) {
    warnings.push(`⚠️ 危险组合：高杠杆(${inp.leverage}×) + 小阈值(${fmt(inp.stepPct * 100, 1)}%) 极易触发强平`);
  }
  
  if (warnings.length > 0) {
    const warningDiv = document.createElement('div');
    warningDiv.id = 'riskWarning';
    warningDiv.className = 'risk-warning';
    warningDiv.innerHTML = warnings.map(w => `<div class="warning-item">${w}</div>`).join('');
    
    const kpisElement = $('#kpis');
    if (kpisElement && kpisElement.parentNode) {
      kpisElement.parentNode.insertBefore(warningDiv, kpisElement);
    }
  }
}

function renderTable(out) {
  const tbody = $('#resultTable tbody');
  tbody.innerHTML = '';
  for (const r of out.rows) {
    const tr = document.createElement('tr');
    if (isFinite(r.distPct) && r.distPct <= 5) tr.classList.add('risk');
    tr.innerHTML = `
      <td>${r.step}</td>
      <td>${fmt(r.price, 4)}</td>
      <td>${fmt(r.liqPrice, 4)}</td>
      <td>${fmt(r.distPct, 2)}%</td>
      <td>${fmt(r.entryAtStep, 4)}</td>
      <td>${fmt(r.nominalOpen, 2)}</td>
      <td>${fmt(r.qty, 6)}</td>
      <td>${fmt(r.pnl, 2)}</td>
      <td>${fmt(r.feeClose + r.feeOpenNext + r.endCloseFee, 4)}</td>
      <td>${fmt(r.funding, 4)}</td>
      <td>${fmt(r.equityEnd, 2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

let chart;
let roiChart;
let sensitivityChart;
function renderChart(out) {
  const ctx = document.getElementById('equityChart');
  const labels = out.equitySeries.map((_, i) => i);
  const dataEquity = out.equitySeries;
  const dataPrice = out.prices;
  const E0 = out.equitySeries[0];
  const roiSeries = out.equitySeries.map(e => (e - E0) / E0 * 100);
  const logScale = !!$('#toggleLog')?.checked;
  const markers = !!$('#toggleMarkers')?.checked;

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '权益 (USDT)',
          data: dataEquity,
          borderColor: '#4f8cff',
          backgroundColor: 'rgba(79,140,255,0.15)',
          tension: 0.2,
          pointRadius: markers ? 3 : 0,
          yAxisID: 'y',
        },
        {
          label: '价格 (相对比例)',
          data: dataPrice.map(p => p / dataPrice[0] * out.equitySeries[0]),
          borderColor: '#7ad3ff',
          backgroundColor: 'rgba(122,211,255,0.15)',
          tension: 0.2,
          pointRadius: 0,
          yAxisID: 'y',
        },
        {
          label: '收益率 (%)',
          data: roiSeries,
          borderColor: '#00e676',
          backgroundColor: 'rgba(0,230,118,0.10)',
          tension: 0.2,
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: true,
          borderDash: [6, 4],
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#e7eefc' } },
        tooltip: { 
          callbacks: { 
            label: (ctx) => {
              if (ctx.dataset.yAxisID === 'y1') {
                return `${ctx.dataset.label}: ${fmt(ctx.parsed.y, 2)}%`;
              } else {
                return `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`;
              }
            },
            afterBody: (tooltipItems) => {
              const stepIndex = tooltipItems[0].dataIndex;
              if (stepIndex > 0 && out.rows && out.rows[stepIndex - 1]) {
                const row = out.rows[stepIndex - 1];
                return [
                  `强平距离: ${fmt(row.distPct, 2)}%`,
                  `PnL: ${fmt(row.pnl, 2)} USDT`,
                  `手续费: ${fmt(row.feeClose + row.feeOpenNext + row.endCloseFee, 2)} USDT`
                ];
              }
              return [];
            }
          },
          backgroundColor: 'rgba(26, 32, 53, 0.95)',
          titleColor: '#e7eefc',
          bodyColor: '#8ea0bf',
          borderColor: 'var(--border)',
          borderWidth: 1
        },
        decimation: { enabled: true, algorithm: 'lttb', samples: 1000 },
      },
      scales: {
        x: { ticks: { color: '#8ea0bf' }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '步 (Step)', color: '#8ea0bf' } },
        y: { type: logScale ? 'logarithmic' : 'linear', ticks: { color: '#8ea0bf' }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '权益 (USDT)', color: '#8ea0bf' } },
        y1: { position: 'right', ticks: { color: '#8ea0bf', callback: (v) => `${v}%` }, grid: { drawOnChartArea: false, color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '收益率 (%)', color: '#8ea0bf' } },
      }
    }
  });

  // ROI-only chart for guaranteed visibility
  const roiCtx = document.getElementById('roiChart');
  if (roiChart) roiChart.destroy();
  roiChart = new Chart(roiCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '收益率 (%)',
          data: roiSeries,
          borderColor: '#00e676',
          backgroundColor: 'rgba(0,230,118,0.10)',
          tension: 0.2,
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: true,
          borderDash: [6, 4],
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#e7eefc' } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y, 2)}%` } }
      },
      scales: {
        x: { ticks: { color: '#8ea0bf' }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '步 (Step)', color: '#8ea0bf' } },
        y: { ticks: { color: '#8ea0bf', callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '收益率 (%)', color: '#8ea0bf' } },
      }
    }
  });
}

function toCSV(out) {
  const headers = ['step','price','liq_price','dist_to_liq_pct','entry_price','nominal_open','qty','pnl','fee_close_open_end','funding','equity_end'];
  const rows = out.rows.map(r => [
    r.step,
    r.price,
    r.liqPrice,
    r.distPct,
    r.entryAtStep,
    r.nominalOpen,
    r.qty,
    r.pnl,
    (r.feeClose + r.feeOpenNext + r.endCloseFee),
    r.funding,
    r.equityEnd,
  ]);
  const lines = [headers.join(','), ...rows.map(r => r.join(','))];
  return lines.join('\n');
}

function toJSON(out, inp) {
  return JSON.stringify({ input: inp, output: out }, null, 2);
}

function download(filename, content, mime = 'application/octet-stream') {
  try {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (err) {
    console.error('Download failed', err);
  }
}

function simulateAndRender() {
  const inp = readInputs();
  const errs = validateInputs(inp);
  renderErrors(errs);
  if (errs.length) return;

  // 显示加载状态
  showLoadingState(true);

  // 使用 requestAnimationFrame 确保 UI 更新后再执行计算
  requestAnimationFrame(() => {
    try {
      persistState(inp);

      const out = runSimulation(inp);
      lastOut = out;
      renderKPIs(out, inp);
      renderTable(out);
      renderChart(out);

      $('#downloadCsv').onclick = () => download('rolling_perp.csv', toCSV(out), 'text/csv');
      const jsonBtn = $('#downloadJson');
      if (jsonBtn) jsonBtn.onclick = () => download('rolling_perp.json', toJSON(out, inp), 'application/json');
    } finally {
      showLoadingState(false);
    }
  });
}

// 防抖版本的模拟和渲染函数
const debouncedSimulateAndRender = debounce(simulateAndRender, 300);

// 加载状态管理
function showLoadingState(isLoading) {
  const button = $('#simForm button[type="submit"]');
  const kpis = $('#kpis');
  
  if (isLoading) {
    if (button) {
      button.disabled = true;
      button.textContent = '计算中...';
    }
    if (kpis) kpis.style.opacity = '0.6';
  } else {
    if (button) {
      button.disabled = false;
      button.textContent = '计算';
    }
    if (kpis) kpis.style.opacity = '1';
  }
}

// 预设模板
const PRESET_TEMPLATES = {
  conservative: {
    name: '保守型',
    initialCapital: 1000,
    leverage: 3,
    entryPrice: 100,
    stepPct: 20,
    steps: 5,
    takerFee: 0.0006,
    fundingPerStep: 0,
    mmr: 0.004,
    closeAtEnd: true,
    description: '低杠杆，大阈值，适合稳健投资者'
  },
  moderate: {
    name: '平衡型',
    initialCapital: 500,
    leverage: 10,
    entryPrice: 100,
    stepPct: 10,
    steps: 8,
    takerFee: 0.0006,
    fundingPerStep: 0,
    mmr: 0.004,
    closeAtEnd: true,
    description: '中等杠杆和阈值，平衡收益与风险'
  },
  aggressive: {
    name: '激进型',
    initialCapital: 100,
    leverage: 25,
    entryPrice: 100,
    stepPct: 5,
    steps: 15,
    takerFee: 0.0006,
    fundingPerStep: 0,
    mmr: 0.004,
    closeAtEnd: true,
    description: '高杠杆，小阈值，高风险高收益'
  }
};

function applyTemplate(templateKey) {
  const template = PRESET_TEMPLATES[templateKey];
  if (!template) return;
  
  // 更新UI
  applyStateToUI({
    initialCapital: template.initialCapital,
    leverage: template.leverage,
    entryPrice: template.entryPrice,
    stepPct: template.stepPct / 100,
    steps: template.steps,
    takerFee: template.takerFee,
    fundingPerStep: template.fundingPerStep,
    mmr: template.mmr,
    closeAtEnd: template.closeAtEnd,
    logScale: false,
    markers: false
  });
  
  // 更新按钮状态
  document.querySelectorAll('.template-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeBtn = document.querySelector(`[data-template="${templateKey}"]`);
  if (activeBtn) activeBtn.classList.add('active');
  
  // 立即计算
  simulateAndRender();
}

function wireEvents() {
  // 移动端表格提示
  function updateMobileTableHint() {
    const hint = document.querySelector('.mobile-table-hint');
    if (hint) {
      hint.style.display = window.innerWidth <= 768 ? 'block' : 'none';
    }
  }
  
  updateMobileTableHint();
  window.addEventListener('resize', updateMobileTableHint);

  // 预设模板事件
  document.querySelectorAll('.template-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const template = btn.dataset.template;
      applyTemplate(template);
    });
  });

  $('#simForm').addEventListener('submit', (e) => {
    e.preventDefault();
    simulateAndRender();
  });
  // live sync on input change with debounce
  $('#simForm').addEventListener('input', (e) => {
    if (e.target && e.target.id) {
      const inp = readInputs();
      const errs = validateInputs(inp);
      renderErrors(errs);
      
      // 如果没有错误，使用防抖重新计算
      if (errs.length === 0) {
        debouncedSimulateAndRender();
      } else {
        persistState(inp);
      }
    }
  });
  $('#resetBtn').addEventListener('click', () => {
    $('#initialCapital').value = '100';
    $('#leverage').value = '10';
    $('#entryPrice').value = '100';
    $('#stepPct').value = '10';
    $('#steps').value = '10';
    $('#takerFee').value = '0.0006';
    $('#fundingPerStep').value = '0';
    $('#mmr').value = '0.004';
    $('#closeAtEnd').checked = true;
    if ($('#toggleLog')) $('#toggleLog').checked = false;
    if ($('#toggleMarkers')) $('#toggleMarkers').checked = false;
    simulateAndRender();
  });

  if ($('#toggleLog')) $('#toggleLog').addEventListener('change', () => {
    if (lastOut) renderChart(lastOut);
    const inp = readInputs();
    persistState(inp);
  });
  if ($('#toggleMarkers')) $('#toggleMarkers').addEventListener('change', () => {
    if (lastOut) renderChart(lastOut);
    const inp = readInputs();
    persistState(inp);
  });

  const shareBtn = $('#shareLink');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    const inp = readInputs();
    persistState(inp);
    try {
      await navigator.clipboard.writeText(window.location.href);
      shareBtn.textContent = '已复制链接';
      setTimeout(() => shareBtn.textContent = '分享链接', 1500);
    } catch {}
  });

  // 图表导出功能
  const exportBtn = $('#exportChart');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (chart) {
      const url = chart.toBase64Image('image/png', 1);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rolling_perp_chart_${new Date().toISOString().slice(0,10)}.png`;
      a.click();
    }
  });

  // 敏感性分析功能
  const sensitivityCheckbox = $('#enableSensitivity');
  const sensitivityParams = document.querySelector('.sensitivity-params');
  const sensitivityChartWrap = document.querySelector('.sensitivity-chart-wrap');
  const sensitivityAnalysis = document.querySelector('.sensitivity-analysis');
  
  if (sensitivityAnalysis) {
    sensitivityAnalysis.style.display = 'block';
  }
  
  if (sensitivityCheckbox) {
    sensitivityCheckbox.addEventListener('change', () => {
      const enabled = sensitivityCheckbox.checked;
      if (sensitivityParams) sensitivityParams.style.display = enabled ? 'block' : 'none';
      if (sensitivityChartWrap) sensitivityChartWrap.style.display = enabled ? 'block' : 'none';
      
      if (enabled) {
        runSensitivityAnalysis();
      }
    });
  }
  
  const sensitivityParam = $('#sensitivityParam');
  if (sensitivityParam) {
    sensitivityParam.addEventListener('change', () => {
      if (sensitivityCheckbox && sensitivityCheckbox.checked) {
        runSensitivityAnalysis();
      }
    });
  }

  // 首次渲染
  const saved = readStateFromUrlOrStorage();
  if (saved) applyStateToUI(saved);
  simulateAndRender();
}

// 敏感性分析
function runSensitivityAnalysis() {
  const baseInput = readInputs();
  const param = $('#sensitivityParam')?.value || 'leverage';
  
  let paramValues = [];
  let paramLabel = '';
  
  if (param === 'leverage') {
    paramValues = [1, 2, 3, 5, 10, 15, 20, 25, 30, 50];
    paramLabel = '杠杆倍数';
  } else if (param === 'stepPct') {
    paramValues = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
    paramLabel = '加仓阈值 (%)';
  }
  
  const results = paramValues.map(value => {
    const testInput = { ...baseInput };
    if (param === 'leverage') {
      testInput.leverage = value;
    } else if (param === 'stepPct') {
      testInput.stepPct = value;
    }
    
    try {
      const out = runSimulation(testInput);
      return {
        param: param === 'stepPct' ? value * 100 : value,
        roi: out.roi * 100,
        finalEquity: out.finalEquity,
        minDistPct: out.minDistPct
      };
    } catch {
      return null;
    }
  }).filter(r => r !== null);
  
  renderSensitivityChart(results, paramLabel);
}

function renderSensitivityChart(results, paramLabel) {
  const ctx = $('#sensitivityChart');
  if (!ctx) return;
  
  const labels = results.map(r => r.param);
  const roiData = results.map(r => r.roi);
  const riskData = results.map(r => r.minDistPct);
  
  if (sensitivityChart) sensitivityChart.destroy();
  
  sensitivityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '收益率 (%)',
          data: roiData,
          borderColor: '#00e676',
          backgroundColor: 'rgba(0,230,118,0.1)',
          tension: 0.2,
          yAxisID: 'y'
        },
        {
          label: '最小强平距离 (%)',
          data: riskData,
          borderColor: '#f39c12',
          backgroundColor: 'rgba(243,156,18,0.1)',
          tension: 0.2,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#e7eefc' } },
        tooltip: {
          backgroundColor: 'rgba(26, 32, 53, 0.95)',
          titleColor: '#e7eefc',
          bodyColor: '#8ea0bf',
          borderColor: 'var(--border)',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          ticks: { color: '#8ea0bf' },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: paramLabel, color: '#8ea0bf' }
        },
        y: {
          type: 'linear',
          position: 'left',
          ticks: { color: '#8ea0bf', callback: (v) => `${v}%` },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: '收益率 (%)', color: '#8ea0bf' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: '#8ea0bf', callback: (v) => `${v}%` },
          grid: { drawOnChartArea: false },
          title: { display: true, text: '强平距离 (%)', color: '#8ea0bf' }
        }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', wireEvents);


