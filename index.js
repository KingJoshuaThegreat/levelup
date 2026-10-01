const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      streak INTEGER DEFAULT 0,
      last_completed_date TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS characters (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      level INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0,
      discipline INTEGER DEFAULT 0,
      focus INTEGER DEFAULT 0,
      health INTEGER DEFAULT 10
    )
  `);
}

const app = express();
const port = process.env.PORT || 3000;

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

async function ensureCharacter(userId) {
  const existing = await pool.query('SELECT * FROM characters WHERE user_id = $1', [userId]);
  if (existing.rows.length === 0) {
    await pool.query('INSERT INTO characters (user_id) VALUES ($1)', [userId]);
    const created = await pool.query('SELECT * FROM characters WHERE user_id = $1', [userId]);
    return created.rows[0];
  }
  return existing.rows[0];
}

async function awardXp(userId, amount, statToIncrease) {
  const character = await ensureCharacter(userId);

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

  await pool.query(
    `UPDATE characters SET level = $1, xp = $2, discipline = $3, focus = $4, health = $5 WHERE user_id = $6`,
    [newLevel, newXp, newDiscipline, newFocus, newHealth, userId]
  );

  return { level: newLevel, xp: newXp, discipline: newDiscipline, focus: newFocus, health: newHealth, leveledUp };
}

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required.');
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  try {
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
    res.send('Account created successfully!');
  } catch (err) {
    res.status(400).send('That username is already taken.');
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user) {
    return res.status(401).send('Invalid username or password.');
  }
  const passwordMatches = bcrypt.compareSync(password, user.password);
  if (!passwordMatches) {
    return res.status(401).send('Invalid username or password.');
  }
  req.session.userId = user.id;
  await ensureCharacter(user.id);
  res.send(`Welcome back, ${user.username}!`);
});

app.get('/profile', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
  res.send(`This is your profile, ${result.rows[0].username}. Only logged-in users can see this.`);
});

app.get('/character', requireLogin, async (req, res) => {
  const character = await ensureCharacter(req.session.userId);
  res.json(character);
});

app.post('/tasks', requireLogin, async (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).send('Task title is required.');
  }
  await pool.query('INSERT INTO tasks (user_id, title) VALUES ($1, $2)', [req.session.userId, title]);
  res.send('Task created!');
});

app.get('/tasks', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT * FROM tasks WHERE user_id = $1', [req.session.userId]);
  res.json(result.rows);
});

app.put('/tasks/:id', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  const task = result.rows[0];
  if (!task) {
    return res.status(404).send('Task not found.');
  }
  if (task.completed) {
    return res.send('Task already completed.');
  }
  await pool.query('UPDATE tasks SET completed = 1 WHERE id = $1', [req.params.id]);
  const xpResult = await awardXp(req.session.userId, 10, 'focus');
  let message = `Task marked complete! +10 XP.`;
  if (xpResult.leveledUp) {
    message += ` Level up! You're now level ${xpResult.level}!`;
  }
  res.send(message);
});

app.delete('/tasks/:id', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  if (!result.rows[0]) {
    return res.status(404).send('Task not found.');
  }
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.send('Task deleted!');
});

app.post('/habits', requireLogin, async (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).send('Habit title is required.');
  }
  await pool.query('INSERT INTO habits (user_id, title, streak, last_completed_date) VALUES ($1, $2, 0, NULL)', [req.session.userId, title]);
  res.send('Habit created!');
});

app.get('/habits', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT * FROM habits WHERE user_id = $1', [req.session.userId]);
  res.json(result.rows);
});

app.post('/habits/:id/complete', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT * FROM habits WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  const habit = result.rows[0];
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
  await pool.query('UPDATE habits SET streak = $1, last_completed_date = $2 WHERE id = $3', [newStreak, today, req.params.id]);
  const xpResult = await awardXp(req.session.userId, 10, 'discipline');
  let message = `Habit completed! Current streak: ${newStreak}. +10 XP.`;
  if (xpResult.leveledUp) {
    message += ` Level up! You're now level ${xpResult.level}!`;
  }
  res.send(message);
});

app.delete('/habits/:id', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT * FROM habits WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  if (!result.rows[0]) {
    return res.status(404).send('Habit not found.');
  }
  await pool.query('DELETE FROM habits WHERE id = $1', [req.params.id]);
  res.send('Habit deleted!');
});

setupTables().then(() => {
  app.listen(port, () => {
    console.log(`LevelUp server running on port ${port}`);
  });
});
