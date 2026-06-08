const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function escapeField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCSV(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

class Table {
  constructor(name, columns) {
    this.name = name;
    this.columns = columns;
    this.file = path.join(DATA_DIR, name + '.csv');
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, columns.map(escapeField).join(',') + '\n');
    }
  }
  all() {
    const text = fs.readFileSync(this.file, 'utf8');
    const rows = parseCSV(text);
    if (rows.length <= 1) return [];
    const header = rows[0];
    const result = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 1 && r[0] === '') continue;
      const obj = {};
      for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] !== undefined ? r[j] : '';
      result.push(obj);
    }
    return result;
  }
  find(pred) { return this.all().find(pred); }
  filter(pred) { return this.all().filter(pred); }
  findById(id) { return this.find(r => r.id === String(id)); }
  nextId() {
    const rows = this.all();
    let max = 0;
    for (const r of rows) { const n = parseInt(r.id, 10); if (!isNaN(n) && n > max) max = n; }
    return String(max + 1);
  }
  insert(obj) {
    const row = { id: obj.id || this.nextId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...obj };
    const line = this.columns.map(c => escapeField(row[c] !== undefined ? row[c] : '')).join(',') + '\n';
    fs.appendFileSync(this.file, line);
    return row;
  }
  update(id, patch) {
    const rows = this.all();
    const idx = rows.findIndex(r => r.id === String(id));
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch, updated_at: new Date().toISOString() };
    this._writeAll(rows);
    return rows[idx];
  }
  remove(id) {
    const rows = this.all().filter(r => r.id !== String(id));
    this._writeAll(rows);
  }
  _writeAll(rows) {
    let out = this.columns.map(escapeField).join(',') + '\n';
    for (const r of rows) out += this.columns.map(c => escapeField(r[c] !== undefined ? r[c] : '')).join(',') + '\n';
    fs.writeFileSync(this.file, out);
  }
}

const users = new Table('users', ['id','name','surname','phone','email','password_hash','role','business_id','status','created_at','updated_at']);
const businesses = new Table('businesses', ['id','name','type','description','city','address','phone','status','created_at','updated_at']);
const tasks = new Table('tasks', ['id','business_id','employee_id','created_by','title','description','task_date','deadline_time','priority','planned_value','actual_value','unit','status','manager_comment','employee_comment','completion_percent','created_at','updated_at']);
const finance_reports = new Table('finance_reports', ['id','business_id','accountant_id','report_date','revenue','expenses','profit','comment','file_id','created_at','updated_at']);
const files = new Table('files', ['id','uploaded_by','business_id','original_name','file_path','file_type','file_size','created_at','updated_at']);
const notifications = new Table('notifications', ['id','user_id','title','message','is_read','created_at','updated_at']);
const task_history = new Table('task_history', ['id','task_id','user_id','action','old_value','new_value','created_at','updated_at']);

module.exports = { users, businesses, tasks, finance_reports, files, notifications, task_history, DATA_DIR, UPLOAD_DIR };
