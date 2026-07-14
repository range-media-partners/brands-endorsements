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
let contextByPerson = {}; // { 'category::name': 'short context string' }
let activeTab      = "Film/TV";
let includeContext = false; // when off, talent is added straight to the tray — no context popup
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

// ─── GROUPING STATE ────────────────────────────────────────────
const GROUP_COLORS = [
  '#4A7BB5', '#B5774A', '#8B4AB5', '#4AB589', '#B54A4A',
  '#9AB54A', '#4A9AB5', '#B59A4A', '#B54A8B', '#4AB5B5'
];

let groupingMode  = null;  // 'tiers' | 'categories' | null
let groups        = [];    // [{ id, name, members: [{name, category}] }]
let activeGroupId = null;
let _nextGroupId  = 1;

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
const contextPopup      = document.getElementById('contextPopup');
const contextPopupInput = document.getElementById('contextPopupInput');
const contextPopupAdd   = document.getElementById('contextPopupAdd');
const includeContextInput = document.getElementById('includeContextInput');

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

function contextKey(name, category) {
  return `${category}::${name}`;
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
// Routes writes to the active group's hierarchy when grouping is on.
function syncOrderFromDOM() {
  const ag = (groupingMode && activeGroupId) ? getGroupById(activeGroupId) : null;

  const newCatOrder = [
    ...document.querySelectorAll('.selected-list > .tray-cat-block')
  ].map(el => el.dataset.category);

  if (ag) ag.catOrder = newCatOrder;
  else     categoryOrder = newCatOrder;

  newCatOrder.forEach(cat => {
    const catBody = document.querySelector(
      `.tray-cat-block[data-category="${CSS.escape(cat)}"] > .tray-cat-body`
    );
    if (!catBody) return;

    const newGenders = [
      ...catBody.querySelectorAll(':scope > .tray-gender-block')
    ].map(el => el.dataset.gender);

    if (ag) ag.gendersByCategory[cat] = newGenders;
    else     genderOrderByCategory[cat] = newGenders;

    newGenders.forEach(gender => {
      const groupKey  = `${cat}::${gender}`;
      const genderBody = catBody.querySelector(
        `.tray-gender-block[data-gender="${CSS.escape(gender)}"] > .tray-gender-body`
      );
      if (!genderBody) return;

      const newPeople = [
        ...genderBody.querySelectorAll(':scope > .selected-row')
      ].map(el => el.dataset.name);

      if (ag) ag.peopleByGroup[groupKey] = newPeople;
      else     peopleOrderByGroup[groupKey] = newPeople;
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

// ─── GROUPING HELPERS ──────────────────────────────────────────
function groupColor(idx) { return GROUP_COLORS[idx % GROUP_COLORS.length]; }
function getGroupById(id) { return groups.find(g => g.id === id); }
function getGroupIndex(id) { return groups.findIndex(g => g.id === id); }

function getPersonGroups(name, category) {
  return groups.filter(g => g.members.some(m => m.name === name && m.category === category));
}

function addPersonToGroup(name, category, groupId) {
  const g = getGroupById(groupId);
  if (!g || g.members.some(m => m.name === name && m.category === category)) return;
  g.members.push({ name, category });
  // Mirror into group's own hierarchy state
  const gender = getGender(name, category);
  const gKey   = `${category}::${gender}`;
  if (!g.catOrder.includes(category))                  g.catOrder.push(category);
  if (!g.gendersByCategory[category])                  g.gendersByCategory[category] = [];
  if (!g.gendersByCategory[category].includes(gender)) g.gendersByCategory[category].push(gender);
  if (!g.peopleByGroup[gKey])                          g.peopleByGroup[gKey] = [];
  if (!g.peopleByGroup[gKey].includes(name))           g.peopleByGroup[gKey].push(name);
}

function removePersonFromGroup(name, category, groupId) {
  const g = getGroupById(groupId);
  if (!g) return;
  g.members = g.members.filter(m => !(m.name === name && m.category === category));
  // Mirror removal into group's own hierarchy state
  const gender = getGender(name, category);
  const gKey   = `${category}::${gender}`;
  if (g.peopleByGroup[gKey]) {
    g.peopleByGroup[gKey] = g.peopleByGroup[gKey].filter(n => n !== name);
    if (g.peopleByGroup[gKey].length === 0) {
      delete g.peopleByGroup[gKey];
      g.gendersByCategory[category] = (g.gendersByCategory[category] || []).filter(gen => gen !== gender);
      if (!g.gendersByCategory[category]?.length) {
        delete g.gendersByCategory[category];
        g.catOrder = g.catOrder.filter(c => c !== category);
      }
    }
  }
}

function removePersonFromAllGroups(name, category) {
  groups.forEach(g => removePersonFromGroup(name, category, g.id));
}

// ─── TIER CONFLICT MODAL ───────────────────────────────────────
function showTierConflictModal(existingGroup, targetGroup) {
  const eIdx = getGroupIndex(existingGroup.id) + 1;
  const tIdx = getGroupIndex(targetGroup.id) + 1;
  document.getElementById('tierModalText').textContent =
    `Tiers are mutually exclusive. Remove this talent from Tier ${eIdx} to add them to Tier ${tIdx}.`;
  document.getElementById('tierModalOverlay').classList.add('visible');
}

// ─── CARD GROUP INDICATORS ─────────────────────────────────────
function refreshCardGroupIndicators() {
  document.querySelectorAll('.person-card').forEach(card => {
    const existing = card.querySelector('.card-group-indicators');
    if (existing) existing.remove();
    card.classList.remove('card-in-other-group');
  });

  if (!groupingMode) return;

  document.querySelectorAll('.person-card').forEach(card => {
    const name      = card.dataset.name;
    const category  = card.dataset.category;
    const pGroups   = getPersonGroups(name, category);
    if (pGroups.length === 0) return;

    const inOther = pGroups.some(g => g.id !== activeGroupId);
    if (inOther) card.classList.add('card-in-other-group');

    const indicators = document.createElement('div');
    indicators.className = 'card-group-indicators';
    pGroups.forEach(g => {
      const idx = getGroupIndex(g.id);
      const dot = document.createElement('span');
      dot.className = 'card-group-dot';
      dot.textContent = idx + 1;
      dot.style.color = groupColor(idx);
      indicators.appendChild(dot);
    });
    card.appendChild(indicators);
  });
}

// ─── RENDER GROUPING SECTION ───────────────────────────────────
function renderGroupingSection() {
  const modeArea  = document.getElementById('groupingGroupsArea');
  const groupList = document.getElementById('groupingGroupsList');

  document.getElementById('btnModeTiers').classList.toggle('active', groupingMode === 'tiers');
  document.getElementById('btnModeCategories').classList.toggle('active', groupingMode === 'categories');

  if (!groupingMode) {
    modeArea.style.display = 'none';
    return;
  }

  modeArea.style.display = 'block';
  groupList.innerHTML = '';

  const modeLabel = groupingMode === 'tiers' ? 'Tier' : 'Category';

  groups.forEach((group, idx) => {
    const isActive = group.id === activeGroupId;
    const color    = groupColor(idx);

    const row = document.createElement('div');
    row.className = 'group-row' + (isActive ? ' group-row-active' : '');

    const colorDot = document.createElement('span');
    colorDot.className = 'group-color-dot';
    colorDot.style.background = color;

    const label = document.createElement('span');
    label.className = 'group-label';
    label.textContent = `${modeLabel} ${idx + 1}`;
    label.style.color = color;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-name-input';
    input.placeholder = `Enter ${modeLabel} ${idx + 1} name…`;
    input.value = group.name;
    input.addEventListener('input', e => {
      group.name = e.target.value;
      // Update "+" button in place so typing doesn't lose focus
      const addBtn = groupList.querySelector('.group-add-btn');
      if (addBtn) {
        const allHaveNames = groups.every(g => g.name.trim().length > 0);
        addBtn.disabled = !allHaveNames;
        addBtn.title = allHaveNames ? `Add ${modeLabel}` : `Enter a name for each ${modeLabel.toLowerCase()} first`;
      }
      renderTray(); // Update tab labels in tray
    });

    const activateBtn = document.createElement('button');
    activateBtn.className = 'group-activate-btn' + (isActive ? ' group-activate-btn-active' : '');
    activateBtn.textContent = isActive ? 'Active' : 'Activate';
    activateBtn.style.borderColor = color;
    if (isActive) { activateBtn.style.background = color; activateBtn.style.color = '#fff'; }
    activateBtn.addEventListener('click', () => setActiveGroup(group.id));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'group-remove-btn';
    removeBtn.title = `Remove ${modeLabel} ${idx + 1}`;
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removeGroup(group.id));

    row.appendChild(colorDot);
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(activateBtn);
    row.appendChild(removeBtn);
    groupList.appendChild(row);
  });

  if (groups.length < 10) {
    const allHaveNames = groups.every(g => g.name.trim().length > 0);
    const addBtn = document.createElement('button');
    addBtn.className = 'group-add-btn';
    addBtn.textContent = '+';
    addBtn.disabled = !allHaveNames;
    addBtn.title = allHaveNames ? `Add ${modeLabel}` : `Enter a name for each ${modeLabel.toLowerCase()} first`;
    addBtn.addEventListener('click', () => { if (!addBtn.disabled) addGroup(); });
    groupList.appendChild(addBtn);
  }
}

// ─── FULL RESET ────────────────────────────────────────────────
// Clears all selections, hierarchy, and group state. Does NOT touch groupingMode.
function _fullReset() {
  selectedPeople        = [];
  featuredNames         = [];
  contextByPerson       = {};
  categoryOrder         = [];
  genderOrderByCategory = {};
  peopleOrderByGroup    = {};
  collapsedCategories   = new Set();
  collapsedGenders      = new Set();
  groups                = [];
  activeGroupId         = null;
  _nextGroupId          = 1;
  document.querySelectorAll('.person-card.selected').forEach(c => c.classList.remove('selected'));
}

// ─── SET GROUPING MODE ─────────────────────────────────────────
function setGroupingMode(mode) {
  const togglingOff = groupingMode === mode;

  _fullReset();

  if (togglingOff) {
    groupingMode = null;
  } else {
    groupingMode = mode;
    // Seed the first group directly (no render chain inside)
    const id = 'g' + (_nextGroupId++);
    groups.push(_makeGroup(id));
    activeGroupId = id;
  }

  renderGroupingSection();
  renderTray();
  refreshCardGroupIndicators();
  updateGenerateBtn();
}

// ─── GROUP FACTORY ─────────────────────────────────────────────
function _makeGroup(id) {
  return {
    id,
    name: '',
    members: [],
    catOrder: [],
    gendersByCategory: {},
    peopleByGroup: {},
    collapsedCats: new Set(),
    collapsedGens: new Set()
  };
}

// ─── ACTIVE HIERARCHY ACCESSORS ────────────────────────────────
// Route hierarchy reads to the active group when grouping is on,
// or to the global state when not.
function _activeCatOrder() {
  return groupingMode && activeGroupId ? (getGroupById(activeGroupId)?.catOrder || []) : categoryOrder;
}
function _activeGendersByCategory() {
  return groupingMode && activeGroupId ? (getGroupById(activeGroupId)?.gendersByCategory || {}) : genderOrderByCategory;
}
function _activePeopleByGroup() {
  return groupingMode && activeGroupId ? (getGroupById(activeGroupId)?.peopleByGroup || {}) : peopleOrderByGroup;
}
function _isCatCollapsed(cat) {
  const s = groupingMode && activeGroupId ? getGroupById(activeGroupId)?.collapsedCats : collapsedCategories;
  return s ? s.has(cat) : false;
}
function _isGenCollapsed(key) {
  const s = groupingMode && activeGroupId ? getGroupById(activeGroupId)?.collapsedGens : collapsedGenders;
  return s ? s.has(key) : false;
}
function _toggleCatCollapse(cat) {
  const s = groupingMode && activeGroupId ? getGroupById(activeGroupId)?.collapsedCats : collapsedCategories;
  if (!s) return;
  s.has(cat) ? s.delete(cat) : s.add(cat);
}
function _toggleGenCollapse(key) {
  const s = groupingMode && activeGroupId ? getGroupById(activeGroupId)?.collapsedGens : collapsedGenders;
  if (!s) return;
  s.has(key) ? s.delete(key) : s.add(key);
}

// ─── ADD GROUP ─────────────────────────────────────────────────
function addGroup() {
  if (groups.length >= 10) return;
  const id = 'g' + (_nextGroupId++);
  groups.push(_makeGroup(id));
  if (!activeGroupId) activeGroupId = id;
  renderGroupingSection();
  // No tray re-render needed — empty group doesn't change tray content
}

// ─── REMOVE GROUP ──────────────────────────────────────────────
function removeGroup(id) {
  const idx = getGroupIndex(id);
  if (idx === -1) return;
  groups.splice(idx, 1);
  // If we removed the active group, switch to nearest remaining group
  if (activeGroupId === id) {
    activeGroupId = groups.length > 0 ? groups[Math.min(idx, groups.length - 1)].id : null;
  }
  renderGroupingSection();
  renderTray();
  refreshCardGroupIndicators();
}

// ─── SET ACTIVE GROUP ──────────────────────────────────────────
function setActiveGroup(id) {
  activeGroupId = id;
  renderGroupingSection();
  renderTray();
}

// ─── CONTEXT POPUP ──────────────────────────────────────────────
// Shown when a not-yet-selected name is clicked, so context ("she has kids",
// "he owns a dog") can be captured right there instead of scrolling down.
let _contextPopupTarget = null; // { name, category, card }

function openContextPopup(name, category, card) {
  _contextPopupTarget = { name, category, card };
  contextPopupInput.value = '';
  contextPopup.style.display = 'block';

  const rect = card.getBoundingClientRect();
  const popupWidth = contextPopup.offsetWidth || 260;
  let left = rect.left + window.scrollX;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - popupWidth - 12;
  if (left > maxLeft) left = Math.max(window.scrollX + 12, maxLeft);

  contextPopup.style.top  = `${rect.bottom + window.scrollY + 6}px`;
  contextPopup.style.left = `${left}px`;

  requestAnimationFrame(() => contextPopupInput.focus());
}

function closeContextPopup() {
  contextPopup.style.display = 'none';
  _contextPopupTarget = null;
}

function commitSelection(name, category, card, context) {
  contextByPerson[contextKey(name, category)] = context || '';

  selectedPeople.push({ name, category });
  card.classList.add('selected');
  addToHierarchy(name, category);

  if (groupingMode && activeGroupId) {
    addPersonToGroup(name, category, activeGroupId);
    refreshCardGroupIndicators();
  }

  renderTray();
  updateGenerateBtn();
}

contextPopupAdd.addEventListener('click', () => {
  if (!_contextPopupTarget) return;
  const { name, category, card } = _contextPopupTarget;
  commitSelection(name, category, card, contextPopupInput.value.trim());
  closeContextPopup();
});

contextPopupInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    contextPopupAdd.click();
  } else if (e.key === 'Escape') {
    closeContextPopup();
  }
});

document.addEventListener('mousedown', e => {
  if (contextPopup.style.display === 'block' && !contextPopup.contains(e.target)) {
    closeContextPopup();
  }
});

includeContextInput.addEventListener('change', e => {
  includeContext = e.target.checked;
});

// ─── TOGGLE PERSON ─────────────────────────────────────────────
function togglePerson(name, category, card) {
  if (groupingMode && activeGroupId) {
    const activeGroup   = getGroupById(activeGroupId);
    const pGroups       = getPersonGroups(name, category);
    const inActiveGroup = pGroups.some(g => g.id === activeGroupId);

    if (inActiveGroup) {
      // Remove from active group
      removePersonFromGroup(name, category, activeGroupId);
      // If no longer in any group, also remove from selectedPeople
      if (getPersonGroups(name, category).length === 0) {
        const idx = selectedPeople.findIndex(p => p.name === name && p.category === category);
        if (idx !== -1) {
          selectedPeople.splice(idx, 1);
          featuredNames = featuredNames.filter(f => !(f.name === name && f.category === category));
          removeFromHierarchy(name, category);
          delete contextByPerson[contextKey(name, category)];
        }
        card.classList.remove('selected');
      }
    } else {
      // Tier conflict check
      if (groupingMode === 'tiers' && pGroups.length > 0) {
        showTierConflictModal(pGroups[0], activeGroup);
        return;
      }
      // Not yet selected anywhere — capture context via popup before adding
      if (!selectedPeople.some(p => p.name === name && p.category === category)) {
        if (!includeContext) {
          commitSelection(name, category, card, '');
          return;
        }
        openContextPopup(name, category, card);
        return;
      }
      // Already selected (in another group) — just add to this group
      addPersonToGroup(name, category, activeGroupId);
    }

    refreshCardGroupIndicators();
    renderTray();
    updateGenerateBtn();
    return;
  }

  // No grouping mode — original behavior
  const idx = selectedPeople.findIndex(p => p.name === name && p.category === category);
  if (idx !== -1) {
    selectedPeople.splice(idx, 1);
    featuredNames = featuredNames.filter(f => !(f.name === name && f.category === category));
    card.classList.remove('selected');
    removeFromHierarchy(name, category);
    delete contextByPerson[contextKey(name, category)];
  } else {
    if (!includeContext) {
      commitSelection(name, category, card, '');
      return;
    }
    openContextPopup(name, category, card);
    return;
  }
  renderTray();
  updateGenerateBtn();
}

// ─── CLEAR ALL ─────────────────────────────────────────────────
function clearAll() {
  selectedPeople        = [];
  featuredNames         = [];
  contextByPerson       = {};
  categoryOrder         = [];
  genderOrderByCategory = {};
  peopleOrderByGroup    = {};
  collapsedCategories   = new Set();
  collapsedGenders      = new Set();
  groups.forEach(g => {
    g.members          = [];
    g.catOrder         = [];
    g.gendersByCategory = {};
    g.peopleByGroup    = {};
    g.collapsedCats    = new Set();
    g.collapsedGens    = new Set();
  });
  document.querySelectorAll('.person-card.selected').forEach(card => card.classList.remove('selected'));
  refreshCardGroupIndicators();
  renderTray();
  updateGenerateBtn();
}

clearAllBtn.addEventListener('click', clearAll);

// ─── RENDER TRAY ───────────────────────────────────────────────
function renderTray() {
  tray.querySelectorAll('.tray-group-tabs, .featured-order-section, .selected-list').forEach(el => el.remove());

  // ── Group tabs (always shown at top when grouping is active) ──
  if (groupingMode && groups.length > 0) {
    const modeLabel = groupingMode === 'tiers' ? 'Tier' : 'Category';
    const tabsEl = document.createElement('div');
    tabsEl.className = 'tray-group-tabs';
    groups.forEach((group, idx) => {
      const isActive    = group.id === activeGroupId;
      const color       = groupColor(idx);
      const displayName = group.name.trim() || `${modeLabel} ${idx + 1}`;
      const tab = document.createElement('button');
      tab.className = 'tray-group-tab' + (isActive ? ' tray-group-tab-active' : '');
      tab.style.borderColor = color;
      tab.style.color = isActive ? '#fff' : color;
      if (isActive) tab.style.background = color;
      tab.textContent = displayName;
      tab.addEventListener('click', () => setActiveGroup(group.id));
      tabsEl.appendChild(tab);
    });
    tray.insertBefore(tabsEl, trayEmpty);
  }

  // ── Determine what to show ─────────────────────────────────────
  const activeGroup = groupingMode ? getGroupById(activeGroupId) : null;
  const viewCount   = groupingMode ? (activeGroup?.members.length || 0) : selectedPeople.length;

  if (viewCount === 0) {
    trayEmpty.style.display = '';
    trayEmpty.textContent   = groupingMode ? 'No talent in this group yet' : 'No talent selected yet';
    selectionCount.textContent = '';
    clearAllBtn.style.display  = 'none';
    refreshCardGroupIndicators();
    return;
  }

  trayEmpty.style.display    = 'none';
  selectionCount.textContent = `— ${viewCount} selected`;
  clearAllBtn.style.display  = 'block';

  // ── Featured Order section ─────────────────────────────────────
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

  // ── Three-level hierarchy (routes to active group's state) ───
  const activeCats    = _activeCatOrder();
  const activeGenders = _activeGendersByCategory();
  const activePeople  = _activePeopleByGroup();

  const list = document.createElement('div');
  list.className = 'selected-list';

  activeCats.forEach(cat => {
    const genders      = activeGenders[cat] || [];
    const catTotal     = genders.reduce((sum, g) => sum + (activePeople[`${cat}::${g}`]?.length || 0), 0);
    const catCollapsed = _isCatCollapsed(cat);
    const multiCat     = activeCats.length > 1;

    // ── Category block ────────────────────────────────────────
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
      _toggleCatCollapse(cat);
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
        const people          = activePeople[groupKey] || [];
        const genderCollapsed = _isGenCollapsed(groupKey);
        const multiGender     = genders.length > 1;

        // ── Gender block ────────────────────────────────────
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
          _toggleGenCollapse(groupKey);
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
            const isFeatured  = featuredNames.some(f => f.name === name && f.category === cat);
            const multiPeople = people.length > 1;

            // ── Person row ────────────────────────────────
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
            starBtn.style.visibility = '';
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

            const contextInput = document.createElement('input');
            contextInput.type = 'text';
            contextInput.className = 'selected-row-context';
            contextInput.placeholder = 'Add context…';
            contextInput.value = contextByPerson[contextKey(name, cat)] || '';
            contextInput.addEventListener('mousedown', e => e.stopPropagation());
            contextInput.addEventListener('input', e => {
              contextByPerson[contextKey(name, cat)] = e.target.value;
            });

            const removeBtn = document.createElement('button');
            removeBtn.className = 'selected-row-remove';
            removeBtn.title = 'Remove';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => {
              if (groupingMode) {
                // Remove from active group only; deselect entirely if last group
                removePersonFromGroup(name, cat, activeGroupId);
                if (getPersonGroups(name, cat).length === 0) {
                  removePerson(name, cat);
                } else {
                  refreshCardGroupIndicators();
                  renderTray();
                }
              } else {
                removePerson(name, cat);
              }
            });

            row.appendChild(pHandle);
            row.appendChild(starBtn);
            row.appendChild(nameSpan);
            row.appendChild(contextInput);
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
  refreshCardGroupIndicators();
}

// ─── REMOVE PERSON ─────────────────────────────────────────────
function removePerson(name, category) {
  selectedPeople = selectedPeople.filter(p => !(p.name === name && p.category === category));
  featuredNames  = featuredNames.filter(f => !(f.name === name && f.category === category));
  delete contextByPerson[contextKey(name, category)];
  removeFromHierarchy(name, category);
  removePersonFromAllGroups(name, category);

  const card = document.querySelector(`.person-card[data-name="${CSS.escape(name)}"][data-category="${CSS.escape(category)}"]`);
  if (card) card.classList.remove('selected');

  refreshCardGroupIndicators();
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
    const modeLabel = groupingMode === 'tiers' ? 'Tier' : 'Category';
    // Build ordered members from each group's drag-ordered hierarchy
    function groupOrderedMembers(g) {
      const out = [];
      for (const cat of g.catOrder) {
        for (const gender of (g.gendersByCategory[cat] || [])) {
          for (const name of (g.peopleByGroup[`${cat}::${gender}`] || [])) {
            out.push({ name, category: cat });
          }
        }
      }
      return out;
    }
    // In grouping mode, allSelections is redundant with groups[].members —
    // omitting it keeps the payload small and avoids URL length limits.
    const payload = encodeURIComponent(JSON.stringify({
      title,
      featuredNames,
      allSelections: groupingMode ? [] : getOrderedSelections(),
      groupingMode: groupingMode || null,
      groups: groupingMode ? groups.map((g, idx) => ({
        index: idx,
        name: g.name.trim() || `${modeLabel} ${idx + 1}`,
        members: groupOrderedMembers(g)
      })) : null,
      contextMap: contextByPerson
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

  document.getElementById('btnModeTiers').addEventListener('click', () => setGroupingMode('tiers'));
  document.getElementById('btnModeCategories').addEventListener('click', () => setGroupingMode('categories'));
  document.getElementById('tierModalDismiss').addEventListener('click', () => {
    document.getElementById('tierModalOverlay').classList.remove('visible');
  });
  document.getElementById('tierModalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
  });
}

initGate();
