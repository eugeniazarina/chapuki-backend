const express = require('express');
const Stripe = require('stripe');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Device-ID']
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== PALĪGFUNKCIJAS ====================

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress;
    if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
    return ip;
}

function getDeviceId(req) {
    return req.headers['x-device-id'] || req.body?.device_id || null;
}

function normalizeCode(raw) {
    return raw.toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateActivationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 12; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function formatCodeForDisplay(code) {
    return normalizeCode(code).match(/.{1,4}/g).join('-');
}

// ==================== GEOLOKĀCIJA ====================

const geoCache = new Map();
let serverPublicIP = null;

async function getServerPublicIP() {
    if (serverPublicIP) return serverPublicIP;
    try {
        const r = await fetch('https://api.ipify.org?format=json');
        const d = await r.json();
        serverPublicIP = d.ip;
        return serverPublicIP;
    } catch { return null; }
}

async function getCountryFromIP(ip) {
    if (geoCache.has(ip)) return geoCache.get(ip);
    try {
        let ipToCheck = ip;
        const isLocal = ['127.0.0.1','localhost'].includes(ip) ||
            ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.');
        if (isLocal) { const pub = await getServerPublicIP(); if (pub) ipToCheck = pub; }

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(`http://ip-api.com/json/${ipToCheck}?fields=status,country,countryCode`, { signal: ctrl.signal });
        clearTimeout(t);
        const d = await r.json();

        const result = d.status === 'success'
            ? { country_code: d.countryCode, country_name: d.country }
            : { country_code: null, country_name: null };
        geoCache.set(ip, result);
        return result;
    } catch { return { country_code: null, country_name: null }; }
}

// ==================== DB INICIALIZĀCIJA ====================

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                full_name VARCHAR(100),
                stripe_session_id VARCHAR(255) UNIQUE,
                stripe_customer_id VARCHAR(100),
                stripe_payment_intent_id VARCHAR(255),
                device_id VARCHAR(255),
                ip_address VARCHAR(45),
                country_code CHAR(2),
                country_name VARCHAR(100),
                purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS activations (
                                                       id SERIAL PRIMARY KEY,
                                                       activation_code VARCHAR(20) UNIQUE NOT NULL,
                customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
                device_id VARCHAR(255),
                ip_address VARCHAR(45),
                user_agent TEXT,
                country_code CHAR(2),
                country_name VARCHAR(100),
                is_used BOOLEAN DEFAULT FALSE,
                activated_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_activation_code ON activations(activation_code)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_is_used ON activations(is_used)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_id ON activations(device_id)`);
        console.log('✅ Datubāzes tabulas ir gatavas');
    } catch (err) {
        console.error('❌ Kļūda veidojot tabulas:', err.message);
    }
}

initDB();

// ==================== E-PASTS ====================

async function sendActivationEmail(email, displayCode, fullName = '') {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('⚠️ EMAIL_USER vai EMAIL_PASS nav konfigurēts');
        return;
    }
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    try {
        await transporter.sendMail({
            from: `"Čāpuki" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Čāpuku Meža Stāsti – aktivācijas kods',
            html: `
                <div style="font-family:sans-serif;max-width:500px;margin:auto">
                    <h2>🌲 Paldies par pirkumu!</h2>
                    ${fullName ? `<p>Sveiki, ${fullName}!</p>` : '<p>Sveiki!</p>'}
                    <p>Tavs aktivācijas kods:</p>
                    <div style="font-size:32px;font-weight:bold;letter-spacing:4px;
                        background:#f0f8e8;border:2px solid #4a7c59;border-radius:8px;
                        padding:20px;text-align:center;color:#2d5a3d;margin:20px 0">
                        ${displayCode}
                    </div>
                    <p>Ievadi šo kodu lietotnē, lai atbloķētu grāmatu.</p>
                    <p style="color:#888;font-size:12px">Kods ir izmantojams vienu reizi.</p>
                    <hr style="margin:20px 0">
                    <p style="color:#aaa;font-size:11px">Čāpuku meža stāsti - 1. grāmata</p>
                </div>
            `,
        });
        console.log(`📧 E-pasts nosūtīts: ${email}`);
    } catch (err) {
        console.error('❌ E-pasta kļūda:', err.message);
    }
}

// ==================== ENDPOINTI ====================

// 1. CHECKOUT SESSION
app.post('/create-checkout-session', async (req, res) => {
    const deviceId = getDeviceId(req);
    const ipAddress = getClientIP(req);
    console.log(`🛒 Jauna sesija | Device: ${deviceId} | IP: ${ipAddress}`);

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: 'Čāpuku Meža stāsti – 1. grāmata',
                        description: 'Pilna piekļuve grāmatai'
                    },
                    unit_amount: 499,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'https://talers.lv/apps/chapuki/success.html',
            cancel_url: 'https://talers.lv/apps/chapuki/cancel.html',
            metadata: { device_id: deviceId || 'unknown', ip_address: ipAddress }
        });

        console.log('✅ Stripe sesija:', session.id);
        res.json({ url: session.url });
    } catch (error) {
        console.error('❌ Stripe kļūda:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. WEBHOOK
app.post('/webhook', async (req, res) => {
    console.log('🔥 WEBHOOK SAŅEMTS');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        console.log(`✅ Notikums: ${event.type}`);
    } catch (err) {
        console.error('❌ Paraksta kļūda:', err.message);
        return res.status(400).send('Webhook Error');
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_details?.email;
        const fullName = session.customer_details?.name;
        const deviceId = session.metadata?.device_id || null;
        const ipAddress = getClientIP(req);
        const userAgent = req.headers['user-agent'] || null;
        const country = await getCountryFromIP(ipAddress);

        if (email) {
            const activationCode = generateActivationCode();
            const displayCode = formatCodeForDisplay(activationCode);
            console.log(`🎉 MAKSĀJUMS! E-pasts: ${email} | Kods: ${displayCode}`);

            try {
                const result = await pool.query(
                    `INSERT INTO customers
                     (email,full_name,stripe_session_id,stripe_customer_id,
                      stripe_payment_intent_id,device_id,ip_address,
                      country_code,country_name,status,purchased_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'paid',NOW()) RETURNING id`,
                    [email, fullName, session.id, session.customer,
                        session.payment_intent, deviceId, ipAddress,
                        country.country_code, country.country_name]
                );
                const customerId = result.rows[0].id;

                await pool.query(
                    `INSERT INTO activations
                     (activation_code,customer_id,device_id,ip_address,user_agent,country_code,country_name)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                    [activationCode, customerId, deviceId, ipAddress,
                        userAgent, country.country_code, country.country_name]
                );

                await sendActivationEmail(email, displayCode, fullName);
            } catch (err) {
                if (err.code === '23505') console.warn('⚠️ Sesija jau apstrādāta:', session.id);
                else console.error('❌ DB kļūda:', err);
            }
        }
    }
    res.status(200).send('OK');
});

// 3. VERIFY CODE
app.post('/verify-code', async (req, res) => {
    const raw = req.body?.code;
    const deviceId = getDeviceId(req);
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || null;

    if (!raw) return res.json({ valid: false, message: 'Nav koda' });

    const code = normalizeCode(raw);
    if (code.length !== 12) return res.json({ valid: false, message: `Kodam jābūt 12 zīmēm. Saņemts: ${code.length}` });

    try {
        const { rows } = await pool.query(
            `SELECT a.* FROM activations a WHERE a.activation_code = $1 AND a.is_used = FALSE`,
            [code]
        );

        if (rows.length > 0) {
            const country = await getCountryFromIP(ipAddress);
            await pool.query(
                `UPDATE activations SET is_used=TRUE, activated_at=NOW(),
                                        device_id=COALESCE($1,device_id), ip_address=COALESCE($2,ip_address),
                                        user_agent=COALESCE($3,user_agent), country_code=COALESCE($4,country_code),
                                        country_name=COALESCE($5,country_name), updated_at=NOW()
                 WHERE activation_code=$6`,
                [deviceId, ipAddress, userAgent, country.country_code, country.country_name, code]
            );
            console.log(`✅ Kods aktivēts: ${code}`);
            return res.json({ valid: true, message: 'Kods veiksmīgi aktivēts' });
        } else {
            console.log(`❌ Kods nederīgs: ${code}`);
            return res.json({ valid: false, message: 'Nepareizs kods vai jau izmantots' });
        }
    } catch (err) {
        console.error('❌ Kļūda:', err);
        return res.status(500).json({ valid: false, message: 'Servera kļūda' });
    }
});

// 4. CHECK ACTIVATION
app.post('/check-activation', async (req, res) => {
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.json({ activated: false });
    try {
        const { rows } = await pool.query(
            `SELECT id FROM activations WHERE device_id=$1 AND is_used=TRUE LIMIT 1`,
            [deviceId]
        );
        return res.json({ activated: rows.length > 0 });
    } catch (err) {
        return res.status(500).json({ activated: false });
    }
});

// ==================== DEBUG ====================

if (process.env.NODE_ENV !== 'production') {
    app.get('/debug/codes', async (req, res) => {
        const { rows } = await pool.query(
            `SELECT a.id, a.activation_code, a.is_used, a.device_id,
                    a.country_code, a.country_name, a.activated_at,
                    c.email, c.full_name
             FROM activations a JOIN customers c ON a.customer_id=c.id
             ORDER BY a.created_at DESC LIMIT 20`
        );
        res.json(rows);
    });

    app.get('/debug/stats', async (req, res) => {
        const { rows: [tc] } = await pool.query('SELECT COUNT(*) as total FROM customers');
        const { rows: [ta] } = await pool.query('SELECT COUNT(*) as total FROM activations WHERE is_used=TRUE');
        const { rows: bc } = await pool.query(
            `SELECT country_code, country_name, COUNT(*) as count FROM customers
             WHERE country_code IS NOT NULL GROUP BY country_code, country_name`
        );
        res.json({ total_customers: tc.total, total_activations: ta.total, customers_by_country: bc });
    });
}

// ==================== START ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🚀 Serveris darbojas uz porta: ${PORT}`);
    console.log(`❤️  Health: https://chapuki-backend.onrender.com/health`);
    console.log(`📊 Webhook: https://chapuki-backend.onrender.com/webhook`);
    console.log(`🔑 Verifikācija: https://chapuki-backend.onrender.com/verify-code`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
