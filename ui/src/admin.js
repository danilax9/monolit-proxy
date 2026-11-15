// Админка monolit proxy. Строки таблицы обновляются на месте по id, смена вида — гаснет 200 мс, проявляется 360 мс.
// Без сервера (файл, ?demo или нет API) работает на демо-данных — для проверки вёрстки
(() => {
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const NF1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }), NF = new Intl.NumberFormat('ru-RU')
  const DF = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }), DFY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
  const TF = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const GB = 1024 ** 3
  const now = () => Math.floor(Date.now() / 1000)

  // ---------- форматирование ----------
  const bytes = (b) => {
    if (b < 1024 ** 2) return NF.format(Math.round(b / 1024)) + ' КБ'
    if (b < GB) return NF.format(Math.round(b / 1024 ** 2)) + ' МБ'
    return NF1.format(b / GB) + ' ГБ'
  }
  const gbOf = (b) => b ? NF1.format(b / GB).replace(/\s/g, '') : ''
  const date = (t) => { const d = new Date(t * 1000); return (d.getFullYear() === new Date().getFullYear() ? DF : DFY).format(d) }
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c }
  const ago = (t) => {
    if (!t) return 'ещё не был'
    const s = now() - t
    if (s < 120) return 'сейчас'
    if (s < 3600) { const m = Math.floor(s / 60); return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад` }
    const d = new Date(t * 1000), td = new Date()
    if (d.toDateString() === td.toDateString()) return 'сегодня в ' + TF.format(d)
    td.setDate(td.getDate() - 1)
    if (d.toDateString() === td.toDateString()) return 'вчера в ' + TF.format(d)
    return date(t)
  }
  const left = (u) => {
    if (!u.expire) return 'бессрочно'
    const days = Math.ceil((u.expire - now()) / 86400)
    if (days <= 0) return 'закончилась ' + date(u.expire)
    return 'до ' + date(u.expire) + (days <= 7 ? `, ${days} ${plural(days, 'день', 'дня', 'дней')}` : '')
  }
  const ST = { active: ['Активна', 'badge-success'], expired: ['Срок вышел', 'badge-warning'], limit: ['Трафик кончился', 'badge-warning'], devices: ['Много устройств', 'badge-warning'], off: ['Выключена', ''] }
  const badge = (u) => `<span class="badge ${ST[u.state][1]}">${ST[u.state][0]}</span>`
  const group = (u) => u.state === 'active' ? 'active' : u.state === 'off' ? 'off' : 'ended'
  const stateOf = (u, t = now()) => !u.enabled ? 'off' : u.expire && u.expire <= t ? 'expired' : u.limit && u.used >= u.limit ? 'limit' : u.block_until > t ? 'devices' : 'active'
  const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const dayLabel = (d) => { const [, m, dd] = d.split('-').map(Number); return dd + ' ' + MON[m - 1] }
  // онлайн: «сейчас» или «сейчас с 3 IP»; иначе — когда был
  const seen = (u) => u.online?.length ? (u.online.length > 1 ? `сейчас с ${u.online.length} IP` : 'сейчас') : ago(u.last_active)

  // ---------- связь с сервером или демо ----------
  let DEMO = location.protocol === 'file:' || new URLSearchParams(location.search).has('demo')
  let S = null   // состояние: { users, settings, xray, template }

  function demoState() {
    const t = now(), d = 86400, mk = (id, name, note, used, limitGb, expDays, enabled, seen) => {
      const u = { id, name, note, token: 'demo' + id + 'Kx7Qp2Lm9Ts4', used, up: Math.round(used * .1), down: Math.round(used * .9), limit: limitGb * GB, expire: expDays === null ? 0 : t + expDays * d, enabled, last_active: seen === null ? 0 : t - seen, created: t - 40 * d }
      u.period = ''; u.reset_at = 0; u.devices = 0; u.block_until = 0; u.online = []
      u.url = 'https://vpn.example.ru/s/' + u.token; u.state = stateOf(u, t); return u
    }
    const users = [mk(1, 'Маша', 'сестра, iPhone', 2.4 * GB, 50, 24, true, 300), mk(2, 'Игорь Белов', 'работа', 48.7 * GB, 50, 61, true, 4000), mk(3, 'Папа', '', 0.3 * GB, 0, null, true, 90000),
      mk(4, 'Дима', 'Android', 50 * GB, 50, 12, true, 7 * d), mk(5, 'Ксения', 'тестовый месяц', 6.1 * GB, 30, -3, true, 5 * d), mk(6, 'Старый ноутбук', '', 120 * GB, 0, null, false, 30 * d),
      mk(7, 'Аня', '', 0, 20, 5, true, null)]
    Object.assign(users[0], { period: 'month', reset_at: t + 9 * d, devices: 2, online: [{ ip: '95.24.181.7', at: t - 40 }] })
    Object.assign(users[1], { devices: 1, block_until: t + 7 * 60, online: [{ ip: '188.170.84.12', at: t - 20 }, { ip: '31.173.86.201', at: t - 75 }] })
    Object.assign(users[2], { online: [{ ip: '46.138.20.99', at: t - 15 }] })
    users.forEach((u) => { u.state = stateOf(u, t) })
    return {
      users,
      update: { current: '1.1.0', latest: { tag: 'v1.2.0', name: 'v1.2.0', notes: 'Несколько серверов в одной админке. График трафика по часам', published: t - 2 * d, url: '#' }, available: true, checked: t - 3 * 3600, error: '', status: null, repo: 'danilax9/monolit-proxy' },
      settings: { server_name: 'aeza', domain: 'vpn.example.ru', fp: 'firefox', kinds: 'vision,hy2', autoupdate: true, support_url: '', update_hours: 12, login: 'admin' },
      xray: { ok: true, error: '', last_sync: t - 20, inbounds: { vision: { tag: 'vision', port: 443 }, hy2: { tag: 'hy2', port: 443 }, xhttp: null } },
      template: { version: '162', hash: '47ffac58afcb3992', source: 'github', since: t - 3 * d, checked: t - 2 * 3600, rollback: true, pending: null, rejected: null }
    }
  }

  async function demoApi(method, path, body) {
    await new Promise((r) => setTimeout(r, 250))
    const id = Number((/\/users\/(\d+)/.exec(path) || [])[1]), u = S.users.find((x) => x.id === id)
    const fix = (x) => { x.state = stateOf(x); return x }
    if (path === 'api/login') { if (body.password !== 'demo1234' || body.login !== 'admin') throw new Error('Неверный логин или пароль'); return {} }
    if (path === 'api/state') return S
    if (path === 'api/users' && method === 'POST') {
      const nu = { id: Math.max(0, ...S.users.map((x) => x.id)) + 1, name: body.name, note: body.note, token: 'demo' + Date.now().toString(36), used: 0, up: 0, down: 0, limit: body.limit, expire: body.expire, enabled: true, last_active: 0, created: now(), period: body.period, reset_at: body.period ? now() + 30 * 86400 : 0, devices: body.devices, block_until: 0, online: [] }
      nu.url = 'https://' + S.settings.domain + '/s/' + nu.token; S.users.push(fix(nu)); return { user: nu }
    }
    if (u && method === 'PATCH') { if (body.unblock || 'devices' in body) u.block_until = 0; delete body.unblock; Object.assign(u, body); return { user: fix(u) } }
    if (u && path.endsWith('/reset')) { u.used = u.up = u.down = 0; fix(u); return {} }
    if (u && path.endsWith('/regen')) { u.token = 'demo' + Date.now().toString(36); u.url = 'https://' + S.settings.domain + '/s/' + u.token; return { user: u } }
    if (u && method === 'DELETE') { S.users = S.users.filter((x) => x !== u); return {} }
    if (path === 'api/settings') { Object.assign(S.settings, body); delete S.settings.password; return S }
    if (path === 'api/template/check') { S.template.checked = now(); return { ok: true, changed: false, state: S } }
    if (path === 'api/template/rollback') { S.template.rollback = false; return S }
    if (path.startsWith('api/traffic')) {
      const uid = Number(new URLSearchParams(path.split('?')[1]).get('user')) || 0, days = []
      for (let i = 29; i >= 0; i--) {
        const dt = new Date(Date.now() - i * 86400e3), k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
        const v = uid === 7 ? 0 : Math.round((0.6 + Math.sin(i * 1.3 + uid) * 0.4 + (i % 7 === 2 ? 0.8 : 0)) * (uid ? 0.4 : 2.2) * GB)
        days.push({ day: k, up: Math.round(v * 0.1), down: Math.round(v * 0.9) })
      }
      return { tz: 'Europe/Moscow', days }
    }
    if (path === 'api/update/check') { S.update.checked = now(); return S.update }
    if (path === 'api/update' && method === 'POST') { S.update.status = { state: 'running', to: S.update.latest.tag, from: S.update.current, at: now(), text: 'Скачиваю ' + S.update.latest.tag }; return { ok: true } }
    if (path === 'api/update') { const st = S.update.status; if (st?.state === 'running' && now() - st.at > 4) { S.update.status = { ...st, state: 'done', text: 'Обновлено до ' + st.to }; S.update.current = st.to.slice(1); S.update.available = false } return S.update }
    throw new Error('Нет такого действия')
  }

  async function api(method, path, body) {
    if (DEMO) return demoApi(method, path, body)
    const raw = typeof body === 'string'
    const r = await fetch(path, { method, headers: body ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}, body: body ? (raw ? body : JSON.stringify(body)) : undefined, credentials: 'same-origin' })
    let j = {}; try { j = await r.json() } catch (e) {}
    if (r.status === 401 && path !== 'api/login') { showLogin(); throw new Error('Нужно войти') }
    if (!r.ok) throw new Error(j.error || 'Сервер ответил ' + r.status)
    return j
  }
  const fail = (e) => window.toast?.({ type: 'error', title: 'Не получилось', text: e.message })
  const busy = async (btn, fn) => { btn.disabled = true; try { return await fn() } finally { btn.disabled = false } }

  // ---------- вход ----------
  function showLogin() { $('mp-app').hidden = true; $('mp-login').hidden = false }
  $('mp-login-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const inp = e.target.password, lg = e.target.login, btn = e.target.querySelector('button[type=submit]')
    if (!lg.value.trim()) { window.fieldError?.(lg, 'Введите логин'); lg.focus(); return }
    window.fieldError?.(lg, '')
    busy(btn, async () => {
      try { await api('POST', 'api/login', { login: lg.value.trim(), password: inp.value }); inp.value = ''; window.fieldError?.(inp, ''); await load() }
      catch (err) { window.fieldError ? window.fieldError(inp, err.message) : alert(err.message) }
    })
  })
  $('mp-logout').addEventListener('click', async () => { try { await api('POST', 'api/logout') } catch (e) {} showLogin() })

  // ---------- графики трафика ----------
  // Система рисует график один раз из data-атрибутов: при новых данных ставим новый узел, если цифры поменялись
  function drawChart(box, days, title) {
    const vals = days.map((d) => d.up + d.down), max = Math.max(0, ...vals)
    const key = days.map((d) => d.day + ':' + (d.up + d.down)).join(',')
    if (box._key === key) return
    box._key = key
    if (!max) { box.innerHTML = '<p class="mp-note mp-chart-empty">За 30 дней трафика не было</p>'; return }
    const mb = max < GB, k = mb ? 1024 ** 2 : GB
    const el = document.createElement('div')
    el.className = 'chart'; el.dataset.type = 'bar'; el.dataset.h = '160'; el.dataset.unit = mb ? ' МБ' : ' ГБ'; el.setAttribute('aria-label', title)
    el.dataset.values = vals.map((v) => mb ? Math.round(v / k) : Math.round(v / k * 10) / 10).join(',')
    el.dataset.labels = days.map((d) => dayLabel(d.day)).join(',')
    box.replaceChildren(el); window.initData?.(box)
  }
  async function loadTotal() {
    try {
      const r = await api('GET', 'api/traffic?days=30')
      const sum = r.days.reduce((a, d) => a + d.up + d.down, 0)
      $('mp-tr-card').hidden = !S.users.length
      $('mp-tr-sum').textContent = bytes(sum)
      $('mp-tr-tz').textContent = r.tz && r.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? 'Дни по времени сервера, ' + r.tz : ''
      drawChart($('mp-tr-chart'), r.days, 'Трафик по дням')
    } catch (e) {}
  }

  // ---------- таблица ----------
  const tbody = $('mp-rows')
  const view = 'all'   // вкладок нет: по видам делят цифры над списком
  let query = ''
  // Трафик коротко: «2,4/50 ГБ» (израсходовано в единицах лимита), без лимита — просто объём
  const usage = (u) => u.limit ? `${NF1.format(u.used / GB)}<span class="mp-muted">/${gbOf(u.limit)} ГБ</span>` : bytes(u.used)
  const useHtml = (u) => {
    const p = u.limit ? Math.min(1, u.used / u.limit) : 0
    return `<div class="mp-use"><span>${usage(u)}</span>${u.limit ? `<div class="progress" role="progressbar" aria-label="Трафик" aria-valuenow="${Math.round(p * 100)}"><i style="--p:${p.toFixed(3)}"></i></div>` : ''}</div>`
  }
  // Телефон: имя и трафик в первой строке, заметка и срок во второй, полоса во всю ширину.
  // Статус без плашки: у активной срок серым, иначе вместо срока — состояние цветом
  const mobileState = (u) => u.state === 'active' ? `<span class="mp-m-exp">${left(u)}</span>` : `<span class="mp-m-exp is-${u.state}">${u.state === 'expired' ? left(u) : ST[u.state][0]}</span>`
  const mobileHtml = (u) => {
    const p = u.limit ? Math.min(1, u.used / u.limit) : 0
    return `<span class="mp-m">${u.note ? `<span class="mp-m-note">${esc(u.note)}</span>` : '<span></span>'}${mobileState(u)}`
      + `<span class="mp-m-use">${usage(u)}</span>`
      + (u.limit ? `<span class="progress" aria-hidden="true"><i style="--p:${p.toFixed(3)}"></i></span>` : '') + '</span>'
  }
  const rowHtml = (u) => `<th scope="row"><span class="mp-who">${esc(u.name)}</span>${u.note ? `<span class="mp-what">${esc(u.note)}</span>` : ''}${mobileHtml(u)}</th>`
    + `<td class="mp-st-col">${badge(u)}</td><td>${useHtml(u)}</td><td class="mp-exp-col"><span class="${u.state === 'expired' ? 'mp-muted' : ''}">${left(u)}</span></td><td class="mp-seen-col"><span class="${u.online?.length ? '' : 'mp-muted'}">${seen(u)}</span></td>`

  function render() {
    const q = query.toLowerCase()
    const list = S.users.filter((u) => (view === 'all' || group(u) === view) && (!q || (u.name + ' ' + (u.note || '')).toLowerCase().includes(q)))
    const byId = new Map([...tbody.children].map((tr) => [tr.dataset.id, tr]))
    let prev = null
    for (const u of list) {
      let tr = byId.get(String(u.id))
      if (tr) byId.delete(String(u.id))
      else { tr = document.createElement('tr'); tr.dataset.id = u.id; tr.tabIndex = 0 }
      const html = rowHtml(u)
      if (tr._html !== html) { tr.innerHTML = html; tr._html = html }
      const want = prev ? prev.nextSibling : tbody.firstChild
      if (tr !== want) tbody.insertBefore(tr, want)
      prev = tr
    }
    byId.forEach((tr) => tr.remove())
    tbody.closest('.table-wrap').hidden = !list.length
    $('mp-empty').hidden = !!list.length
    if (!list.length) {
      const none = !S.users.length
      $('mp-empty-t').textContent = none ? 'Пока никого' : query ? 'Никого не нашлось' : 'Здесь пусто'
      $('mp-empty-p').textContent = none ? 'Добавьте первого человека, и у него появится своя ссылка на подписку' : query ? 'Проверьте написание имени или заметки' : 'Здесь пока никого'
    }
  }

  function renderHead() {
    const c = { all: S.users.length, active: 0, ended: 0, off: 0 }
    for (const u of S.users) c[group(u)]++
    $('mp-count-all').textContent = c.all
    $('mp-n-active').textContent = c.active
    const on = S.users.filter((u) => u.online?.length).length
    $('mp-n-active-f').textContent = on ? `${on} в сети сейчас` : 'подписка работает'
    $('mp-n-ended').textContent = c.ended
    $('mp-n-ended').closest('.stat').classList.toggle('mp-bad', c.ended > 0)
    $('mp-traffic').textContent = bytes(S.users.reduce((a, u) => a + u.used, 0))
    const tp = S.template
    $('mp-tpl-ver').textContent = tp ? tp.version : 'Нет'
    $('mp-tpl-foot').textContent = !tp ? 'не загружен' : tp.rejected && tp.rejected.fetched_at > tp.since ? 'новая не прошла проверку' : tp.pending ? 'есть новая версия' : 'проверена ' + (new Date(tp.checked * 1000).toDateString() === new Date().toDateString() ? 'в ' + TF.format(new Date(tp.checked * 1000)) : date(tp.checked))
    const ok = S.xray.ok
    const b = $('mp-xray-badge')
    b.className = 'badge ' + (ok ? 'badge-success' : 'badge-danger')
    b.lastChild.textContent = ok ? 'Xray работает' : 'Xray не отвечает'
    $('mp-xray-alert').hidden = ok
    if (!ok && S.xray.error) $('mp-xray-err').textContent = S.xray.error + '. Изменения применятся, когда он снова заработает'
    $('mp-sub').textContent = `Сервер ${S.settings.server_name}, обновлено в ${TF.format(new Date())}`
    $('mp-server-foot').textContent = S.settings.domain || S.settings.server_name
    const lg = S.settings.login || 'admin'; $('mp-acc-login').textContent = lg; $('mp-acc-av').textContent = lg.slice(0, 1).toUpperCase()
  }

  const paint = () => { renderHead(); render(); if (openId) fillDetail(false) }

  const listEl = $('mp-list')
  let t
  const change = () => { listEl.classList.add('out'); clearTimeout(t); t = setTimeout(() => { render(); listEl.classList.remove('out') }, parseFloat(getComputedStyle(listEl).getPropertyValue('--dur-swap-out')) || 200) }   // ждём, пока старое погаснет (токен системы)
  let typing
  $('mp-search').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { const v = $('mp-search').value.trim(); if (v !== query) { query = v; change() } }, 250) })

  // ---------- карточка пользователя ----------
  let openId = null
  const cur = () => S.users.find((u) => u.id === openId)
  const dForm = $('mp-d-form')
  const toDateInput = (t) => { if (!t) return ''; const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const fromDateInput = (v) => { if (!v) return 0; const [y, m, d] = v.split('-').map(Number); return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000) }
  const setCopy = (inp, btn, url) => { inp.value = url; btn.dataset.copy = url }

  function fillDetail(form = true) {
    const u = cur(); if (!u) return
    $('mp-d-title').textContent = u.name
    $('mp-d-state').textContent = ST[u.state][0] + ', ' + left(u)
    setCopy($('mp-d-url'), $('mp-d-copy'), u.url)
    $('mp-d-open').href = u.url
    $('mp-d-used').innerHTML = bytes(u.used) + (u.limit ? ` <small>из ${gbOf(u.limit)} ГБ</small>` : ' <small>без лимита</small>')
    const p = u.limit ? Math.min(1, u.used / u.limit) : 0
    $('mp-d-prog').hidden = !u.limit
    $('mp-d-prog').firstElementChild.style.setProperty('--p', p.toFixed(3))
    $('mp-d-usage-note').textContent = (u.period === 'month' && u.reset_at ? `Лимит на месяц, счётчик обнулится ${date(u.reset_at)}. ` : '') + `Отдано ${bytes(u.down)}, принято ${bytes(u.up)}`
    // устройства: IP, с которых подключён сейчас
    const blocked = u.block_until > now()
    $('mp-d-block').hidden = !blocked
    if (blocked) $('mp-d-block-t').textContent = 'Доступ закрыт до ' + TF.format(new Date(u.block_until * 1000))
    $('mp-d-unblock-row').hidden = !blocked
    $('mp-d-ips').innerHTML = (u.online || []).map((o) => `<div><dt>${esc(o.ip)}</dt><dd>${now() - o.at < 120 ? 'сейчас' : ago(o.at)}</dd></div>`).join('')
    $('mp-d-ips').hidden = !u.online?.length
    $('mp-d-dev-note').textContent = (u.online?.length ? '' : `Сейчас не подключён, в сети ${ago(u.last_active)}. `) + (u.devices ? `Разрешено устройств одновременно: ${u.devices}` : 'Без ограничения по устройствам')
    if (!form) return
    dForm.enabled.checked = u.enabled
    dForm.name.value = u.name
    dForm.note.value = u.note || ''
    dForm.limit.value = gbOf(u.limit)
    dForm.period.value = u.period || ''; dForm.period.dispatchEvent(new Event('change'))
    dForm.devices.value = u.devices || ''
    window.fieldError?.(dForm.devices, '')
    dForm.expire.value = toDateInput(u.expire)
    window.fieldError?.(dForm.limit, '')
  }
  async function loadUserChart(id) {
    const box = $('mp-d-chart'); box._key = ''; box.replaceChildren()
    try { const r = await api('GET', 'api/traffic?days=30&user=' + id); if (openId === id) drawChart(box, r.days, 'Трафик по дням') } catch (e) {}
  }
  function openDetail(id) { openId = Number(id); fillDetail(); $('mp-detail').showModal(); loadUserChart(openId) }
  $('mp-d-unblock').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const u = cur(); if (!u) return
    try { const r = await api('PATCH', 'api/users/' + u.id, { unblock: true }); putUser(r.user); fillDetail(false); toast({ type: 'success', title: 'Доступ открыт', text: u.name }) } catch (err) { fail(err) }
  }))
  $('mp-detail').addEventListener('close', () => { openId = null })
  tbody.addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (tr) openDetail(tr.dataset.id) })
  tbody.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr')) openDetail(e.target.dataset.id) })

  const parseGb = (v) => { const n = parseFloat(String(v).replace(',', '.').replace(/\s/g, '')); return n > 0 ? Math.round(n * GB) : 0 }
  // лимит: пусто или 0 — без лимита; не число — ошибка, а не молчаливое «без лимита»
  const limitOk = (inp) => {
    const v = inp.value.replace(',', '.').replace(/\s/g, '')
    const ok = !v || /^\d+(\.\d+)?$/.test(v)
    window.fieldError?.(inp, ok ? '' : 'Нужно число гигабайт, например 50')
    if (!ok) inp.focus()
    return ok
  }
  const devOk = (inp) => {
    const v = inp.value.trim(), ok = !v || (/^\d{1,2}$/.test(v) && Number(v) <= 50)
    window.fieldError?.(inp, ok ? '' : 'Число от 1 до 50, пусто — без ограничения')
    if (!ok) inp.focus()
    return ok
  }
  const putUser = (u) => { const i = S.users.findIndex((x) => x.id === u.id); if (i >= 0) S.users[i] = u; else S.users.push(u); paint() }

  dForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const u = cur(); if (!u) return
    if (!limitOk(dForm.limit) || !devOk(dForm.devices)) return
    busy(document.querySelector('[form="mp-d-form"]'), async () => {
      try {
        const r = await api('PATCH', 'api/users/' + u.id, { name: dForm.name.value, note: dForm.note.value, limit: parseGb(dForm.limit.value), expire: fromDateInput(dForm.expire.value), enabled: dForm.enabled.checked, period: dForm.period.value, devices: Number(dForm.devices.value) || 0 })
        putUser(r.user); fillDetail(); toast({ type: 'success', title: 'Сохранено', text: ST[r.user.state][0] + ', ' + left(r.user) })
      } catch (err) { fail(err) }
    })
  })
  dForm.querySelectorAll('[data-add-days]').forEach((b) => b.addEventListener('click', () => {
    const base = Math.max(fromDateInput(dForm.expire.value) || 0, now())
    dForm.expire.value = toDateInput(base + Number(b.dataset.addDays) * 86400)
  }))
  $('mp-d-noexp').addEventListener('click', () => { dForm.expire.value = '' })   // бессрочно; применится по «Сохранить»

  // Включение и выключение — сразу, без «Сохранить»: иначе легко закрыть шторку, думая, что подписка уже выключена
  dForm.enabled.addEventListener('change', async () => {
    const u = cur(); if (!u) return
    const on = dForm.enabled.checked
    try { const r = await api('PATCH', 'api/users/' + u.id, { enabled: on }); putUser(r.user); fillDetail(false); toast({ type: 'success', title: on ? 'Подписка включена' : 'Подписка выключена', text: u.name }) }
    catch (err) { dForm.enabled.checked = !on; fail(err) }
  })

  $('mp-d-qrbtn').addEventListener('click', () => { $('mp-d-qr').innerHTML = qrSvg(cur().url); $('mp-qr-dlg').showModal() })

  // Подтверждение для необратимого
  function confirmAct(title, text, okLabel) {
    const d = $('mp-confirm')
    $('mp-c-t').textContent = title; $('mp-c-p').textContent = text; $('mp-c-ok').firstElementChild.textContent = okLabel
    d.showModal()
    return new Promise((res) => {
      const ok = () => { cleanup(); d.close(); res(true) }, no = () => { cleanup(); res(false) }
      const cleanup = () => { $('mp-c-ok').removeEventListener('click', ok); d.removeEventListener('close', no) }
      $('mp-c-ok').addEventListener('click', ok); d.addEventListener('close', no)
    })
  }

  $('mp-d-reset').addEventListener('click', async () => {
    const u = cur(); if (!u) return
    if (!await confirmAct('Обнулить трафик?', `Счётчик «${u.name}» начнётся с нуля, лимит останется прежним. Прошлые цифры не вернуть`, 'Обнулить')) return
    try { await api('POST', `api/users/${u.id}/reset`); u.used = u.up = u.down = 0; u.state = stateOf(u); paint(); toast({ type: 'success', title: 'Трафик обнулён', text: u.name }) } catch (e) { fail(e) }
  })
  $('mp-d-regen').addEventListener('click', async () => {
    const u = cur(); if (!u) return
    if (!await confirmAct('Выдать новую ссылку?', `Старая ссылка для «${u.name}» перестанет работать, в приложение нужно будет добавить новую`, 'Выдать новую')) return
    try { const r = await api('POST', `api/users/${u.id}/regen`); putUser(r.user); fillDetail(false); toast({ type: 'success', title: 'Новая ссылка готова', text: 'Отправьте её заново, старая больше не работает' }) } catch (e) { fail(e) }
  })
  $('mp-d-del').addEventListener('click', async () => {
    const u = cur(); if (!u) return
    if (!await confirmAct(`Удалить «${u.name}»?`, 'Подписка перестанет работать сразу, а счётчики трафика удалятся. Вернуть не получится', 'Удалить')) return
    try { await api('DELETE', 'api/users/' + u.id); S.users = S.users.filter((x) => x.id !== u.id); $('mp-detail').close(); paint(); toast({ title: 'Удалено', text: u.name }) } catch (e) { fail(e) }
  })

  // ---------- добавление ----------
  const aForm = $('mp-add-form')
  aForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = aForm.name.value.trim()
    if (!name) { window.fieldError?.(aForm.name, 'Напишите, кому подписка'); aForm.name.focus(); return }
    window.fieldError?.(aForm.name, '')
    if (!limitOk(aForm.limit) || !devOk(aForm.devices)) return
    busy(aForm.querySelector('button[type=submit]'), async () => {
      try {
        const r = await api('POST', 'api/users', { name, note: aForm.note.value.trim(), limit: parseGb(aForm.limit.value), period: aForm.period.value, devices: Number(aForm.devices.value) || 0, expire: Number(aForm.days.value) ? now() + Number(aForm.days.value) * 86400 : 0 })
        putUser(r.user)
        $('mp-add').close(); aForm.reset(); aForm.days.dispatchEvent(new Event('change')); aForm.period.dispatchEvent(new Event('change'))
        setCopy($('mp-made-url'), $('mp-made-copy'), r.user.url)
        $('mp-made-t').textContent = `Ссылка для «${r.user.name}» готова`
        $('mp-made-p').textContent = 'Отправьте её человеку: по ней откроется страница с инструкцией'
        $('mp-made').showModal()
      } catch (err) { fail(err) }
    })
  })

  // ---------- шаблон ----------
  function fillTpl() {
    const tp = S.template
    const rows = !tp ? [['Версия', 'не загружен']] : [['Версия autoXRAY', tp.version], ['Откуда', tp.source === 'github' ? 'GitHub' : 'встроенная копия'], ['Применён', date(tp.since)], ['Проверен', ago(tp.checked)], ['Отпечаток', tp.hash.slice(0, 12)]]
    if (tp?.pending) rows.push(['Ждёт применения', 'новая версия от ' + date(tp.pending.fetched_at)])
    $('mp-tpl-kv').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')
    const rej = tp?.rejected && tp.rejected.fetched_at >= (tp.since || 0)
    $('mp-tpl-rej').hidden = !rej
    if (rej) $('mp-tpl-rej-t').textContent = 'Оставили рабочую. Ошибка: ' + tp.rejected.error
    $('mp-tpl-auto').checked = !!S.settings.autoupdate
    $('mp-tpl-back').hidden = !tp?.rollback
  }
  document.querySelectorAll('[data-open="mp-tpl"]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); fillTpl() }))
  $('mp-tpl-check').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const r = await api('POST', 'api/template/check'); S = r.state || S; paint(); fillTpl()
      toast(r.ok ? { type: 'success', title: r.changed ? 'Шаблон обновлён' : 'Новой версии нет', text: 'Версия ' + S.template?.version } : { type: 'error', title: 'Шаблон не обновился', text: r.error })
    } catch (err) { fail(err) }
  }))
  $('mp-tpl-back').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try { S = await api('POST', 'api/template/rollback'); paint(); fillTpl(); toast({ type: 'success', title: 'Вернули прошлую версию', text: 'Версия ' + S.template?.version }) } catch (err) { fail(err) }
  }))
  $('mp-tpl-auto').addEventListener('change', async (e) => {
    try { S = await api('PATCH', 'api/settings', { autoupdate: e.target.checked }); paint() } catch (err) { e.target.checked = !e.target.checked; fail(err) }
  })

  // ---------- настройки ----------
  const sForm = $('mp-set-form')
  const KINDS = [['vision', 'Vision', 'VLESS через TCP с TLS'], ['hy2', 'Hysteria2', 'через UDP, быстрее на плохой связи'], ['xhttp', 'XHTTP', 'через HTTP, если TCP режут']]
  function fillSet() {
    const s = S.settings, on = s.kinds.split(','), ib = S.xray.inbounds || {}
    sForm.server_name.value = s.server_name; sForm.domain.value = s.domain; sForm.update_hours.value = s.update_hours; sForm.support_url.value = s.support_url || ''; sForm.password.value = ''; sForm.login.value = s.login || ''
    sForm.fp.value = s.fp; sForm.fp.dispatchEvent(new Event('change'))
    $('mp-kinds').innerHTML = KINDS.map(([k, n, h]) => `<label class="choice"><input type="checkbox" class="check" value="${k}" ${on.includes(k) && ib[k] ? 'checked' : ''} ${ib[k] ? '' : 'disabled'}><span>${n}<small>${ib[k] ? h : 'на этом сервере нет такого входа Xray'}</small></span></label>`).join('')
  }
  document.querySelectorAll('[data-open="mp-set"]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); fillSet(); fillUpd() }))

  // ---------- обновление monolit из релизов GitHub ----------
  let updPoll = 0
  function fillUpd() {
    const u = S.update; if (!u) return
    const st = u.status, running = st?.state === 'running' && now() - st.at < 900
    const rows = [['Установлена', 'v' + u.current], ['Последняя', u.latest ? u.latest.tag + (u.latest.published ? ' от ' + date(u.latest.published) : '') : 'релизов пока нет'], ['Проверено', u.checked ? ago(u.checked) : 'ещё нет']]
    if (u.error) rows.push(['Ошибка проверки', u.error])
    $('mp-up-kv').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')
    const failed = st?.state === 'failed' && now() - st.at < 86400
    $('mp-up-fail').hidden = !failed
    if (failed) $('mp-up-fail-t').textContent = st.text
    $('mp-up-new').hidden = !u.available || running
    if (u.available) { $('mp-up-new-t').textContent = 'Вышла ' + u.latest.tag; $('mp-up-notes').textContent = u.latest.notes || 'Без описания' }
    $('mp-up-run').hidden = !running
    if (running) $('mp-up-run').textContent = st.text + '. Админка перезапустится, страница обновится сама'
    $('mp-up-go').hidden = !u.available || running
    if (u.available) $('mp-up-go').lastElementChild.textContent = 'Обновить до ' + u.latest.tag
    if (running && !updPoll) watchUpd()
  }
  // Во время установки админка перезапускается: ошибки запросов ожидаемы, ждём ответа с итогом
  function watchUpd() {
    const from = S.update.current, t0 = Date.now()
    updPoll = setInterval(async () => {
      let u; try { u = await api('GET', 'api/update') } catch (e) { return }
      S.update = u; fillUpd()
      const st = u.status
      if (st?.state === 'done' || u.current !== from) { clearInterval(updPoll); updPoll = 0; toast({ type: 'success', title: 'monolit обновлён', text: 'Версия ' + u.current }); if (!DEMO) setTimeout(() => location.reload(), 1500) }
      else if (st?.state === 'failed') { clearInterval(updPoll); updPoll = 0; toast({ type: 'error', title: 'Обновление не встало', text: st.text }) }
      else if (Date.now() - t0 > 15 * 60e3) { clearInterval(updPoll); updPoll = 0 }
    }, 3000)
  }
  $('mp-up-check').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try { S.update = await api('POST', 'api/update/check'); fillUpd(); toast(S.update.available ? { type: 'success', title: 'Есть новая версия', text: S.update.latest.tag } : { title: 'Новой версии нет', text: 'Установлена последняя, v' + S.update.current }) } catch (err) { fail(err) }
  }))
  $('mp-up-go').addEventListener('click', async (e) => {
    const u = S.update, btn = e.currentTarget
    if (!await confirmAct(`Обновить до ${u.latest.tag}?`, 'Скачаем релиз с GitHub и переустановим. Админка перезапустится, подключения VPN могут оборваться на пару секунд. Если новая версия не встанет, вернём прежнюю', 'Обновить')) return
    busy(btn, async () => {
      try { await api('POST', 'api/update'); S.update.status = { state: 'running', to: u.latest.tag, from: u.current, at: now(), text: 'Скачиваю ' + u.latest.tag }; fillUpd() } catch (err) { fail(err) }
    })
  })

  // ---------- бэкап и восстановление ----------
  $('mp-bk-get').addEventListener('click', (e) => { if (DEMO) { e.preventDefault(); toast({ title: 'В демо бэкапа нет' }) } })
  $('mp-bk-dz').addEventListener('files-added', async (e) => {
    const f = e.detail.files[0]; if (!f) return
    if (f.size > 64 * 1024 ** 2) { fail(new Error('Файл больше 64 МБ')); return }
    let text, b
    try { text = await f.text(); b = JSON.parse(text); if (b.monolit_backup !== 1) throw new Error() } catch (err) { fail(new Error('Это не файл бэкапа monolit')); return }
    const when = b.created ? date(b.created) + ' в ' + TF.format(new Date(b.created * 1000)) : 'без даты'
    if (!await confirmAct('Восстановить из бэкапа?', `Сервер «${b.server || '?'}», ${when}, пользователей: ${b.users ?? '?'}. Всё, что сейчас в админке, заменится. Текущая база останется на сервере рядом, но вернуть её можно только вручную. После перезапуска войдите с логином и паролем из бэкапа`, 'Восстановить')) return
    try {
      await api('POST', 'api/restore', text)
      toast({ type: 'success', title: 'Восстанавливаем', text: 'Админка перезапускается' })
      if (DEMO) return
      // ждём, пока админка поднимется с новой базой
      const t0 = Date.now(), iv = setInterval(async () => {
        try { const r = await fetch('api/state', { credentials: 'same-origin' }); if (r.status === 401 || r.ok) { clearInterval(iv); location.reload() } } catch (err) {}
        if (Date.now() - t0 > 120e3) clearInterval(iv)
      }, 2000)
    } catch (err) { fail(err) }
  })
  sForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const pw = sForm.password.value
    if (pw && pw.length < 8) { window.fieldError?.(sForm.password, 'Нужно не меньше 8 символов'); return }
    window.fieldError?.(sForm.password, '')
    const login = sForm.login.value.trim(), relogin = pw || login !== S.settings.login
    if (!/^[\p{L}\p{N}_.@-]{3,32}$/u.test(login)) { window.fieldError?.(sForm.login, 'От 3 до 32 букв, цифр и знаков . _ - @'); return }
    window.fieldError?.(sForm.login, '')
    const kinds = [...$('mp-kinds').querySelectorAll('input:checked')].map((i) => i.value)
    if (!kinds.length) { toast({ type: 'error', title: 'Оставьте хотя бы один протокол' }); return }
    busy(document.querySelector('[form="mp-set-form"]'), async () => {
      try {
        S = await api('PATCH', 'api/settings', { server_name: sForm.server_name.value, domain: sForm.domain.value, fp: sForm.fp.value, update_hours: sForm.update_hours.value, support_url: sForm.support_url.value, kinds, login, ...(pw ? { password: pw } : {}) })
        paint(); $('mp-set').close()
        if (relogin) { toast({ type: 'success', title: pw ? 'Пароль сменён' : 'Логин сменён', text: 'Войдите заново' }); showLogin() } else toast({ type: 'success', title: 'Настройки сохранены' })
      } catch (err) { fail(err) }
    })
  })

  // Для разделов сервера (server.js)
  window.mpAdmin = { demo: () => DEMO, api: (m, p, b) => api(m, p, b), confirm: confirmAct, setCopy, domain: () => S?.settings?.domain || location.hostname }

  // ---------- QR в SVG ----------
  function qrSvg(text) {
    const q = qrcode(0, 'M'); q.addData(text); q.make()
    const n = q.getModuleCount(); let d = ''
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`
    return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR-код ссылки"><path d="${d}" fill="#000"/></svg>`
  }

  // ---------- загрузка и обновление раз в минуту ----------
  async function load() {
    try { S = await api('GET', 'api/state') }
    catch (e) {
      if (!DEMO && /404|Failed to fetch|NetworkError|Сервер ответил/.test(e.message) && !/Нужно войти/.test(e.message)) { DEMO = true; S = demoState() }
      else if (/Нужно войти/.test(e.message)) return
      else throw e
    }
    $('mp-login').hidden = true; $('mp-app').hidden = false
    paint(); loadTotal()
  }
  if (DEMO) S = demoState()
  load().catch(fail)
  setInterval(() => { if (!document.hidden && !$('mp-app').hidden && !DEMO) api('GET', 'api/state').then((s) => { S = s; paint(); loadTotal(); if (openId) api('GET', 'api/traffic?days=30&user=' + openId).then((r) => openId && drawChart($('mp-d-chart'), r.days, 'Трафик по дням')).catch(() => {}) }).catch(() => {}) }, 60000)
})()
