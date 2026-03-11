require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const fetch    = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ── Schemas ──────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  name:      { type: String, required: true, unique: true },
  role:      { type: String, enum: ['patient', 'provider'], required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Availability = mongoose.model('Availability', new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dayOfWeek:  { type: Number, min: 0, max: 6 },
  startTime:  String,
  endTime:    String,
}));

const Meeting = mongoose.model('Meeting', new mongoose.Schema({
  providerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  patientId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  scheduledAt:   { type: Date, required: true },
  duration:      { type: Number, default: 30 },
  status:        { type: String, enum: ['scheduled','active','completed','cancelled'], default: 'scheduled' },
  roomId:        String,
  hostRoomCode:  String,
  guestRoomCode: String,
  createdAt:     { type: Date, default: Date.now }
}));

// ── 100ms helpers ────────────────────────────────────────
function generate100msToken() {
  return jwt.sign(
    { access_key: process.env.HMS_ACCESS_KEY, type: 'management', version: 2,
      iat: Math.floor(Date.now()/1000), nbf: Math.floor(Date.now()/1000) },
    process.env.HMS_SECRET,
    { algorithm: 'HS256', expiresIn: '24h', jwtid: Math.random().toString(36).slice(2) }
  );
}

async function create100msRoom(name) {
  const token = generate100msToken();
  const tRes  = await fetch('https://api.100ms.live/v2/templates', { headers: { Authorization: `Bearer ${token}` }});
  const tData = await tRes.json();
  const templateId = tData.data?.[0]?.id;
  const res = await fetch('https://api.100ms.live/v2/rooms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,40), description: 'Swastham consultation', ...(templateId && { template_id: templateId }) })
  });
  return res.json();
}

async function create100msRoomCodes(roomId) {
  const token = generate100msToken();
  const res = await fetch(`https://api.100ms.live/v2/room-codes/room/${roomId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return res.json();
}

// ── Routes ───────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Swastham API ✅' }));

app.post('/api/login', async (req, res) => {
  try {
    const { name, role } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'Name and role required' });
    let user = await User.findOne({ name: name.trim() });
    if (!user) user = await User.create({ name: name.trim(), role });
    res.json({ user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/providers', async (req, res) => {
  try {
    const providers = await User.find({ role: 'provider' });
    res.json({ providers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/availability', async (req, res) => {
  try {
    const { providerId, slots } = req.body;
    await Availability.deleteMany({ providerId });
    await Availability.insertMany(slots.map(s => ({ providerId, ...s })));
    res.json({ message: 'Availability saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/availability/:providerId', async (req, res) => {
  try {
    const slots = await Availability.find({ providerId: req.params.providerId });
    res.json({ slots });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/slots/:providerId', async (req, res) => {
  try {
    const availability = await Availability.find({ providerId: req.params.providerId });
    if (!availability.length) return res.json({ slots: [] });

    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14*24*60*60*1000);
    const booked = await Meeting.find({
      providerId: req.params.providerId,
      scheduledAt: { $gte: now, $lte: twoWeeks },
      status: { $ne: 'cancelled' }
    });
    const bookedTimes = booked.map(m => m.scheduledAt.getTime());

    const slots = [];
    for (let d = 0; d < 14; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() + d);
      date.setHours(0,0,0,0);
      const dow = date.getDay();
      const avail = availability.find(a => a.dayOfWeek === dow);
      if (!avail) continue;

      const [sH, sM] = avail.startTime.split(':').map(Number);
      const [eH, eM] = avail.endTime.split(':').map(Number);
      let t = new Date(date); t.setHours(sH, sM, 0, 0);
      const end = new Date(date); end.setHours(eH, eM, 0, 0);

      while (t < end) {
        const tEnd = new Date(t.getTime() + 30*60*1000);
        if (t > now && !bookedTimes.includes(t.getTime())) {
          slots.push({ start: t.toISOString(), end: tEnd.toISOString() });
        }
        t = tEnd;
      }
    }
    res.json({ slots });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/meetings', async (req, res) => {
  try {
    const { providerId, patientId, scheduledAt } = req.body;
    const conflict = await Meeting.findOne({ providerId, scheduledAt: new Date(scheduledAt), status: { $ne: 'cancelled' } });
    if (conflict) return res.status(409).json({ error: 'Slot already booked' });

    const room = await create100msRoom(`swastham-${Date.now()}`);
    if (!room.id) return res.status(500).json({ error: '100ms room creation failed', details: room });

    const codes = await create100msRoomCodes(room.id);
    const hostCode  = codes.data?.find(c => c.role === 'host')?.code;
    const guestCode = codes.data?.find(c => c.role === 'guest')?.code;

    const meeting = await Meeting.create({ providerId, patientId, scheduledAt: new Date(scheduledAt), roomId: room.id, hostRoomCode: hostCode, guestRoomCode: guestCode });
    const populated = await Meeting.findById(meeting._id).populate('providerId','name role').populate('patientId','name role');
    res.json({ meeting: populated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/meetings/user/:userId', async (req, res) => {
  try {
    const meetings = await Meeting.find({ $or: [{ providerId: req.params.userId }, { patientId: req.params.userId }], status: { $ne: 'cancelled' } })
      .populate('providerId','name role').populate('patientId','name role').sort({ scheduledAt: 1 });
    res.json({ meetings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/meetings/:meetingId', async (req, res) => {
  try {
    const meeting = await Meeting.findById(req.params.meetingId).populate('providerId','name role').populate('patientId','name role');
    if (!meeting) return res.status(404).json({ error: 'Not found' });
    res.json({ meeting });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/meetings/:meetingId/cancel', async (req, res) => {
  try {
    const meeting = await Meeting.findByIdAndUpdate(req.params.meetingId, { status: 'cancelled' }, { new: true });
    res.json({ meeting });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Swastham API on port ${PORT}`));
