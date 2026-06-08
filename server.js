const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./csvdb');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'uli-platform-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ts = Date.now();
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, ts + '_' + safe);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// --- seed admin if no users ---
(function seed() {
  if (db.users.all().length === 0) {
    const hash = bcrypt.hashSync('admin123', 8);
    db.users.insert({
      name: 'Главный', surname: 'Администратор', phone: '', email: 'admin',
      password_hash: hash, role: 'admin', business_id: '', status: 'active'
    });
    console.log('Создан администратор: логин admin, пароль admin123');
  }
})();

// --- helpers ---
function currentUser(req) {
  if (!req.session.userId) return null;
  return db.users.findById(req.session.userId);
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  req.user = u;
  res.locals.user = u;
  res.locals.businesses = db.businesses.all();
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).send('Доступ запрещен');
    next();
  };
}
function canAccessBusiness(user, businessId) {
  if (user.role === 'admin' || user.role === 'partner') return true;
  return String(user.business_id) === String(businessId);
}
function recalcTaskStatus(task) {
  const plan = parseFloat(task.planned_value) || 0;
  const fact = parseFloat(task.actual_value) || 0;
  if (plan > 0) task.completion_percent = Math.round((fact / plan) * 100);
  if (task.status === 'completed' || task.status === 'partial' || task.status === 'failed') return task;
  const today = new Date().toISOString().slice(0, 10);
  if (task.task_date && task.task_date < today && task.status !== 'completed') {
    task.status = 'overdue';
  }
  return task;
}
function notify(userId, title, message) {
  db.notifications.insert({ user_id: userId, title, message, is_read: '0' });
}

const STATUS_LABELS = {
  new: 'Новая', in_progress: 'В работе', completed: 'Выполнена',
  partial: 'Частично выполнена', failed: 'Не выполнена', overdue: 'Просрочена'
};
const STATUS_COLORS = {
  new: 'gray', in_progress: 'blue', completed: 'green',
  partial: 'yellow', failed: 'red', overdue: 'orange'
};
const ROLE_LABELS = {
  admin: 'Главный администратор', partner: 'Партнер',
  manager: 'Управляющий', accountant: 'Бухгалтер', employee: 'Сотрудник'
};
app.use((req, res, next) => {
  res.locals.STATUS_LABELS = STATUS_LABELS;
  res.locals.STATUS_COLORS = STATUS_COLORS;
  res.locals.ROLE_LABELS = ROLE_LABELS;
  res.locals.path = req.path;
  next();
});

// --- AUTH ---
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null });
});
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => (u.email === email || u.phone === email) && u.status !== 'fired');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Неверный логин или пароль' });
  }
  req.session.userId = user.id;
  res.redirect('/');
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// --- DASHBOARD ---
app.get('/', requireAuth, (req, res) => {
  const u = req.user;
  if (u.role === 'employee' || u.role === 'accountant') return res.redirect('/my-tasks');

  let tasks = db.tasks.all().map(recalcTaskStatus);
  let businesses = db.businesses.all();
  if (u.role === 'manager') {
    tasks = tasks.filter(t => t.business_id === u.business_id);
    businesses = businesses.filter(b => b.id === u.business_id);
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayTasks = tasks.filter(t => t.task_date === today);
  const finance = db.finance_reports.filter(f => f.report_date === today);
  const employees = db.users.filter(usr => usr.role === 'employee' || usr.role === 'manager' || usr.role === 'accountant');

  const sumBy = arr => arr.reduce((s, x) => s + (parseFloat(x) || 0), 0);

  res.render('dashboard', {
    businesses,
    stats: {
      businesses_count: businesses.length,
      employees_count: u.role === 'manager' ? employees.filter(e => e.business_id === u.business_id).length : employees.length,
      today_tasks: todayTasks.length,
      done: todayTasks.filter(t => t.status === 'completed').length,
      failed: todayTasks.filter(t => t.status === 'failed').length,
      overdue: tasks.filter(t => t.status === 'overdue').length,
      revenue: sumBy(finance.map(f => f.revenue)),
      expenses: sumBy(finance.map(f => f.expenses)),
      profit: sumBy(finance.map(f => f.profit))
    },
    bizCards: businesses.map(b => {
      const bt = tasks.filter(t => t.business_id === b.id && t.task_date === today);
      const emps = employees.filter(e => e.business_id === b.id);
      return { ...b, employees_count: emps.length, tasks_count: bt.length, done_count: bt.filter(t => t.status === 'completed').length };
    })
  });
});

// --- BUSINESSES ---
app.get('/businesses', requireAuth, requireRole('admin', 'partner'), (req, res) => {
  res.render('businesses', { items: db.businesses.all() });
});
app.get('/businesses/new', requireAuth, requireRole('admin', 'partner'), (req, res) => {
  res.render('business_form', { item: {}, action: '/businesses' });
});
app.post('/businesses', requireAuth, requireRole('admin', 'partner'), (req, res) => {
  db.businesses.insert({
    name: req.body.name, type: req.body.type, description: req.body.description,
    city: req.body.city, address: req.body.address, phone: req.body.phone, status: req.body.status || 'active'
  });
  res.redirect('/businesses');
});
app.get('/businesses/:id', requireAuth, (req, res) => {
  const b = db.businesses.findById(req.params.id);
  if (!b) return res.status(404).send('Не найдено');
  if (!canAccessBusiness(req.user, b.id)) return res.status(403).send('Доступ запрещен');
  const employees = db.users.filter(u => u.business_id === b.id);
  const tasks = db.tasks.filter(t => t.business_id === b.id).map(recalcTaskStatus);
  const finance = db.finance_reports.filter(f => f.business_id === b.id);
  res.render('business_view', { biz: b, employees, tasks, finance });
});
app.get('/businesses/:id/edit', requireAuth, requireRole('admin', 'partner'), (req, res) => {
  const b = db.businesses.findById(req.params.id);
  if (!b) return res.status(404).send('Не найдено');
  res.render('business_form', { item: b, action: '/businesses/' + b.id });
});
app.post('/businesses/:id', requireAuth, requireRole('admin', 'partner'), (req, res) => {
  db.businesses.update(req.params.id, req.body);
  res.redirect('/businesses/' + req.params.id);
});
app.post('/businesses/:id/delete', requireAuth, requireRole('admin'), (req, res) => {
  db.businesses.remove(req.params.id);
  res.redirect('/businesses');
});

// --- EMPLOYEES ---
app.get('/employees', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  let list = db.users.filter(u => u.role !== 'admin');
  if (req.user.role === 'manager') list = list.filter(u => u.business_id === req.user.business_id);
  res.render('employees', { items: list });
});
app.get('/employees/new', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  res.render('employee_form', { item: {}, action: '/employees' });
});
app.post('/employees', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  const body = req.body;
  if (req.user.role === 'manager') body.business_id = req.user.business_id;
  const hash = bcrypt.hashSync(body.password || 'changeme', 8);
  db.users.insert({
    name: body.name, surname: body.surname, phone: body.phone, email: body.email,
    password_hash: hash, role: body.role || 'employee', business_id: body.business_id || '',
    status: body.status || 'active'
  });
  res.redirect('/employees');
});
app.get('/employees/:id', requireAuth, (req, res) => {
  const emp = db.users.findById(req.params.id);
  if (!emp) return res.status(404).send('Не найдено');
  if (req.user.role === 'manager' && emp.business_id !== req.user.business_id) return res.status(403).send('Доступ запрещен');
  if (req.user.role === 'employee' && emp.id !== req.user.id) return res.status(403).send('Доступ запрещен');
  const tasks = db.tasks.filter(t => t.employee_id === emp.id).map(recalcTaskStatus);
  const biz = emp.business_id ? db.businesses.findById(emp.business_id) : null;
  res.render('employee_view', { emp, tasks, biz });
});
app.get('/employees/:id/edit', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  const emp = db.users.findById(req.params.id);
  if (!emp) return res.status(404).send('Не найдено');
  res.render('employee_form', { item: emp, action: '/employees/' + emp.id });
});
app.post('/employees/:id', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  const patch = { ...req.body };
  if (patch.password) { patch.password_hash = bcrypt.hashSync(patch.password, 8); }
  delete patch.password;
  db.users.update(req.params.id, patch);
  res.redirect('/employees/' + req.params.id);
});
app.post('/employees/:id/delete', requireAuth, requireRole('admin', 'partner'), (req, res) => {
  db.users.remove(req.params.id);
  res.redirect('/employees');
});

// --- TASKS ---
app.get('/tasks', requireAuth, (req, res) => {
  let list = db.tasks.all().map(recalcTaskStatus);
  if (req.user.role === 'manager') list = list.filter(t => t.business_id === req.user.business_id);
  else if (req.user.role === 'employee' || req.user.role === 'accountant') list = list.filter(t => t.employee_id === req.user.id);

  const { business_id, employee_id, date, status } = req.query;
  if (business_id) list = list.filter(t => t.business_id === business_id);
  if (employee_id) list = list.filter(t => t.employee_id === employee_id);
  if (date) list = list.filter(t => t.task_date === date);
  if (status) list = list.filter(t => t.status === status);

  const employees = db.users.filter(u => u.role !== 'admin');
  res.render('tasks', { items: list, employees, filters: req.query });
});
app.get('/tasks/new', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  let employees = db.users.filter(u => u.role !== 'admin' && u.status === 'active');
  if (req.user.role === 'manager') employees = employees.filter(e => e.business_id === req.user.business_id);
  res.render('task_form', { item: {}, employees, action: '/tasks' });
});
app.post('/tasks', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  const emp = db.users.findById(req.body.employee_id);
  const t = db.tasks.insert({
    business_id: emp ? emp.business_id : '',
    employee_id: req.body.employee_id,
    created_by: req.user.id,
    title: req.body.title, description: req.body.description,
    task_date: req.body.task_date, deadline_time: req.body.deadline_time,
    priority: req.body.priority || 'medium',
    planned_value: req.body.planned_value || '',
    actual_value: '', unit: req.body.unit || '',
    status: 'new', manager_comment: req.body.manager_comment || '',
    employee_comment: '', completion_percent: '0'
  });
  db.task_history.insert({ task_id: t.id, user_id: req.user.id, action: 'created', old_value: '', new_value: t.title });
  if (emp) notify(emp.id, 'Новая задача', t.title);
  res.redirect('/tasks');
});
app.get('/tasks/:id', requireAuth, (req, res) => {
  const t = db.tasks.findById(req.params.id);
  if (!t) return res.status(404).send('Не найдено');
  if (req.user.role === 'employee' && t.employee_id !== req.user.id) return res.status(403).send('Доступ запрещен');
  if (req.user.role === 'manager' && t.business_id !== req.user.business_id) return res.status(403).send('Доступ запрещен');
  recalcTaskStatus(t);
  const emp = db.users.findById(t.employee_id);
  const biz = db.businesses.findById(t.business_id);
  const history = db.task_history.filter(h => h.task_id === t.id);
  res.render('task_view', { t, emp, biz, history });
});
app.post('/tasks/:id', requireAuth, (req, res) => {
  const t = db.tasks.findById(req.params.id);
  if (!t) return res.status(404).send('Не найдено');
  const isOwner = t.employee_id === req.user.id;
  const isManager = ['admin','partner','manager'].includes(req.user.role);
  if (!isOwner && !isManager) return res.status(403).send('Доступ запрещен');

  const patch = {};
  if (isManager) {
    ['title','description','task_date','deadline_time','priority','planned_value','unit','manager_comment','employee_id'].forEach(k => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
  }
  if (req.body.status) patch.status = req.body.status;
  if (req.body.actual_value !== undefined) patch.actual_value = req.body.actual_value;
  if (req.body.employee_comment !== undefined) patch.employee_comment = req.body.employee_comment;

  const plan = parseFloat(patch.planned_value || t.planned_value) || 0;
  const fact = parseFloat(patch.actual_value !== undefined ? patch.actual_value : t.actual_value) || 0;
  if (plan > 0) patch.completion_percent = Math.round((fact / plan) * 100);

  db.tasks.update(t.id, patch);
  db.task_history.insert({ task_id: t.id, user_id: req.user.id, action: 'updated', old_value: t.status, new_value: patch.status || t.status });
  if (patch.status === 'completed') notify(t.created_by, 'Задача выполнена', t.title);
  res.redirect('/tasks/' + t.id);
});
app.post('/tasks/:id/delete', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  db.tasks.remove(req.params.id);
  res.redirect('/tasks');
});

// --- MY TASKS (employee personal cabinet) ---
app.get('/my-tasks', requireAuth, (req, res) => {
  const tasks = db.tasks.filter(t => t.employee_id === req.user.id).map(recalcTaskStatus);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  res.render('my_tasks', {
    today: tasks.filter(t => t.task_date === today),
    tomorrow: tasks.filter(t => t.task_date === tomorrow),
    future: tasks.filter(t => t.task_date > tomorrow),
    done: tasks.filter(t => t.status === 'completed'),
    overdue: tasks.filter(t => t.status === 'overdue')
  });
});

// --- FINANCE ---
app.get('/finance', requireAuth, (req, res) => {
  let list = db.finance_reports.all();
  if (req.user.role === 'manager' || req.user.role === 'accountant') {
    list = list.filter(f => f.business_id === req.user.business_id);
  }
  const { business_id, date } = req.query;
  if (business_id) list = list.filter(f => f.business_id === business_id);
  if (date) list = list.filter(f => f.report_date === date);
  list.sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''));
  res.render('finance', { items: list, files: db.files.all(), filters: req.query });
});
app.get('/finance/new', requireAuth, requireRole('admin', 'partner', 'manager', 'accountant'), (req, res) => {
  res.render('finance_form', { item: {} });
});
app.post('/finance', requireAuth, requireRole('admin', 'partner', 'manager', 'accountant'), upload.single('excel'), (req, res) => {
  let fileId = '';
  if (req.file) {
    const f = db.files.insert({
      uploaded_by: req.user.id, business_id: req.body.business_id,
      original_name: req.file.originalname, file_path: req.file.filename,
      file_type: req.file.mimetype, file_size: String(req.file.size)
    });
    fileId = f.id;
  }
  const revenue = parseFloat(req.body.revenue) || 0;
  const expenses = parseFloat(req.body.expenses) || 0;
  db.finance_reports.insert({
    business_id: req.body.business_id, accountant_id: req.user.id,
    report_date: req.body.report_date, revenue: String(revenue),
    expenses: String(expenses), profit: String(revenue - expenses),
    comment: req.body.comment || '', file_id: fileId
  });
  res.redirect('/finance');
});
app.get('/finance/file/:id', requireAuth, (req, res) => {
  const f = db.files.findById(req.params.id);
  if (!f) return res.status(404).send('Файл не найден');
  if (!canAccessBusiness(req.user, f.business_id)) return res.status(403).send('Доступ запрещен');
  res.download(path.join(db.UPLOAD_DIR, f.file_path), f.original_name);
});

// --- REPORTS ---
app.get('/reports', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  let tasks = db.tasks.all().map(recalcTaskStatus);
  if (req.user.role === 'manager') tasks = tasks.filter(t => t.business_id === req.user.business_id);
  const { business_id, employee_id, date, status } = req.query;
  if (business_id) tasks = tasks.filter(t => t.business_id === business_id);
  if (employee_id) tasks = tasks.filter(t => t.employee_id === employee_id);
  if (date) tasks = tasks.filter(t => t.task_date === date);
  if (status) tasks = tasks.filter(t => t.status === status);
  const users = db.users.all();
  res.render('reports', { items: tasks, users, filters: req.query });
});

// --- ANALYTICS ---
app.get('/analytics', requireAuth, requireRole('admin', 'partner', 'manager'), (req, res) => {
  let tasks = db.tasks.all().map(recalcTaskStatus);
  let finance = db.finance_reports.all();
  if (req.user.role === 'manager') {
    tasks = tasks.filter(t => t.business_id === req.user.business_id);
    finance = finance.filter(f => f.business_id === req.user.business_id);
  }
  const taskStats = {
    total: tasks.length,
    done: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    overdue: tasks.filter(t => t.status === 'overdue').length,
    partial: tasks.filter(t => t.status === 'partial').length
  };
  const employees = db.users.filter(u => u.role === 'employee' || u.role === 'manager');
  const empStats = employees.map(e => {
    const my = tasks.filter(t => t.employee_id === e.id);
    const done = my.filter(t => t.status === 'completed').length;
    const avg = my.length ? Math.round(my.reduce((s, t) => s + (parseInt(t.completion_percent) || 0), 0) / my.length) : 0;
    return { name: e.name + ' ' + e.surname, total: my.length, done, not_done: my.length - done, avg };
  });
  const byDate = {};
  finance.forEach(f => {
    if (!byDate[f.report_date]) byDate[f.report_date] = { revenue: 0, expenses: 0, profit: 0 };
    byDate[f.report_date].revenue += parseFloat(f.revenue) || 0;
    byDate[f.report_date].expenses += parseFloat(f.expenses) || 0;
    byDate[f.report_date].profit += parseFloat(f.profit) || 0;
  });
  const dates = Object.keys(byDate).sort();
  res.render('analytics', { taskStats, empStats, dates, byDate });
});

// --- NOTIFICATIONS ---
app.get('/notifications', requireAuth, (req, res) => {
  const items = db.notifications.filter(n => n.user_id === req.user.id).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.render('notifications', { items });
});
app.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.notifications.update(req.params.id, { is_read: '1' });
  res.redirect('/notifications');
});

app.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
