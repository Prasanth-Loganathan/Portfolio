import { DateTime } from "luxon";

// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { DateTime } = require('luxon');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@example.com';

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error('Missing credentials.json (Google Cloud OAuth).');
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const { client_id, client_secret, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

if (fs.existsSync(TOKEN_PATH)) {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
}

// Optional Nodemailer transport if .env SMTP provided
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  transporter.verify().then(()=>console.log('Nodemailer ready')).catch(err => console.warn('Nodemailer:', err.message));
}

function calendarClient() {
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// 1) Start OAuth flow
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

// 2) OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send('Authorization successful. You can close this tab.');
  } catch (err) {
    console.error('OAuth error', err);
    res.status(500).send('Auth error');
  }
});

/**
POST /api/schedule
{
  "name": "Client Name",
  "email": "client@example.com",
  "start": "2025-09-01T15:00",   // datetime-local string
  "durationMinutes": 30,
  "timezone": "Europe/Berlin"
}
*/
app.post('/api/schedule', async (req, res) => {
  try {
    const creds = oAuth2Client.credentials;
    if (!creds || (!creds.access_token && !creds.refresh_token)) {
      return res.status(401).json({ error: 'Server not authorized. Visit /auth first.' });
    }

    const { name, email, start, durationMinutes = 30, timezone = 'Europe/Berlin' } = req.body;
    if (!name || !email || !start) return res.status(400).json({ error: 'Missing fields' });

    // const startDT = DateTime.fromISO(start, { zone: timezone });
    // if (!startDT.isValid) return res.status(400).json({ error: 'Invalid start datetime' });
    // const endDT = startDT.plus({ minutes: durationMinutes });

    // const userTimezone = "Asia/Kolkata";       // Incoming meetingTime is in IST
const targetTimezone = "Europe/Berlin";    // Convert to Berlin time

// Parse naive datetime as IST
const startDT_GMT = DateTime.fromISO(start, { zone: targetTimezone });

// Convert to Berlin
const startDT_Berlin = startDT_GMT.setZone(targetTimezone);
const endDT_Berlin = startDT_Berlin.plus({ minutes: durationMinutes });

const eventBody = {
  summary: `Meeting with ${name}`,
  description: `Scheduled via portfolio. Participant: ${name} <${email}>`,
  start: { dateTime: startDT_Berlin.toISO(), timeZone: targetTimezone },
  end: { dateTime: endDT_Berlin.toISO(), timeZone: targetTimezone },
  
  attendees: [{ email: OWNER_EMAIL }, { email }],
  reminders: {
    useDefault: false,
    overrides: [{ method: 'email', minutes: 15 }]
  },
  conferenceData: {
    createRequest: {
      requestId: uuidv4(),
      conferenceSolutionKey: { type: 'hangoutsMeet' }
    }
  }
};
    // const eventBody = {
    //   summary: `Meeting with ${name}`,
    //   description: `Scheduled via portfolio. Participant: ${name} <${email}>`,
    //   start: { dateTime: startDT.toISO(), timeZone: timezone },
    //   end: { dateTime: endDT.toISO(), timeZone: timezone },
    //   attendees: [{ email: OWNER_EMAIL }, { email }],
    //   reminders: {
    //     useDefault: false,
    //     overrides: [{ method: 'email', minutes: 15 }]
    //   },
    //   conferenceData: {
    //     createRequest: {
    //       requestId: uuidv4(),
    //       conferenceSolutionKey: { type: 'hangoutsMeet' }
    //     }
    //   }
    // };

    const response = await calendarClient().events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: eventBody,
      sendUpdates: 'all'
    });

    const ev = response.data;
    const meetLink = ev.hangoutLink ||
      (ev.conferenceData?.entryPoints || []).find(e => e.entryPointType === 'video')?.uri || null;

//     // Optional: immediate confirmation + scheduled extra reminder using Nodemailer
//     if (transporter) {
//       const confirmationHtml = `
//         <p>Hi ${name},</p>
//         <p>Your meeting is scheduled:</p>
//         <ul>
//           <li><b>When:</b> ${startDT.toFormat('dd LLL yyyy HH:mm')} (${timezone})</li>
//           <li><b>Duration:</b> ${durationMinutes} minutes</li>
//           <li><b>Meet:</b> ${meetLink ? `<a href="${meetLink}">${meetLink}</a>` : 'Check calendar invite'}</li>
//         </ul>
//       `;
//       transporter.sendMail({
//         from: "Scheduler" <\${process.env.SMTP_USER}>\`,
//         to: [email, OWNER_EMAIL],
//         subject: ,Meeting scheduled: ${startDT.toFormat('dd LLL yyyy HH:mm')}`,
//         html, confirmationHtml
//       }).catch(err => console.warn('Immediate mail failed:', err.message));

//       // schedule in-memory reminder 15 minutes before event
//       const reminderDate = startDT.minus({ minutes: 15 }).toJSDate();
//       if (reminderDate > new Date()) {
//         schedule.scheduleJob(reminderDate, async () => {
//           try {
//             await transporter.sendMail({
//               from: \`"Scheduler" <\${process.env.SMTP_USER}>\`,
//               to: [email, OWNER_EMAIL],
//               subject: 'Reminder: Meeting in 15 minutes',
//               html: `<p>Reminder: meeting starts in 15 minutes. Join: ${meetLink || 'check calendar invite'}</p>`
//             });
//           } catch (err) {
//             console.error('Scheduled mail failed:', err.message);
//           }
//         });
//       }
//     }

    res.json({
      eventId: ev.id,
      htmlLink: ev.htmlLink,
      meetLink,
      start: ev.start,
      end: ev.end
    });
  } catch (err) {
    console.error('Schedule error', err);
    res.status(500).json({ error: 'Failed to schedule', details: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));