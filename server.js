const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const db = require("./db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");





const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeBase = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    cb(null, safeBase + ext);
  }
});



const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB cap for MVP
});


const app = express();

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

app.use(
  session({
    secret: "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
    },
  })
);

// ... app.use(session(...)) above ...

app.use((req, res, next) => {
  const u = req.session && req.session.user;

  if (!u) res.locals.homeHref = "/";
  else if (u.role === "coach") res.locals.homeHref = "/coach";
  else res.locals.homeHref = "/home";

  next();
});

// routes start here

const crypto = require("crypto");

function normalizeIdNumber(id) {
  return String(id || "").replace(/\s+/g, "");
}

function idHash(id) {
  const clean = normalizeIdNumber(id);
  const secret = process.env.ID_HASH_SECRET || "dev-change-me";
  return crypto.createHmac("sha256", secret).update(clean).digest("hex");
}

function idLast4(id) {
  const clean = normalizeIdNumber(id);
  return clean.slice(-4);
}


function idHash(id) {
  const clean = normalizeIdNumber(id);
  if (!clean) return null;

  // deterministic hash using a server secret (set this in .env)
  const secret = process.env.ID_HASH_SECRET || "dev-change-me";
  return crypto.createHmac("sha256", secret).update(clean).digest("hex");
}

function idLast4(id) {
  const clean = normalizeIdNumber(id);
  return clean.slice(-4);
}


// Make user available in templates
// Make session user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;

  // Home link for layout
  const u = req.session?.user;
  if (!u) res.locals.homeHref = "/";
  else if (u.role === "coach") res.locals.homeHref = "/coach";
  else res.locals.homeHref = "/home";

  next();
});

// Root
app.get("/", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (req.session.user.role === "coach") {
    return res.redirect("/coach");
  }

  return res.redirect("/home");
});


// Login
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.render("login", { error: "Invalid email or password." });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render("login", { error: "Invalid email or password." });

  req.session.user = {
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  card_code: user.card_code
};

  return user.role === "coach"
    ? res.redirect("/coach")
    : res.redirect("/home");
});

// Signup


function mergeUsersIntoPrimary(db, primaryId, dupeIds) {
  for (const dupeId of dupeIds) {
    // attendance: keep unique(session_id,user_id) safe
    db.prepare(`
      INSERT OR IGNORE INTO attendance (session_id, user_id, check_in_time, method)
      SELECT session_id, ?, check_in_time, method
      FROM attendance
      WHERE user_id = ?
    `).run(primaryId, dupeId);
    db.prepare(`DELETE FROM attendance WHERE user_id = ?`).run(dupeId);

    // competitions
    try {
      db.prepare(`
        INSERT INTO user_competitions (user_id, competition_id, added_at, result_place, event_date)
        SELECT ?, competition_id, added_at, result_place, event_date
        FROM user_competitions
        WHERE user_id = ?
      `).run(primaryId, dupeId);
      db.prepare(`DELETE FROM user_competitions WHERE user_id = ?`).run(dupeId);
    } catch (e) {}

    // uploads (if table exists)
    try { db.prepare(`UPDATE fight_uploads SET user_id = ? WHERE user_id = ?`).run(primaryId, dupeId); } catch (e) {}

    // finally delete the duplicate user row
    db.prepare(`DELETE FROM users WHERE id = ?`).run(dupeId);
  }
}

app.use((req, res, next) => {
  const u = req.session?.user;
  res.locals.homeHref = !u ? "/" : (u.role === "coach" ? "/coach" : "/home");
  next();
});

app.post("/signup", (req, res) => {
  const nameInput = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const jsa = (req.body.jsa_number || "").trim().toUpperCase();

  if (!email || !password || !jsa) {
    return res.status(400).render("signup", { error: "Please fill in email, password, and JSA number." });
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  db.exec("BEGIN");
  try {
    const matches = db.prepare(`
      SELECT id, name, role, email, jsa_number
      FROM users
      WHERE jsa_number = ?
      ORDER BY id ASC
    `).all(jsa);

    let userId, role, finalName;

    if (matches.length === 0) {
      // New person: create fresh account (default role judoka)
      const info = db.prepare(`
        INSERT INTO users (name, email, password_hash, role, jsa_number, claimed_at)
        VALUES (?, ?, ?, 'judoka', ?, CURRENT_TIMESTAMP)
      `).run(nameInput || "Member", email, passwordHash, jsa);

      userId = info.lastInsertRowid;
      role = "judoka";
      finalName = nameInput || "Member";
    } else {
      const primary = matches[0];

      // If already claimed by another email, stop
      if (primary.email && primary.email !== email) {
        throw new Error("That JSA number is already linked to another account.");
      }

      // Merge duplicates (if any)
      if (matches.length > 1) {
        const dupeIds = matches.slice(1).map(r => r.id);
        mergeUsersIntoPrimary(db, primary.id, dupeIds);
      }

      // Claim the primary record (attach login)
      db.prepare(`
        UPDATE users
        SET email = COALESCE(email, ?),
            password_hash = COALESCE(password_hash, ?),
            name = CASE WHEN name IS NULL OR name = '' THEN ? ELSE name END,
            claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP),
            jsa_number = COALESCE(jsa_number, ?)
        WHERE id = ?
      `).run(email, passwordHash, nameInput, jsa, primary.id);

      userId = primary.id;
      role = primary.role || "judoka";
      finalName = primary.name || nameInput || "Member";
    }

    db.exec("COMMIT");

    req.session.user = {
      id: userId,
      name: finalName,
      email,
      role,
      card_code: null
    };

    return res.redirect("/home");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(400).render("signup", { error: e.message });
  }
});





app.get("/signup", (req, res) => {
  if (req.session.user) return res.redirect("/home");
  res.render("signup", { error: "" });
});


// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Judoka home
app.get("/home", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role === "coach") return res.redirect("/coach");
  res.render("home");
});

// Coach portal
app.get("/coach", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach")
    return res.status(403).send("Forbidden");
  res.render("coach");
});

// Coach: list all members
app.get("/coach/members", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const members = db.prepare(`
    SELECT id, name, email, role, profile_photo
    FROM users
    ORDER BY role DESC, COALESCE(name, email) ASC
  `).all();

  res.render("coach_members", { members });
});

// Coach: view any member profile + stats
app.get("/coach/profile/:userId", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const userId = Number(req.params.userId);

  const member = db.prepare(`
    SELECT id, name, email, role, card_code, profile_photo
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!member) return res.status(404).send("User not found");

  const attendanceCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM attendance
    WHERE user_id = ?
  `).get(member.id).c;

  const uploadCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM fight_uploads
    WHERE user_id = ?
  `).get(member.id).c;

  const myCompetitions = db.prepare(`
    SELECT uc.id as user_competition_id,
           c.name,
           uc.result_place,
           uc.event_date
    FROM user_competitions uc
    JOIN competitions c ON c.id = uc.competition_id
    WHERE uc.user_id = ?
    ORDER BY COALESCE(uc.event_date, '') DESC, c.name ASC
  `).all(member.id);

  res.render("coach_profile", {
    member,
    stats: { attendanceCount, uploadCount },
    myCompetitions
  });
});


function mergeUsersIntoPrimary(db, primaryId, dupeIds) {
  for (const dupeId of dupeIds) {
    // attendance (UNIQUE(session_id, user_id) exists)
    db.prepare(`
      INSERT OR IGNORE INTO attendance (session_id, user_id, check_in_time, method)
      SELECT session_id, ?, check_in_time, method
      FROM attendance
      WHERE user_id = ?
    `).run(primaryId, dupeId);
    db.prepare(`DELETE FROM attendance WHERE user_id = ?`).run(dupeId);

    // competitions
    db.prepare(`
      INSERT INTO user_competitions (user_id, competition_id, added_at, result_place, event_date)
      SELECT ?, competition_id, added_at, result_place, event_date
      FROM user_competitions
      WHERE user_id = ?
    `).run(primaryId, dupeId);
    db.prepare(`DELETE FROM user_competitions WHERE user_id = ?`).run(dupeId);

    // Any other tables you have that reference users.id (add as needed)
    try { db.prepare(`UPDATE fight_uploads SET user_id = ? WHERE user_id = ?`).run(primaryId, dupeId); } catch (e) {}

    // delete duplicate user
    db.prepare(`DELETE FROM users WHERE id = ?`).run(dupeId);
  }
}





const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});



app.get("/classes", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role === "coach") return res.redirect("/coach/classes");

  const classes = db.prepare("SELECT * FROM classes ORDER BY day_of_week, start_time").all();
  res.render("classes", { classes });
});


app.use("/uploads", express.static("uploads"));

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

app.get("/classes/:classId/today", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role === "coach") return res.redirect("/coach/classes");

  const classId = Number(req.params.classId);
  const klass = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!klass) return res.status(404).send("Class not found");

  const date = todayISO();

  // Ensure session exists
  db.prepare("INSERT OR IGNORE INTO sessions (class_id, session_date) VALUES (?, ?)").run(classId, date);
  const sessionRow = db.prepare("SELECT * FROM sessions WHERE class_id = ? AND session_date = ?").get(classId, date);
  console.log("JUDOKA sessionRow.id =", sessionRow.id, "classId =", classId, "date =", date);


  // Attendees list
  const judokaAttendees = db.prepare(`
  SELECT u.id, u.name, u.email, u.profile_photo, a.check_in_time, a.method
  FROM attendance a
  JOIN users u ON u.id = a.user_id
  WHERE a.session_id = ?
    AND u.role = 'judoka'
  ORDER BY a.check_in_time ASC
`).all(sessionRow.id);

const coachAttendees = db.prepare(`
  SELECT u.id, u.name, u.email, u.profile_photo, a.check_in_time, a.method
  FROM attendance a
  JOIN users u ON u.id = a.user_id
  WHERE a.session_id = ?
    AND u.role = 'coach'
  ORDER BY a.check_in_time ASC
`).all(sessionRow.id);


  // Session notes (read-only for judoka)
    const noteRow = db.prepare(`
    SELECT notes
    FROM session_notes
    WHERE session_id = ?
    `).all(session.id);



  // Has current user checked in?
  const me = db.prepare("SELECT 1 as ok FROM attendance WHERE session_id = ? AND user_id = ?")
    .get(sessionRow.id, req.session.user.id);

  res.render("class_today", {
  klass,
  date,
  sessionId: sessionRow.id,
  judokaAttendees,
  coachAttendees,
  alreadyCheckedIn: !!me,
  notes: noteRow?.notes || ""
});
});


app.post("/sessions/:sessionId/checkin", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
if (req.session.user.role === "judoka") return res.status(403).send("Judoka must be checked in by coach scan.");



  const sessionId = Number(req.params.sessionId);
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO attendance (session_id, user_id, check_in_time, method)
      VALUES (?, ?, ?, 'self')
    `).run(sessionId, req.session.user.id, now);
  } catch (err) {
    // ignore duplicate check-in
  }

  // Redirect back
  const classId = db.prepare("SELECT class_id FROM sessions WHERE id = ?").get(sessionId)?.class_id;
  return res.redirect(`/classes/${classId}/today`);
});


app.get("/coach/classes", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const date = todayISO();

  // Ensure sessions exist for today's classes (optional but convenient)
  const classesToday = db.prepare(`
    SELECT * FROM classes
    WHERE day_of_week = ?
    ORDER BY start_time
  `).all(new Date().getDay());

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (class_id, session_date)
    VALUES (?, ?)
  `);

  for (const c of classesToday) insertSession.run(c.id, date);

  const sessions = db.prepare(`
    SELECT s.id as session_id, s.session_date, c.id as class_id, c.name, c.start_time, c.end_time
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    WHERE s.session_date = ?
    ORDER BY c.start_time
  `).all(date);

  res.render("coach_classes", { date, sessions });
});


app.get("/coach/sessions/:sessionId", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);

  const session = db.prepare(`
    SELECT s.id as session_id, s.session_date, c.name, c.start_time, c.end_time
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) return res.status(404).send("Session not found");


  // For manual add dropdown: list all judoka
  const judoka = db.prepare(`
    SELECT id, name, email
    FROM users
    WHERE role = 'judoka'
    ORDER BY COALESCE(name, email) ASC
  `).all();

  const noteRow = db.prepare(`
    SELECT notes FROM session_notes WHERE session_id = ?
  `).get(sessionId);

  const judokaAttendees = db.prepare(`
  SELECT u.id, u.name, u.email, u.profile_photo, a.check_in_time, a.method
  FROM attendance a
  JOIN users u ON u.id = a.user_id
  WHERE a.session_id = ? AND u.role = 'judoka'
  ORDER BY a.check_in_time ASC
`).all(sessionId);

const coachAttendees = db.prepare(`
  SELECT u.id, u.name, u.email, u.profile_photo, a.check_in_time, a.method
  FROM attendance a
  JOIN users u ON u.id = a.user_id
  WHERE a.session_id = ? AND u.role = 'coach'
  ORDER BY a.check_in_time ASC
`).all(sessionId);


  res.render("coach_session", {
  session,
  judokaAttendees,
  coachAttendees,
  judoka,
  notes: noteRow?.notes || ""
  });
});


app.post("/coach/sessions/:sessionId/add", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const userId = Number(req.body.user_id);
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO attendance (session_id, user_id, check_in_time, method)
      VALUES (?, ?, ?, 'coach')
    `).run(sessionId, userId, now);
  } catch (e) {
    // ignore duplicates
  }

  return res.redirect(`/coach/sessions/${sessionId}`);
});


app.post("/coach/sessions/:sessionId/remove", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const userId = Number(req.body.user_id);

  db.prepare(`
    DELETE FROM attendance WHERE session_id = ? AND user_id = ?
  `).run(sessionId, userId);

  return res.redirect(`/coach/sessions/${sessionId}`);
});


app.post("/coach/sessions/:sessionId/notes", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const notes = (req.body.notes || "").trim();
  const now = new Date().toISOString();
  console.log("COACH saving notes for sessionId =", sessionId);


  db.prepare(`
    INSERT INTO session_notes (session_id, coach_id, notes, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      coach_id = excluded.coach_id,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(sessionId, req.session.user.id, notes || "(no notes)", now);

  return res.redirect(`/coach/sessions/${sessionId}`);
});


app.get("/coach/members/new", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");
  res.render("coach_member_new", { error: "" });
});

app.post("/coach/members/new", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const name = (req.body.name || "").trim();
  const role = (req.body.role || "").trim(); // 'judoka' | 'coach'
  const jsa = (req.body.jsa_number || "").trim().toUpperCase();

  if (!name || !["judoka", "coach"].includes(role)) {
    return res.status(400).render("coach_member_new", { error: "Please enter a name and choose a role." });
  }

  if (jsa) {
    const existing = db.prepare("SELECT id FROM users WHERE jsa_number = ?").get(jsa);
    if (existing) {
      return res.render("coach_member_new", { error: "That JSA number already exists. Go to the member profile instead." });
    }
  }

  db.prepare(`
    INSERT INTO users (name, role, email, password_hash, jsa_number, claimed_at)
    VALUES (?, ?, NULL, NULL, ?, NULL)
  `).run(name, role, jsa || null);

  return res.redirect("/coach/classes");
});




app.get("/coach/scan", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const date = todayISO();

  const sessions = db.prepare(`
    SELECT s.id as session_id, c.name, c.start_time, c.end_time
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    WHERE s.session_date = ?
    ORDER BY c.start_time
  `).all(date);

  res.render("coach_scan", { date, sessions });
});



app.post("/coach/scan/checkin", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.body.session_id);
  const cardCode = (req.body.card_code || "").trim();
  const now = new Date().toISOString();

  const judoka = db.prepare(`
    SELECT id FROM users WHERE role='judoka' AND card_code = ?
  `).get(cardCode);

  if (!judoka) return res.status(400).json({ ok: false, error: "Unknown card" });

  try {
    db.prepare(`
      INSERT INTO attendance (session_id, user_id, check_in_time, method)
      VALUES (?, ?, ?, 'scan')
    `).run(sessionId, judoka.id, now);
  } catch (e) {}

  return res.json({ ok: true });
});

app.get("/feedback", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka") return res.status(403).send("Forbidden");

  const uploads = db.prepare(`
    SELECT fu.id, fu.original_name, fu.file_name, fu.uploaded_at, fu.status,
           ff.feedback, ff.reviewed_at
    FROM fight_uploads fu
    LEFT JOIN fight_feedback ff ON ff.upload_id = fu.id
    WHERE fu.user_id = ?
    ORDER BY fu.uploaded_at DESC
  `).all(req.session.user.id);

  res.render("feedback", { uploads });
});

app.post("/feedback/upload", upload.single("fight_video"), (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka") return res.status(403).send("Forbidden");

  if (!req.file) return res.status(400).send("No file uploaded");

  db.prepare(`
    INSERT INTO fight_uploads (user_id, original_name, file_name, mime_type, uploaded_at, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(
    req.session.user.id,
    req.file.originalname,
    req.file.filename,
    req.file.mimetype,
    new Date().toISOString()
  );

  res.redirect("/feedback");
});

// Coach scanner page for a specific session
app.get("/coach/sessions/:sessionId/scanner", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);

  const session = db.prepare(`
    SELECT s.id as session_id, s.session_date, c.name as class_name, c.start_time, c.end_time
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) return res.status(404).send("Session not found");

  res.render("coach_scanner", { session });
});


app.post("/coach/sessions/:sessionId/scan", express.urlencoded({ extended: true }), (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const raw = (req.body.code || "").trim();

  // Expect format: JSA:XXXX
  if (!raw.startsWith("JSA:")) return res.status(400).send("Invalid QR payload");

  const jsa = raw.slice(4).trim().toUpperCase();
  if (!jsa) return res.status(400).send("Invalid JSA");

  // Find user by JSA number
  const user = db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE UPPER(jsa_number) = ?
  `).get(jsa);

  if (!user) return res.status(404).send("No member found for this QR");

  // Only allow scanning judoka (optional rule)
  if (user.role !== "judoka") return res.status(400).send("This QR is not a judoka");

  // Insert attendance (ignore duplicates)
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO attendance (session_id, user_id, check_in_time, method)
    VALUES (?, ?, ?, 'scan')
  `).run(sessionId, user.id, now);

  res.json({ ok: true, user: { id: user.id, name: user.name || user.email || "Member" } });
});



app.get("/coach/feedback", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const pending = db.prepare(`
    SELECT fu.id, fu.original_name, fu.file_name, fu.uploaded_at, u.name, u.email, u.profile_photo
    FROM fight_uploads fu
    JOIN users u ON u.id = fu.user_id
    LEFT JOIN fight_feedback ff ON ff.upload_id = fu.id
    WHERE fu.status = 'pending' AND ff.id IS NULL
    ORDER BY fu.uploaded_at DESC
  `).all();

  res.render("coach_feedback", { pending });
});

app.post("/coach/sessions/:sessionId/attend", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO attendance (session_id, user_id, check_in_time, method)
      VALUES (?, ?, ?, 'coach_attend')
    `).run(sessionId, req.session.user.id, now);
  } catch (e) {
    // ignore duplicates
  }

  res.redirect(`/coach/sessions/${sessionId}`);
});



app.post("/coach/feedback/:uploadId", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const uploadId = Number(req.params.uploadId);
  const feedback = (req.body.feedback || "").trim();
  if (!feedback) return res.status(400).send("Feedback required");

  db.prepare(`
    INSERT INTO fight_feedback (upload_id, coach_id, feedback, reviewed_at)
    VALUES (?, ?, ?, ?)
  `).run(uploadId, req.session.user.id, feedback, new Date().toISOString());

  db.prepare(`
    UPDATE fight_uploads SET status='reviewed' WHERE id=?
  `).run(uploadId);

  res.redirect("/coach/feedback");
});

app.post("/feedback/delete/:id", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka") return res.status(403).send("Forbidden");

  const id = Number(req.params.id);

  const upload = db.prepare(`
    SELECT * FROM fight_uploads
    WHERE id = ? AND user_id = ?
  `).get(id, req.session.user.id);

  if (!upload) return res.status(404).send("Not found");

  // delete file
  try {
    fs.unlinkSync(`uploads/${upload.file_name}`);
  } catch (e) {}

  // delete db rows
  db.prepare("DELETE FROM fight_feedback WHERE upload_id = ?").run(id);
  db.prepare("DELETE FROM fight_uploads WHERE id = ?").run(id);

  res.redirect("/feedback");
});

app.get("/profile", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const me = db.prepare(`
    SELECT id, name, email, role, card_code, profile_photo
    FROM users
    WHERE id = ?
  `).get(req.session.user.id);

  const attendanceCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM attendance
    WHERE user_id = ?
  `).get(me.id).c;

  const uploadCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM fight_uploads
    WHERE user_id = ?
  `).get(me.id).c;

  const competitions = db.prepare(`
    SELECT id, name FROM competitions ORDER BY name
  `).all();

  const myCompetitions = db.prepare(`
  SELECT uc.id as user_competition_id,
         c.name,
         uc.result_place,
         uc.event_date
  FROM user_competitions uc
  JOIN competitions c ON c.id = uc.competition_id
  WHERE uc.user_id = ?
  ORDER BY
    CASE WHEN uc.event_date IS NULL OR uc.event_date = '' THEN 1 ELSE 0 END,
    uc.event_date DESC,
    uc.id DESC
`).all(me.id);


  res.render("profile", {
    me,
    stats: { attendanceCount, uploadCount },
    competitions,
    myCompetitions
  });
});








app.post("/profile/photo", upload.single("profile_photo"), (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (!req.file) return res.status(400).send("No file uploaded");

  db.prepare(`
    UPDATE users SET profile_photo = ?
    WHERE id = ?
  `).run(req.file.filename, req.session.user.id);

  // keep session in sync (optional but helpful)
  req.session.user.profile_photo = req.file.filename;

  res.redirect("/profile");
});




app.post("/signup", (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";
    const jsa = (req.body.jsa_number || "").trim().toUpperCase();

    if (!email || !password || !jsa) {
      return res.status(400).send("Missing email, password, or JSA number.");
    }

    const passwordHash = bcrypt.hashSync(password, 10);

    // 1) If a placeholder member exists with this JSA, "claim" it (merge)
    const existing = db.prepare("SELECT * FROM users WHERE jsa_number = ?").get(jsa);

    if (existing) {
      // If already claimed (has email), block duplicate signup
      if (existing.email) {
        return res.status(400).send("That JSA number is already linked to an account. Please log in.");
      }

      // Claim: attach email/password to the existing row (keeps stats)
      db.prepare(`
        UPDATE users
        SET name = COALESCE(NULLIF(?, ''), name),
            email = ?,
            password_hash = ?,
            claimed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, email, passwordHash, existing.id);

      req.session.user = {
        id: existing.id,
        name: existing.name || name,
        email,
        role: existing.role,
        card_code: existing.card_code || null,
        jsa_number: jsa
      };

      return res.redirect("/home");
    }

    // 2) No existing placeholder -> create a fresh account
    const info = db.prepare(`
      INSERT INTO users (name, role, email, password_hash, jsa_number, claimed_at)
      VALUES (?, 'judoka', ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(name || "Member", email, passwordHash, jsa);

    req.session.user = {
      id: info.lastInsertRowid,
      name: name || "Member",
      email,
      role: "judoka",
      card_code: null,
      jsa_number: jsa
    };

    return res.redirect("/home");
  } catch (e) {
    console.error("SIGNUP ERROR:", e);
    return res.status(500).send("Signup failed: " + e.message);
  }
});




app.post("/coach/members/new", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const name = (req.body.name || "").trim();
  const role = (req.body.role || "judoka").trim(); // 'judoka' | 'coach'
  const jsa = (req.body.jsa_number || "").trim().toUpperCase();

  if (!name || !["judoka", "coach"].includes(role)) {
    return res.status(400).send("Missing name or invalid role.");
  }

  // If JSA already exists, go to that profile (no duplicate)
  if (jsa) {
    const existing = db.prepare("SELECT id FROM users WHERE jsa_number = ?").get(jsa);
    if (existing) return res.redirect(`/coach/profile/${existing.id}`);
  }

  // Create placeholder member: no email/password yet
  const info = db.prepare(`
    INSERT INTO users (name, role, email, password_hash, jsa_number, claimed_at)
    VALUES (?, ?, NULL, NULL, ?, NULL)
  `).run(name, role, jsa || null);

  return res.redirect(`/coach/profile/${info.lastInsertRowid}`);
});




app.post("/profile/competition", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka") return res.status(403).send("Forbidden");

  try {
    const competitionId = Number(req.body.competition_id);
    const resultPlace = (req.body.result_place || "").trim();
    const eventDate = (req.body.event_date || "").trim();

    if (!competitionId) return res.redirect("/profile");

    db.prepare(`
  INSERT INTO user_competitions (user_id, competition_id, added_at, result_place, event_date)
  VALUES (?, ?, ?, ?, ?)
`).run(
  req.session.user.id,
  competitionId,
  new Date().toISOString(),
  resultPlace || null,
  eventDate || null
);


    return res.redirect("/profile");
  } catch (e) {
    console.error("COMP SAVE ERROR:", e.message);
    return res.status(500).send("Competition save failed: " + e.message);
  }
});










app.post("/profile/competition", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka") return res.status(403).send("Forbidden");

  const competitionId = Number(req.body.competition_id);
  const resultPlace = (req.body.result_place || "").trim();
  const eventDate = (req.body.event_date || "").trim();

  if (!competitionId) return res.redirect("/profile");

  db.prepare(`
    INSERT INTO user_competitions (user_id, competition_id, added_at, result_place, event_date)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, competition_id)
    DO UPDATE SET
      result_place = excluded.result_place,
      event_date = excluded.event_date
  `).run(
    req.session.user.id,
    competitionId,
    new Date().toISOString(),
    resultPlace || null,
    eventDate || null
  );

  res.redirect("/profile");
});


app.post("/profile/competition/:id/delete", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka") return res.status(403).send("Forbidden");

  const id = Number(req.params.id);

  db.prepare(`
    DELETE FROM user_competitions
    WHERE id = ? AND user_id = ?
  `).run(id, req.session.user.id);

  res.redirect("/profile");
});


app.get("/profile/attendance", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const userId = req.session.user.id;

  const attended = db.prepare(`
    SELECT
      s.id as session_id,
      s.session_date,
      c.id as class_id,
      c.name as class_title
    FROM attendance a
    JOIN sessions s ON s.id = a.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE a.user_id = ?
    ORDER BY s.session_date DESC, s.id DESC
  `).all(userId);

  res.render("profile_attendance", { attended });
});


app.get("/sessions/:sessionId", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const sessionId = Number(req.params.sessionId);

  // If judoka, require that they attended this session
  if (req.session.user.role === "judoka") {
    const ok = db.prepare(`
      SELECT 1 FROM attendance
      WHERE session_id = ? AND user_id = ?
      LIMIT 1
    `).get(sessionId, req.session.user.id);

    if (!ok) return res.status(403).send("Forbidden");
  }

  const session = db.prepare(`
    SELECT s.id as session_id, s.session_date, c.name as class_title
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) return res.status(404).send("Session not found");

  const judokaAttendees = db.prepare(`
    SELECT u.id, u.name, u.email, u.profile_photo, a.check_in_time, a.method
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    WHERE a.session_id = ? AND u.role = 'judoka'
    ORDER BY a.check_in_time ASC
  `).all(sessionId);

  const coachAttendees = db.prepare(`
    SELECT u.id, u.name, u.email, u.profile_photo, a.check_in_time, a.method
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    WHERE a.session_id = ? AND u.role = 'coach'
    ORDER BY a.check_in_time ASC
  `).all(sessionId);

  const noteRow = db.prepare(`
    SELECT notes FROM session_notes WHERE session_id = ?
  `).get(sessionId);

  res.render("session_view", {
    session,
    judokaAttendees,
    coachAttendees,
    notes: noteRow?.notes || ""
  });
});


app.get("/coach/profile/:userId/attendance", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const userId = Number(req.params.userId);

  const member = db.prepare(`
    SELECT id, name, email, role, profile_photo
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!member) return res.status(404).send("User not found");

  const attended = db.prepare(`
    SELECT
      s.id as session_id,
      s.session_date,
      c.id as class_id,
      c.name as class_title
    FROM attendance a
    JOIN sessions s ON s.id = a.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE a.user_id = ?
    ORDER BY s.session_date DESC, s.id DESC
  `).all(userId);

  res.render("coach_member_attendance", { member, attended });
});

app.get("/coach/sessions/:sessionId/scanner", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);

  const session = db.prepare(`
    SELECT s.id as session_id, s.session_date, c.name as class_name, c.start_time, c.end_time
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) return res.status(404).send("Session not found");

  res.render("coach_scanner", { session });
});


app.post("/coach/sessions/:sessionId/scan", express.urlencoded({ extended: true }), (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const raw = (req.body.code || "").trim();

  // Expect: JSA:XXXX
  if (!raw.startsWith("JSA:")) return res.status(400).send("Invalid QR payload");

  const jsa = raw.slice(4).trim().toUpperCase();
  if (!jsa) return res.status(400).send("Invalid JSA value");

  // Find member by JSA number
  const user = db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE UPPER(jsa_number) = ?
  `).get(jsa);

  if (!user) return res.status(404).send("No member found for this QR");

  // Only allow judoka check-ins (recommended)
  if (user.role !== "judoka") return res.status(400).send("This QR is not a judoka");

  // Ensure the session exists (safety)
  const exists = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!exists) return res.status(404).send("Session not found");

  // Insert attendance (ignore duplicates)
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO attendance (session_id, user_id, check_in_time, method)
    VALUES (?, ?, ?, 'scan')
  `).run(sessionId, user.id, now);

  res.json({ ok: true, name: user.name || user.email || "Member" });
});



app.post("/coach/sessions/:sessionId/add-judoka", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "coach") return res.status(403).send("Forbidden");

  const sessionId = Number(req.params.sessionId);
  const userId = Number(req.body.user_id);

  if (!sessionId || !userId) return res.redirect(`/coach/sessions/${sessionId}`);

  // Ensure the user is a judoka (don’t allow coaches added here)
  const u = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
  if (!u || u.role !== "judoka") return res.status(400).send("Invalid judoka");

  // Insert attendance (ignore if already checked in)
  db.prepare(`
    INSERT OR IGNORE INTO attendance (session_id, user_id, check_in_time, method)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, userId, new Date().toISOString(), "coach");

  return res.redirect(`/coach/sessions/${sessionId}`);
});


app.get("/scan-checkin", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "judoka")
    return res.status(403).send("Forbidden");

  const me = db.prepare(`
    SELECT id, name, email, jsa_number
    FROM users
    WHERE id = ?
  `).get(req.session.user.id);

  if (!me) return res.redirect("/login");

  if (!me.jsa_number) {
    return res.send(
      "No JSA number on your account yet. Ask your coach to add it first."
    );
  }

  const payload = `JSA:${me.jsa_number.toUpperCase()}`;
  const qrDataUrl = await QRCode.toDataURL(payload, { scale: 8 });

  res.render("scan_checkin", {
    me,
    qrDataUrl,
    payload
  });
});




