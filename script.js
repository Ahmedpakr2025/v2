/* app.js
   Inventory / Permissions web app logic (vanilla JS)
   - Data persistence: localStorage ("intermaint_data_v1")
   - Data model (in comments) and main functions:
     * items: [{id,name,unit,type,group}]
     * warehouses: [{id,name,desc}]
     * permissions: [{id,number,type,store,from,to,date,subNumber,posted,postedAt,lines:[{itemId,unit,qty,desc}],createdAt}]
   - Balance calculation uses formula described in requirements.
   - Exports:
     * Excel: CSV download
     * PDF: open print window with table and call print
   - Import:
     * Items from CSV expected columns: name,unit,type,group,initial_qty
   - Backup/Restore: JSON file export/import
   - Max 25 lines per permission enforced
*/

/* -----------------------------------------------------------
   Utilities
------------------------------------------------------------*/
const qs = s => document.querySelector(s);
const qsa = s => Array.from(document.querySelectorAll(s));
const uid = (p='id') => `${p}_${Math.random().toString(36).slice(2,9)}`;

/* -----------------------------------------------------------
   Data store
   -----------------------------------------------------------
   Structure in localStorage key "intermaint_data_v1":
   {
     items: [{id,name,unit,type,group}],
     warehouses: [{id,name,desc}],
     permissions: [{id,number,type,store,from,to,date,subNumber,posted,postedAt,lines:[{itemId,unit,qty}],createdAt}]
   }
------------------------------------------------------------*/
const STORAGE_KEY = 'intermaint_data_v1';

function loadStore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seed = {
      items: [
        // sample items
        {id:uid('it'), name:'مسمار', unit:'قطعة', type:'مستهلكات', group:'مكتبي'},
        {id:uid('it'), name:'مفتاح ربط', unit:'قطعة', type:'عدة', group:'عدة'},
      ],
      warehouses: [
        {id:uid('wh'), name:'المخزن الرئيسي', desc:'المخزن المركزي'},
        {id:uid('wh'), name:'مورد خارجي', desc:'مورد'},
      ],
      permissions: []
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  }
  return JSON.parse(raw);
}

function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/* Retrieve store */
let store = loadStore();

/* -----------------------------------------------------------
   Core data operations
------------------------------------------------------------*/
function addItem({name,unit,type,group}) {
  const newItem = {id:uid('it'), name, unit, type, group};
  store.items.push(newItem);
  saveStore(store);
  return newItem;
}

function editItem(itemId, data) {
  const it = store.items.find(i=>i.id===itemId);
  if (it) Object.assign(it, data);
  saveStore(store);
}

function removeItem(itemId) {
  // Remove item. Note: existing permission lines referencing it will keep itemId (historical).
  store.items = store.items.filter(i=>i.id!==itemId);
  saveStore(store);
}

function addWarehouse({name,desc}) {
  const wh = {id:uid('wh'), name, desc};
  store.warehouses.push(wh);
  saveStore(store);
  return wh;
}

function addPermission(perm) {
  // perm should be object with header fields and lines array.
  const p = Object.assign({id:uid('perm'), posted:false, createdAt:new Date().toISOString()}, perm);
  store.permissions.push(p);
  saveStore(store);
  return p;
}

function updatePermission(id, updated) {
  const idx = store.permissions.findIndex(p=>p.id===id);
  if (idx>=0) {
    store.permissions[idx] = Object.assign(store.permissions[idx], updated);
    saveStore(store);
    return store.permissions[idx];
  }
  return null;
}

function deletePermission(id) {
  store.permissions = store.permissions.filter(p=>p.id!==id);
  saveStore(store);
}

/* -----------------------------------------------------------
   Business logic: balance calculation
   Balance = (إذن الإضافة) - (إذن التحويل) - (إذن خصم المعدة) - (إذن الصرف) + (إذن الارتجاع)
   We compute item balances by scanning all posted permissions and summing their line quantities
------------------------------------------------------------*/
function computeBalances({fromDate, toDate, filterPermType, filterItemId, filterGroup} = {}) {
  // return map itemId -> balance
  // consider only posted permissions
  const balances = {};
  store.items.forEach(it => balances[it.id] = 0);

  store.permissions
    .filter(p => p.posted)
    .filter(p => {
      if (filterPermType && p.type !== filterPermType) return false;
      if (fromDate && new Date(p.date) < new Date(fromDate)) return false;
      if (toDate && new Date(p.date) > new Date(toDate)) return false;
      return true;
    })
    .forEach(p => {
      p.lines.forEach(line => {
        if (!balances.hasOwnProperty(line.itemId)) {
          // if item was removed later, still track it
          balances[line.itemId] = 0;
        }
        const qty = Number(line.qty) || 0;
        switch (p.type) {
          case 'إذن إضافة':
            balances[line.itemId] += qty; break;
          case 'إذن تحويل':
            balances[line.itemId] -= qty; break;
          case 'إذن خصم معدة':
            balances[line.itemId] -= qty; break;
          case 'إذن صرف':
            balances[line.itemId] -= qty; break;
          case 'إذن ارتجاع':
            balances[line.itemId] += qty; break;
          default: break;
        }
      });
    });

  // apply optional filters: return only relevant entries (but keep all items if not filtering)
  if (filterItemId) {
    const out = {};
    out[filterItemId] = balances[filterItemId] || 0;
    return out;
  }
  if (filterGroup) {
    const out = {};
    store.items.filter(it=>it.group===filterGroup).forEach(it => out[it.id] = balances[it.id]||0);
    return out;
  }
  return balances;
}

/* For item card, we need ordered transaction rows and running balance */
function getItemCard(itemId) {
  // Gather all posted permissions that include this item, ordered by date then createdAt
  const txs = [];
  store.permissions
    .filter(p => p.posted)
    .filter(p => p.lines.some(l=>l.itemId===itemId))
    .sort((a,b)=> new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt))
    .forEach(p => {
      p.lines.forEach(line => {
        if (line.itemId !== itemId) return;
        const qty = Number(line.qty) || 0;
        const isIn = (p.type === 'إذن إضافة' || p.type === 'إذن ارتجاع');
        const inVal = isIn ? qty : 0;
        const outVal = isIn ? 0 : qty;
        txs.push({
          header: p.type,
          in: inVal,
          out: outVal,
          desc: line.desc || '',
          permNumber: p.number,
          date: p.date || p.createdAt
        });
      });
    });

  // Calculate running balance
  const rows = [];
  let bal = 0;
  txs.forEach(t => {
    bal += (t.in - t.out);
    rows.push(Object.assign({}, t, {balance: bal}));
  });
  return {rows, balance: bal};
}

/* -----------------------------------------------------------
   UI helpers and bindings
------------------------------------------------------------*/
function el(tag, attrs={}, children=[]) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') e.className = v;
    else if (k.startsWith('data-')) e.setAttribute(k,v);
    else if (k==='html') e.innerHTML = v;
    else e[k]=v;
  });
  (children || []).forEach(c => e.appendChild(c));
  return e;
}

/* Populate select options */
function fillSelect(selectEl, items, valueKey='id', textKey='name', includeBlank=true) {
  selectEl.innerHTML = '';
  if (includeBlank) {
    const opt = document.createElement('option'); opt.value=''; opt.textContent='-- اختر --'; selectEl.appendChild(opt);
  }
  items.forEach(i => {
    const o = document.createElement('option'); o.value = i[valueKey]; o.textContent = i[textKey]; selectEl.appendChild(o);
  });
}

/* Refresh UI master data (items, warehouses, groups) */
function refreshMasterData() {
  // warehouses selects
  const stores = store.warehouses;
  qsa('#permStore, #permFrom, #permTo, #editPermStore').forEach(sel => {
    fillSelect(sel, stores, 'name', 'name', true);
  });

  // items selects
  const items = store.items;
  // filterItem and card select and lines use name value map to id for selects; we will use id-based selects for lines
  // Build select elements
  const filterItem = qs('#filterItem');
  filterItem.innerHTML = '<option value="">-- الكل --</option>';
  store.items.sort((a,b)=> a.name.localeCompare(b.name)).forEach(it => {
    const o = document.createElement('option'); o.value=it.id; o.textContent=it.name; filterItem.appendChild(o);
  });

  const cardSelect = qs('#cardItemSelect');
  cardSelect.innerHTML = '<option value="">-- اختر صنف --</option>';
  store.items.forEach(it => {
    const o = document.createElement('option'); o.value=it.id; o.textContent=it.name; cardSelect.appendChild(o);
  });

  // item group select in addItem and filterGroup
  const groups = Array.from(new Set(store.items.map(i=>i.group).filter(Boolean)));
  const groupSel = qs('#itemGroup');
  groupSel.innerHTML = '<option value="">-- اختر مجموعة --</option>';
  groups.forEach(g => { const o = document.createElement('option'); o.value=g; o.textContent=g; groupSel.appendChild(o); });

  const filterGroup = qs('#filterGroup');
  filterGroup.innerHTML = '<option value="">-- الكل --</option>';
  groups.forEach(g => { const o = document.createElement('option'); o.value=g; o.textContent=g; filterGroup.appendChild(o); });

  // update item table in items page
  renderItemsTable();
}

/* -----------------------------------------------------------
   Permission Entry page: lines management and posting
------------------------------------------------------------*/
function createLineRow(index, data={itemId:'', unit:'', qty:''}, container, allowRemove=true) {
  const row = el('div',{class:'line-row', 'data-index':index});
  const itemSel = document.createElement('select');
  itemSel.innerHTML = '';
  const blankOpt = document.createElement('option'); blankOpt.value=''; blankOpt.textContent='-- اختر صنف --'; itemSel.appendChild(blankOpt);
  store.items.forEach(it => {
    const o = document.createElement('option'); o.value = it.id; o.textContent = it.name; if (it.id===data.itemId) o.selected=true; itemSel.appendChild(o);
  });
  const unitDiv = el('div', {class:'unit'}, []);
  unitDiv.textContent = data.unit || '';
  const qtyInput = document.createElement('input'); qtyInput.type='number'; qtyInput.min=0; qtyInput.step='1'; qtyInput.value = data.qty || '';
  qtyInput.placeholder = 'الكمية';

  const removeBtn = el('button', {class:'btn small'}, []);
  removeBtn.textContent = 'حذف';
  removeBtn.type = 'button';

  itemSel.addEventListener('change', e => {
    const it = store.items.find(i=>i.id===itemSel.value);
    unitDiv.textContent = it ? it.unit : '';
  });

  removeBtn.addEventListener('click', ()=> {
    container.removeChild(row);
    updateLinesCount(container);
  });

  row.appendChild(itemSel);
  row.appendChild(unitDiv);
  row.appendChild(qtyInput);
  if (allowRemove) row.appendChild(removeBtn);
  container.appendChild(row);
  updateLinesCount(container);
  return row;
}

function updateLinesCount(container) {
  const count = container.querySelectorAll('.line-row').length;
  qs('#linesCount').textContent = `${count} / 25`;
}

/* Build empty lines container for new permission */
function buildLinesContainer(initialLines=[]) {
  const container = qs('#linesContainer');
  container.innerHTML = '';
  const max = Math.min(25, Math.max(1, initialLines.length || 1));
  for (let i=0;i<max;i++) {
    const data = initialLines[i] || {itemId:'', unit:'', qty:''};
    createLineRow(i, data, container);
  }
}

/* Post/Commit a permission */
function postPermissionFromForm(formEl, isEdit=false, existingPermId=null) {
  // gather header
  const number = qs('#permNumber').value.trim();
  const date = qs('#permDate').value || new Date().toISOString().slice(0,10);
  const storeName = qs('#permStore').value || '';
  const type = qs('#permType').value;
  const from = qs('#permFrom').value || '';
  const to = qs('#permTo').value || '';
  const subNumber = qs('#permSubNumber').value || '';

  // lines
  const lines = [];
  const container = qs('#linesContainer');
  const rows = Array.from(container.querySelectorAll('.line-row'));
  if (rows.length === 0) return alert('أضف بند واحد على الأقل');
  if (rows.length > 25) return alert('الحد الأقصى 25 بند');

  for (let r of rows) {
    const sel = r.querySelector('select');
    const qty = r.querySelector('input').value;
    if (!sel.value) { alert('أدخل صنف لكل بند'); return; }
    if (!qty || Number(qty) <= 0) { alert('الكمية يجب أن تكون أكبر من صفر'); return; }
    const it = store.items.find(i=>i.id===sel.value);
    lines.push({itemId: sel.value, unit: it ? it.unit : '', qty: Number(qty)});
  }

  const p = {
    number, store: storeName, type, from, to, date, subNumber,
    lines, posted:true, postedAt:new Date().toISOString()
  };

  if (isEdit && existingPermId) {
    // replace lines and header but keep id and createdAt
    const existing = store.permissions.find(pp=>pp.id===existingPermId);
    if (!existing) return alert('لم يتم العثور على الإذن للتحرير');
    existing.number = p.number; existing.store = p.store; existing.type = p.type;
    existing.from = p.from; existing.to = p.to; existing.date = p.date; existing.subNumber = p.subNumber;
    existing.lines = p.lines; existing.posted = true; existing.postedAt = p.postedAt;
    saveStore(store);
    alert('تم حفظ وتحديث الإذن');
  } else {
    addPermission(p);
    alert('تم ترحيل الإذن');
  }

  // after posting, recalculate and refresh
  refreshAllViews();
  // reset form
  formEl.reset();
  buildLinesContainer([]);
}

/* -----------------------------------------------------------
   Render functions for pages
------------------------------------------------------------*/
function renderItemsTable() {
  const tbody = qs('#itemsTable tbody');
  tbody.innerHTML = '';
  const balances = computeBalances();
  const itemsSorted = store.items.slice().sort((a,b)=>a.name.localeCompare(b.name));
  itemsSorted.forEach(it => {
    const tr = document.createElement('tr');
    const balance = balances[it.id] || 0;
    tr.innerHTML = `<td>${it.name}</td><td>${it.unit}</td><td>${it.type}</td><td>${it.group || ''}</td><td>${balance}</td>
      <td>
        <button class="btn small edit-item" data-id="${it.id}">تعديل</button>
        <button class="btn small danger delete-item" data-id="${it.id}">حذف</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // bind actions
  qsa('.delete-item').forEach(b => b.addEventListener('click', e => {
    const id = e.currentTarget.dataset.id;
    if (confirm('هل تريد حذف الصنف؟ هذا لا يحذف الحركات التاريخية المسجلة.')) {
      removeItem(id);
      refreshAllViews();
    }
  }));

  qsa('.edit-item').forEach(b => b.addEventListener('click', e => {
    const id = e.currentTarget.dataset.id;
    const it = store.items.find(x=>x.id===id);
    if (!it) return;
    // populate add item form for quick edit
    qs('#itemName').value = it.name;
    qs('#itemUnit').value = it.unit;
    qs('#itemType').value = it.type;
    qs('#itemGroup').value = it.group || '';
    qs('#itemInitial').value = '';
    // when saving, we will detect duplicate name? For simplicity, perform edit instead of add if same id matches existing name.
    // We will set a temporary attribute to capture editing
    qs('#addItemForm').dataset.editing = id;
    window.scrollTo({top:0,behavior:'smooth'});
  }));
}

function renderStockTable(filters={}) {
  const tbody = qs('#stockTable tbody');
  tbody.innerHTML = '';
  const balances = computeBalances(filters);
  // by default show alphabetic
  const items = store.items.slice().sort((a,b)=>a.name.localeCompare(b.name));
  items.forEach(it => {
    // apply group filter?
    if (filters.filterGroup && it.group !== filters.filterGroup) return;
    if (filters.filterItemId && it.id !== filters.filterItemId) return;
    const bal = balances[it.id] !== undefined ? balances[it.id] : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${it.name}</td><td>${it.unit}</td><td>${it.group || ''}</td><td>${it.type}</td><td>${bal}</td>`;
    tbody.appendChild(tr);
  });
}

/* Render warehouses table */
function renderWarehouses() {
  const tbody = qs('#whTable tbody');
  tbody.innerHTML = '';
  store.warehouses.forEach(w => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${w.name}</td><td>${w.desc || ''}</td><td><button class="btn small delete-wh" data-id="${w.id}">حذف</button></td>`;
    tbody.appendChild(tr);
  });
  qsa('.delete-wh').forEach(b => b.addEventListener('click', e => {
    const id = e.currentTarget.dataset.id;
    if (confirm('حذف المخزن/المورد؟')) {
      store.warehouses = store.warehouses.filter(x=>x.id!==id);
      saveStore(store);
      refreshAllViews();
    }
  }));
}

/* Render permissions search results */
function renderPermsTable(results) {
  const tbody = qs('#permsTable tbody');
  tbody.innerHTML = '';
  results.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.number}</td><td>${p.type}</td><td>${p.store || ''}</td><td>${p.date || ''}</td><td>${p.lines.length}</td>
      <td>
        <button class="btn small open-perm" data-id="${p.id}">فتح</button>
        <button class="btn small danger delete-perm" data-id="${p.id}">حذف</button>
      </td>`;
    tbody.appendChild(tr);
  });

  qsa('.delete-perm').forEach(b => b.addEventListener('click', e => {
    const id = e.currentTarget.dataset.id;
    if (confirm('حذف الإذن نهائياً؟')) {
      deletePermission(id);
      refreshAllViews();
      alert('تم حذف الإذن');
    }
  }));

  qsa('.open-perm').forEach(b => b.addEventListener('click', e => {
    const id = e.currentTarget.dataset.id;
    openEditPermPanel(id);
  }));
}

/* Open edit permission modal and populate fields */
function openEditPermPanel(id) {
  const perm = store.permissions.find(p=>p.id===id);
  if (!perm) return alert('لم يتم العثور على الإذن');
  qs('#editPermPanel').classList.remove('hidden');
  qs('#editPermNumber').value = perm.number;
  qs('#editPermDate').value = perm.date ? perm.date.slice(0,10) : '';
  // fill store list then set value
  const editStoreSel = qs('#editPermStore');
  fillSelect(editStoreSel, store.warehouses, 'name', 'name', true);
  if (perm.store) {
    const opt = Array.from(editStoreSel.options).find(o=>o.value===perm.store);
    if (opt) opt.selected = true;
  }
  qs('#editPermType').value = perm.type;
  // lines
  const container = qs('#editLinesContainer');
  container.innerHTML = '';
  perm.lines.forEach((ln, idx) => {
    createEditLineRow(idx, ln, container);
  });
  // save id on form dataset
  qs('#editPermForm').dataset.editId = id;
}

/* Create line row inside edit modal */
function createEditLineRow(index, data, container) {
  const row = el('div',{class:'line-row', 'data-index':index});
  const itemSel = document.createElement('select');
  itemSel.innerHTML = '';
  const blankOpt = document.createElement('option'); blankOpt.value=''; blankOpt.textContent='-- اختر صنف --'; itemSel.appendChild(blankOpt);
  store.items.forEach(it => {
    const o = document.createElement('option'); o.value = it.id; o.textContent = it.name; if (it.id===data.itemId) o.selected=true; itemSel.appendChild(o);
  });
  const unitDiv = el('div', {class:'unit'}, []);
  unitDiv.textContent = data.unit || '';
  const qtyInput = document.createElement('input'); qtyInput.type='number'; qtyInput.min=0; qtyInput.step='1'; qtyInput.value = data.qty || '';
  qtyInput.placeholder = 'الكمية';

  const removeBtn = el('button', {class:'btn small'}, []);
  removeBtn.textContent = 'حذف';
  removeBtn.type = 'button';

  itemSel.addEventListener('change', e => {
    const it = store.items.find(i=>i.id===itemSel.value);
    unitDiv.textContent = it ? it.unit : '';
  });

  removeBtn.addEventListener('click', ()=> {
    container.removeChild(row);
  });

  row.appendChild(itemSel);
  row.appendChild(unitDiv);
  row.appendChild(qtyInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

/* -----------------------------------------------------------
   Import / Export / Backup
------------------------------------------------------------*/

/* CSV (Excel-compatible) export for stock balance table */
function exportStockToCSV(filters={}) {
  // Build CSV rows
  const headers = ['الصنف','الوحدة','المجموعة','النوع','الرصيد الحالي'];
  const balances = computeBalances(filters);
  const rows = [headers.join(',')];
  store.items.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(it => {
    if (filters.filterGroup && it.group !== filters.filterGroup) return;
    if (filters.filterItemId && it.id !== filters.filterItemId) return;
    const bal = balances[it.id]||0;
    rows.push([it.name, it.unit, it.group||'', it.type, bal].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
  });
  const csv = rows.join('\n');
  downloadFile(csv, 'stock_balance.csv', 'text/csv;charset=utf-8;');
}

/* Download helper */
function downloadFile(data, filename, mime='text/plain') {
  const blob = new Blob([data], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/* Export item card to CSV */
function exportItemCardToCSV(itemId) {
  const it = store.items.find(i=>i.id===itemId);
  if (!it) return alert('اختر صنفاً صالحاً للتصدير');
  const {rows, balance} = getItemCard(itemId);
  const headers = ['البيان','دخول','خروج','الرصيد بعد الحركة','رقم الإذن','التاريخ'];
  const data = [headers.join(',')];
  rows.forEach(r => {
    data.push([r.header, r.in, r.out, r.balance, r.permNumber, r.date].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  });
  data.push([`الرصيد الحالي: ${balance}`].join(','));
  downloadFile(data.join('\n'), `${it.name}_card.csv`, 'text/csv;charset=utf-8;');
}

/* Simple PDF export by opening a print window. This is a client-side approach:
   - Build an HTML representation of the current filtered stock table or item card
   - Open a new window, write the HTML, call print()
   (For more advanced PDF generation use libraries like jsPDF or html2pdf; not used here to keep vanilla.)
*/
function exportStockToPDF(filters={}) {
  // create table HTML
  const balances = computeBalances(filters);
  let html = `<html dir="rtl"><head><meta charset="utf-8"><title>كشف رصيد</title><style>
    body{font-family:Arial,Helvetica,sans-serif;direction:rtl;padding:20px}
    table{width:100%;border-collapse:collapse} th,td{border:1px solid #333;padding:6px;text-align:right}
  </style></head><body>`;
  html += '<h3>كشف رصيد الأصناف</h3>';
  html += '<table><thead><tr><th>الصنف</th><th>الوحدة</th><th>المجموعة</th><th>النوع</th><th>الرصيد</th></tr></thead><tbody>';
  store.items.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(it=>{
    if (filters.filterGroup && it.group !== filters.filterGroup) return;
    if (filters.filterItemId && it.id !== filters.filterItemId) return;
    const bal = balances[it.id]||0;
    html += `<tr><td>${it.name}</td><td>${it.unit}</td><td>${it.group||''}</td><td>${it.type}</td><td>${bal}</td></tr>`;
  });
  html += '</tbody></table></body></html>';
  const win = window.open('', '_blank', 'noopener');
  win.document.write(html);
  win.document.close();
  // small delay to ensure rendering then print
  setTimeout(()=>win.print(), 500);
}

/* Backup export (JSON) and import */
function exportBackup() {
  const data = JSON.stringify(store, null, 2);
  downloadFile(data, `intermaint_backup_${(new Date()).toISOString().slice(0,19)}.json`, 'application/json');
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      // basic validation
      if (!data.items || !data.warehouses || !data.permissions) throw new Error('ملف نسخة احتياطية غير صالح');
      store = data;
      saveStore(store);
      refreshAllViews();
      alert('تم استرجاع النسخة الاحتياطية');
    } catch (err) {
      alert('فشل استرجاع النسخة: ' + err.message);
    }
  };
  reader.readAsText(file);
}

/* Import items from CSV (simple CSV parser) */
function importItemsCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter(l=>l.trim());
    if (lines.length === 0) return alert('الملف فارغ');
    const headers = lines[0].split(',').map(h=>h.replace(/"/g,'').trim().toLowerCase());
    // expected headers: name,unit,type,group,initial_qty
    const colIndex = {};
    headers.forEach((h,i) => colIndex[h]=i);
    if (!('name' in colIndex) || !('unit' in colIndex)) {
      return alert('ملف CSV يجب أن يحتوي على على الأقل الأعمدة: name, unit');
    }
    // parse rows
    for (let i=1;i<lines.length;i++) {
      const row = parseCSVLine(lines[i]);
      if (!row || !row[colIndex['name']]) continue;
      const name = row[colIndex['name']].trim();
      const unit = row[colIndex['unit']] ? row[colIndex['unit']].trim() : '';
      const type = row[colIndex['type']] ? row[colIndex['type']].trim() : 'مستهلكات';
      const group = row[colIndex['group']] ? row[colIndex['group']].trim() : '';
      const initial_qty = row[colIndex['initial_qty']] ? Number(row[colIndex['initial_qty']]) : 0;
      // if item with same name exists, skip or update? We'll skip duplicates.
      if (!store.items.some(it=>it.name === name)) {
        const newIt = addItem({name,unit,type,group});
        if (initial_qty > 0) {
          // create an initial addition permission to record initial quantity
          addPermission({
            number: `INIT_${newIt.id}`,
            store: store.warehouses[0] ? store.warehouses[0].name : '',
            type: 'إذن إضافة',
            from: '',
            to: store.warehouses[0] ? store.warehouses[0].name : '',
            date: new Date().toISOString().slice(0,10),
            subNumber: '',
            lines: [{itemId:newIt.id, unit:newIt.unit, qty:initial_qty}],
            posted:true,
            postedAt:new Date().toISOString()
          });
        }
      }
    }
    saveStore(store);
    refreshAllViews();
    alert('تم استيراد الأصناف من CSV');
  };
  reader.readAsText(file);
}

/* simple CSV line parser (handles quoted values) */
function parseCSVLine(line) {
  const res = [];
  let cur = '';
  let inQuotes = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"' ) {
      if (inQuotes && line[i+1]==='"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      res.push(cur); cur=''; 
    } else cur += ch;
  }
  res.push(cur);
  return res;
}

/* -----------------------------------------------------------
   Page navigation and event binding
------------------------------------------------------------*/
function showPage(id) {
  qsa('.page').forEach(p => p.classList.add('hidden'));
  if (id === 'dashboard') {
    qs('#dashboard').classList.remove('hidden');
  } else {
    qs('#dashboard').classList.add('hidden');
    qs(`#page-${id}`) && qs(`#page-${id}`).classList.remove('hidden');
  }
}

/* Bind main nav buttons */
qsa('.nav-card').forEach(b => b.addEventListener('click', e => {
  const page = e.currentTarget.dataset.page;
  if (page === 'entry') {
    // prepare entry form
    buildLinesContainer([]);
  }
  showPage(page);
}));

qsa('.back-btn').forEach(b => b.addEventListener('click', e => {
  const page = e.currentTarget.dataset.page || 'dashboard';
  showPage(page);
}));

/* Build initial lines container for entry page and add-line button */
qs('#addLineBtn').addEventListener('click', () => {
  const container = qs('#linesContainer');
  const count = container.querySelectorAll('.line-row').length;
  if (count >= 25) return alert('الحد الأقصى 25 بند');
  createLineRow(count, {}, container);
});

/* Submit permission form */
qs('#permForm').addEventListener('submit', (e) => {
  e.preventDefault();
  postPermissionFromForm(e.target, false, null);
});

/* Add item form submit */
qs('#addItemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const editingId = e.target.dataset.editing;
  const name = qs('#itemName').value.trim();
  const unit = qs('#itemUnit').value.trim();
  const type = qs('#itemType').value;
  const group = qs('#itemGroup').value || qs('#newGroupInput').value.trim();
  const initial = Number(qs('#itemInitial').value) || 0;
  if (!name || !unit) return alert('أكمل بيانات الصنف');
  if (editingId) {
    editItem(editingId, {name,unit,type,group});
    delete e.target.dataset.editing;
  } else {
    const newIt = addItem({name,unit,type,group});
    if (initial > 0) {
      addPermission({
        number: `INIT_${newIt.id}`,
        store: store.warehouses[0] ? store.warehouses[0].name : '',
        type: 'إذن إضافة',
        from: '',
        to: store.warehouses[0] ? store.warehouses[0].name : '',
        date: new Date().toISOString().slice(0,10),
        subNumber: '',
        lines: [{itemId:newIt.id, unit:newIt.unit, qty:initial}],
        posted:true,
        postedAt:new Date().toISOString()
      });
    }
  }
  e.target.reset();
  refreshAllViews();
});

/* Add group quick button */
qs('#addGroupBtn').addEventListener('click', () => {
  const g = qs('#newGroupInput').value.trim();
  if (!g) return alert('أدخل اسم مجموعة');
  // add as option
  const opt = document.createElement('option'); opt.value = g; opt.textContent = g;
  qs('#itemGroup').appendChild(opt);
  qs('#itemGroup').value = g;
  qs('#newGroupInput').value = '';
});

/* Add warehouse form */
qs('#addWarehouseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = qs('#whName').value.trim();
  const desc = qs('#whDesc').value.trim();
  if (!name) return alert('أدخل اسم المخزن/المورد');
  addWarehouse({name,desc});
  e.target.reset();
  refreshAllViews();
});

/* Render warehouses table */
renderWarehouses();

/* Search permissions */
qs('#searchPermBtn').addEventListener('click', ()=> {
  const num = qs('#searchPermNumber').value.trim();
  const item = qs('#searchPermItem').value.trim().toLowerCase();
  const type = qs('#searchPermType').value;
  let results = store.permissions.slice();
  if (num) results = results.filter(p => p.number && p.number.includes(num));
  if (type) results = results.filter(p => p.type === type);
  if (item) results = results.filter(p => p.lines.some(ln => {
    const it = store.items.find(i=>i.id===ln.itemId); return it && it.name.toLowerCase().includes(item);
  }));
  renderPermsTable(results);
});

/* Edit modal: add line button */
qs('#editAddLine').addEventListener('click', ()=> {
  const container = qs('#editLinesContainer');
  const count = container.querySelectorAll('.line-row').length;
  if (count >= 25) return alert('الحد الأقصى 25 بند');
  createEditLineRow(count, {itemId:'', unit:'', qty:''}, container);
});

/* Close edit modal */
qs('#closeEdit').addEventListener('click', ()=> qs('#editPermPanel').classList.add('hidden'));

/* Save edit permission */
qs('#editPermForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = e.target.dataset.editId;
  const perm = store.permissions.find(p=>p.id===id);
  if (!perm) return alert('خطأ: لم يتم العثور على الإذن');
  const number = qs('#editPermNumber').value.trim();
  const date = qs('#editPermDate').value || new Date().toISOString().slice(0,10);
  const storeName = qs('#editPermStore').value || '';
  const type = qs('#editPermType').value;
  const container = qs('#editLinesContainer');
  const lines = Array.from(container.querySelectorAll('.line-row')).map(r=>{
    const sel = r.querySelector('select');
    const qty = r.querySelector('input').value;
    const it = store.items.find(i=>i.id===sel.value);
    return {itemId: sel.value, unit: it?it.unit:'', qty: Number(qty)||0};
  }).filter(l=>l.itemId && l.qty>0);

  if (lines.length===0) return alert('أدخل بند واحد على الأقل');

  // Update permission & keep posted flag true and update postedAt
  perm.number = number; perm.date = date; perm.store = storeName; perm.type = type; perm.lines = lines;
  perm.postedAt = new Date().toISOString();
  saveStore(store);
  qs('#editPermPanel').classList.add('hidden');
  refreshAllViews();
  alert('تم تحديث الإذن');
});

/* Delete permission from edit modal */
qs('#deletePermBtn').addEventListener('click', ()=> {
  const id = qs('#editPermForm').dataset.editId;
  if (!id) return;
  if (!confirm('هل تريد حذف الإذن نهائياً؟')) return;
  deletePermission(id);
  qs('#editPermPanel').classList.add('hidden');
  refreshAllViews();
});

/* Item Card: show card */
qs('#showCardBtn').addEventListener('click', ()=> {
  const id = qs('#cardItemSelect').value;
  if (!id) return alert('اختر صنفاً');
  const {rows, balance} = getItemCard(id);
  const tbody = qs('#cardTable tbody'); tbody.innerHTML = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.desc||r.header}</td><td>${r.in}</td><td>${r.out}</td><td>${r.balance}</td><td>${r.permNumber}</td><td>${r.date}</td>`;
    tbody.appendChild(tr);
  });
  qs('#cardBalance').textContent = balance;
  const it = store.items.find(i=>i.id===id);
  qs('#cardTitle').textContent = it ? `كارتة صنف: ${it.name}` : 'كارتة الصنف';
  qs('#cardResult').classList.remove('hidden');
});

/* Export menu bindings */
qs('#exportBtn').addEventListener('mouseover', ()=> qs('#exportMenu').style.display='flex');
qs('#exportBtn').addEventListener('mouseout', ()=> qs('#exportMenu').style.display='none');
qsa('#exportMenu button').forEach(b => b.addEventListener('click', (e)=>{
  const type = e.currentTarget.dataset.export;
  // use current filters
  const filters = {
    filterGroup: qs('#filterGroup').value || '',
    filterItemId: qs('#filterItem').value || ''
  };
  if (type === 'excel') exportStockToCSV(filters);
  else exportStockToPDF(filters);
}));

/* Import items input */
qs('#importItemsBtn').addEventListener('click', ()=> qs('#importFile').click());
qs('#importFile').addEventListener('change', (e)=>{
  const f = e.target.files[0];
  if (!f) return;
  // simple approach: accept CSV only
  importItemsCSV(f);
  e.target.value = '';
});

/* Backup menu */
qs('#backupBtn').addEventListener('mouseover', ()=> qs('#backupMenu').style.display='flex');
qs('#backupBtn').addEventListener('mouseout', ()=> qs('#backupMenu').style.display='none');
qs('#backupExport').addEventListener('click', exportBackup);
qs('#backupImport').addEventListener('click', ()=> {
  const inp = document.createElement('input'); inp.type='file'; inp.accept='application/json';
  inp.onchange = (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    if (!confirm('سيتم استرجاع البيانات من الملف المحدد (سيستبدل البيانات الحالية). متابعة؟')) return;
    importBackupFile(f);
  };
  inp.click();
});

/* Apply/clear filters on stock page */
qs('#applyFilters').addEventListener('click', ()=> {
  const filters = {
    filterGroup: qs('#filterGroup').value || '',
    filterItemId: qs('#filterItem').value || '',
    filterPermType: qs('#filterPermType').value || '',
    fromDate: qs('#filterFrom').value || '',
    toDate: qs('#filterTo').value || ''
  };
  renderStockTable(filters);
});
qs('#clearFilters').addEventListener('click', ()=> {
  qs('#filterGroup').value=''; qs('#filterItem').value=''; qs('#filterPermType').value=''; qs('#filterFrom').value=''; qs('#filterTo').value='';
  renderStockTable();
});

/* Export item card button (contextual) - add dynamically: we will add right-click or another place if needed.
   For simplicity, export when user views item card: add a small export icon next to card title (not implemented visually).
*/
document.addEventListener('keydown', (e) => {
  // quick key: ctrl+shift+e exports current card if visible
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase()==='e') {
    const id = qs('#cardItemSelect').value;
    if (id) exportItemCardToCSV(id);
  }
});

/* -----------------------------------------------------------
   Initial rendering and helpers
------------------------------------------------------------*/
function refreshAllViews() {
  saveStore(store);
  refreshMasterData();
  renderWarehouses();
  renderItemsTable();
  // default stock view
  renderStockTable();
  // refresh permissions table if visible
  const perms = qs('#permsTable tbody');
  if (perms) perms.innerHTML='';
}

/* initial setup */
refreshAllViews();
showPage('dashboard');

/* -----------------------------------------------------------
   Additional developer notes (in comments):
   - To change default groups: modify items' group field or add groups via Add Item page.
   - To add warehouses/suppliers: use "إضافة مخزن / مورد" page.
   - Import from Excel: we implemented CSV import. Expected columns (headers in first row): 
       name,unit,type,group,initial_qty
     Each following row contains values. initial_qty is optional and will create an initial "إذن إضافة".
   - Export to Excel: generates CSV file which Excel can open. Header row is included.
   - Export to PDF: opens printable window (client-side) and triggers print. For high-fidelity PDF consider using html2pdf/jsPDF.
   - Balance recalculation: balances are always computed from posted permissions. Editing or deleting permissions updates balances immediately.
   - Max 25 items per permission enforced on UI.
   - Units are auto-filled in line rows from item data.
   - All data is persisted in localStorage under the key 'intermaint_data_v1'. To reset, clear localStorage or use backup/restore.
------------------------------------------------------------*/