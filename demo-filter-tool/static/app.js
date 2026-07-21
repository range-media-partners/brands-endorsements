(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let allData    = [];
  let categories = {};   // { Category: [Criteria, ...] }
  let filters    = [];   // [{ id, cat, crit, dir, val }]  (live from DOM)
  let sortCol    = 'total_followers';
  let sortAsc    = false;
  let filterIdSeq = 0;
  let columns = [];
  let colKeyToIndex = {};
  // minor precision updates. Adding this line to force push.

  // ── Load data from the API (once, on page load) ─────────────────────────
  document.addEventListener('DOMContentLoaded', loadData);

  async function loadData() {
    try {
      const res = await fetch('/api/data');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      columns = payload.columns;
      allData = payload.data;
      buildColumnIndex(columns);
      discoverCategories(columns);
      indexRecords(allData);
      render();
    } catch (err) {
      document.getElementById('results-count').textContent =
        'Failed to load data: ' + err.message;
    }
  }

  function discoverCategories(cols) {
    categories = {};
    cols.forEach(c => {
      if (!categories[c.category]) categories[c.category] = [];
      categories[c.category].push(c.criteria);
    });
  }

  function buildColumnIndex(cols) {
    colKeyToIndex = {};
    cols.forEach((c, i) => { colKeyToIndex[c.category + '__' + c.criteria] = i; });
  }

  function indexRecords(data) {
    data.forEach(r => {
      const byCol = {};
      for (let i = 0; i < r.idx.length; i++) {
        byCol[r.idx[i]] = { percent: r.percent[i], index: r.index[i] };
      }
      r._byCol = byCol;
    });
  }

  // ── Filter Rows ───────────────────────────────────────────────────────
  document.getElementById('add-filter-btn').addEventListener('click', addFilterRow);

  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    document.getElementById('filter-rows').innerHTML = '';
    render();
  });

  // ── Range Clients toggle ─────────────────────────────────────────────
  document.getElementById('range-clients-checkbox').addEventListener('change', render);

// ── Total Followers filter ────────────────────────────────────────────
  document.getElementById('followers-min').addEventListener('input', triggerRefilter);
  document.getElementById('followers-max').addEventListener('input', triggerRefilter);

  function addFilterRow() {
    const id = ++filterIdSeq;
    const container = document.getElementById('filter-rows');

    const row = document.createElement('div');
    row.className = 'filter-row';
    row.dataset.id = id;

    const catSel = document.createElement('select');
    catSel.className = 'cat-select';
    catSel.innerHTML = '<option value="">Category…</option>';
    Object.keys(categories).sort().forEach(cat => {
      const o = document.createElement('option');
      o.value = cat; o.textContent = cat;
      catSel.appendChild(o);
    });

    const critSel = document.createElement('select');
    critSel.className = 'crit-select';
    critSel.innerHTML = '<option value="">Criteria…</option>';
    critSel.disabled = true;

    const dirBtn = document.createElement('button');
    dirBtn.className = 'btn-dir';
    dirBtn.textContent = '>';
    dirBtn.title = 'Toggle direction';
    dirBtn.type = 'button';
    dirBtn.addEventListener('click', () => {
      dirBtn.textContent = dirBtn.textContent === '>' ? '<' : '>';
      triggerRefilter();
    });

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.step = 'any';
    numInput.placeholder = 'Threshold';

    const remBtn = document.createElement('button');
    remBtn.className = 'btn-remove';
    remBtn.textContent = '×';
    remBtn.title = 'Remove filter';
    remBtn.type = 'button';
    remBtn.addEventListener('click', () => {
      row.remove();
      triggerRefilter();
    });

    catSel.addEventListener('change', () => {
      const cat = catSel.value;
      critSel.innerHTML = '<option value="">Criteria…</option>';
      if (cat && categories[cat]) {
        categories[cat].forEach(crit => {
          const o = document.createElement('option');
          o.value = crit; o.textContent = crit;
          critSel.appendChild(o);
        });
        critSel.disabled = false;
      } else {
        critSel.disabled = true;
      }
      triggerRefilter();
    });

    critSel.addEventListener('change', triggerRefilter);
    numInput.addEventListener('input', triggerRefilter);

    row.append(catSel, critSel, dirBtn, numInput, remBtn);
    container.appendChild(row);
  }

  function collectFilters() {
    const rows = document.querySelectorAll('.filter-row');
    const active = [];
    rows.forEach(row => {
      const cat  = row.querySelector('.cat-select').value;
      const crit = row.querySelector('.crit-select').value;
      const dir  = row.querySelector('.btn-dir').textContent.trim();
      const raw  = row.querySelector('input[type="number"]').value;
      const val  = parseFloat(raw);
      if (cat && crit && dir && raw !== '' && isFinite(val)) {
        active.push({ cat, crit, dir, val });
      }
    });
    return active;
  }

  function collectFollowersFilter() {
    const minRaw = document.getElementById('followers-min').value;
    const maxRaw = document.getElementById('followers-max').value;
    const min = minRaw !== '' && isFinite(parseFloat(minRaw)) ? parseFloat(minRaw) : null;
    const max = maxRaw !== '' && isFinite(parseFloat(maxRaw)) ? parseFloat(maxRaw) : null;
    if (min === null && max === null) return null;
    return { min, max };
  }

  function applyFollowersFilter(data) {
    const f = collectFollowersFilter();
    if (!f) return data;
    return data.filter(record => {
      const v = record.total_followers;
      if (v === null || v === undefined) return false;
      if (f.min !== null && v < f.min) return false;
      if (f.max !== null && v > f.max) return false;
      return true;
    });
  }

  function applyFilters(data, activeFilters) {
    if (!activeFilters.length) return data;
    return data.filter(record => {
      return activeFilters.every(f => {
        const colIdx = colKeyToIndex[f.cat + '__' + f.crit];
        const entry = record._byCol[colIdx];
        if (!entry || entry.index == null) return false;
        return f.dir === '>' ? entry.index > f.val : entry.index < f.val;
      });
    });
  }

  function sortData(data, cols, col, asc) {
    const colDef = cols.find(c => c.key === col);
    const accessor = colDef ? colDef.accessor : r => r[col];
    return [...data].sort((a, b) => {
      let av = accessor(a), bv = accessor(b);
      if (av === null || av === undefined) av = asc ? Infinity : -Infinity;
      if (bv === null || bv === undefined) bv = asc ? Infinity : -Infinity;
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
      return 0;
    });
  }

  function geometricMeanIndex(indexValues) {
    if (!indexValues.length) return null;
    const sumLogs = indexValues.reduce((acc, v) => acc + Math.log(v), 0);
    return Math.exp(sumLogs / indexValues.length);
  }

  function buildColumns(activeFilters) {
    const cols = [
      {
        key: 'display_name', label: 'Display Name',
        accessor: r => r.display_name,
        format: (v, r) => {
          if (v == null) return '—';
          const name = escHtml(String(v));
          if (!r.instagram_handle) return name;
          const url = 'https://www.instagram.com/' + encodeURIComponent(r.instagram_handle) + '/';
          return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="talent-link">' + name + '</a>';
        },
        numeric: false
      },
      {
        key: 'total_followers', label: 'Total Followers',
        accessor: r => r.total_followers,
        format: v => v != null ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '<span class="em-dash">—</span>',
        numeric: true
      }
    ];

    activeFilters.forEach(f => {
      const colIdx = colKeyToIndex[f.cat + '__' + f.crit];
      const shortLabel = f.crit;

      cols.push({
        key: 'percent_' + colIdx, label: shortLabel + ' %',
        accessor: r => r._byCol[colIdx] ? r._byCol[colIdx].percent : null,
        format: v => v != null ? Number(v).toFixed(2) + '%' : '<span class="em-dash">—</span>',
        numeric: true
      });
      cols.push({
        key: 'index_' + colIdx, label: shortLabel + ' Index',
        accessor: r => r._byCol[colIdx] ? r._byCol[colIdx].index : null,
        format: v => v != null ? Number(v).toFixed(2) : '<span class="em-dash">—</span>',
        numeric: true,
        copyable: true,
        criteria: f.crit
      });
    });

    if (activeFilters.length > 1) {
        cols.push({
            key: 'avg_index',
            label: 'Average Index',
            accessor: r => {
            const vals = activeFilters.map(f => {
                const colIdx = colKeyToIndex[f.cat + '__' + f.crit];
                return r._byCol[colIdx] ? r._byCol[colIdx].index : null;
            });
            return geometricMeanIndex(vals);
            },
            format: v => v != null ? Number(v).toFixed(2) : '<span class="em-dash">—</span>',
            numeric: true
        });
    }

    return cols;
  }

  function render() {
    const rangeClientsOnly = document.getElementById('range-clients-checkbox').checked;
    let base = rangeClientsOnly ? allData.filter(r => r.is_range_client) : allData;
    base = applyFollowersFilter(base);

    const activeFilters = collectFilters();
    const filtered = applyFilters(base, activeFilters);
    const cols = buildColumns(activeFilters);

    const validKeys = new Set(cols.map(c => c.key));
    if (!validKeys.has(sortCol)) {
      sortCol = 'total_followers';
      sortAsc = false;
    }

    const sorted = sortData(filtered, cols, sortCol, sortAsc);

    document.getElementById('clear-filters-btn').disabled =
      document.querySelectorAll('.filter-row').length === 0;

    const countEl = document.getElementById('results-count');
    countEl.innerHTML = 'Showing <span>' + filtered.length + '</span> of <span>' + base.length + '</span> talents';

    const theadRow = document.getElementById('thead-row');
    theadRow.innerHTML = '';
    cols.forEach(col => {
      const th = document.createElement('th');
      const isActive = col.key === sortCol;
      if (isActive) th.classList.add('sort-active');

      let labelHtml = escHtml(col.label);
      if (isActive) {
        labelHtml += '<span class="sort-indicator">' + (sortAsc ? '▲' : '▼') + '</span>';
      }
      th.innerHTML = labelHtml;

      th.addEventListener('click', () => {
        if (sortCol === col.key) {
          sortAsc = !sortAsc;
        } else {
          sortCol = col.key;
          sortAsc = true;
        }
        render();
      });

      theadRow.appendChild(th);
    });

    const tbody = document.getElementById('tbody');
    tbody.innerHTML = '';

    if (!sorted.length) {
      const tr = document.createElement('tr');
      tr.className = 'no-data';
      const td = document.createElement('td');
      td.colSpan = cols.length;
      td.textContent = 'No results match the current filters.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

  sorted.forEach(record => {
      const tr = document.createElement('tr');
      cols.forEach(col => {
        const td = document.createElement('td');
        if (col.numeric) td.classList.add('num');
        const value = col.accessor(record);
        td.innerHTML = col.format(value, record);
        if (col.copyable && value != null) {
          td.classList.add('copyable');
          td.title = 'Click to copy comparison text';
          td.addEventListener('click', () => copyIndexComparison(record, col, value, td));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function copyIndexComparison(record, col, value, td) {
    const pct = Math.round(Math.abs(value - 1) * 100);
    const direction = value >= 1 ? 'more' : 'fewer';
    const demo = col.criteria.toLowerCase();
    const text = record.display_name + ' has ' + pct + '% ' + direction + ' ' + demo +
      ' followers than the Instagram average.';

    navigator.clipboard.writeText(text).then(() => {
      const original = td.innerHTML;
      td.innerHTML = 'Index copied';
      setTimeout(() => { td.innerHTML = original; }, 1200);
    }).catch(err => {
      console.error('Copy failed:', err);
    });
  }


  function triggerRefilter() {
    render();
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();