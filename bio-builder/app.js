// ─── PASSWORD GATE ─────────────────────────────────────────────
const PASSWORD_HASH = '763f90da109f3c87d7db257083b856cfd18b317981e91222cf220a1c3933e1c1';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function submitGate() {
  const input = document.getElementById('gateInput');
  const error = document.getElementById('gateError');
  const hash  = await sha256(input.value);

  if (hash === PASSWORD_HASH) {
    sessionStorage.setItem('rmp_auth', '1');
    const gate = document.getElementById('gate');
    gate.classList.add('gate-out');
    gate.addEventListener('animationend', () => gate.remove());
    initApp();
  } else {
    input.value = '';
    error.classList.add('visible');
    input.classList.add('gate-shake');
    input.addEventListener('animationend', () => input.classList.remove('gate-shake'), { once: true });
    input.focus();
  }
}

function initGate() {
  if (sessionStorage.getItem('rmp_auth') === '1') {
    document.getElementById('gate').remove();
    initApp();
    return;
  }
  document.getElementById('gateSubmit').addEventListener('click', submitGate);
  document.getElementById('gateInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitGate();
    document.getElementById('gateError').classList.remove('visible');
  });
  document.getElementById('gateInput').focus();
}

// ─── CONFIGURATION ─────────────────────────────────────────────
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxtWLCPcmi64VwBP7dEHn677SOzbWezr8HI6Ekm4RFXnMzXaBpIttxdMajeYFYwXf97/exec";
const TABS = ["Film/TV", "Musician", "Digital", "Sports", "Culinary"];

// ─── STATE ─────────────────────────────────────────────────────
let roster         = {};
let selectedPeople = [];  // flat [{ name, category }] — used only for selection tracking & count
let featuredNames  = [];  // [{ name, category }] in featured priority order
let activeTab      = "Film/TV";
let isGenerating   = false;
let generateTimer  = null;
let generateSeconds = 0;

// ─── HIERARCHY STATE ───────────────────────────────────────────
// Three-level structure: categories → genders → people
// Order within each level is user-controllable via drag.
let categoryOrder         = [];  // ['Film/TV', 'Sports', ...]
let genderOrderByCategory = {};  // { 'Film/TV': ['M', 'F'], ... }
let peopleOrderByGroup    = {};  // { 'Film/TV::M': ['Alice', 'Bob'], ... }
let collapsedCategories   = new Set();
let collapsedGenders      = new Set();  // keyed as 'category::gender'

// ─── DRAG STATE ────────────────────────────────────────────────
let _handleActive  = false;  // true only while a drag-handle is held
let _dragSrc       = null;
let _dragContainer = null;

document.addEventListener('mouseup', () => { _handleActive = false; });

// ─── DOM REFS ──────────────────────────────────────────────────
const rosterPanels   = document.getElementById('rosterPanels');
const rosterLoading  = document.getElementById('rosterLoading');
const rosterFilter   = document.getElementById('rosterFilter');
const tray           = document.getElementById('tray');
const trayEmpty      = document.getElementById('trayEmpty');
const selectionCount = document.getElementById('selectionCount');
const clearAllBtn    = document.getElementById('clearAllBtn');
const generateBtn    = document.getElementById('generateBtn');
const generateMeta   = document.getElementById('generateMeta');
const docTitleInput  = document.getElementById('docTitle');
const resultEl       = document.getElementById('result');
const resultTitle    = document.getElementById('resultTitle');
const resultLink     = document.getElementById('resultLink');
const errorEl        = document.getElementById('error');
const footerCount    = document.getElementById('footerCount');

// ─── JSONP HELPER ──────────────────────────────────────────────
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = 'cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    script.src = `${url}&callback=${callbackName}`;

    window[callbackName] = (data) => {
      resolve(data);
      delete window[callbackName];
      script.remove();
    };

    script.onerror = () => {
      reject(new Error('Network error — could not reach Apps Script.'));
      delete window[callbackName];
      script.remove();
    };

    document.head.appendChild(script);
  });
}

// ─── FETCH ROSTER ──────────────────────────────────────────────
async function fetchRoster() {
  try {
    const data = await jsonp(`${APPS_SCRIPT_URL}?action=getRoster`);
    if (!data.success) throw new Error(data.error || "Failed to load roster.");
    roster = data.roster;
    renderRoster();
    updateFooterCount();
  } catch (err) {
    rosterLoading.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'roster-error';
    const msg = document.createElement('div');
    msg.className = 'roster-error-msg';
    msg.textContent = `Roster failed to load: ${err.message}`;
    const retryBtn = document.createElement('button');
    retryBtn.className = 'roster-retry';
    retryBtn.textContent = 'Try again';
    retryBtn.addEventListener('click', () => {
      rosterLoading.innerHTML = '';
      const pulse = document.createElement('div');
      pulse.className = 'dot-pulse';
      pulse.innerHTML = '<span></span><span></span><span></span>';
      rosterLoading.appendChild(pulse);
      rosterLoading.appendChild(document.createTextNode('Loading roster from Google Sheets...'));
      rosterFilter.disabled = false;
      generateMeta.textContent = 'Select talent and enter a title to continue';
      fetchRoster();
    });
    wrap.appendChild(msg);
    wrap.appendChild(retryBtn);
    rosterLoading.appendChild(wrap);
    rosterFilter.disabled = true;
    generateMeta.textContent = 'Roster unavailable — generation disabled';
  }
}

// ─── RENDER ROSTER ─────────────────────────────────────────────
function renderRoster() {
  rosterLoading.remove();

  TABS.forEach((tab, i) => {
    const people = roster[tab] || [];
    const countEl = document.getElementById(`count-${tab}`);
    if (countEl) countEl.textContent = people.length ? `(${people.length})` : '';

    const panel = document.createElement('div');
    panel.className = `people-panel${i === 0 ? ' active' : ''}`;
    panel.id = `panel-${tab}`;

    if (people.length === 0) {
      panel.innerHTML = `<div style="font-size:11px;color:var(--ink-muted);padding:20px 0;letter-spacing:0.05em;">No talent in this category yet.</div>`;
    } else {
      const GENDER_ORDER  = ['M', 'F', 'NB'];
      const GENDER_LABELS = { M: 'Men:', F: 'Women:', NB: 'Non-Binary:' };

      const byGender = { M: [], F: [], NB: [] };
      people.forEach(p => {
        const g = (p.gender || '').toUpperCase();
        if (byGender[g] !== undefined) byGender[g].push(p);
      });

      const nonEmptyGenders = GENDER_ORDER.filter(g => byGender[g].length > 0);

      nonEmptyGenders.forEach((gender, idx) => {
        const section = document.createElement('div');
        section.className = 'gender-section';
        section.dataset.gender = gender;

        const label = document.createElement('div');
        label.className = 'gender-label';
        label.textContent = GENDER_LABELS[gender];
        section.appendChild(label);

        const grid = document.createElement('div');
        grid.className = 'people-grid';

        byGender[gender].forEach(({ name, exclusivity, exclusivitySummary }) => {
          const card = document.createElement('div');
          card.className = 'person-card';
          card.dataset.name = name;
          card.dataset.category = tab;

          const nameEl = document.createElement('div');
          nameEl.className = 'person-name';

          const hasExclusivity = exclusivity || exclusivitySummary;
          if (hasExclusivity) {
            nameEl.textContent = name;
            const asterisk = document.createElement('span');
            asterisk.className = 'exclusivity-asterisk';
            asterisk.textContent = '*';
            nameEl.appendChild(asterisk);

            const tooltip = document.createElement('div');
            tooltip.className = 'exclusivity-tooltip';
            if (exclusivitySummary) {
              const h = document.createElement('div');
              h.className = 'tooltip-heading';
              h.textContent = 'Exclusivity Summary';
              const p = document.createElement('div');
              p.className = 'tooltip-body';
              p.textContent = exclusivitySummary;
              tooltip.appendChild(h);
              tooltip.appendChild(p);
            }
            if (exclusivity) {
              const h = document.createElement('div');
              h.className = 'tooltip-heading';
              h.textContent = 'Exclusivity';
              const p = document.createElement('div');
              p.className = 'tooltip-body';
              p.textContent = exclusivity;
              tooltip.appendChild(h);
              tooltip.appendChild(p);
            }
            card.appendChild(tooltip);
          } else {
            nameEl.textContent = name;
          }

          const catEl = document.createElement('div');
          catEl.className = 'person-category';
          catEl.textContent = tab;
          card.appendChild(nameEl);
          card.appendChild(catEl);
          card.addEventListener('click', () => togglePerson(name, tab, card));
          grid.appendChild(card);
        });

        section.appendChild(grid);
        panel.appendChild(section);

        if (idx < nonEmptyGenders.length - 1) {
          const divider = document.createElement('div');
          divider.className = 'gender-divider';
          panel.appendChild(divider);
        }
      });
    }

    rosterPanels.appendChild(panel);
  });
}

// ─── FILTER ROSTER ─────────────────────────────────────────────
function filterRoster() {
  const query = rosterFilter.value.trim().toLowerCase();
  const activePanel = document.getElementById(`panel-${activeTab}`);
  if (!activePanel) return;

  const cards = activePanel.querySelectorAll('.person-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const matches = card.dataset.name.toLowerCase().includes(query);
    card.style.display = matches ? '' : 'none';
    if (matches) visibleCount++;
  });

  // Hide gender sections whose cards are all filtered out; adjust dividers accordingly
  activePanel.querySelectorAll('.gender-section').forEach(section => {
    const anyVisible = [...section.querySelectorAll('.person-card')].some(c => c.style.display !== 'none');
    section.style.display = anyVisible ? '' : 'none';
  });
  activePanel.querySelectorAll('.gender-divider').forEach(div => {
    const prev = div.previousElementSibling;
    const next = div.nextElementSibling;
    div.style.display = (prev?.style.display !== 'none' && next?.style.display !== 'none') ? '' : 'none';
  });

  let noResults = activePanel.querySelector('.filter-empty');
  if (visibleCount === 0 && query.length > 0) {
    if (!noResults) {
      noResults = document.createElement('div');
      noResults.className = 'filter-empty';
      activePanel.appendChild(noResults);
    }
    noResults.textContent = `No results for "${rosterFilter.value.trim()}"`;
    noResults.style.display = '';
  } else if (noResults) {
    noResults.style.display = 'none';
  }
}

rosterFilter.addEventListener('input', filterRoster);

// ─── TAB SWITCHING ─────────────────────────────────────────────
document.getElementById('categoryTabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;

  const tab = btn.dataset.tab;
  activeTab = tab;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('.people-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`panel-${tab}`);
  if (panel) panel.classList.add('active');

  rosterFilter.value = '';
  filterRoster();
});

// ─── HIERARCHY HELPERS ──────────────────────────────────────────
function getGender(name, category) {
  return (roster[category] || []).find(p => p.name === name)?.gender || '';
}

function addToHierarchy(name, category) {
  const gender   = getGender(name, category);
  const groupKey = `${category}::${gender}`;

  if (!categoryOrder.includes(category))                  categoryOrder.push(category);
  if (!genderOrderByCategory[category])                   genderOrderByCategory[category] = [];
  if (!genderOrderByCategory[category].includes(gender))  genderOrderByCategory[category].push(gender);
  if (!peopleOrderByGroup[groupKey])                      peopleOrderByGroup[groupKey] = [];
  if (!peopleOrderByGroup[groupKey].includes(name))       peopleOrderByGroup[groupKey].push(name);
}

function removeFromHierarchy(name, category) {
  const gender   = getGender(name, category);
  const groupKey = `${category}::${gender}`;

  if (!peopleOrderByGroup[groupKey]) return;

  peopleOrderByGroup[groupKey] = peopleOrderByGroup[groupKey].filter(n => n !== name);

  if (peopleOrderByGroup[groupKey].length === 0) {
    delete peopleOrderByGroup[groupKey];
    genderOrderByCategory[category] = (genderOrderByCategory[category] || []).filter(g => g !== gender);

    if (genderOrderByCategory[category].length === 0) {
      delete genderOrderByCategory[category];
      categoryOrder = categoryOrder.filter(c => c !== category);
    }
  }
}

// Returns ordered flat array for backend (respects all three drag levels)
function getOrderedSelections() {
  const result = [];
  for (const cat of categoryOrder) {
    for (const gender of (genderOrderByCategory[cat] || [])) {
      for (const name of (peopleOrderByGroup[`${cat}::${gender}`] || [])) {
        result.push({ name, category: cat });
      }
    }
  }
  return result;
}

// Reads category / gender / person order back from the live DOM after a drop.
// Only updates state for levels that are expanded (body present in DOM).
// Collapsed levels are untouched so their data survives the re-order.
function syncOrderFromDOM() {
  // Category order is always readable — the cat-blocks themselves are never hidden
  categoryOrder = [
    ...document.querySelectorAll('.selected-list > .tray-cat-block')
  ].map(el => el.dataset.category);

  categoryOrder.forEach(cat => {
    // catBody is absent when the category is collapsed — skip if so
    const catBody = document.querySelector(
      `.tray-cat-block[data-category="${CSS.escape(cat)}"] > .tray-cat-body`
    );
    if (!catBody) return;

    genderOrderByCategory[cat] = [
      ...catBody.querySelectorAll(':scope > .tray-gender-block')
    ].map(el => el.dataset.gender);

    (genderOrderByCategory[cat] || []).forEach(gender => {
      const groupKey = `${cat}::${gender}`;
      // genderBody is absent when the gender group is collapsed — skip if so
      const genderBody = catBody.querySelector(
        `.tray-gender-block[data-gender="${CSS.escape(gender)}"] > .tray-gender-body`
      );
      if (!genderBody) return;

      peopleOrderByGroup[groupKey] = [
        ...genderBody.querySelectorAll(':scope > .selected-row')
      ].map(el => el.dataset.name);
    });
  });
}

// ─── DRAG INIT ─────────────────────────────────────────────────
// Generic: attaches drag-and-drop to el, constrained within container.
// Drag only starts when _handleActive is true (set by handle mousedown).
function initDrag(el, container) {
  el.addEventListener('dragstart', e => {
    if (!_handleActive) { e.preventDefault(); e.stopPropagation(); return; }
    e.stopPropagation();
    _dragSrc       = el;
    _dragContainer = container;
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => el.classList.add('dragging'));
  });

  el.addEventListener('dragover', e => {
    if (_dragContainer !== container || _dragSrc === el) return;
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.tray-drag-over').forEach(x => x.classList.remove('tray-drag-over'));
    el.classList.add('tray-drag-over');
  });

  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('tray-drag-over');
  });

  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('tray-drag-over');
    if (!_dragSrc || _dragSrc === el || _dragContainer !== container) return;
    e.stopPropagation();
    const siblings = [...container.children];
    const srcIdx   = siblings.indexOf(_dragSrc);
    const tgtIdx   = siblings.indexOf(el);
    if (srcIdx < tgtIdx) container.insertBefore(_dragSrc, el.nextSibling);
    else                 container.insertBefore(_dragSrc, el);
    syncOrderFromDOM();
  });

  el.addEventListener('dragend', e => {
    e.stopPropagation();
    _handleActive = false;
    el.classList.remove('dragging');
    document.querySelectorAll('.tray-drag-over').forEach(x => x.classList.remove('tray-drag-over'));
    _dragSrc       = null;
    _dragContainer = null;
  });
}

// ─── TOGGLE PERSON ─────────────────────────────────────────────
function togglePerson(name, category, card) {
  const idx = selectedPeople.findIndex(p => p.name === name && p.category === category);
  if (idx !== -1) {
    selectedPeople.splice(idx, 1);
    featuredNames = featuredNames.filter(f => !(f.name === name && f.category === category));
    card.classList.remove('selected');
    removeFromHierarchy(name, category);
  } else {
    selectedPeople.push({ name, category });
    card.classList.add('selected');
    addToHierarchy(name, category);
  }
  renderTray();
  updateGenerateBtn();
}

// ─── CLEAR ALL ─────────────────────────────────────────────────
function clearAll() {
  selectedPeople        = [];
  featuredNames         = [];
  categoryOrder         = [];
  genderOrderByCategory = {};
  peopleOrderByGroup    = {};
  collapsedCategories   = new Set();
  collapsedGenders      = new Set();
  document.querySelectorAll('.person-card.selected').forEach(card => card.classList.remove('selected'));
  renderTray();
  updateGenerateBtn();
}

clearAllBtn.addEventListener('click', clearAll);

// ─── RENDER TRAY ───────────────────────────────────────────────
function renderTray() {
  tray.querySelectorAll('.featured-order-section, .selected-list').forEach(el => el.remove());

  const total = selectedPeople.length;

  if (total === 0) {
    trayEmpty.style.display = '';
    selectionCount.textContent = '';
    clearAllBtn.style.display = 'none';
    return;
  }

  trayEmpty.style.display = 'none';
  selectionCount.textContent = `— ${total} selected`;
  clearAllBtn.style.display = 'block';

  // ── Featured Order section ────────────────────────────────────
  if (featuredNames.length > 0) {
    const featSection = document.createElement('div');
    featSection.className = 'featured-order-section';

    const featLabel = document.createElement('div');
    featLabel.className = 'featured-order-label';
    featLabel.textContent = 'Featured Order';
    featSection.appendChild(featLabel);

    featuredNames.forEach((feat, i) => {
      const row = document.createElement('div');
      row.className = 'featured-order-row';

      const num = document.createElement('span');
      num.className = 'featured-order-num';
      num.textContent = `${i + 1}.`;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'featured-order-name';
      nameSpan.textContent = feat.name;

      const catSpan = document.createElement('span');
      catSpan.className = 'featured-order-cat';
      catSpan.textContent = feat.category;

      const btnWrap = document.createElement('div');
      btnWrap.className = 'featured-order-btns';

      if (i > 0) {
        const upBtn = document.createElement('button');
        upBtn.textContent = '↑';
        upBtn.title = 'Move up';
        upBtn.addEventListener('click', () => {
          [featuredNames[i - 1], featuredNames[i]] = [featuredNames[i], featuredNames[i - 1]];
          renderTray();
        });
        btnWrap.appendChild(upBtn);
      }

      if (i < featuredNames.length - 1) {
        const downBtn = document.createElement('button');
        downBtn.textContent = '↓';
        downBtn.title = 'Move down';
        downBtn.addEventListener('click', () => {
          [featuredNames[i], featuredNames[i + 1]] = [featuredNames[i + 1], featuredNames[i]];
          renderTray();
        });
        btnWrap.appendChild(downBtn);
      }

      row.appendChild(num);
      row.appendChild(nameSpan);
      row.appendChild(catSpan);
      row.appendChild(btnWrap);
      featSection.appendChild(row);
    });

    tray.appendChild(featSection);
  }

  // ── Three-level hierarchy ───────────────────────────────────
  const list = document.createElement('div');
  list.className = 'selected-list';

  categoryOrder.forEach(cat => {
    const genders      = genderOrderByCategory[cat] || [];
    const catTotal     = genders.reduce((sum, g) => sum + (peopleOrderByGroup[`${cat}::${g}`]?.length || 0), 0);
    const catCollapsed = collapsedCategories.has(cat);
    const multiCat     = categoryOrder.length > 1;

    // ── Category block ──────────────────────────────────────
    const catBlock = document.createElement('div');
    catBlock.className = 'tray-cat-block';
    catBlock.dataset.category = cat;
    catBlock.draggable = multiCat;

    const catRow = document.createElement('div');
    catRow.className = 'tray-cat-row';

    const catHandle = document.createElement('span');
    catHandle.className = 'drag-handle drag-handle-light' + (multiCat ? '' : ' drag-handle-hidden');
    catHandle.textContent = '⠿';
    catHandle.addEventListener('mousedown', () => { _handleActive = true; });

    const catToggle = document.createElement('button');
    catToggle.className = 'collapse-toggle collapse-toggle-light';
    catToggle.textContent = catCollapsed ? '▶' : '▼';
    catToggle.addEventListener('click', e => {
      e.stopPropagation();
      collapsedCategories.has(cat) ? collapsedCategories.delete(cat) : collapsedCategories.add(cat);
      renderTray();
    });

    const catName = document.createElement('span');
    catName.className = 'tray-cat-name';
    catName.textContent = cat;

    const catCount = document.createElement('span');
    catCount.className = 'tray-level-count tray-level-count-light';
    catCount.textContent = `(${catTotal})`;

    catRow.appendChild(catHandle);
    catRow.appendChild(catToggle);
    catRow.appendChild(catName);
    catRow.appendChild(catCount);
    catBlock.appendChild(catRow);

    if (!catCollapsed) {
      const catBody = document.createElement('div');
      catBody.className = 'tray-cat-body';

      genders.forEach(gender => {
        const groupKey        = `${cat}::${gender}`;
        const people          = peopleOrderByGroup[groupKey] || [];
        const genderCollapsed = collapsedGenders.has(groupKey);
        const multiGender     = genders.length > 1;

        // ── Gender block ──────────────────────────────────
        const genderBlock = document.createElement('div');
        genderBlock.className = 'tray-gender-block';
        genderBlock.dataset.gender = gender;
        genderBlock.draggable = multiGender;

        const genderRow = document.createElement('div');
        genderRow.className = 'tray-gender-row';

        const gHandle = document.createElement('span');
        gHandle.className = 'drag-handle' + (multiGender ? '' : ' drag-handle-hidden');
        gHandle.textContent = '⠿';
        gHandle.addEventListener('mousedown', () => { _handleActive = true; });

        const gToggle = document.createElement('button');
        gToggle.className = 'collapse-toggle';
        gToggle.textContent = genderCollapsed ? '▶' : '▼';
        gToggle.addEventListener('click', e => {
          e.stopPropagation();
          collapsedGenders.has(groupKey) ? collapsedGenders.delete(groupKey) : collapsedGenders.add(groupKey);
          renderTray();
        });

        const gLabel = document.createElement('span');
        gLabel.className = 'tray-gender-label';
        gLabel.textContent = gender || 'Unknown';

        const gCount = document.createElement('span');
        gCount.className = 'tray-level-count';
        gCount.textContent = `(${people.length})`;

        genderRow.appendChild(gHandle);
        genderRow.appendChild(gToggle);
        genderRow.appendChild(gLabel);
        genderRow.appendChild(gCount);
        genderBlock.appendChild(genderRow);

        if (!genderCollapsed) {
          const genderBody = document.createElement('div');
          genderBody.className = 'tray-gender-body';

          people.forEach(name => {
            const isFeatured = featuredNames.some(f => f.name === name && f.category === cat);
            const multiPeople = people.length > 1;

            // ── Person row ──────────────────────────────
            const row = document.createElement('div');
            row.className = 'selected-row' + (isFeatured ? ' is-featured' : '');
            row.dataset.name     = name;
            row.dataset.category = cat;
            row.draggable = multiPeople;

            const pHandle = document.createElement('span');
            pHandle.className = 'drag-handle' + (multiPeople ? '' : ' drag-handle-hidden');
            pHandle.textContent = '⠿';
            pHandle.addEventListener('mousedown', () => { _handleActive = true; });

            const starBtn = document.createElement('button');
            starBtn.className = 'featured-star-btn';
            starBtn.title = isFeatured ? 'Remove from Featured' : 'Mark as Featured';
            starBtn.textContent = isFeatured ? '★' : '☆';
            starBtn.addEventListener('click', () => {
              if (isFeatured) {
                featuredNames = featuredNames.filter(f => !(f.name === name && f.category === cat));
              } else {
                featuredNames.push({ name, category: cat });
              }
              renderTray();
            });

            const nameSpan = document.createElement('span');
            nameSpan.className = 'selected-row-name';
            nameSpan.textContent = name;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'selected-row-remove';
            removeBtn.title = 'Remove';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => removePerson(name, cat));

            row.appendChild(pHandle);
            row.appendChild(starBtn);
            row.appendChild(nameSpan);
            row.appendChild(removeBtn);

            if (multiPeople) initDrag(row, genderBody);
            genderBody.appendChild(row);
          });

          genderBlock.appendChild(genderBody);
        }

        if (multiGender) initDrag(genderBlock, catBody);
        catBody.appendChild(genderBlock);
      });

      catBlock.appendChild(catBody);
    }

    if (multiCat) initDrag(catBlock, list);
    list.appendChild(catBlock);
  });

  tray.appendChild(list);
}

// ─── REMOVE PERSON ─────────────────────────────────────────────
function removePerson(name, category) {
  selectedPeople = selectedPeople.filter(p => !(p.name === name && p.category === category));
  featuredNames  = featuredNames.filter(f => !(f.name === name && f.category === category));
  removeFromHierarchy(name, category);

  const card = document.querySelector(`.person-card[data-name="${CSS.escape(name)}"][data-category="${CSS.escape(category)}"]`);
  if (card) card.classList.remove('selected');

  renderTray();
  updateGenerateBtn();
}

// ─── UPDATE GENERATE BUTTON ────────────────────────────────────
function updateGenerateBtn() {
  const hasTitle      = docTitleInput.value.trim().length > 0;
  const totalSelected = selectedPeople.length;
  const hasSelections = totalSelected > 0;

  generateBtn.disabled = !(hasTitle && hasSelections);

  if (!hasTitle && !hasSelections) {
    generateMeta.textContent = 'Select talent and enter a title to continue';
  } else if (!hasTitle) {
    generateMeta.textContent = 'Enter a document title to continue';
  } else if (!hasSelections) {
    generateMeta.textContent = 'Select at least one person to continue';
  } else {
    generateMeta.textContent = `Ready — ${totalSelected} ${totalSelected === 1 ? 'person' : 'people'} selected`;
  }
}

docTitleInput.addEventListener('input', updateGenerateBtn);

// ─── GENERATE DOCUMENT ─────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
  if (isGenerating) return;
  const title = docTitleInput.value.trim();
  if (!title || selectedPeople.length === 0) return;

  isGenerating = true;

  resultEl.style.display = 'none';
  errorEl.style.display  = 'none';
  generateBtn.disabled   = true;
  generateBtn.querySelector('span').textContent = 'Generating…';
  generateSeconds = 0;
  generateMeta.textContent = 'Building your document… 0:00';
  generateTimer = setInterval(() => {
    generateSeconds++;
    const m = Math.floor(generateSeconds / 60);
    const s = generateSeconds % 60;
    generateMeta.textContent = `Building your document… ${m}:${String(s).padStart(2, '0')}`;
  }, 1000);

  try {
    const payload = encodeURIComponent(JSON.stringify({
      title,
      featuredNames,
      allSelections: getOrderedSelections()
    }));
    const data = await jsonp(`${APPS_SCRIPT_URL}?action=generateDocument&payload=${payload}`);

    if (!data.success) throw new Error(data.error || 'Document generation failed.');

    resultTitle.textContent = data.docTitle;
    resultLink.href         = data.docUrl;
    resultEl.style.display  = 'block';
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    generateMeta.textContent = 'Document created successfully.';

  } catch (err) {
    errorEl.textContent    = `Something went wrong: ${err.message}`;
    errorEl.style.display  = 'block';
    generateMeta.textContent = 'An error occurred. Please try again.';
  } finally {
    clearInterval(generateTimer);
    generateTimer  = null;
    isGenerating   = false;
    generateBtn.disabled = false;
    generateBtn.querySelector('span').textContent = 'Generate Document';
    updateGenerateBtn();
  }
});

// ─── FOOTER COUNT ──────────────────────────────────────────────
function updateFooterCount() {
  const total = Object.values(roster).reduce((sum, arr) => sum + arr.length, 0);
  footerCount.textContent = `${total} talent on roster`;
}

// ─── INIT ──────────────────────────────────────────────────────
function initApp() {
  fetchRoster();
}

initGate();
