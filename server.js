const express = require('express');
const Stripe = require('stripe');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());

// ⚠️ Svarīgi: raw body VISPERVESM (webhook vajadzībām)
app.use('/webhook', express.raw({ type: 'application/json' }));

// Visām pārējām rūtām izmanto JSON
app.use(express.json());

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==================== PALĪGFUNKCIJAS ====================

// Iegūt reālo klienta IP adresi
function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress;

    // Konvertēt IPv6 loopback uz IPv4
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
        return '127.0.0.1';
    }
    return ip;
}

// Iegūt ierīces ID (no headers vai body)
function getDeviceId(req) {
    const deviceId = req.headers['x-device-id'] || req.body?.device_id;
    return deviceId || null;
}

// Normalizēt kodu: noņem visu, izņemot burtus un ciparus, lielie burti
function normalizeCode(raw) {
    return raw.toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Ģenerēt aktivācijas kodu (12 zīmes)
function generateActivationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 12; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Formatēt kodu lietotājam: XXXX-XXXX-XXXX
function formatCodeForDisplay(code) {
    const clean = normalizeCode(code);
    return clean.match(/.{1,4}/g).join('-');
}

// ==================== GEOlokācija (tikai pēc IP, NAV GPS) ====================

const geoCache = new Map();
let serverPublicIP = null;

// Iegūt servera publisko IP adresi
async function getServerPublicIP() {
    if (serverPublicIP) return serverPublicIP;

    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        serverPublicIP = data.ip;
        console.log(`🖥️ Servera publiskā IP: ${serverPublicIP}`);
        return serverPublicIP;
    } catch (error) {
        console.log('⚠️ Nevar iegūt servera publisko IP');
        return null;
    }
}

// NOTEIKT VALSTI PĒC IP ADRESES (darbojas ar JEBKURU IP)
async function getCountryFromIP(ip) {
    // Pārbaudīt kešu
    if (geoCache.has(ip)) {
        return geoCache.get(ip);
    }

    try {
        let ipToCheck = ip;

        // Ja IP ir lokāla, izmantot servera publisko IP
        const isLocalIP = ip === '127.0.0.1' ||
            ip === 'localhost' ||
            ip.startsWith('192.168.') ||
            ip.startsWith('10.') ||
            ip.startsWith('172.16.');

        if (isLocalIP) {
            const publicIp = await getServerPublicIP();
            if (publicIp) {
                ipToCheck = publicIp;
                console.log(`📍 Lokālā IP ${ip} → izmanto publisko IP ${publicIp}`);
            }
        }

        // Izmantot bezmaksas IP geolokācijas API (nav nepieciešama atļauja)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`http://ip-api.com/json/${ipToCheck}?fields=status,country,countryCode`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await response.json();

        let result;
        if (data.status === 'success') {
            result = {
                country_code: data.countryCode,
                country_name: data.country
            };
            console.log(`🌍 Valsts noteikta: ${data.country} (${data.countryCode}) IP: ${ipToCheck}`);
        } else {
            result = { country_code: null, country_name: null };
            console.log(`⚠️ Nevar noteikt valsti IP: ${ipToCheck}`);
        }

        // Saglabāt kešā
        geoCache.set(ip, result);
        return result;

    } catch (error) {
        console.log('⚠️ Kļūda nosakot valsti:', error.message);
        return { country_code: null, country_name: null };
    }
}

// ==================== DATUBĀZES INICIALIZĀCIJA ====================

async function initDB() {
    try {
        const conn = await pool.getConnection();

        // customers tabula
        await conn.query(`
            CREATE TABLE IF NOT EXISTS customers (
                                                     id INT AUTO_INCREMENT PRIMARY KEY,
                                                     email VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) DEFAULT NULL,
                stripe_session_id VARCHAR(255) UNIQUE,
                stripe_customer_id VARCHAR(100) DEFAULT NULL,
                stripe_payment_intent_id VARCHAR(255) DEFAULT NULL,
                device_id VARCHAR(255) DEFAULT NULL,
                ip_address VARCHAR(45) DEFAULT NULL,
                country_code CHAR(2) DEFAULT NULL,
                country_name VARCHAR(100) DEFAULT NULL,
                purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status ENUM('pending', 'paid', 'failed') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
        `);

        // activations tabula
        await conn.query(`
            CREATE TABLE IF NOT EXISTS activations (
                                                       id INT AUTO_INCREMENT PRIMARY KEY,
                                                       activation_code VARCHAR(20) UNIQUE NOT NULL,
                customer_id INT,
                device_id VARCHAR(255) DEFAULT NULL,
                ip_address VARCHAR(45) DEFAULT NULL,
                user_agent TEXT DEFAULT NULL,
                country_code CHAR(2) DEFAULT NULL,
                country_name VARCHAR(100) DEFAULT NULL,
                is_used BOOLEAN DEFAULT FALSE,
                activated_at DATETIME DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                INDEX idx_activation_code (activation_code),
                INDEX idx_customer_id (customer_id),
                INDEX idx_is_used (is_used)
                );
        `);

        console.log('✅ Datubāzes tabulas ir gatavas');
        conn.release();
    } catch (err) {
        console.error('❌ Kļūda veidojot tabulas:', err.message);
    }
}

initDB();

// ==================== E-PASTA SŪTĪŠANA ====================

async function sendActivationEmail(email, displayCode, fullName = '') {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('⚠️ EMAIL_USER vai EMAIL_PASS nav konfigurēts .env failā');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });

    const nameHtml = fullName ? `<p>Sveiki, ${fullName}!</p>` : '<p>Sveiki!</p>';

    try {
        await transporter.sendMail({
            from: `"Čāpuki" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Čāpuku Meža Stāsti – aktivācijas kods',
            html: `
                <div style="font-family: sans-serif; max-width: 500px; margin: auto;">
                    <h2>🌲 Paldies par pirkumu!</h2>
                    ${nameHtml}
                    <p>Tavs aktivācijas kods:</p>
                    <div style="
                        font-size: 32px;
                        font-weight: bold;
                        letter-spacing: 4px;
                        background: #f0f8e8;
                        border: 2px solid #4a7c59;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                        color: #2d5a3d;
                        margin: 20px 0;
                    ">${displayCode}</div>
                    <p>Ievadi šo kodu lietotnē, lai atbloķētu grāmatu.</p>
                    <p style="color: #888; font-size: 12px;">Kods ir izmantojams vienu reizi.</p>
                    <hr style="margin: 20px 0;">
                    <p style="color: #aaa; font-size: 11px;">Čāpuku meža stāsti - 1. grāmata</p>
                </div>
            `,
        });
        console.log(`📧 E-pasts nosūtīts uz: ${email}`);
    } catch (err) {
        console.error('❌ E-pasta kļūda:', err.message);
    }
}

// ==================== ENDPOINTI ====================

// 1. IZVEIDOT MAKSĀJUMA SESIJU
app.post('/create-checkout-session', async (req, res) => {
    const deviceId = getDeviceId(req);
    const ipAddress = getClientIP(req);

    console.log('🛒 Jauna pirkuma sesija');
    console.log(`   Device ID: ${deviceId}`);
    console.log(`   IP: ${ipAddress}`);

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: 'Čāpuku Meža stāsti – 1. grāmata',
                        description: 'Pilna piekļuve grāmatai'                   },
                    unit_amount: 499,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'https://talers.lv/apps/chapuki/success.html',  // ← Donde está tu app
            cancel_url: 'https://talers.lv/apps/chapuki/cancel.html',    // ← Donde está tu app
            metadata: {
                device_id: deviceId || 'unknown',
                ip_address: ipAddress
            }
        });

        console.log('✅ Stripe sesija izveidota:', session.id);
        res.json({ url: session.url });
    } catch (error) {
        console.error('❌ Kļūda izveidojot sesiju:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. WEBHOOK (saņem apstiprinājumu no Stripe)
app.post('/webhook', async (req, res) => {
    console.log("🔥 WEBHOOK SAŅEMTS");
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        console.log(`✅ Notikuma veids: ${event.type}`);
    } catch (err) {
        console.error("❌ Paraksta kļūda:", err.message);
        return res.status(400).send('Webhook Error');
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_details?.email;
        const fullName = session.customer_details?.name;
        const stripeCustomerId = session.customer;
        const stripePaymentIntentId = session.payment_intent;

        const deviceId = req.headers['x-device-id'] || session.metadata?.device_id || null;
        const ipAddress = getClientIP(req);
        const userAgent = req.headers['user-agent'] || null;

        // NOTEIKT VALSTI PĒC IP (automātiski, bez GPS)
        const country = await getCountryFromIP(ipAddress);

        if (email) {
            const activationCode = generateActivationCode();
            const displayCode = formatCodeForDisplay(activationCode);

            console.log(`🎉 MAKSĀJUMS VEIKSMĪGS!`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`📧 E-pasts: ${email}`);
            console.log(`👤 Vārds: ${fullName || 'Nav norādīts'}`);
            console.log(`🆔 Device ID: ${deviceId}`);
            console.log(`🌐 IP adrese: ${ipAddress}`);
            console.log(`🌍 Valsts: ${country.country_name || 'Nav noteikts'} (${country.country_code || '-'})`);
            console.log(`🔑 Aktivācijas kods: ${displayCode}`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

            try {
                const [result] = await pool.query(
                    `INSERT INTO customers
                     (email, full_name, stripe_session_id, stripe_customer_id,
                      stripe_payment_intent_id, device_id, ip_address,
                      country_code, country_name, status, purchased_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', NOW())`,
                    [email, fullName, session.id, stripeCustomerId,
                        stripePaymentIntentId, deviceId, ipAddress,
                        country.country_code, country.country_name]
                );

                const customerId = result.insertId;
                console.log(`💾 Saglabāts customers ar ID: ${customerId}`);

                await pool.query(
                    `INSERT INTO activations
                     (activation_code, customer_id, device_id, ip_address, user_agent,
                      country_code, country_name)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [activationCode, customerId, deviceId, ipAddress, userAgent,
                        country.country_code, country.country_name]
                );

                console.log(`💾 Saglabāts aktivācijas kods datubāzē`);
                await sendActivationEmail(email, displayCode, fullName);

            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    console.warn('⚠️ Sesija jau apstrādāta:', session.id);
                } else {
                    console.error('❌ Kļūda saglabājot datubāzē:', err);
                }
            }
        }
    }

    res.status(200).send('OK');
});

// 3. AKTIVĒT KODU
app.post('/verify-code', async (req, res) => {
    const raw = req.body?.code;
    const deviceId = getDeviceId(req);
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || null;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 KODA AKTIVĀCIJA');
    console.log(`📱 Device ID: ${deviceId}`);
    console.log(`🌐 IP adrese: ${ipAddress}`);

    if (!raw) {
        return res.json({ valid: false, message: 'Nav koda' });
    }

    const code = normalizeCode(raw);
    console.log(`🔍 Normalizēts kods: "${code}"`);

    if (code.length !== 12) {
        return res.json({
            valid: false,
            message: `Kodam jābūt 12 zīmēm. Saņemts: ${code.length}`
        });
    }

    try {
        const [rows] = await pool.query(
            `SELECT a.*, c.email, c.full_name
             FROM activations a
                      JOIN customers c ON a.customer_id = c.id
             WHERE a.activation_code = ? AND a.is_used = FALSE`,
            [code]
        );

        if (rows.length > 0) {
            // NOTEIKT VALSTI AKTIVĀCIJAS BRĪDĪ
            const country = await getCountryFromIP(ipAddress);

            await pool.query(
                `UPDATE activations
                 SET is_used = TRUE,
                     activated_at = NOW(),
                     device_id = COALESCE(?, device_id),
                     ip_address = COALESCE(?, ip_address),
                     user_agent = COALESCE(?, user_agent),
                     country_code = COALESCE(?, country_code),
                     country_name = COALESCE(?, country_name)
                 WHERE activation_code = ?`,
                [deviceId, ipAddress, userAgent, country.country_code, country.country_name, code]
            );

            console.log(`✅ Kods VEIKSMĪGI aktivēts!`);
            console.log(`   Valsts: ${country.country_name || 'Nav noteikts'}`);

            return res.json({
                valid: true,
                message: 'Kods veiksmīgi aktivēts'
            });
        } else {
            console.log(`❌ Kods nederīgs vai jau izmantots: ${code}`);
            return res.json({
                valid: false,
                message: 'Nepareizs kods vai jau izmantots'
            });
        }
    } catch (err) {
        console.error('❌ Kļūda verificējot kodu:', err);
        return res.status(500).json({
            valid: false,
            message: 'Servera kļūda'
        });
    }
});

// 4. PĀRBAUDĪT AKTIVĀCIJAS STATUSU
app.post('/check-activation', async (req, res) => {
    const deviceId = getDeviceId(req);

    console.log(`🔍 Pārbauda aktivāciju ierīcei: ${deviceId}`);

    if (!deviceId) {
        return res.json({ activated: false });
    }

    try {
        const [rows] = await pool.query(
            `SELECT * FROM activations
             WHERE device_id = ? AND is_used = TRUE`,
            [deviceId]
        );

        if (rows.length > 0) {
            console.log(`✅ Ierīce jau aktivēta: ${deviceId}`);
            return res.json({ activated: true });
        } else {
            console.log(`❌ Ierīce nav aktivēta: ${deviceId}`);
            return res.json({ activated: false });
        }
    } catch (err) {
        console.error('Kļūda:', err);
        return res.status(500).json({ activated: false });
    }
});

// ==================== DEBUG ENDPOINTI ====================

if (process.env.NODE_ENV !== 'production') {

    app.get('/debug/codes', async (req, res) => {
        const [rows] = await pool.query(
            `SELECT a.id, a.activation_code, a.is_used, a.device_id, a.ip_address,
                    a.country_code, a.country_name, a.activated_at,
                    c.email, c.full_name
             FROM activations a
                      JOIN customers c ON a.customer_id = c.id
             ORDER BY a.created_at DESC
                 LIMIT 20`
        );
        res.json(rows);
    });

    app.get('/debug/stats', async (req, res) => {
        const [totalCustomers] = await pool.query('SELECT COUNT(*) as total FROM customers');
        const [totalActivations] = await pool.query('SELECT COUNT(*) as total FROM activations WHERE is_used = TRUE');
        const [customersByCountry] = await pool.query(
            'SELECT country_code, country_name, COUNT(*) as count FROM customers WHERE country_code IS NOT NULL GROUP BY country_code'
        );

        res.json({
            total_customers: totalCustomers[0].total,
            total_activations: totalActivations[0].total,
            customers_by_country: customersByCountry
        });
    });
}

// ==================== STARTĒT SERVERI ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🚀 Serveris darbojas uz porta: ${PORT}`);
    console.log(`📊 Webhook: https://chapuki-backend.onrender.com/webhook`);
    console.log(`🔑 Verifikācija: https://chapuki-backend.onrender.com/verify-code`);
    console.log(`🌍 Geolokācija pēc IP (bez GPS) - darbojas ar JEBKURU IP`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
