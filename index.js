const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('levelup.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    streak INTEGER DEFAULT 0,
    last_completed_date TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    user_id INTEGER PRIMARY KEY,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    discipline INTEGER DEFAULT 0,
    focus INTEGER DEFAULT 0,
    health INTEGER DEFAULT 10,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

const app = express();
const port = 3000;

app.use(express.json());
app.use(session({
  secret: 'levelup-secret-key',
  resave: false,
  saveUninitialized: false
}));
app.use(express.static('public'));

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).send('You must be logged in.');
  }
  next();
}

function todayString() {
  return new Date().toISOString().split('T')[0];
}

function yesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function ensureCharacter(userId) {
  const existing = db.prepare('SELECT * FROM characters WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO characters (user_id) VALUES (?)').run(userId);
    return db.prepare('SELECT * FROM characters WHERE user_id = ?').get(userId);
  }
  return existing;
}

function awardXp(userId, amount, statToIncrease) {
  const character = ensureCharacter(userId);

  let newXp = character.xp + amount;
  let newLevel = character.level;
  let newHealth = character.health;
  let leveledUp = false;

  let xpNeeded = newLevel * 100;
  while (newXp >= xpNeeded) {
    newXp -= xpNeeded;
    newLevel += 1;
    newHealth += 5;
    leveledUp = true;
    xpNeeded = newLevel * 100;
  }

  const newDiscipline = statToIncrease === 'discipline' ? character.discipline + 1 : character.discipline;
  const newFocus = statToIncrease === 'focus' ? character.focus + 1 : character.focus;

  db.prepare(`
    UPDATE characters
    SET level = ?, xp = ?, discipline = ?, focus = ?, health = ?
    WHERE user_id = ?
  `).run(newLevel, newXp, newDiscipline, newFocus, newHealth, userId);

  return {
    level: newLevel,
    xp: newXp,
    discipline: newDiscipline,
    focus: newFocus,
    health: newHealth,
    leveledUp
  };
}

app.post('/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required.');
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
      .run(username, hashedPassword);
    res.send('Account created successfully!');
  } catch (err) {
    res.status(400).send('That username is already taken.');
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).send('Invalid username or password.');
  }
  const passwordMatches = bcrypt.compareSync(password, user.password);
  if (!passwordMatches) {
    return res.status(401).send('Invalid username or password.');
  }
  req.session.userId = user.id;
  ensureCharacter(user.id);
  res.send(`Welcome back, ${user.username}!`);
});

app.get('/profile', requireLogin, (req, res) => {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
  res.send(`This is your profile, ${user.username}. Only logged-in users can see this.`);
});

app.get('/character', requireLogin, (req, res) => {
  const character = ensureCharacter(req.session.userId);
  res.json(character);
});

app.post('/tasks', requireLogin, (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).send('Task title is required.');
  }
  db.prepare('INSERT INTO tasks (user_id, title) VALUES (?, ?)')
    .run(req.session.userId, title);
  res.send('Task created!');
});

app.get('/tasks', requireLogin, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ?').all(req.session.userId);
  res.json(tasks);
});

app.put('/tasks/:id', requireLogin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!task) {
    return res.status(404).send('Task not found.');
  }
  if (task.completed) {
    return res.send('Task already completed.');
  }
  db.prepare('UPDATE tasks SET completed = 1 WHERE id = ?').run(req.params.id);
  const result = awardXp(req.session.userId, 10, 'focus');
  let message = `Task marked complete! +10 XP.`;
  if (result.leveledUp) {
    message += ` Level up! You're now level ${result.level}!`;
  }
  res.send(message);
});

app.delete('/tasks/:id', requireLogin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!task) {
    return res.status(404).send('Task not found.');
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.send('Task deleted!');
});

app.post('/habits', requireLogin, (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).send('Habit title is required.');
  }
  db.prepare('INSERT INTO habits (user_id, title, streak, last_completed_date) VALUES (?, ?, 0, NULL)')
    .run(req.session.userId, title);
  res.send('Habit created!');
});

app.get('/habits', requireLogin, (req, res) => {
  const habits = db.prepare('SELECT * FROM habits WHERE user_id = ?').all(req.session.userId);
  res.json(habits);
});

app.post('/habits/:id/complete', requireLogin, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!habit) {
    return res.status(404).send('Habit not found.');
  }
  const today = todayString();
  const yesterday = yesterdayString();
  if (habit.last_completed_date === today) {
    return res.send('Already marked complete today.');
  }
  let newStreak;
  if (habit.last_completed_date === yesterday) {
    newStreak = habit.streak + 1;
  } else {
    newStreak = 1;
  }
  db.prepare('UPDATE habits SET streak = ?, last_completed_date = ? WHERE id = ?')
    .run(newStreak, today, req.params.id);
  const result = awardXp(req.session.userId, 10, 'discipline');
  let message = `Habit completed! Current streak: ${newStreak}. +10 XP.`;
  if (result.leveledUp) {
    message += ` Level up! You're now level ${result.level}!`;
  }
  res.send(message);
});

app.delete('/habits/:id', requireLogin, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!habit) {
    return res.status(404).send('Habit not found.');
  }
  db.prepare('DELETE FROM habits WHERE id = ?').run(req.params.id);
  res.send('Habit deleted!');
});

app.listen(port, () => {
  console.log(`LevelUp server running on port ${port}`);
});
