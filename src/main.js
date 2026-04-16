const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

// ── 狀態 ──
const GROUPS = ['proxy', 'forward'];
const GROUP_LABELS = { proxy: '集運', forward: '轉寄' };

const state = {
  labels: null, // { count: {proxy:N,forward:N}, items: {proxy:[...],forward:[...]} }
  loaders: {
    proxy:   { loaded: 0, running: false, gen: 0 },
    forward: { loaded: 0, running: false, gen: 0 },
  },
};

// ── DOM 快取 ──
const $ = (sel) => document.querySelector(sel);
const el = {};

// ── 工具 ──
const sep = (n) => n.toLocaleString();

const STORAGE_KEY = 'label-loader-settings';
function saveSettings() {
  const data = {
    apiBase: el.apiBase.value,
    token: el.apiToken.value,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
function loadSettings() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!data) return;
    el.apiBase.value = data.apiBase || '';
    el.apiToken.value = data.token || '';
  } catch {}
}

// ── 進度環 ──
function setRing(circleEl, percent) {
  const r = parseFloat(circleEl.getAttribute('r'));
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - percent / 100);
  circleEl.style.strokeDashoffset = offset;
}

function getItems(group) {
  return state.labels?.items?.[group] || [];
}

function getLoaded(key) {
  const loader = state.loaders[key];
  return (loader.cachedCount || 0) + loader.loaded;
}

function updateProgress() {
  const proxyItems = getItems('proxy');
  const forwardItems = getItems('forward');
  const total = proxyItems.length + forwardItems.length;
  const loadedProxy = getLoaded('proxy');
  const loadedForward = getLoaded('forward');
  const totalLoaded = loadedProxy + loadedForward;

  // 總進度
  const totalPct = total > 0 ? Math.floor((totalLoaded / total) * 100) : 0;
  el.totalPercent.textContent = totalPct;
  el.totalLoaded.textContent = sep(totalLoaded);
  el.totalCount.textContent = sep(total);
  setRing(el.totalRing, totalPct);

  // 集運單
  const pctProxy = proxyItems.length > 0 ? Math.floor((loadedProxy / proxyItems.length) * 100) : 0;
  el.percentProxy.textContent = pctProxy;
  el.loadedProxy.textContent = sep(loadedProxy);
  el.countProxy.textContent = sep(proxyItems.length);
  setRing(el.ringProxy, pctProxy);

  // 轉寄單
  const pctForward = forwardItems.length > 0 ? Math.floor((loadedForward / forwardItems.length) * 100) : 0;
  el.percentForward.textContent = pctForward;
  el.loadedForward.textContent = sep(loadedForward);
  el.countForward.textContent = sep(forwardItems.length);
  setRing(el.ringForward, pctForward);

  updateButtons();
}

function updateButtons() {
  for (const key of GROUPS) {
    const btn = el[`btn_${key}`];
    const items = getItems(key);
    const loader = state.loaders[key];

    const done = getLoaded(key) >= items.length;
    if (items.length === 0 || done) {
      btn.disabled = true;
      btn.textContent = items.length === 0 ? '無資料' : '完成';
      btn.className = 'btn-secondary';
    } else if (loader.running) {
      btn.disabled = false;
      btn.textContent = '停止';
      btn.className = 'btn-danger';
    } else {
      btn.disabled = false;
      btn.textContent = loader.loaded > 0 || (loader.cachedCount || 0) > 0 ? '繼續' : '執行';
      btn.className = key === 'proxy' ? 'btn-primary' : 'btn-info';
    }
  }
}

// ── 日誌 ──
function addLog(msg, type = '') {
  const div = document.createElement('div');
  div.className = 'log-item' + (type ? ` ${type}` : '');
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  div.textContent = `[${time}] ${msg}`;
  el.logList.appendChild(div);
  el.logList.scrollTop = el.logList.scrollHeight;
}

// ── 下載 ──
async function downloadSequentially(key, gen) {
  const loader = state.loaders[key];
  const label = GROUP_LABELS[key];
  const allItems = getItems(key);
  const totalCount = allItems.length;

  // 首次啟動時，過濾已快取的檔案
  if (!loader.uncached) {
    addLog(`${label} 正在檢查本地快取...`);
    loader.uncached = await invoke('filter_uncached', { paths: allItems });
    loader.cachedCount = totalCount - loader.uncached.length;
    loader.loaded = 0;
    addLog(`${label} 已快取 ${sep(loader.cachedCount)} 張，需下載 ${sep(loader.uncached.length)} 張`);
    updateProgress();
  }

  const uncached = loader.uncached;

  while (loader.running && loader.gen === gen && loader.loaded < uncached.length) {
    const path = uncached[loader.loaded];
    const fileName = path.split('/').pop() || 'unknown';
    const displayIdx = loader.cachedCount + loader.loaded + 1;
    try {
      const result = await invoke('download_image', { path });
      loader.loaded++;
      if (result.success) {
        addLog(`${label} [${displayIdx}/${totalCount}] ${fileName}`, 'ok');
      } else {
        addLog(`${label} [${displayIdx}/${totalCount}] ${fileName} 下載失敗`, 'fail');
      }
    } catch (err) {
      loader.loaded++;
      addLog(`${label} [${displayIdx}/${totalCount}] ${fileName} 錯誤: ${err}`, 'fail');
    }
    updateProgress();
  }

  if (loader.gen !== gen) return;
  loader.running = false;
  updateButtons();

  if (loader.loaded >= uncached.length) {
    addLog(`${label}單全部完成 (${totalCount} 張)`);
  }
}

function toggleLoader(key) {
  const loader = state.loaders[key];
  if (loader.running) {
    loader.running = false;
    loader.gen++;
    updateButtons();
  } else {
    loader.gen++;
    loader.running = true;
    updateButtons();
    downloadSequentially(key, loader.gen);
  }
}

// ── 連線（Personal Access Token）──
async function handleLogin(e) {
  e.preventDefault();
  el.loginError.hidden = true;
  el.loginBtn.disabled = true;
  el.loginBtn.textContent = '連線中...';

  try {
    await invoke('connect', {
      apiBase: el.apiBase.value.trim(),
      token: el.apiToken.value.trim(),
    });

    saveSettings();
    showMain();
  } catch (err) {
    el.loginError.textContent = String(err);
    el.loginError.hidden = false;
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = '連線';
  }
}

// ── 取得清單 ──
async function fetchLabels() {
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = '載入中...';
  addLog('正在取得面單清單...');

  try {
    state.labels = await invoke('fetch_labels');
    state.loaders.proxy = { loaded: 0, running: false, gen: state.loaders.proxy.gen + 1, uncached: null, cachedCount: 0 };
    state.loaders.forward = { loaded: 0, running: false, gen: state.loaders.forward.gen + 1, uncached: null, cachedCount: 0 };
    updateProgress();

    const proxyLen = getItems('proxy').length;
    const forwardLen = getItems('forward').length;
    addLog(`取得 ${proxyLen + forwardLen} 張面單（集運 ${proxyLen}，轉寄 ${forwardLen}）`);
  } catch (err) {
    addLog(`取得清單失敗: ${err}`, 'fail');
  } finally {
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = '重新整理';
  }
}

// ── 儲存位置 ──
async function displayCacheDir() {
  const dir = await invoke('get_cache_dir');
  el.savePath.textContent = dir;
  el.savePath.title = dir;
}

async function chooseDir() {
  const selected = await openDialog({ directory: true, title: '選擇面單儲存位置' });
  if (selected) {
    await invoke('set_cache_dir', { dir: selected });
    el.savePath.textContent = selected;
    el.savePath.title = selected;
    addLog(`儲存位置已變更為: ${selected}`);
  }
}

// ── 畫面切換 ──
function showMain() {
  $('#login-view').hidden = true;
  $('#main-view').hidden = false;
  displayCacheDir();
  fetchLabels();
}

function logout() {
  state.loaders.proxy.running = false;
  state.loaders.forward.running = false;
  state.labels = null;

  $('#main-view').hidden = true;
  $('#login-view').hidden = false;
}

// ── 初始化 ──
window.addEventListener('DOMContentLoaded', () => {
  el.apiBase = $('#api-base');
  el.apiToken = $('#api-token');
  el.loginBtn = $('#login-btn');
  el.loginError = $('#login-error');
  el.refreshBtn = $('#refresh-btn');
  el.logList = $('#log-list');
  el.totalRing = $('#total-ring');
  el.totalPercent = $('#total-percent');
  el.totalLoaded = $('#total-loaded');
  el.totalCount = $('#total-count');
  el.ringProxy = $('#ring-proxy');
  el.percentProxy = $('#percent-proxy');
  el.loadedProxy = $('#loaded-proxy');
  el.countProxy = $('#count-proxy');
  el['btn_proxy'] = $('#btn-proxy');
  el.ringForward = $('#ring-forward');
  el.percentForward = $('#percent-forward');
  el.loadedForward = $('#loaded-forward');
  el.countForward = $('#count-forward');
  el['btn_forward'] = $('#btn-forward');

  el.savePath = $('#save-path');
  el.chooseDirBtn = $('#choose-dir-btn');

  loadSettings();

  $('#login-form').addEventListener('submit', handleLogin);
  $('#logout-btn').addEventListener('click', logout);
  el.refreshBtn.addEventListener('click', fetchLabels);
  el['btn_proxy'].addEventListener('mousedown', (e) => { e.preventDefault(); toggleLoader('proxy'); });
  el['btn_forward'].addEventListener('mousedown', (e) => { e.preventDefault(); toggleLoader('forward'); });
  $('#clear-log').addEventListener('click', () => { el.logList.innerHTML = ''; });
  el.chooseDirBtn.addEventListener('click', chooseDir);
});
