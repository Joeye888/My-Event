const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const scrypt = promisify(crypto.scrypt);
const DEMO_ACCOUNTS = {
  N000001: { password: '990101-14-0001', role: 'crew', name: 'John Doe' },
  S000001: { password: 'Supervisor@123', role: 'supervisor', name: 'Event Kaki Supervisor' }
};
const activeSessions = new Map();
const SHIFT_START_MINUTES = 9 * 60;
const SHIFT_END_MINUTES = 18 * 60;
const SCHEDULE_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const CHECKIN_LOCATION = {
  latitude: Number(process.env.CHECKIN_LATITUDE || 3.1579),
  longitude: Number(process.env.CHECKIN_LONGITUDE || 101.7116),
  radiusMeters: 150
};

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '16mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Initialize SQLite Database
const db = new sqlite3.Database(path.join(__dirname, 'event_kaki.db'), (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    // Employees table
    db.run(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        position TEXT,
        department TEXT,
        document_type TEXT,
        document_number TEXT,
        current_address TEXT,
        gender TEXT,
        document_name TEXT,
        document_mime_type TEXT,
        document_data BLOB,
        profile_photo_mime_type TEXT,
        profile_photo_data BLOB,
        password_salt TEXT,
        password_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.all('PRAGMA table_info(employees)', (err, columns) => {
      if (err) return console.error('Unable to inspect employees schema:', err.message);
      const existing = new Set(columns.map(column => column.name));
      [
        ['document_type', 'TEXT'],
        ['document_number', 'TEXT'],
        ['current_address', 'TEXT'],
        ['gender', 'TEXT'],
        ['document_name', 'TEXT'],
        ['document_mime_type', 'TEXT'],
        ['document_data', 'BLOB'],
        ['profile_photo_mime_type', 'TEXT'],
        ['profile_photo_data', 'BLOB'],
        ['password_salt', 'TEXT'],
        ['password_hash', 'TEXT']
      ].forEach(([name, definition]) => {
        if (!existing.has(name)) db.run(`ALTER TABLE employees ADD COLUMN ${name} ${definition}`);
      });
    });

    // Attendance records table
    db.run(`
      CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        job_application_id TEXT,
        check_in_time DATETIME,
        check_out_time DATETIME,
        hours_worked REAL,
        date DATE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id),
        UNIQUE(employee_id, date)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS profile_change_requests (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        proposed_profile TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_by TEXT,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        location TEXT NOT NULL,
        date TEXT NOT NULL,
        date_key TEXT NOT NULL,
        requirements TEXT NOT NULL DEFAULT '[]',
        client_notice TEXT NOT NULL,
        sections TEXT NOT NULL,
        job_type TEXT,
        call_time TEXT,
        end_time TEXT,
        dress_code TEXT,
        food_provided INTEGER NOT NULL DEFAULT 0,
        wage REAL,
        pax INTEGER,
        notes TEXT,
        application_deadline TEXT,
        auto_cancel INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS job_applications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        section TEXT NOT NULL,
        shift_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Applied',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(job_id, employee_id, section, shift_time)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS crew_booking_restrictions (
        employee_id TEXT PRIMARY KEY,
        blocked_until DATETIME NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS application_cancellation_requests (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL UNIQUE,
        employee_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_name TEXT NOT NULL,
        evidence_mime_type TEXT NOT NULL,
        evidence_data BLOB NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_by TEXT,
        reviewed_at DATETIME,
        FOREIGN KEY (application_id) REFERENCES job_applications(id),
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    // Add fields introduced after the original jobs schema (safe for existing databases).
    db.all('PRAGMA table_info(jobs)', (err, columns) => {
      if (err) return console.error('Unable to inspect jobs schema:', err.message);
      const existing = new Set(columns.map(column => column.name));
      [
        ['job_type', 'TEXT'], ['call_time', 'TEXT'], ['end_time', 'TEXT'],
        ['dress_code', 'TEXT'], ['food_provided', 'INTEGER NOT NULL DEFAULT 0'],
        ['wage', 'REAL'], ['pax', 'INTEGER'], ['notes', 'TEXT'],
        ['application_deadline', 'TEXT'], ['auto_cancel', 'INTEGER NOT NULL DEFAULT 0']
      ].forEach(([name, definition]) => {
        if (!existing.has(name)) db.run(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      });
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS wallets (
        employee_id TEXT PRIMARY KEY,
        available_balance REAL NOT NULL DEFAULT 0,
        pending_balance REAL NOT NULL DEFAULT 0,
        paid_balance REAL NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        title TEXT NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        reference TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    db.all('PRAGMA table_info(attendance)', (err, columns) => {
      if (err) {
        console.error('Unable to inspect attendance schema:', err.message);
        return;
      }

      const existingColumns = new Set(columns.map(column => column.name));
      const migrations = [
        ['job_application_id', 'TEXT'],
        ['late_minutes', 'INTEGER NOT NULL DEFAULT 0'],
        ['early_leave_minutes', 'INTEGER NOT NULL DEFAULT 0'],
        ['attendance_status', "TEXT NOT NULL DEFAULT 'on_time'"]
      ];

      migrations.forEach(([name, definition]) => {
        if (!existingColumns.has(name)) {
          db.run(`ALTER TABLE attendance ADD COLUMN ${name} ${definition}`, migrationError => {
            if (migrationError) {
              console.error(`Unable to add attendance.${name}:`, migrationError.message);
            }
          });
        }
      });
    });

    // Seed demo employees if table is empty
    db.all('SELECT COUNT(*) as count FROM employees', (err, rows) => {
      if (rows && rows[0].count === 0) {
        const demoEmployees = [
          { id: 'N000001', name: 'John Doe', email: 'john@eventkai.com', position: 'Event Coordinator', department: 'Operations' },
          { id: 'N000002', name: 'Jane Smith', email: 'jane@eventkai.com', position: 'Event Manager', department: 'Management' },
          { id: 'N000003', name: 'Mike Johnson', email: 'mike@eventkai.com', position: 'Crew Member', department: 'Operations' },
          { id: 'B000001', name: 'Sarah Williams', email: 'sarah@eventkai.com', position: 'Marketing', department: 'Marketing' }
        ];

        demoEmployees.forEach(emp => {
          db.run(
            'INSERT INTO employees (id, name, email, position, department) VALUES (?, ?, ?, ?, ?)',
            [emp.id, emp.name, emp.email, emp.position, emp.department]
          );
        });

        console.log('Demo employees created');
      }

    });

    db.get('SELECT COUNT(*) AS count FROM jobs', (err, row) => {
      if (err || !row || row.count !== 0) return;
      const demoJob = {
        id: 'demo-catering-setup',
        title: 'Catering & Setup Crew',
        location: 'KLCC, Kuala Lumpur',
        date: 'Today · 23 September 2026',
        dateKey: '2026-09-23',
        requirements: ['WAJIB ADA TYPHOID'],
        clientNotice: 'Last-minute crew requests are subject to an additional service charge.',
        sections: [
          { title: 'CATERING', shifts: [{ time: '10:00 AM', pax: 3 }] },
          { title: 'COMMERCIAL CATERING', shifts: [
            { time: '9:00 AM', pax: 1 },
            { time: '10:00 AM', pax: 2 },
            { time: '11:00 AM', pax: 1 },
            { time: '12:00 PM', pax: 1 }
          ] },
          { title: 'SETUP', requirement: 'MALE ONLY', shifts: [
            { time: '9:00 AM', pax: 3 },
            { time: '11:00 AM', pax: 2 },
            { time: '5:00 PM', pax: 1, note: 'LONG HOUR' }
          ] }
        ]
      };
      db.run(
        `INSERT INTO jobs (id, title, location, date, date_key, requirements, client_notice, sections, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          demoJob.id,
          demoJob.title,
          demoJob.location,
          demoJob.date,
          demoJob.dateKey,
          JSON.stringify(demoJob.requirements),
          demoJob.clientNotice,
          JSON.stringify(demoJob.sections),
          'S000001'
        ]
      );
    });

    console.log('Database initialized');
  });
}

function getScheduleMetrics(timestamp) {
  const date = new Date(timestamp);
  const minutes = (
    date.getUTCHours() * 60
    + date.getUTCMinutes()
    + SCHEDULE_TIMEZONE_OFFSET_MINUTES
  ) % (24 * 60);
  const lateMinutes = Math.max(0, minutes - SHIFT_START_MINUTES);
  const earlyLeaveMinutes = Math.max(0, SHIFT_END_MINUTES - minutes);

  return {
    lateMinutes,
    earlyLeaveMinutes,
    attendanceStatus: lateMinutes > 0 && earlyLeaveMinutes > 0
      ? 'late_and_early_leave'
      : lateMinutes > 0
        ? 'late'
        : earlyLeaveMinutes > 0
          ? 'early_leave'
          : 'on_time'
  };
}

function getCheckInMetrics(timestamp) {
  const metrics = getScheduleMetrics(timestamp);
  return {
    lateMinutes: metrics.lateMinutes,
    attendanceStatus: metrics.lateMinutes > 0 ? 'late' : 'on_time'
  };
}

function getAttendanceStatus(row) {
  if (!row || !row.check_in_time) {
    return {
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      attendanceStatus: 'not_checked_in'
    };
  }

  const checkInMetrics = getCheckInMetrics(row.check_in_time);
  const checkOutMetrics = row.check_out_time ? getScheduleMetrics(row.check_out_time) : null;
  const lateMinutes = Math.max(Number(row.late_minutes) || 0, checkInMetrics.lateMinutes);
  const earlyLeaveMinutes = row.check_out_time
    ? Math.max(Number(row.early_leave_minutes) || 0, checkOutMetrics.earlyLeaveMinutes)
    : 0;

  return {
    lateMinutes,
    earlyLeaveMinutes,
    attendanceStatus: lateMinutes > 0 && earlyLeaveMinutes > 0
      ? 'late_and_early_leave'
      : lateMinutes > 0
        ? 'late'
        : earlyLeaveMinutes > 0
          ? 'early_leave'
          : row.check_out_time ? 'on_time' : 'in_progress'
  };
}

// API Routes

function requireSupervisor(req, res, next) {
  const session = activeSessions.get(req.get('x-auth-token'));
  if (!session || session.role !== 'supervisor') {
    return res.status(403).json({ message: 'Supervisor access is required' });
  }
  req.session = session;
  next();
}

function requireCrew(req, res, next) {
  const session = activeSessions.get(req.get('x-auth-token'));
  if (!session || session.role !== 'crew') {
    return res.status(403).json({ message: 'Crew access is required' });
  }
  if (req.body.employeeId && req.body.employeeId !== session.employeeId) {
    return res.status(403).json({ message: 'You can only access your own attendance' });
  }
  if (req.params.employeeId && req.params.employeeId !== session.employeeId) {
    return res.status(403).json({ message: 'You can only access your own attendance' });
  }
  req.session = session;
  next();
}

function requireAuthenticated(req, res, next) {
  const session = activeSessions.get(req.get('x-auth-token'));
  if (!session) {
    return res.status(401).json({ message: 'Authentication is required' });
  }
  req.session = session;
  next();
}

function parseJob(row) {
  const sections = JSON.parse(row.sections || '[]');
  const sectionPax = sections.reduce((total, section) =>
    total + (section.shifts || []).reduce((sum, shift) => sum + (Number(shift.pax) || 0), 0), 0);
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    date: row.date,
    dateKey: row.date_key,
    requirements: JSON.parse(row.requirements || '[]'),
    clientNotice: row.client_notice,
    sections,
    status: row.status,
    jobType: row.job_type || row.jobType || null,
    callTime: row.call_time || row.callTime || null,
    endTime: row.end_time || row.endTime || null,
    dressCode: row.dress_code || row.dressCode || null,
    foodProvided: Boolean(row.food_provided),
    wage: row.wage == null ? null : Number(row.wage),
    pax: row.pax == null ? sectionPax : Number(row.pax),
    notes: row.notes || null,
    applicationDeadline: row.application_deadline || null,
    autoCancel: Boolean(row.auto_cancel),
    paxAvailable: null
  };
}

function dateTimeForJob(job, time) {
  if (!time) return null;
  const date = job.date_key || job.dateKey;
  if (!date) return null;
  const value = String(time);
  const iso = value.match(/^\d{4}-\d{2}-\d{2}T/) ? value : `${date}T${value}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isEventInThePast(job) {
  const eventDate = String(job.date_key || '').slice(0, 10);
  if (!eventDate) return false;
  const today = malaysiaDateKey();
  if (eventDate < today) return true;
  const endTime = dateTimeForJob(job, job.end_time);
  return eventDate === today && Boolean(endTime && endTime < new Date());
}

function normalizeApplicationStatus(value) {
  const status = String(value || '').trim();
  if (!status) return 'Pending';
  const lookup = {
    Applied: 'Pending',
    'Job cancelled': 'Cancelled',
    'job cancelled': 'Cancelled',
    cancelled: 'Cancelled',
    approved: 'Approved',
    rejected: 'Rejected',
    pending: 'Pending',
    expired: 'Expired'
  };
  return lookup[status] || status;
}

function refreshJobStatuses(done) {
  let completed = false;
  const finish = err => {
    if (completed) return;
    completed = true;
    if (done) done(err || null);
  };
  db.all("SELECT * FROM jobs WHERE status IN ('open','Open','Job Full')", (err, jobs) => {
    if (err) return finish(err);
    if (!jobs || !jobs.length) return finish(null);

    let pending = jobs.length;
    jobs.forEach(job => {
      const now = new Date();
      const deadline = job.application_deadline && new Date(job.application_deadline);
      const callTime = dateTimeForJob(job, job.call_time);
      const autoCancelAt = callTime ? new Date(callTime.getTime() + 2 * 60 * 60 * 1000) : null;
      const shouldExpire = (deadline && !Number.isNaN(deadline.getTime()) && deadline < now)
        || (Boolean(job.auto_cancel) && autoCancelAt && autoCancelAt <= now);

      if (shouldExpire) {
        db.run("UPDATE jobs SET status = 'Expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [job.id], updateError => {
            if (updateError) return finish(updateError);
            db.run(
              "UPDATE job_applications SET status = 'Cancelled', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status IN ('Pending','Applied','Approved')",
              [job.id],
              applicationError => {
                if (applicationError) return finish(applicationError);
                db.run(
                  `UPDATE application_cancellation_requests SET status = 'Cancelled'
                   WHERE status = 'Pending' AND application_id IN
                     (SELECT id FROM job_applications WHERE job_id = ?)`,
                  [job.id],
                  requestError => requestError ? finish(requestError) : finishJob()
                );
              }
            );
          });
      } else {
        db.get(
          "SELECT COUNT(*) AS assigned FROM job_applications WHERE job_id = ? AND status = 'Approved'",
          [job.id],
          (countError, countRow) => {
            if (countError) return finish(countError);
            const capacity = Math.max(0, Number(job.pax) || 0);
            const nextStatus = capacity > 0 && Number(countRow.assigned || 0) >= capacity ? 'Job Full' : 'open';
            if (job.status === nextStatus) return finishJob();
            db.run(
              'UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [nextStatus, job.id],
              updateError => updateError ? finish(updateError) : finishJob()
            );
          }
        );
      }

      function finishJob() {
        pending -= 1;
        if (pending <= 0) finish(null);
      }
    });
  });
}

function enrichJobs(rows, callback) {
  if (!rows.length) return callback(null, []);
  let remaining = rows.length;
  const result = new Map();
  rows.forEach(row => {
    const job = parseJob(row);
    db.get(
      `SELECT COUNT(*) AS applied,
              SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END) AS assigned,
              SUM(CASE WHEN status IN ('Pending','Applied') THEN 1 ELSE 0 END) AS pending
       FROM job_applications WHERE job_id = ?`,
      [row.id],
      (err, counts) => {
        if (err) return callback(err);
        const applied = Number(counts.applied || 0);
        const assigned = Number(counts.assigned || 0);
        const pendingCount = Number(counts.pending || 0);
        job.applicationsCount = applied;
        job.assignedCrewCount = assigned;
        job.pendingApplicationsCount = pendingCount;
        job.paxAvailable = Math.max(0, (Number(job.pax) || 0) - assigned - pendingCount);
        const eventDate = String(job.dateKey || '').slice(0, 10);
        const today = malaysiaDateKey();
        const callTime = dateTimeForJob(job, job.callTime);
        const endTime = dateTimeForJob(job, job.endTime);
        const now = new Date();
        if (['Cancelled', 'Expired'].includes(job.status)) job.displayStatus = job.status;
        else if (eventDate && eventDate < today) job.displayStatus = 'Completed';
        else if (eventDate === today && endTime && endTime < now) job.displayStatus = 'Completed';
        else if (eventDate === today && callTime && callTime <= now) job.displayStatus = 'Ongoing';
        else job.displayStatus = job.status === 'Job Full' ? 'Job Full' : 'Open';
        result.set(job.id, job);
        if (!--remaining) callback(null, rows.map(item => result.get(item.id)));
      }
    );
  });
}

function distanceInMeters(latitude, longitude) {
  const earthRadius = 6371000;
  const toRadians = value => value * Math.PI / 180;
  const dLat = toRadians(latitude - CHECKIN_LOCATION.latitude);
  const dLon = toRadians(longitude - CHECKIN_LOCATION.longitude);
  const lat1 = toRadians(CHECKIN_LOCATION.latitude);
  const lat2 = toRadians(latitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function malaysiaDateKey(date = new Date()) {
  return new Date(date.getTime() + SCHEDULE_TIMEZONE_OFFSET_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

app.post('/api/auth/login', (req, res) => {
  const employeeId = String(req.body.employeeId || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const account = DEMO_ACCOUNTS[employeeId];

  if (account) {
    if (account.password !== password) {
      return res.status(401).json({ message: 'Invalid employee ID or password' });
    }
    const token = uuidv4();
    activeSessions.set(token, { employeeId, role: account.role });
    return res.json({ employeeId, role: account.role, name: account.name, token });
  }

  db.get(
    'SELECT id, name, password_salt, password_hash FROM employees WHERE id = ?',
    [employeeId],
    async (err, employee) => {
      if (err) return res.status(500).json({ message: 'Unable to authenticate account', error: err.message });
      if (!employee || !employee.password_hash || !employee.password_salt) {
        return res.status(401).json({ message: 'Invalid employee ID or password' });
      }
      try {
        const submittedHash = await scrypt(password, employee.password_salt, 64);
        const storedHash = Buffer.from(employee.password_hash, 'hex');
        if (storedHash.length !== submittedHash.length || !crypto.timingSafeEqual(storedHash, submittedHash)) {
          return res.status(401).json({ message: 'Invalid employee ID or password' });
        }
        const token = uuidv4();
        activeSessions.set(token, { employeeId: employee.id, role: 'crew' });
        res.json({ employeeId: employee.id, role: 'crew', name: employee.name, token });
      } catch (hashError) {
        res.status(500).json({ message: 'Unable to verify account password', error: hashError.message });
      }
    }
  );
});

app.post('/api/auth/register', async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const phone = String(req.body.phone || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const documentType = String(req.body.documentType || '').trim();
  const documentNumber = String(req.body.documentNumber || '').trim().toUpperCase();
  const currentAddress = String(req.body.currentAddress || '').trim();
  const gender = String(req.body.gender || '').trim();
  const password = String(req.body.password || '');
  const documentData = String(req.body.documentData || '');
  const profilePhotoData = String(req.body.profilePhotoData || '');
  const documentName = String(req.body.documentName || '').trim().slice(0, 160);
  const documentMatch = documentData.match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/);
  const profilePhotoMatch = profilePhotoData.match(/^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/);

  if (!fullName || !phone || !email || !documentType || !documentNumber || !currentAddress || !gender || !password || !documentMatch || !profilePhotoMatch) {
    return res.status(400).json({ message: 'Complete all required fields, capture a profile photo, and upload your ID document' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Enter a valid email address' });
  }
  if (!['MyKad', 'Passport'].includes(documentType)) {
    return res.status(400).json({ message: 'Document type must be MyKad or Passport' });
  }
  if (documentType === 'MyKad') {
    const myKadMatch = documentNumber.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})-(\d{4})$/);
    if (!myKadMatch) {
      return res.status(400).json({ message: 'MyKad number must use the 12-digit YYMMDD-PB-#### format' });
    }
    const yearPrefix = Number(myKadMatch[1]);
    const currentYearPrefix = new Date().getFullYear() % 100;
    const year = yearPrefix <= currentYearPrefix ? 2000 + yearPrefix : 1900 + yearPrefix;
    const month = Number(myKadMatch[2]);
    const day = Number(myKadMatch[3]);
    const birthDate = new Date(year, month - 1, day);
    if (birthDate.getFullYear() !== year || birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) {
      return res.status(400).json({ message: 'MyKad number must contain a valid birth date' });
    }
  } else if (!/^[A-Z0-9]{5,20}$/.test(documentNumber)) {
    return res.status(400).json({ message: 'Enter a valid passport number using 5 to 20 letters or numbers' });
  }
  if (!['Male', 'Female'].includes(gender)) {
    return res.status(400).json({ message: 'Select Male or Female for gender' });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' });
  }

  const documentBytes = Buffer.from(documentMatch[2], 'base64');
  if (!documentBytes.length || documentBytes.length > 8 * 1024 * 1024 || documentBytes.toString('base64') !== documentMatch[2]) {
    return res.status(400).json({ message: 'ID document must be a valid PDF or image no larger than 8 MB' });
  }
  const profilePhotoBytes = Buffer.from(profilePhotoMatch[2], 'base64');
  if (!profilePhotoBytes.length || profilePhotoBytes.length > 2 * 1024 * 1024 || profilePhotoBytes.toString('base64') !== profilePhotoMatch[2]) {
    return res.status(400).json({ message: 'Profile photo must be a valid image no larger than 2 MB' });
  }

  db.get(
    `SELECT id FROM employees
     WHERE lower(email) = ? OR (document_number IS NOT NULL AND upper(document_number) = ?)
     LIMIT 1`,
    [email, documentNumber],
    async (lookupError, existing) => {
      if (lookupError) return res.status(500).json({ message: 'Unable to check registration details', error: lookupError.message });
      if (existing) return res.status(409).json({ message: 'This email address or document number is already registered' });

      try {
        const employeeId = `N${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
        const documentMimeType = documentMatch[1];
        const inferredExtension = documentMimeType === 'application/pdf'
          ? '.pdf'
          : documentMimeType === 'image/png' ? '.png' : '.jpg';
        const safeDocumentName = documentName || `identity-document${inferredExtension}`;

        db.run(
          `INSERT INTO employees
           (id, name, email, phone, document_type, document_number, current_address, gender,
            document_name, document_mime_type, document_data, profile_photo_mime_type, profile_photo_data,
            password_salt, password_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            employeeId, fullName, email, phone, documentType, documentNumber, currentAddress, gender,
            safeDocumentName, documentMimeType, documentBytes, profilePhotoMatch[1], profilePhotoBytes,
            salt, passwordHash
          ],
          function (insertError) {
            if (insertError) {
              if (insertError.code === 'SQLITE_CONSTRAINT') {
                return res.status(409).json({ message: 'Unable to create account because these details are already registered' });
              }
              return res.status(500).json({ message: 'Unable to create account', error: insertError.message });
            }
            const token = uuidv4();
            activeSessions.set(token, { employeeId, role: 'crew' });
            res.status(201).json({ employeeId, role: 'crew', name: fullName, token });
          }
        );
      } catch (hashError) {
        res.status(500).json({ message: 'Unable to secure account password', error: hashError.message });
      }
    }
  );
});

app.get('/api/profile', requireAuthenticated, (req, res) => {
  db.get(
    `SELECT id, name, email, phone, document_type, document_number, current_address, gender,
            profile_photo_mime_type, profile_photo_data,
            (SELECT status FROM profile_change_requests
             WHERE employee_id = employees.id ORDER BY created_at DESC LIMIT 1) AS latest_change_request_status
     FROM employees WHERE id = ?`,
    [req.session.employeeId],
    (err, employee) => {
      if (err) return res.status(500).json({ message: 'Unable to load profile', error: err.message });
      if (!employee) return res.status(404).json({ message: 'Profile not found' });
      const photo = employee.profile_photo_data
        ? `data:${employee.profile_photo_mime_type};base64,${Buffer.from(employee.profile_photo_data).toString('base64')}`
        : null;
      res.json({
        profile: {
          employeeId: employee.id,
          fullName: employee.name,
          email: employee.email,
          phone: employee.phone,
          documentType: employee.document_type,
          documentNumber: employee.document_number,
          currentAddress: employee.current_address,
          gender: employee.gender,
          profilePhoto: photo,
          latestChangeRequestStatus: employee.latest_change_request_status
        }
      });
    }
  );
});

app.post('/api/profile/change-requests', requireCrew, (req, res) => {
  const proposed = {
    name: String(req.body.name || '').trim(),
    document_type: String(req.body.documentType || '').trim(),
    document_number: String(req.body.documentNumber || '').trim().toUpperCase(),
    email: String(req.body.email || '').trim().toLowerCase(),
    phone: String(req.body.phone || '').trim(),
    current_address: String(req.body.currentAddress || '').trim(),
    gender: String(req.body.gender || '').trim()
  };
  if (!proposed.name || !proposed.email || !proposed.phone || !proposed.current_address
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proposed.email)
    || !['Male', 'Female'].includes(proposed.gender)
    || !['MyKad', 'Passport'].includes(proposed.document_type)
    || !proposed.document_number) {
    return res.status(400).json({ message: 'Provide valid name, identity document, email, phone, address and gender details' });
  }
  if (proposed.document_type === 'MyKad') {
    const match = proposed.document_number.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})-(\d{4})$/);
    if (!match) return res.status(400).json({ message: 'MyKad number must use the 12-digit YYMMDD-PB-#### format' });
    const yearPrefix = Number(match[1]);
    const currentYearPrefix = new Date().getFullYear() % 100;
    const year = yearPrefix <= currentYearPrefix ? 2000 + yearPrefix : 1900 + yearPrefix;
    const month = Number(match[2]);
    const day = Number(match[3]);
    const birthDate = new Date(year, month - 1, day);
    if (birthDate.getFullYear() !== year || birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) {
      return res.status(400).json({ message: 'MyKad number must contain a valid birth date' });
    }
  } else if (!/^[A-Z0-9]{5,20}$/.test(proposed.document_number)) {
    return res.status(400).json({ message: 'Enter a valid passport number using 5 to 20 letters or numbers' });
  }

  db.get(
    "SELECT id FROM profile_change_requests WHERE employee_id = ? AND status = 'Pending'",
    [req.session.employeeId],
    (pendingError, pending) => {
      if (pendingError) return res.status(500).json({ message: 'Unable to check pending requests', error: pendingError.message });
      if (pending) return res.status(409).json({ message: 'You already have a profile change request awaiting review' });

      db.get('SELECT id FROM employees WHERE lower(email) = ? AND id != ?', [proposed.email, req.session.employeeId], (emailError, duplicate) => {
        if (emailError) return res.status(500).json({ message: 'Unable to verify email address', error: emailError.message });
        if (duplicate) return res.status(409).json({ message: 'This email address is already in use' });
        const requestId = uuidv4();
        db.run(
          `INSERT INTO profile_change_requests (id, employee_id, proposed_profile)
           VALUES (?, ?, ?)`,
          [requestId, req.session.employeeId, JSON.stringify(proposed)],
          insertError => {
            if (insertError) return res.status(500).json({ message: 'Unable to submit profile change request', error: insertError.message });
            res.status(201).json({ message: 'Profile change request submitted', requestId, status: 'Pending' });
          }
        );
      });
    }
  );
});

app.get('/api/profile/change-requests', requireSupervisor, (req, res) => {
  db.all(
    `SELECT r.id, r.employee_id, r.proposed_profile, r.status, r.created_at, r.updated_at,
            e.name AS crew_name, e.email AS crew_email, e.document_type AS crew_document_type,
            e.document_number AS crew_document_number, e.phone AS crew_phone,
            e.current_address AS crew_address, e.gender AS crew_gender
     FROM profile_change_requests r
     JOIN employees e ON e.id = r.employee_id
     ORDER BY CASE WHEN r.status = 'Pending' THEN 0 ELSE 1 END, r.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ message: 'Unable to load profile change requests', error: err.message });
      res.json({
        requests: (rows || []).map(row => ({
          ...row,
          proposed_profile: JSON.parse(row.proposed_profile)
        }))
      });
    }
  );
});

app.patch('/api/profile/change-requests/:requestId/:decision', requireSupervisor, (req, res) => {
  const decision = req.params.decision === 'approve' ? 'Approved'
    : req.params.decision === 'reject' ? 'Rejected' : null;
  if (!decision) return res.status(400).json({ message: 'Decision must be approve or reject' });

  db.get(
    `SELECT r.*
     FROM profile_change_requests r JOIN employees e ON e.id = r.employee_id
     WHERE r.id = ?`,
    [req.params.requestId],
    (requestError, request) => {
      if (requestError) return res.status(500).json({ message: 'Unable to load profile change request', error: requestError.message });
      if (!request) return res.status(404).json({ message: 'Profile change request not found' });
      if (request.status !== 'Pending') return res.status(409).json({ message: 'Profile change request has already been reviewed' });

      const finishReview = () => db.run(
        `UPDATE profile_change_requests SET status = ?, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'Pending'`,
        [decision, req.session.employeeId, request.id],
        function (updateError) {
          if (updateError) return res.status(500).json({ message: 'Unable to update request status', error: updateError.message });
          if (!this.changes) return res.status(409).json({ message: 'Profile change request has already been reviewed' });
          res.json({ message: `Profile change request ${decision.toLowerCase()}`, status: decision });
        }
      );

      if (decision === 'Rejected') return finishReview();

      let proposed;
      try {
        proposed = JSON.parse(request.proposed_profile);
      } catch (parseError) {
        return res.status(500).json({ message: 'Stored profile change request is invalid', error: parseError.message });
      }
      db.get(
        'SELECT id FROM employees WHERE lower(email) = ? AND id != ?',
        [proposed.email, request.employee_id],
        (emailError, duplicate) => {
          if (emailError) return res.status(500).json({ message: 'Unable to verify proposed email', error: emailError.message });
          if (duplicate) return res.status(409).json({ message: 'Proposed email address is already in use' });
          db.get(
            'SELECT id FROM employees WHERE upper(document_number) = ? AND id != ?',
            [proposed.document_number, request.employee_id],
            (documentError, duplicateDocument) => {
              if (documentError) return res.status(500).json({ message: 'Unable to verify identity document number', error: documentError.message });
              if (duplicateDocument) return res.status(409).json({ message: 'Proposed identity document number is already in use' });
          db.serialize(() => {
            db.run('BEGIN IMMEDIATE TRANSACTION', beginError => {
              if (beginError) return res.status(500).json({ message: 'Unable to start profile update', error: beginError.message });
              db.run(
                `UPDATE employees
                 SET name = ?, document_type = ?, document_number = ?, email = ?, phone = ?,
                     current_address = ?, gender = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [proposed.name, proposed.document_type, proposed.document_number, proposed.email, proposed.phone, proposed.current_address, proposed.gender, request.employee_id],
                function (employeeError) {
                  if (employeeError || !this.changes) {
                    return db.run('ROLLBACK', () => {
                      if (employeeError) return res.status(500).json({ message: 'Unable to apply profile changes', error: employeeError.message });
                      res.status(404).json({ message: 'Crew account no longer exists' });
                    });
                  }
                  db.run(
                    `UPDATE profile_change_requests SET status = 'Approved', reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND status = 'Pending'`,
                    [req.session.employeeId, request.id],
                    function (requestUpdateError) {
                      if (requestUpdateError || !this.changes) {
                        return db.run('ROLLBACK', () => {
                          if (requestUpdateError) return res.status(500).json({ message: 'Unable to mark profile request approved', error: requestUpdateError.message });
                          res.status(409).json({ message: 'Profile change request has already been reviewed' });
                        });
                      }
                      db.run('COMMIT', commitError => {
                        if (commitError) {
                          return db.run('ROLLBACK', () => res.status(500).json({ message: 'Unable to complete profile update', error: commitError.message }));
                        }
                        res.json({ message: 'Profile change request approved', status: 'Approved' });
                      });
                    }
                  );
                }
              );
            });
          });
            }
          );
        }
      );
    }
  );
});

app.post('/api/auth/logout', (req, res) => {
  activeSessions.delete(req.get('x-auth-token'));
  res.status(204).end();
});

app.get('/api/jobs', requireAuthenticated, (req, res) => {
  refreshJobStatuses(refreshError => {
    if (refreshError) return res.status(500).json({ message: 'Unable to refresh job statuses', error: refreshError.message });
    const loadJobs = bookingRestriction => {
      if (req.session.role === 'crew' && bookingRestriction) {
        return res.json({
          jobs: [],
          bookingRestriction: {
            blockedUntil: bookingRestriction.blocked_until,
            reason: bookingRestriction.reason
          }
        });
      }
      const query = req.session.role === 'supervisor'
        ? 'SELECT * FROM jobs ORDER BY date_key DESC, created_at DESC'
        : "SELECT * FROM jobs WHERE status IN ('open','Open','Job Full') ORDER BY date_key ASC, created_at DESC";
    db.all(query, (err, rows) => {
      if (err) {
        return res.status(500).json({ message: 'Unable to load jobs', error: err.message });
      }
      enrichJobs(rows, (enrichError, jobs) => {
        if (enrichError) return res.status(500).json({ message: 'Unable to calculate job availability', error: enrichError.message });
        res.json({ jobs });
      });
    });
    };
    if (req.session.role !== 'crew') return loadJobs(null);
    db.get(
      'SELECT blocked_until, reason FROM crew_booking_restrictions WHERE employee_id = ? AND blocked_until > CURRENT_TIMESTAMP',
      [req.session.employeeId],
      (restrictionError, restriction) => {
        if (restrictionError) return res.status(500).json({ message: 'Unable to check booking eligibility', error: restrictionError.message });
        loadJobs(restriction || null);
      }
    );
  });
});

app.get('/api/jobs/:jobId/applications', requireAuthenticated, (req, res) => {
  db.all(
    `SELECT a.*, e.name AS crew_name, e.email AS crew_email, e.phone AS crew_phone,
            e.position AS crew_position, e.department AS crew_department
     FROM job_applications a
     LEFT JOIN employees e ON e.id = a.employee_id
     WHERE a.job_id = ?
     ORDER BY a.created_at DESC`,
    [req.params.jobId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: 'Unable to load job applications', error: err.message });
      res.json({ applications: rows || [] });
    }
  );
});

app.post('/api/jobs', requireSupervisor, (req, res) => {
  const { title, location, date, dateKey, requirements, clientNotice, sections,
    jobType, callTime, endTime, dressCode, foodProvided, wage, pax, notes,
    applicationDeadline, autoCancel } = req.body;
  if (!title || !location || !date || !dateKey || !Array.isArray(sections) || !sections.length) {
    return res.status(400).json({ message: 'Title, location, date, dateKey and sections are required' });
  }
  const id = uuidv4();
  db.run(
    `INSERT INTO jobs (id, title, location, date, date_key, requirements, client_notice, sections,
       job_type, call_time, end_time, dress_code, food_provided, wage, pax, notes, application_deadline, auto_cancel, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(title).trim(),
      String(location).trim(),
      String(date).trim(),
      String(dateKey).trim(),
      JSON.stringify(Array.isArray(requirements) ? requirements : []),
      String(clientNotice || '').trim() || 'Please arrive on time and follow the event supervisor instructions.',
      JSON.stringify(sections),
      jobType || null, callTime || null, endTime || null, dressCode || null,
      foodProvided ? 1 : 0, wage == null ? null : Number(wage),
      pax == null ? sections.reduce((sum, s) => sum + (s.shifts || []).reduce((n, x) => n + (Number(x.pax) || 0), 0), 0) : Number(pax),
      notes || null, applicationDeadline || null, autoCancel ? 1 : 0,
      activeSessions.get(req.get('x-auth-token')).employeeId
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ message: 'Unable to create job', error: err.message });
      }
      db.get('SELECT * FROM jobs WHERE id = ?', [id], (selectError, row) => {
        if (selectError) {
          return res.status(500).json({ message: 'Job created but could not be loaded', error: selectError.message });
        }
        res.status(201).json({ job: parseJob(row) });
      });
    }
  );
});

app.delete('/api/jobs/:jobId', requireSupervisor, (req, res) => {
  db.run(
    "UPDATE jobs SET status = 'Cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('open','Open','Job Full')",
    [req.params.jobId],
    function (err) {
      if (err) {
        return res.status(500).json({ message: 'Unable to cancel job', error: err.message });
      }
      if (!this.changes) {
        return res.status(404).json({ message: 'Active job not found' });
      }
      db.run(
        "UPDATE job_applications SET status = 'Cancelled', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status IN ('Pending','Applied','Approved')",
        [req.params.jobId],
        updateError => {
          if (updateError) {
            return res.status(500).json({ message: 'Job cancelled but applications could not be updated', error: updateError.message });
          }
          db.run(
            `UPDATE application_cancellation_requests SET status = 'Cancelled'
             WHERE status = 'Pending' AND application_id IN
               (SELECT id FROM job_applications WHERE job_id = ?)`,
            [req.params.jobId],
            requestError => requestError
              ? res.status(500).json({ message: 'Job cancelled but pending cancellation requests could not be closed', error: requestError.message })
              : res.status(204).end()
          );
        }
      );
    }
  );
});

app.patch('/api/jobs/:jobId', requireSupervisor, (req, res) => {
  db.get('SELECT * FROM jobs WHERE id = ?', [req.params.jobId], (selectError, current) => {
    if (selectError) return res.status(500).json({ message: 'Unable to load event', error: selectError.message });
    if (!current) return res.status(404).json({ message: 'Event not found' });
    if (['Cancelled', 'Expired'].includes(current.status)) {
      return res.status(409).json({ message: 'Cancelled or expired events cannot be edited' });
    }

    const title = String(req.body.title ?? current.title).trim();
    const location = String(req.body.location ?? current.location).trim();
    const date = String(req.body.date ?? current.date).trim();
    const dateKey = String(req.body.dateKey ?? current.date_key).trim();
    const sections = Array.isArray(req.body.sections) ? req.body.sections : JSON.parse(current.sections || '[]');
    const pax = req.body.pax == null || req.body.pax === '' ? Number(current.pax) : Number(req.body.pax);
    const wage = req.body.wage == null || req.body.wage === '' ? current.wage : Number(req.body.wage);
    if (!title || !location || !date || !dateKey || !Array.isArray(sections) || !sections.length
      || !Number.isInteger(pax) || pax < 1 || (wage != null && (!Number.isFinite(wage) || wage < 0))) {
      return res.status(400).json({ message: 'Provide a title, date, venue, at least one crew section, a positive crew count, and a valid wage' });
    }

    const values = [
      title, location, date, dateKey,
      JSON.stringify(Array.isArray(req.body.requirements) ? req.body.requirements : JSON.parse(current.requirements || '[]')),
      String(req.body.clientNotice ?? current.client_notice),
      JSON.stringify(sections),
      req.body.jobType ?? current.job_type,
      req.body.callTime ?? current.call_time,
      req.body.endTime ?? current.end_time,
      req.body.dressCode ?? current.dress_code,
      req.body.foodProvided == null ? current.food_provided : (req.body.foodProvided ? 1 : 0),
      wage, pax,
      req.body.notes ?? current.notes,
      req.body.applicationDeadline ?? current.application_deadline,
      req.body.autoCancel == null ? current.auto_cancel : (req.body.autoCancel ? 1 : 0),
      req.params.jobId
    ];
    db.run(
      `UPDATE jobs SET title = ?, location = ?, date = ?, date_key = ?, requirements = ?,
         client_notice = ?, sections = ?, job_type = ?, call_time = ?, end_time = ?, dress_code = ?,
         food_provided = ?, wage = ?, pax = ?, notes = ?, application_deadline = ?,
         auto_cancel = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      values,
      updateError => {
        if (updateError) return res.status(500).json({ message: 'Unable to update event', error: updateError.message });
        refreshJobStatuses(refreshError => {
          if (refreshError) return res.status(500).json({ message: 'Event was updated but status refresh failed', error: refreshError.message });
          db.get('SELECT * FROM jobs WHERE id = ?', [req.params.jobId], (reloadError, row) => {
            if (reloadError) return res.status(500).json({ message: 'Event updated but could not be reloaded', error: reloadError.message });
            res.json({ job: parseJob(row) });
          });
        });
      }
    );
  });
});

app.post('/api/jobs/:jobId/apply', requireCrew, (req, res) => {
  const { section, time, shiftTime } = req.body;
  const selectedTime = time || shiftTime;

  if (!section || !selectedTime) {
    return res.status(400).json({ message: 'Section and shift time are required' });
  }

  db.get(
    'SELECT blocked_until FROM crew_booking_restrictions WHERE employee_id = ? AND blocked_until > CURRENT_TIMESTAMP',
    [req.session.employeeId],
    (restrictionError, restriction) => {
      if (restrictionError) return res.status(500).json({ message: 'Unable to check booking eligibility', error: restrictionError.message });
      if (restriction) return res.status(403).json({
        message: `Booking is temporarily unavailable until ${restriction.blocked_until}. You can still use the rest of the platform.`
      });
  refreshJobStatuses(refreshError => {
    if (refreshError) return res.status(500).json({ message: 'Unable to refresh job status', error: refreshError.message });
    db.get('SELECT * FROM jobs WHERE id = ?', [req.params.jobId], (err, jobRow) => {
      if (err) return res.status(500).json({ message: 'Unable to load job', error: err.message });
      if (!jobRow) return res.status(404).json({ message: 'Job not found' });
      if (jobRow.status !== 'open' && jobRow.status !== 'Open') {
        return res.status(409).json({
          message: jobRow.status === 'Job Full' ? 'Job Full: applications are closed for this event.' : 'This event is no longer accepting applications.'
        });
      }
      if (isEventInThePast(jobRow)) return res.status(409).json({ message: 'This event has already been completed and is no longer accepting applications.' });

      const sections = JSON.parse(jobRow.sections || '[]');
      const selectedSection = sections.find(item => item.title === section);
      const shift = selectedSection && (selectedSection.shifts || []).find(item => item.time === selectedTime);
      if (!shift) return res.status(404).json({ message: 'Shift not found' });

      db.get(
        "SELECT COUNT(*) AS count FROM job_applications WHERE job_id = ? AND status IN ('Pending','Applied','Approved')",
        [req.params.jobId],
        (countError, countRow) => {
          if (countError) return res.status(500).json({ message: 'Unable to check job availability', error: countError.message });
          const capacity = Number(jobRow.pax) || Number(shift.pax) || 0;
          if (Number(countRow.count || 0) >= capacity) return res.status(409).json({ message: 'Job Full: applications are closed for this event.' });

          db.get("SELECT status FROM job_applications WHERE job_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT 1",
            [req.params.jobId, req.session.employeeId],
            (existingError, existing) => {
              if (existingError) return res.status(500).json({ message: 'Unable to check previous applications', error: existingError.message });

              const normalized = existing ? normalizeApplicationStatus(existing.status) : null;
              if (normalized && ['Rejected', 'Approved', 'Pending', 'Cancelled'].includes(normalized)) {
                if (normalized === 'Rejected') return res.status(409).json({ message: 'You cannot re-apply for this job' });
                return res.status(409).json({ message: 'You already applied for this job' });
              }

              const applicationId = uuidv4();
              db.run(
                `INSERT INTO job_applications (id, job_id, employee_id, section, shift_time, status)
                 SELECT ?, ?, ?, ?, ?, 'Pending'
                 WHERE EXISTS (
                   SELECT 1 FROM jobs WHERE id = ? AND status IN ('open','Open')
                 ) AND (
                   SELECT COUNT(*) FROM job_applications
                   WHERE job_id = ? AND status IN ('Pending','Applied','Approved')
                 ) < ?`,
                [applicationId, req.params.jobId, req.session.employeeId, section, selectedTime, req.params.jobId, req.params.jobId, capacity],
                function (insertError) {
                  if (insertError) {
                    if (insertError.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ message: 'You already applied for this shift' });
                    return res.status(500).json({ message: 'Unable to apply for job', error: insertError.message });
                  }
                  if (!this.changes) return res.status(409).json({ message: 'Job Full: applications are closed for this event.' });
                  res.status(201).json({ message: 'Application submitted', applicationId });
                }
              );
            }
          );
        }
      );
    });
      }
    );
  });
});

app.get('/api/job-applications', requireAuthenticated, (req, res) => {
  refreshJobStatuses(refreshError => {
    if (refreshError) return res.status(500).json({ message: 'Unable to refresh application statuses', error: refreshError.message });
    if (req.session.role === 'crew') {
      return db.all(
        `SELECT a.*, j.title AS job_title, j.date, j.date_key, j.location, j.call_time, j.end_time,
                j.wage, j.status AS job_status,
                (SELECT status FROM application_cancellation_requests
                 WHERE application_id = a.id ORDER BY created_at DESC LIMIT 1) AS cancellation_request_status
         FROM job_applications a JOIN jobs j ON j.id = a.job_id
         WHERE a.employee_id = ? ORDER BY a.created_at DESC`,
        [req.session.employeeId],
        (err, rows) => err
          ? res.status(500).json({ message: 'Unable to load job history', error: err.message })
          : res.json({ applications: rows })
      );
    }
    db.all(
      `SELECT a.*, j.title AS job_title, j.date, j.date_key, j.location, j.job_type, j.call_time,
              j.end_time, j.wage, j.pax, j.status AS job_status,
              (SELECT status FROM application_cancellation_requests
               WHERE application_id = a.id ORDER BY created_at DESC LIMIT 1) AS cancellation_request_status,
              e.name AS crew_name, e.email AS crew_email, e.phone AS crew_phone,
              e.position AS crew_position, e.department AS crew_department
       FROM job_applications a JOIN jobs j ON j.id = a.job_id
       LEFT JOIN employees e ON e.id = a.employee_id
       ORDER BY a.created_at DESC`,
      (err, rows) => {
        if (err) return res.status(500).json({ message: 'Unable to load applications', error: err.message });
        res.json({ applications: rows });
      }
    );
  });
});

function reviewApplication(req, res, status) {
  db.get(`SELECT a.*, j.pax, j.sections, j.status AS job_status, j.date_key, j.end_time,
                 (SELECT status FROM application_cancellation_requests
                  WHERE application_id = a.id AND status = 'Pending' LIMIT 1) AS pending_cancellation
          FROM job_applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    [req.params.applicationId], (err, application) => {
      if (err) return res.status(500).json({ message: 'Unable to load application', error: err.message });
      if (!application) return res.status(404).json({ message: 'Application not found' });
      if (status === 'Approved') {
        if (application.pending_cancellation) return res.status(409).json({ message: 'This Crew booking has a cancellation request awaiting review.' });
        if (application.job_status !== 'open' && application.job_status !== 'Open') {
          return res.status(409).json({ message: application.job_status === 'Job Full' ? 'Job Full: no further crew can be assigned.' : 'This event is not accepting approvals.' });
        }
        if (isEventInThePast(application)) return res.status(409).json({ message: 'This event is already completed.' });
        db.get("SELECT COUNT(*) AS count FROM job_applications WHERE job_id = ? AND status IN ('Pending','Applied','Approved')",
          [application.job_id], (countError, count) => {
            if (countError) return res.status(500).json({ message: 'Unable to check capacity', error: countError.message });
            if (Number(count.count || 0) > Number(application.pax || 0)) return res.status(409).json({ message: 'This job is full' });
            db.run("UPDATE job_applications SET status = 'Approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('Pending','Applied')",
              [application.id], function (updateError) {
                if (updateError) return res.status(500).json({ message: 'Unable to approve application', error: updateError.message });
                if (!this.changes) return res.status(409).json({ message: 'Application has already been reviewed' });
                refreshJobStatuses(refreshError => refreshError
                  ? res.status(500).json({ message: 'Application approved but event status refresh failed', error: refreshError.message })
                  : res.json({ message: 'Application approved', applicationId: application.id, status }));
              });
          });
      } else {
        db.run("UPDATE job_applications SET status = 'Rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('Pending','Applied')",
          [application.id], function (updateError) {
            if (updateError) return res.status(500).json({ message: 'Unable to reject application', error: updateError.message });
            if (!this.changes) return res.status(409).json({ message: 'Application has already been reviewed' });
            refreshJobStatuses(refreshError => refreshError
              ? res.status(500).json({ message: 'Application rejected but event status refresh failed', error: refreshError.message })
              : res.json({ message: 'Application rejected', applicationId: application.id, status }));
          });
      }
    });
}

app.patch('/api/job-applications/:applicationId/approve', requireSupervisor, (req, res) => reviewApplication(req, res, 'Approved'));
app.post('/api/job-applications/:applicationId/approve', requireSupervisor, (req, res) => reviewApplication(req, res, 'Approved'));
app.patch('/api/job-applications/:applicationId/reject', requireSupervisor, (req, res) => reviewApplication(req, res, 'Rejected'));
app.post('/api/job-applications/:applicationId/reject', requireSupervisor, (req, res) => reviewApplication(req, res, 'Rejected'));
app.patch('/api/job-applications/:applicationId/status', requireSupervisor, (req, res) => {
  const status = ['Pending', 'Approved', 'Rejected', 'Withdrawn'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ message: 'Status must be Pending, Approved, Rejected or Withdrawn' });
  db.get(
    `SELECT a.*, j.pax, j.status AS job_status, j.date_key, j.end_time,
            (SELECT status FROM application_cancellation_requests
             WHERE application_id = a.id AND status = 'Pending' LIMIT 1) AS pending_cancellation
     FROM job_applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    [req.params.applicationId],
    (selectError, application) => {
      if (selectError) return res.status(500).json({ message: 'Unable to load application', error: selectError.message });
      if (!application) return res.status(404).json({ message: 'Application not found' });
      if (status === 'Approved' && application.pending_cancellation) return res.status(409).json({ message: 'This Crew booking has a cancellation request awaiting review.' });
      if (status === 'Approved' && (application.job_status !== 'open' && application.job_status !== 'Open' || isEventInThePast(application))) {
        return res.status(409).json({ message: 'This event is no longer accepting approvals.' });
      }
      const update = () => db.run(
        'UPDATE job_applications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, application.id],
        function (updateError) {
          if (updateError) return res.status(500).json({ message: 'Unable to update application status', error: updateError.message });
          refreshJobStatuses(refreshError => refreshError
            ? res.status(500).json({ message: 'Application updated but event status refresh failed', error: refreshError.message })
            : res.json({ applicationId: application.id, status }));
        }
      );
      if (!['Approved', 'Pending'].includes(status)
        || normalizeApplicationStatus(application.status) === status) return update();
      db.get(
        "SELECT COUNT(*) AS count FROM job_applications WHERE job_id = ? AND id != ? AND status IN ('Pending','Applied','Approved')",
        [application.job_id, application.id],
        (countError, count) => {
          if (countError) return res.status(500).json({ message: 'Unable to check reserved crew count', error: countError.message });
          if (Number(count.count || 0) >= Number(application.pax || 0)) return res.status(409).json({ message: 'Job Full: the event has no unreserved crew spaces.' });
          update();
        }
      );
    }
  );
});

function startTimeForApplication(application) {
  const dateKey = String(application.date_key || '').slice(0, 10);
  const value = String(application.shift_time || application.call_time || '').trim();
  if (!dateKey || !value) return null;
  const match = value.match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) {
    const parsed = dateTimeForJob({ dateKey }, value);
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]) {
    const meridiem = match[3].toUpperCase();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    hour = hour % 12 + (meridiem === 'PM' ? 12 : 0);
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = new Date(year, month - 1, day, hour, minute);
  return Number.isNaN(start.getTime()) ? null : start;
}

function setBookingRestriction(employeeId, durationSql, reason, callback) {
  db.run(
    `INSERT INTO crew_booking_restrictions (employee_id, blocked_until, reason)
     VALUES (?, datetime('now', ?), ?)
     ON CONFLICT(employee_id) DO UPDATE SET
       blocked_until = excluded.blocked_until, reason = excluded.reason, created_at = CURRENT_TIMESTAMP`,
    [employeeId, durationSql, reason],
    callback
  );
}

app.post('/api/job-applications/:applicationId/cancel', requireCrew, (req, res) => {
  db.get(
    `SELECT a.*, j.date_key, j.call_time, j.status AS job_status
     FROM job_applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.id = ? AND a.employee_id = ?`,
    [req.params.applicationId, req.session.employeeId],
    (selectError, application) => {
      if (selectError) return res.status(500).json({ message: 'Unable to load booking', error: selectError.message });
      if (!application) return res.status(404).json({ message: 'Booking not found' });
      if (!['Pending', 'Applied', 'Approved'].includes(normalizeApplicationStatus(application.status))) {
        return res.status(409).json({ message: 'This booking can no longer be cancelled' });
      }
      db.get(
        "SELECT id FROM application_cancellation_requests WHERE application_id = ? AND status = 'Pending'",
        [application.id],
        (requestError, pendingRequest) => {
          if (requestError) return res.status(500).json({ message: 'Unable to check cancellation request', error: requestError.message });
          if (pendingRequest) return res.status(409).json({ message: 'Your cancellation request is already awaiting Supervisor review' });

          const start = startTimeForApplication(application);
          if (!start) return res.status(400).json({ message: 'The event start time is unavailable; ask a Supervisor to cancel this booking' });
          const hoursUntilStart = (start.getTime() - Date.now()) / 3600000;
          if (hoursUntilStart <= 0) return res.status(409).json({ message: 'A booking cannot be cancelled after its shift has started' });

          if (hoursUntilStart >= 24) {
            return db.run(
              "UPDATE job_applications SET status = 'Withdrawn', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              [application.id],
              updateError => updateError
                ? res.status(500).json({ message: 'Unable to withdraw booking', error: updateError.message })
                : refreshJobStatuses(refreshError => refreshError
                  ? res.status(500).json({ message: 'Booking cancelled but event capacity refresh failed', error: refreshError.message })
                  : res.json({ status: 'Withdrawn', message: 'Booking cancelled more than 24 hours before the shift.' }))
            );
          }
          if (hoursUntilStart > 3) {
            return res.status(409).json({ message: 'Bookings can only be cancelled at least 24 hours before the shift, except for the late-cancellation process within 3 hours.' });
          }

          const reason = String(req.body.reason || '').trim();
          const evidence = String(req.body.evidenceData || '');
          if (!reason && !evidence) {
            return db.serialize(() => db.run('BEGIN IMMEDIATE TRANSACTION', beginError => {
              if (beginError) return res.status(500).json({ message: 'Unable to start late cancellation', error: beginError.message });
              db.run(
                "UPDATE job_applications SET status = 'Withdrawn', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('Pending','Applied','Approved')",
                [application.id],
                function (updateError) {
                  if (updateError || !this.changes) {
                    return db.run('ROLLBACK', () => updateError
                      ? res.status(500).json({ message: 'Unable to cancel booking', error: updateError.message })
                      : res.status(409).json({ message: 'Booking status changed before cancellation' }));
                  }
                  setBookingRestriction(req.session.employeeId, '+30 days', 'Late cancellation without reason or evidence', restrictionError => {
                    if (restrictionError) return db.run('ROLLBACK', () => res.status(500).json({ message: 'Unable to apply the 30-day booking restriction', error: restrictionError.message }));
                    db.run('COMMIT', commitError => {
                      if (commitError) return db.run('ROLLBACK', () => res.status(500).json({ message: 'Unable to complete late cancellation', error: commitError.message }));
                      refreshJobStatuses(refreshError => refreshError
                        ? res.status(500).json({ message: 'Booking cancelled but event capacity refresh failed', error: refreshError.message })
                        : res.json({ status: 'Withdrawn', blockedDays: 30, message: 'Late cancellation recorded. Job booking is frozen for 1 month; other platform features remain available.' }));
                    });
                  });
                }
              );
            }));
          }
          if (!reason || !evidence) return res.status(400).json({ message: 'A cancellation reason and supporting evidence are both required for late cancellation review' });
          const match = evidence.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
          if (!match || Buffer.byteLength(match[2], 'base64') > 5 * 1024 * 1024) {
            return res.status(400).json({ message: 'Evidence must be a PDF, JPEG, PNG or WebP file no larger than 5 MB' });
          }
          const requestId = uuidv4();
          db.run(
            `INSERT INTO application_cancellation_requests
               (id, application_id, employee_id, reason, evidence_name, evidence_mime_type, evidence_data)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              requestId, application.id, req.session.employeeId, reason,
              String(req.body.evidenceName || 'cancellation-evidence').slice(0, 180),
              match[1], Buffer.from(match[2], 'base64')
            ],
            insertError => insertError
              ? res.status(500).json({ message: 'Unable to submit cancellation evidence', error: insertError.message })
              : res.status(201).json({ status: 'Pending Review', requestId, message: 'Cancellation evidence sent to the Supervisor. Your booking remains active until review.' })
          );
        }
      );
    }
  );
});

app.get('/api/admin/cancellation-requests', requireSupervisor, (req, res) => {
  db.all(
    `SELECT r.id, r.application_id, r.employee_id, r.reason, r.evidence_name,
            r.evidence_mime_type, r.status, r.created_at, e.name AS crew_name,
            e.phone AS crew_phone, e.email AS crew_email, j.title AS job_title,
            j.date, j.date_key, j.location, a.shift_time
     FROM application_cancellation_requests r
     JOIN employees e ON e.id = r.employee_id
     JOIN job_applications a ON a.id = r.application_id
     JOIN jobs j ON j.id = a.job_id
     ORDER BY CASE WHEN r.status = 'Pending' THEN 0 ELSE 1 END, r.created_at DESC`,
    (err, requests) => {
      if (err) return res.status(500).json({ message: 'Unable to load cancellation requests', error: err.message });
      res.json({ requests: requests || [] });
    }
  );
});

app.get('/api/admin/cancellation-requests/:requestId/evidence', requireSupervisor, (req, res) => {
  db.get(
    'SELECT evidence_name, evidence_mime_type, evidence_data FROM application_cancellation_requests WHERE id = ?',
    [req.params.requestId],
    (err, evidence) => {
      if (err) return res.status(500).json({ message: 'Unable to load evidence', error: err.message });
      if (!evidence) return res.status(404).json({ message: 'Cancellation evidence not found' });
      res.json({
        name: evidence.evidence_name,
        mimeType: evidence.evidence_mime_type,
        data: `data:${evidence.evidence_mime_type};base64,${Buffer.from(evidence.evidence_data).toString('base64')}`
      });
    }
  );
});

app.patch('/api/admin/cancellation-requests/:requestId', requireSupervisor, (req, res) => {
  const decision = req.body.decision;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Decision must be approve or reject' });
  db.get('SELECT * FROM application_cancellation_requests WHERE id = ?', [req.params.requestId], (selectError, request) => {
    if (selectError) return res.status(500).json({ message: 'Unable to load cancellation request', error: selectError.message });
    if (!request) return res.status(404).json({ message: 'Cancellation request not found' });
    if (request.status !== 'Pending') return res.status(409).json({ message: 'Cancellation request has already been reviewed' });
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION', beginError => {
        if (beginError) return res.status(500).json({ message: 'Unable to begin cancellation review', error: beginError.message });
        db.run(
          `UPDATE job_applications SET status = 'Withdrawn', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status IN ('Pending','Applied','Approved')`,
          [request.application_id],
          function (applicationError) {
            if (applicationError || !this.changes) {
              return db.run('ROLLBACK', () => applicationError
                ? res.status(500).json({ message: 'Unable to cancel booking', error: applicationError.message })
                : res.status(409).json({ message: 'Booking status changed before review' }));
            }
            db.run(
              `UPDATE application_cancellation_requests
               SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'Pending'`,
              [decision === 'approve' ? 'Approved' : 'Rejected', req.session.employeeId, request.id],
              function (requestError) {
                if (requestError || !this.changes) {
                  return db.run('ROLLBACK', () => requestError
                    ? res.status(500).json({ message: 'Unable to record cancellation review', error: requestError.message })
                    : res.status(409).json({ message: 'Cancellation request has already been reviewed' }));
                }
                const complete = () => db.run('COMMIT', commitError => {
                  if (commitError) return db.run('ROLLBACK', () => res.status(500).json({ message: 'Unable to complete cancellation review', error: commitError.message }));
                  refreshJobStatuses(refreshError => {
                    if (refreshError) return res.status(500).json({ message: 'Cancellation reviewed but event capacity refresh failed', error: refreshError.message });
                    res.json({
                      status: 'Withdrawn',
                      blockedHours: decision === 'reject' ? 24 : 0,
                      message: decision === 'approve'
                        ? 'Evidence verified; booking withdrawn with no booking freeze.'
                        : 'Evidence not accepted; booking withdrawn and booking frozen for 24 hours.'
                    });
                  });
                });
                if (decision === 'approve') return complete();
                setBookingRestriction(request.employee_id, '+24 hours', 'Late cancellation evidence not accepted', restrictionError => {
                  if (restrictionError) return db.run('ROLLBACK', () => res.status(500).json({ message: 'Review saved but the 24-hour booking restriction could not be applied', error: restrictionError.message }));
                  complete();
                });
              }
            );
          }
        );
      });
    });
  });
});
app.get('/api/crew-job-applications', requireCrew, (req, res) => {
  db.all(
    `SELECT a.*, j.title AS job_title, j.date, j.date_key, j.location
     FROM job_applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.employee_id = ? ORDER BY a.created_at DESC`,
    [req.session.employeeId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: 'Unable to load job history', error: err.message });
      res.json({ applications: rows });
    }
  );
});

app.get('/api/wallet', requireCrew, (req, res) => {
  db.get('SELECT * FROM wallets WHERE employee_id = ?', [req.session.employeeId], (err, wallet) => {
    if (err) return res.status(500).json({ message: 'Unable to load wallet', error: err.message });
    const result = wallet || { employee_id: req.session.employeeId, available_balance: 0, pending_balance: 0, paid_balance: 0 };
    db.all('SELECT * FROM wallet_transactions WHERE employee_id = ? ORDER BY created_at DESC', [req.session.employeeId], (transactionError, transactions) => {
      if (transactionError) return res.status(500).json({ message: 'Unable to load wallet transactions', error: transactionError.message });
      res.json({ wallet: result, transactions });
    });
  });
});

app.post('/api/wallet/request-withdrawal', requireCrew, (req, res) => {
  const amount = Number(req.body.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'A valid withdrawal amount is required' });
  }

  db.get('SELECT available_balance FROM wallets WHERE employee_id = ?', [req.session.employeeId], (walletError, wallet) => {
    if (walletError) return res.status(500).json({ message: 'Unable to load wallet', error: walletError.message });
    const available = Number(wallet?.available_balance || 0);
    if (amount > available) {
      return res.status(400).json({ message: 'Withdrawal amount exceeds your available balance' });
    }

    const transactionId = uuidv4();
    db.run(
      `UPDATE wallets SET available_balance = available_balance - ?, pending_balance = pending_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE employee_id = ?`,
      [amount, amount, req.session.employeeId],
      updateError => {
        if (updateError) return res.status(500).json({ message: 'Unable to process withdrawal', error: updateError.message });

        db.run(
          `INSERT INTO wallet_transactions (id, employee_id, title, amount, type, status, reference)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [transactionId, req.session.employeeId, 'Withdrawal request', amount, 'debit', 'Pending', `WITHDRAW-${Date.now()}`],
          transactionError => {
            if (transactionError) return res.status(500).json({ message: 'Withdrawal request received but transaction log failed', error: transactionError.message });
            res.status(201).json({ message: 'Withdrawal requested', amount, status: 'Pending' });
          }
        );
      }
    );
  });
});

app.post('/api/wallet/transactions', requireSupervisor, (req, res) => {
  const { employeeId, title, amount, type = 'credit', status = 'Pending' } = req.body;
  const numericAmount = Number(amount);
  if (!employeeId || !title || !Number.isFinite(numericAmount) || numericAmount <= 0 || !['credit', 'debit'].includes(type)) {
    return res.status(400).json({ message: 'Employee ID, title, positive amount and valid transaction type are required' });
  }
  const availableDelta = type === 'credit' && status === 'Released' ? numericAmount : 0;
  const pendingDelta = type === 'credit' && status !== 'Released' ? numericAmount : 0;
  const paidDelta = type === 'debit' ? numericAmount : 0;
  db.run(
    `INSERT INTO wallets (employee_id, available_balance, pending_balance, paid_balance)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(employee_id) DO UPDATE SET
       available_balance = available_balance + excluded.available_balance,
       pending_balance = pending_balance + excluded.pending_balance,
       paid_balance = paid_balance + excluded.paid_balance,
       updated_at = CURRENT_TIMESTAMP`,
    [employeeId, availableDelta - paidDelta, pendingDelta, paidDelta],
    err => {
      if (err) return res.status(500).json({ message: 'Unable to update wallet', error: err.message });
      db.run(
        `INSERT INTO wallet_transactions (id, employee_id, title, amount, type, status, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), employeeId, title, numericAmount, type, status, `SIM-${Date.now()}`],
        transactionError => {
          if (transactionError) return res.status(500).json({ message: 'Wallet updated but transaction log failed', error: transactionError.message });
          res.status(201).json({ message: 'Wallet transaction recorded' });
        }
      );
    }
  );
});

// Check In endpoint
app.post('/api/checkin', requireCrew, (req, res) => {
  const { employeeId } = req.body;

  if (!employeeId) {
    return res.status(400).json({ message: 'Employee ID is required' });
  }
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ message: 'Location permission is required before checking in' });
  }
  const distance = distanceInMeters(latitude, longitude);
  if (distance > CHECKIN_LOCATION.radiusMeters) {
    return res.status(403).json({
      message: `Check in is only available within ${CHECKIN_LOCATION.radiusMeters}m of the event venue`,
      distanceMeters: Math.round(distance)
    });
  }

  const today = malaysiaDateKey();
  refreshJobStatuses(refreshError => {
    if (refreshError) return res.status(500).json({ message: 'Unable to refresh job status', error: refreshError.message });
    db.get(
    `SELECT a.id AS application_id, j.title AS job_title
     FROM job_applications a
     JOIN jobs j ON j.id = a.job_id
     WHERE a.employee_id = ? AND a.status = 'Approved' AND j.date_key = ?
     ORDER BY a.created_at ASC LIMIT 1`,
    [req.session.employeeId, today],
    (approvalError, approvedJob) => {
      if (approvalError) return res.status(500).json({ message: 'Unable to verify approved shift', error: approvalError.message });
      if (!approvedJob) {
        return res.status(403).json({ message: 'Check in is only available to Crew with an approved job for today' });
      }

      const checkInTime = new Date().toISOString();
      const attendanceId = uuidv4();
      const scheduleMetrics = getCheckInMetrics(checkInTime);
      db.get(
        'SELECT * FROM attendance WHERE employee_id = ? AND date = ?',
        [req.session.employeeId, today],
        (err, row) => {
          if (err) return res.status(500).json({ message: 'Database error', error: err.message });
          if (row && row.check_in_time) return res.status(400).json({ message: 'Already checked in today' });

          const completeCheckIn = error => {
            if (error) return res.status(500).json({ message: 'Check in failed', error: error.message });
            res.json({
              message: 'Check in successful',
              employeeId: req.session.employeeId,
              checkInTime,
              jobTitle: approvedJob.job_title,
              ...scheduleMetrics,
              timestamp: new Date()
            });
          };

          if (row) {
            db.run(
              `UPDATE attendance SET job_application_id = ?, check_in_time = ?, late_minutes = ?,
               attendance_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [approvedJob.application_id, checkInTime, scheduleMetrics.lateMinutes, scheduleMetrics.attendanceStatus, row.id],
              completeCheckIn
            );
          } else {
            db.run(
              `INSERT INTO attendance (id, employee_id, job_application_id, check_in_time, late_minutes, attendance_status, date)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [attendanceId, req.session.employeeId, approvedJob.application_id, checkInTime, scheduleMetrics.lateMinutes, scheduleMetrics.attendanceStatus, today],
              completeCheckIn
            );
          }
          }
        );
      });
    }
  );
});

// Check Out endpoint
app.post('/api/checkout', requireCrew, (req, res) => {
  const { employeeId } = req.body;

  if (!employeeId) {
    return res.status(400).json({ message: 'Employee ID is required' });
  }

  const today = malaysiaDateKey();
  const checkOutTime = new Date().toISOString();

  db.get(
    'SELECT * FROM attendance WHERE employee_id = ? AND date = ?',
    [employeeId, today],
    (err, row) => {
      if (err) {
        return res.status(500).json({ message: 'Database error', error: err.message });
      }

      if (!row || !row.check_in_time) {
        return res.status(400).json({ message: 'No check in record found for today' });
      }
      if (!row.job_application_id) {
        return res.status(403).json({ message: 'Check out requires an attendance record linked to an approved job' });
      }

      if (row.check_out_time) {
        return res.status(400).json({ message: 'Already checked out today' });
      }

      // Calculate hours worked
      const checkInDate = new Date(row.check_in_time);
      const checkOutDate = new Date(checkOutTime);
      const hoursWorked = (checkOutDate - checkInDate) / (1000 * 60 * 60);
      const scheduleMetrics = getScheduleMetrics(checkOutTime);
      const attendanceStatus = getAttendanceStatus({
        ...row,
        check_out_time: checkOutTime,
        early_leave_minutes: scheduleMetrics.earlyLeaveMinutes
      });

      db.run(
        'UPDATE attendance SET check_out_time = ?, hours_worked = ?, early_leave_minutes = ?, attendance_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [checkOutTime, hoursWorked, scheduleMetrics.earlyLeaveMinutes, attendanceStatus.attendanceStatus, row.id],
        (err) => {
          if (err) {
            return res.status(500).json({ message: 'Check out failed', error: err.message });
          }
          res.json({
            message: 'Check out successful',
            employeeId,
            checkOutTime,
            hoursWorked: hoursWorked.toFixed(2),
            ...attendanceStatus,
            timestamp: new Date()
          });
        }
      );
    }
  );
});

// Get today's attendance status
app.get('/api/attendance/today/:employeeId', requireCrew, (req, res) => {
  const { employeeId } = req.params;
  const today = malaysiaDateKey();
  refreshJobStatuses(refreshError => {
    if (refreshError) return res.status(500).json({ message: 'Unable to refresh job status', error: refreshError.message });
    db.get(
    `SELECT j.title FROM job_applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.employee_id = ? AND a.status = 'Approved' AND j.date_key = ?
     ORDER BY a.created_at ASC LIMIT 1`,
    [req.session.employeeId, today],
    (approvalError, approvedJob) => {
      if (approvalError) return res.status(500).json({ message: 'Unable to check approved shifts', error: approvalError.message });
      db.get(
        'SELECT * FROM attendance WHERE employee_id = ? AND date = ?',
        [req.session.employeeId, today],
        (err, row) => {
          if (err) return res.status(500).json({ message: 'Database error', error: err.message });
          if (!row) {
            return res.json({
              employeeId: req.session.employeeId,
              date: today,
              canCheckIn: Boolean(approvedJob),
              approvedJobTitle: approvedJob ? approvedJob.title : null,
              checkInTime: null,
              checkOutTime: null,
              hoursWorked: 0,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              attendanceStatus: 'not_checked_in'
            });
          }
          res.json({
            employeeId: req.session.employeeId,
            date: today,
            canCheckIn: Boolean(approvedJob),
            approvedJobTitle: approvedJob ? approvedJob.title : null,
            checkInTime: row.check_in_time,
            checkOutTime: row.check_out_time,
            hoursWorked: row.hours_worked || 0,
            ...getAttendanceStatus(row)
          });
        }
      );
      }
    );
  });
});

// Get attendance history for employee
app.get('/api/attendance/:employeeId', requireCrew, (req, res) => {
  const { employeeId } = req.params;
  const { startDate, endDate } = req.query;

  let query = 'SELECT * FROM attendance WHERE employee_id = ?';
  const params = [employeeId];

  if (startDate) {
    query += ' AND date >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND date <= ?';
    params.push(endDate);
  }

  query += ' ORDER BY date DESC';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ message: 'Database error', error: err.message });
    }

    res.json({
      employeeId,
      records: rows || [],
      totalRecords: rows ? rows.length : 0
    });
  });
});

// Get all employees
app.get('/api/employees', requireSupervisor, (req, res) => {
  db.all(
    `SELECT id, name, email, phone, position, department, document_type, document_number,
            current_address, gender, document_name, document_mime_type, created_at, updated_at
     FROM employees ORDER BY name`,
    (err, rows) => {
    if (err) {
      return res.status(500).json({ message: 'Database error', error: err.message });
    }

    res.json({
      employees: rows || [],
      total: rows ? rows.length : 0
    });

    }
  );
});

app.patch('/api/employees/:employeeId', requireSupervisor, (req, res) => {
  const { employeeId } = req.params;
  const { name, email, phone, position, department } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: 'Name is required' });
  }

  db.run(
    `UPDATE employees
     SET name = ?, email = ?, phone = ?, position = ?, department = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      String(name).trim(),
      email ? String(email).trim() : null,
      phone ? String(phone).trim() : null,
      position ? String(position).trim() : null,
      department ? String(department).trim() : null,
      employeeId
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ message: 'Employee update failed', error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ message: 'Employee not found' });
      }
      res.json({ message: 'Employee updated successfully' });
    }
  );
});

app.delete('/api/employees/:employeeId', requireSupervisor, (req, res) => {
  const employeeId = String(req.params.employeeId || '').trim().toUpperCase();
  if (!employeeId || DEMO_ACCOUNTS[employeeId]) {
    return res.status(400).json({ message: 'This account cannot be deleted' });
  }

  db.serialize(() => {
    db.run('BEGIN IMMEDIATE TRANSACTION', beginError => {
      if (beginError) return res.status(500).json({ message: 'Unable to start account deletion', error: beginError.message });
      const deleteSteps = [
        ['DELETE FROM application_cancellation_requests WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM job_applications WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM crew_booking_restrictions WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM attendance WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM wallet_transactions WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM wallets WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM profile_change_requests WHERE employee_id = ?', [employeeId]],
        ['DELETE FROM employees WHERE id = ?', [employeeId]]
      ];
      let employeeRemoved = false;
      const runStep = index => {
        if (index >= deleteSteps.length) {
          return db.run('COMMIT', commitError => {
            if (commitError) {
              return db.run('ROLLBACK', () => res.status(500).json({ message: 'Unable to complete account deletion', error: commitError.message }));
            }
            if (!employeeRemoved) {
              return res.status(404).json({ message: 'Crew account not found' });
            }
            for (const [token, session] of activeSessions) {
              if (session.employeeId === employeeId) activeSessions.delete(token);
            }
            res.json({ message: 'Crew account and related records deleted' });
          });
        }
        const [query, params] = deleteSteps[index];
        db.run(query, params, function (deleteError) {
          if (deleteError) {
            return db.run('ROLLBACK', () => res.status(500).json({ message: 'Unable to delete crew account', error: deleteError.message }));
          }
          if (index === deleteSteps.length - 1) employeeRemoved = this.changes > 0;
          runStep(index + 1);
        });
      };
      runStep(0);
    });
  });
});

// Get all attendance records (for admin dashboard)
app.get('/api/admin/attendance', requireSupervisor, (req, res) => {
  const { date, startDate, endDate } = req.query;

  let query = `SELECT a.*, e.name, e.position
    FROM attendance a
    LEFT JOIN employees e ON a.employee_id = e.id
    WHERE a.job_application_id IS NOT NULL`;
  const params = [];

  if (date) {
    query += ' AND a.date = ?';
    params.push(date);
  } else if (startDate && endDate) {
    query += ' AND a.date BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }

  query += ' ORDER BY a.date DESC, a.employee_id';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ message: 'Database error', error: err.message });
    }

    // Calculate statistics
    const stats = {
      totalRecords: rows ? rows.length : 0,
      checkedIn: rows ? rows.filter(r => r.check_in_time && !r.check_out_time).length : 0,
      checkedOut: rows ? rows.filter(r => r.check_out_time).length : 0,
      totalHours: rows ? rows.reduce((sum, r) => sum + (r.hours_worked || 0), 0).toFixed(2) : 0
    };

    res.json({
      records: rows || [],
      statistics: stats
    });
  });
});

// Get employee statistics
app.get('/api/stats/employee/:employeeId', requireCrew, (req, res) => {
  const { employeeId } = req.params;
  const { period = 'month' } = req.query;

  let startDate;
  const today = new Date();

  if (period === 'week') {
    startDate = new Date(today.setDate(today.getDate() - 7));
  } else if (period === 'month') {
    startDate = new Date(today.setMonth(today.getMonth() - 1));
  } else {
    startDate = new Date(today.setFullYear(today.getFullYear() - 1));
  }

  const query = `
    SELECT 
      COUNT(*) as total_days,
      SUM(CASE WHEN check_in_time IS NOT NULL THEN 1 ELSE 0 END) as checked_in_days,
      SUM(hours_worked) as total_hours,
      AVG(hours_worked) as avg_hours
    FROM attendance 
    WHERE employee_id = ? AND date >= ?
  `;

  db.get(query, [employeeId, startDate.toISOString().split('T')[0]], (err, row) => {
    if (err) {
      return res.status(500).json({ message: 'Database error', error: err.message });
    }

    res.json({
      employeeId,
      period,
      statistics: {
        totalDays: row.total_days || 0,
        checkedInDays: row.checked_in_days || 0,
        totalHours: (row.total_hours || 0).toFixed(2),
        avgHours: (row.avg_hours || 0).toFixed(2)
      }
    });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error', error: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Event Kaki Server is running on http://localhost:${PORT}`);
  console.log(`📱 Check In/Out Page: http://localhost:${PORT}/checkin.html`);
  console.log(`📊 Admin Dashboard: http://localhost:${PORT}/admin-dashboard.html`);
  console.log(`\n📝 Demo Crew Account:`);
  console.log(`   Employee ID: N000001`);
  console.log(`   Password: 990101-14-0001`);
  console.log(`\n📝 Demo Supervisor Account:`);
  console.log(`   Employee ID: S000001`);
  console.log(`   Password: Supervisor@123\n`);
});

// Handle server termination
process.on('SIGINT', () => {
  db.close(() => {
    console.log('\nDatabase connection closed');
    process.exit(0);
  });
});
