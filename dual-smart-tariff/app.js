/* ─── DUAL SMART TARIFF — app.js ─────────────────────────────────────────
   Fetches live Octopus Agile half-hourly prices and optionally controls
   a Shelly smart relay to switch a device on/off based on price threshold.
   ──────────────────────────────────────────────────────────────────────── */

const OCTOPUS_PRODUCTS_URL = 'https://api.octopus.energy/v1/products/?brand=OCTOPUS_ENERGY&is_variable=true&page_size=100';

let allSlots       = [];   // all fetched half-hourly price slots
let autoRefreshTimer = null;

// ─── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  fetchPrices();

  document.getElementById('regionNav').addEventListener('change', () => {
    saveSettings();
    fetchPrices();
  });

  document.getElementById('autoRefresh').addEventListener('change', () => {
    saveSettings();
    scheduleAutoRefresh();
  });

  // Auto-select "Cloud" gen when user pastes a shelly.cloud URL
  document.getElementById('shellyUrl').addEventListener('input', function () {
    if (isCloudUrl(this.value)) {
      document.getElementById('shellyGen').value = 'cloud';
    }
  });
});

// ─── SETTINGS (localStorage) ───────────────────────────────────────────────
function loadSettings() {
  const s = JSON.parse(localStorage.getItem('dst_settings') || '{}');
  if (s.region)       document.getElementById('regionNav').value    = s.region;
  if (s.shellyUrl)    document.getElementById('shellyUrl').value     = s.shellyUrl;
  if (s.shellyGen)    document.getElementById('shellyGen').value     = s.shellyGen;
  if (s.shellyChannel)document.getElementById('shellyChannel').value = s.shellyChannel;
  if (s.threshold !== undefined) document.getElementById('threshold').value = s.threshold;
  if (s.autoRefresh !== undefined) document.getElementById('autoRefresh').checked = s.autoRefresh;
}

function saveSettings() {
  localStorage.setItem('dst_settings', JSON.stringify({
    region:        document.getElementById('regionNav').value,
    shellyUrl:     document.getElementById('shellyUrl').value,
    shellyGen:     document.getElementById('shellyGen').value,
    shellyChannel: document.getElementById('shellyChannel').value,
    threshold:     document.getElementById('threshold').value,
    autoRefresh:   document.getElementById('autoRefresh').checked,
  }));
}

// ─── FETCH PRICES ──────────────────────────────────────────────────────────
async function fetchPrices() {
  setLiveDot('loading');
  setHeroMeta('Fetching live Octopus Agile prices…');

  const region = document.getElementById('regionNav').value;

  try {
    // 1. Find current Agile product
    const productCode = await getAgileProductCode();

    // 2. Build tariff URL for this region
    const tariffCode = `E-1R-${productCode}-${region}`;
    const now = new Date();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 2); // fetch today + tomorrow

    const url = `https://api.octopus.energy/v1/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/` +
                `?period_from=${from.toISOString()}&period_to=${to.toISOString()}&page_size=100`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    const data = await resp.json();

    if (!data.results || data.results.length === 0) {
      throw new Error('No price data returned — check your region or try again shortly.');
    }

    // Sort ascending by valid_from
    allSlots = data.results
      .map(r => ({
        from:  new Date(r.valid_from),
        to:    new Date(r.valid_to),
        price: r.value_inc_vat, // pence/kWh inc. VAT
      }))
      .sort((a, b) => a.from - b.from);

    renderHeroPrices();
    renderChart();
    setLiveDot('ok');
    setHeroMeta(`Last updated ${formatTime(new Date())} · Product: ${productCode} · Region ${region}`);
    scheduleAutoRefresh();

  } catch (err) {
    setLiveDot('error');
    setHeroMeta(`Error: ${err.message}`);
    document.getElementById('chartLoading').textContent = `Failed to load prices: ${err.message}`;
    console.error('[DST]', err);
  }
}

async function getAgileProductCode() {
  const resp = await fetch(OCTOPUS_PRODUCTS_URL);
  if (!resp.ok) throw new Error(`Products API error ${resp.status}`);
  const data = await resp.json();

  // Find available Agile products, prefer the most recent one
  const agile = (data.results || [])
    .filter(p => p.code && p.code.toUpperCase().includes('AGILE') && p.is_available)
    .sort((a, b) => new Date(b.available_from || 0) - new Date(a.available_from || 0));

  if (agile.length === 0) throw new Error('No available Octopus Agile product found.');
  return agile[0].code;
}

// ─── RENDER HERO PRICE CARDS ───────────────────────────────────────────────
function renderHeroPrices() {
  const now = new Date();
  const currentSlot = allSlots.find(s => now >= s.from && now < s.to);
  const upcoming = allSlots.filter(s => s.from > now).slice(0, 4);

  // Current price
  const nowCard = document.getElementById('priceNowCard');
  const priceNowEl = document.getElementById('priceNow');
  const badgeEl = document.getElementById('priceBadge');

  if (currentSlot) {
    const p = currentSlot.price;
    priceNowEl.textContent = p.toFixed(1);
    const tier = priceTier(p);
    nowCard.className = `price-big-card ${tier}-card`;
    badgeEl.textContent = tierLabel(p);
    badgeEl.className   = `pbig-badge ${tier}`;
  } else {
    priceNowEl.textContent = '—';
    badgeEl.textContent = 'No data';
  }

  // Upcoming slots
  const nextWrap = document.getElementById('priceNextCards');
  nextWrap.innerHTML = upcoming.map(s => `
    <div class="price-next-card">
      <div class="pnext-time">${formatTime(s.from)}</div>
      <div class="pnext-val ${priceTier(s.price)}">${s.price.toFixed(1)}p</div>
    </div>
  `).join('');
}

// ─── RENDER CHART ──────────────────────────────────────────────────────────
function renderChart() {
  const loading = document.getElementById('chartLoading');
  const barsEl  = document.getElementById('chartBars');
  loading.style.display = 'none';
  barsEl.innerHTML = '';

  if (allSlots.length === 0) { loading.style.display = ''; loading.textContent = 'No data.'; return; }

  const maxPrice = Math.max(...allSlots.map(s => s.price), 1);
  const now = new Date();
  const MAX_HEIGHT = 100;

  allSlots.forEach(slot => {
    const height = Math.max(4, (slot.price / maxPrice) * MAX_HEIGHT);
    const tier   = priceTier(slot.price);
    const isNow  = now >= slot.from && now < slot.to;
    const tip    = `${formatTime(slot.from)} — ${slot.price.toFixed(2)}p/kWh`;

    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';

    const bar = document.createElement('div');
    bar.className  = `chart-bar ${tier}${isNow ? ' now' : ''}`;
    bar.style.height = `${height}px`;
    bar.setAttribute('data-tip', tip);
    bar.title = tip;

    const lbl = document.createElement('div');
    lbl.className   = `chart-time${isNow ? ' now' : ''}`;
    lbl.textContent = formatTime(slot.from, true);

    wrap.appendChild(bar);
    wrap.appendChild(lbl);
    barsEl.appendChild(wrap);

    // Scroll current slot into view after render
    if (isNow) setTimeout(() => bar.scrollIntoView({ inline: 'center', behavior: 'smooth' }), 100);
  });
}

// ─── AUTO REFRESH ──────────────────────────────────────────────────────────
function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  if (!document.getElementById('autoRefresh').checked) return;

  // Refresh every 30 minutes, aligned to the half-hour
  const now = new Date();
  const msToNextHalf = (30 - (now.getMinutes() % 30)) * 60000 - now.getSeconds() * 1000;
  setTimeout(() => {
    fetchPrices();
    autoRefreshTimer = setInterval(fetchPrices, 30 * 60 * 1000);
  }, msToNextHalf);

  const nextEl = document.getElementById('nextCheck');
  if (nextEl) {
    const next = new Date(Date.now() + msToNextHalf);
    nextEl.textContent = formatTime(next);
  }
}

// ─── UPDATE TARIFF (main Shelly action) ────────────────────────────────────
async function updateTariff() {
  saveSettings();
  setStatus('Fetching current price…', '');

  // Refresh prices first if we have no data
  if (allSlots.length === 0) await fetchPrices();

  const now = new Date();
  const currentSlot = allSlots.find(s => now >= s.from && now < s.to);
  if (!currentSlot) {
    setStatus('Could not determine current price slot. Try refreshing.', 'warn');
    return;
  }

  const price     = currentSlot.price;
  const threshold = parseFloat(document.getElementById('threshold').value) || 15;
  const shouldBeOn = price <= threshold;

  document.getElementById('triggerPrice').textContent  = `${price.toFixed(2)}p/kWh`;
  document.getElementById('thresholdDisplay').textContent = `${threshold}p/kWh`;

  setStatus(`Price: ${price.toFixed(2)}p/kWh · Threshold: ${threshold}p · ${shouldBeOn ? 'Switching ON ⚡' : 'Switching OFF'}`, '');

  if (shouldBeOn) {
    await shellyOn(price);
  } else {
    await shellyOff(price);
  }
}

// ─── CLOUD URL HELPERS ─────────────────────────────────────────────────────
function isCloudUrl(url) {
  return url.includes('shelly.cloud');
}

/**
 * Parse a Shelly Cloud URL of the form:
 * https://shelly-239-eu.shelly.cloud/v2/users/{user}/{payload}.{sig}
 * Returns { server, token, deviceId }
 */
function parseCloudUrl(url) {
  const u    = new URL(url);
  const server = u.origin;                              // https://shelly-239-eu.shelly.cloud
  const parts  = u.pathname.split('/').filter(Boolean); // ['v2','users','username','token']
  const token  = parts[parts.length - 1];               // full token string

  let deviceId = null;
  try {
    // Token is {base64_payload}.{signature} — decode payload to get device id
    const payloadB64 = token.split('.')[0];
    // atob needs standard base64 (add padding)
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    deviceId = payload.id;
  } catch (e) {
    console.warn('[Shelly Cloud] Could not decode device ID from token:', e.message);
  }

  return { server, token, deviceId };
}

// ─── SHELLY CONTROL ────────────────────────────────────────────────────────
async function shellyOn(triggerPrice) {
  await shellySwitch(true, triggerPrice);
}

async function shellyOff(triggerPrice) {
  await shellySwitch(false, triggerPrice);
}

async function shellySwitch(on, triggerPrice) {
  const rawUrl  = document.getElementById('shellyUrl').value.trim().replace(/\/$/, '');
  if (!rawUrl) { setStatus('Enter your Shelly URL first.', 'warn'); return; }

  const gen     = document.getElementById('shellyGen').value;
  const channel = document.getElementById('shellyChannel').value;
  const action  = on ? 'on' : 'off';
  const priceStr = triggerPrice !== undefined ? triggerPrice.toFixed(2) + 'p/kWh' : '—';

  try {
    if (gen === 'cloud' || isCloudUrl(rawUrl)) {
      await shellyCloudSwitch(rawUrl, on, channel, action, priceStr);
    } else if (gen === '1') {
      // Gen 1 local: GET /relay/{ch}?turn=on|off
      await fetch(`${rawUrl}/relay/${channel}?turn=${action}`, { mode: 'no-cors' });
      setDeviceState(on);
      setStatus(`✅ Shelly turned ${action.toUpperCase()} · ${priceStr}`, 'ok');
      updateLastAction(on);
    } else {
      // Gen 2+ local: GET /rpc/Switch.Set?id={ch}&on=true|false
      await fetch(`${rawUrl}/rpc/Switch.Set?id=${channel}&on=${on}`, { mode: 'no-cors' });
      setDeviceState(on);
      setStatus(`✅ Shelly turned ${action.toUpperCase()} · ${priceStr}`, 'ok');
      updateLastAction(on);
    }
  } catch (err) {
    setStatus(`Failed: ${err.message}`, 'error');
    console.error('[Shelly]', err);
  }
}

async function shellyCloudSwitch(rawUrl, on, channel, action, priceStr) {
  const { server, token, deviceId } = parseCloudUrl(rawUrl);

  if (!deviceId) {
    setStatus('⚠️ Could not decode device ID from cloud URL. Check the URL is correct.', 'error');
    return;
  }

  // Shelly Cloud REST API — relay control
  const body = new URLSearchParams({
    id:       deviceId,
    channel:  channel,
    turn:     action,
    auth_key: token,
  });

  const resp = await fetch(`${server}/device/relay/control`, {
    method:  'POST',
    mode:    'cors',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (resp.ok) {
    const data = await resp.json();
    if (data.isok || data.data) {
      setDeviceState(on);
      setStatus(`✅ Cloud: Shelly turned ${action.toUpperCase()} · ${priceStr}`, 'ok');
      updateLastAction(on);
    } else {
      setStatus(`⚠️ Cloud responded but reported an error: ${JSON.stringify(data)}`, 'warn');
    }
  } else {
    const txt = await resp.text().catch(() => '');
    setStatus(`Cloud API error ${resp.status}: ${txt || resp.statusText}`, 'error');
  }
}

async function testShelly() {
  const rawUrl = document.getElementById('shellyUrl').value.trim().replace(/\/$/, '');
  if (!rawUrl) { setStatus('Enter your Shelly URL first.', 'warn'); return; }

  const gen = document.getElementById('shellyGen').value;
  setStatus('Testing connection…', '');

  try {
    if (gen === 'cloud' || isCloudUrl(rawUrl)) {
      const { server, token, deviceId } = parseCloudUrl(rawUrl);
      if (!deviceId) { setStatus('⚠️ Could not decode device ID from URL.', 'warn'); return; }

      const body = new URLSearchParams({ id: deviceId, auth_key: token });
      const resp = await fetch(`${server}/device/status`, {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (resp.ok) {
        const data = await resp.json();
        const model = data.data?.device_status?.model
          || data.data?.model || 'Shelly Cloud Device';
        setStatus(`✅ Cloud connected · ${model} · Device ID: ${deviceId}`, 'ok');
      } else {
        setStatus(`Cloud API ${resp.status} — check your URL is current.`, 'warn');
      }
    } else {
      const statusUrl = gen === '1'
        ? `${rawUrl}/shelly`
        : `${rawUrl}/rpc/Shelly.GetDeviceInfo`;
      const resp = await fetch(statusUrl, { mode: 'cors' });
      if (resp.ok) {
        const data = await resp.json();
        setStatus(`✅ Connected — ${data.model || data.type || data.app || 'Unknown'}`, 'ok');
      } else {
        setStatus(`Device HTTP ${resp.status}`, 'warn');
      }
    }
  } catch (err) {
    setStatus(`⚠️ Request blocked (CORS/mixed-content). Device may still respond to commands — try "Update Tariff Now".`, 'warn');
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function priceTier(p) {
  if (p <= 10) return 'cheap';
  if (p <= 20) return 'mid';
  return 'exp';
}

function tierLabel(p) {
  if (p < 0)   return '🎉 Negative — free energy!';
  if (p <= 5)  return '⚡ Very cheap — run everything!';
  if (p <= 10) return '✅ Cheap — good time to heat up';
  if (p <= 15) return '🟡 Moderate';
  if (p <= 25) return '🔶 Standard rate';
  return '🔴 Expensive — avoid heavy loads';
}

function formatTime(date, short = false) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  if (short) return `${h}:${m}`;
  return `${h}:${m}`;
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = `status${type ? ' ' + type : ''}`;
}

function setDeviceState(on) {
  const dot   = document.getElementById('deviceDot');
  const state = document.getElementById('deviceState');
  if (!dot) return;
  dot.className   = `device-dot ${on ? 'on' : 'off'}`;
  state.textContent = on ? 'ON' : 'OFF';
}

function updateLastAction(on) {
  const el = document.getElementById('lastAction');
  if (el) el.textContent = `${on ? 'ON' : 'OFF'} at ${formatTime(new Date())}`;
}

function setLiveDot(state) {
  const el = document.getElementById('liveDot');
  el.className = `live-dot ${state === 'ok' ? '' : state}`;
}

function setHeroMeta(msg) {
  document.getElementById('heroMeta').textContent = msg;
}
