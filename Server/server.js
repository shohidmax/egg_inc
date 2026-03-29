const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- DATABASE CONNECTION ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
  .then(async () => {
      console.log('Successfully connected to MongoDB Atlas');
      try {
          const count = await ProfileModel.countDocuments();
          if (count === 0) {
              await ProfileModel.insertMany(defaultProfiles);
              console.log('Default profiles injected into DB.');
          }
          const dbProfiles = await ProfileModel.find();
          dbProfiles.forEach(p => { profiles[p.id] = p; });
      } catch (err) {
          console.error('Failed to init profiles:', err.message);
      }
  })
  .catch(err => console.error('MongoDB Connection Error:', err.message));

// Data Schema
const LogSchema = new mongoose.Schema({
    avgTemp: Number,
    humidity: Number,
    dhtTemp: Number,
    airQuality: Number,
    probes: [Number],
    timestamp: { type: Date, default: Date.now }
});
const TelemetryLog = mongoose.model('Telemetry', LogSchema);

const ProfileSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: String,
    days: Number,
    stages: [{ startDay: Number, endDay: Number, temp: Number, hum: Number, trayON: Boolean, trayInterval: Number, trayDuration: Number }]
});
const ProfileModel = mongoose.model('Profile', ProfileSchema);

// Incubation Profiles
let profiles = {}; // Loaded dynamically from DB

const defaultProfiles = [
    { id: 'chicken', name: "Chicken (21 Days)", days: 21, stages: [
        { startDay: 1, endDay: 18, temp: 37.7, hum: 55, trayON: true, trayInterval: 4, trayDuration: 10 },
        { startDay: 19, endDay: 21, temp: 37.2, hum: 65, trayON: false, trayInterval: 4, trayDuration: 10 }
    ]},
    { id: 'duck', name: "Duck (28 Days)", days: 28, stages: [
        { startDay: 1, endDay: 25, temp: 37.5, hum: 60, trayON: true, trayInterval: 4, trayDuration: 10 },
        { startDay: 26, endDay: 28, temp: 37.0, hum: 70, trayON: false, trayInterval: 4, trayDuration: 10 }
    ]},
    { id: 'quail', name: "Quail (18 Days)", days: 18, stages: [
        { startDay: 1, endDay: 15, temp: 37.5, hum: 45, trayON: true, trayInterval: 4, trayDuration: 10 },
        { startDay: 16, endDay: 18, temp: 37.2, hum: 65, trayON: false, trayInterval: 4, trayDuration: 10 }
    ]}
];

let currentProject = {
    active: false,
    profileId: null,
    startDate: null,
    currentDay: 0
};

// State Management
let currentStatus = {
    avgTemp: 0,
    humidity: 0,
    dhtTemp: 0,
    airQuality: 0,
    dallas: [0, 0, 0],
    relays: { heater: false, fogger: false, tray: false },
    config: { targetTemp: 37.5, targetHum: 65, trayInterval: 14400000, trayDuration: 600000 },
    project: currentProject,
    device: { online: false, ssid: '--', rssi: -100, ip: '--', lastSeen: 0 },
    overrides: { heater: -1, fogger: -1, tray: -1, buzzer: -1 }
};

let lastDbSave = 0;

// System Master Loop (every 5 seconds)
setInterval(() => {
    // 1. ESP32 Heartbeat Monitor
    if (currentStatus.device.online && (Date.now() - currentStatus.device.lastSeen > 10000)) {
        currentStatus.device.online = false;
        io.emit('telemetry', currentStatus);
    }

    // 2. Project Engine Logic
    if (currentProject.active && currentProject.startDate) {
        const msElapsed = Date.now() - new Date(currentProject.startDate).getTime();
        const currentDay = Math.floor(msElapsed / (1000 * 60 * 60 * 24)) + 1;
        currentProject.currentDay = currentDay;
        
        const profile = profiles[currentProject.profileId];
        if (profile) {
            const stage = profile.stages.find(s => currentDay >= s.startDay && currentDay <= s.endDay);
            if (stage) {
                currentStatus.config.targetTemp = stage.temp;
                currentStatus.config.targetHum = stage.hum;
                if (stage.trayON) {
                    currentStatus.config.trayInterval = (stage.trayInterval || 4) * 3600000; // hours to ms
                    currentStatus.config.trayDuration = (stage.trayDuration || 10) * 60000;  // minutes to ms
                    if (currentStatus.overrides.tray === 0) currentStatus.overrides.tray = -1; // Remove force off if stage becomes ON
                } else {
                    currentStatus.config.trayInterval = 999999999;
                    currentStatus.config.trayDuration = 0;
                    currentStatus.overrides.tray = 0; // Force tray OFF
                }
            }
        }
        io.emit('telemetry', currentStatus); // Push updates to UI
    }
}, 5000);

// --- ROUTES ---

// 1. Root Route (Fixed the "Cannot GET /" error)
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
            <h1 style="color: #60a5fa;">Smart Incubator Server</h1>
            <p style="color: #10b981;">● System is Live and Running</p>
            <p style="color: #94a3b8;">Listening for ESP32 and Dashboard connections on port 3000.</p>
            <hr style="border-color: #334155; margin: 20px 0;">
            <div style="font-size: 0.8em; color: #64748b;">Server IP: 192.168.0.2</div>
        </div>
    `);
});

// 2. Health Check for Dashboard
app.get('/health', (req, res) => {
    res.json({ status: 'online', database: mongoose.connection.readyState === 1 });
});

// 4. Update Status (Received from ESP32 via Firmware)
app.post('/api/update', async (req, res) => {
    const { temp, hum, dhtTemp, air, probes, relays, totalPpm, ssid, rssi, ip } = req.body;
    
    currentStatus.avgTemp = temp;
    currentStatus.humidity = hum;
    currentStatus.dhtTemp = dhtTemp;
    currentStatus.airQuality = air;
    currentStatus.dallas = probes;
    currentStatus.relays = relays;
    currentStatus.device = {
        online: true,
        ssid: ssid || '--',
        rssi: rssi || -100,
        ip: ip || '--',
        lastSeen: Date.now()
    };

    io.emit('telemetry', currentStatus);

    const now = Date.now();
    if (now - lastDbSave >= 60000) {
        lastDbSave = now;
        try {
            await new TelemetryLog({ avgTemp: temp, humidity: hum, dhtTemp, airQuality: air, probes }).save();
        } catch (e) { console.error("DB Save Error:", e.message); }
    }

    const responsePayload = {
        ...currentStatus.overrides,
        targetTemp: currentStatus.config.targetTemp,
        targetHum: currentStatus.config.targetHum,
        trayInterval: currentStatus.config.trayInterval,
        trayDuration: currentStatus.config.trayDuration
    };
    res.json(responsePayload);
});

// 5. Override Relay State
app.post('/api/override', (req, res) => {
    const { heater, fogger, tray, buzzer } = req.body;
    
    if (heater !== undefined) currentStatus.overrides.heater = heater;
    if (fogger !== undefined) currentStatus.overrides.fogger = fogger;
    if (tray !== undefined) currentStatus.overrides.tray = tray;
    if (buzzer !== undefined) currentStatus.overrides.buzzer = buzzer;

    io.emit('telemetry', currentStatus);
    res.json({ success: true, overrides: currentStatus.overrides });
});

app.get('/api/history', async (req, res) => {
    const { start, end } = req.query;
    let query = {};
    if (start && end) {
        query.timestamp = { $gte: new Date(start), $lte: new Date(end) };
    }
    
    try {
        const history = await TelemetryLog.find(query).sort({ timestamp: -1 }).limit(100);
        res.json(history);
    } catch (e) {
        console.error("Fetch DB Error:", e.message);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// --- PROJECT & SETTINGS APIS ---

app.get('/api/project/profiles', (req, res) => res.json(profiles));

app.post('/api/project/profiles', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload.id || !payload.name) return res.status(400).json({error: "Missing required fields"});
        const result = await ProfileModel.findOneAndUpdate(
            { id: payload.id }, 
            payload, 
            { new: true, upsert: true }
        );
        profiles[payload.id] = result;
        res.json({ success: true, profile: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/project/profiles/:id', async (req, res) => {
    try {
        const id = req.params.id;
        await ProfileModel.deleteOne({ id: id });
        delete profiles[id];
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/project/start', (req, res) => {
    const { profileId } = req.body;
    if (profiles[profileId]) {
        currentProject.active = true;
        currentProject.profileId = profileId;
        currentProject.startDate = new Date().toISOString();
        currentStatus.project = currentProject;
        res.json({ success: true, project: currentProject });
    } else {
        res.status(400).json({ error: "Invalid profile ID" });
    }
});

app.post('/api/project/stop', (req, res) => {
    currentProject.active = false;
    currentProject.currentDay = 0;
    currentStatus.overrides.tray = -1; // Restore tray logic to auto
    res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
    const { targetTemp, targetHum, trayInterval, trayDuration } = req.body;
    if (targetTemp !== undefined) currentStatus.config.targetTemp = Number(targetTemp);
    if (targetHum !== undefined) currentStatus.config.targetHum = Number(targetHum);
    if (trayInterval !== undefined) currentStatus.config.trayInterval = Number(trayInterval);
    if (trayDuration !== undefined) currentStatus.config.trayDuration = Number(trayDuration);
    io.emit('telemetry', currentStatus);
    res.json({ success: true, config: currentStatus.config });
});

// Socket.io Events
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('telemetry', currentStatus);
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is live and listening on port ${PORT}`);
});