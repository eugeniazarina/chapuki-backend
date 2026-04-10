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

// ← ORDEN CRÍTICO: raw body PRIMERO (para webhook)
app.use('/webhook', express.raw({ type: 'application/json' }));

// Para todas las demás rutas usamos JSON
app.use(express.json());

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function initDB() {
    try {
        const conn = await pool.getConnection();
        await conn.query(`
            CREATE TABLE IF NOT EXISTS customers (
                                                     id INT AUTO_INCREMENT PRIMARY KEY,
                                                     email VARCHAR(255) NOT NULL,
                stripe_session_id VARCHAR(255) UNIQUE,
                purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status ENUM('pending', 'paid') DEFAULT 'pending'
                );
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS activations (
                                                       id INT AUTO_INCREMENT PRIMARY KEY,
                                                       activation_code VARCHAR(20) UNIQUE NOT NULL,
                customer_id INT,
                is_used BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
                );
        `);
        console.log('✅ Datubāzes tabulas ir gatavas');
        conn.release();
    } catch (err) {
        console.error('❌ Kļūda veidojot tabulas:', err.message);
    }
}
initDB();

// ==================== HELPER: normalizar código ====================
// Elimina TODO excepto letras y números, convierte a mayúsculas
// Tanto el código guardado en DB como el recibido del cliente
// pasan por esta función → siempre coinciden
function normalizeCode(raw) {
    return raw.toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Genera código SIN guiones (12 chars alfanuméricos)
function generateActivationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 12; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code; // guardamos sin guiones en DB
}

// Formatea para mostrar al usuario: XXXX-XXXX-XXXX
function formatCodeForDisplay(code) {
    return normalizeCode(code).match(/.{1,4}/g).join('-');
}

// ==================== CREATE CHECKOUT SESSION ====================
app.post('/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { name: 'Čāpuku meža stāsti – 1. grāmata' },
                    unit_amount: 999,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'http://192.168.18.6:3000/payment-success',
            cancel_url: 'http://192.168.18.6:3000/cancel',
        });

        console.log('✅ Sesija izveidota:', session.id);
        res.json({ url: session.url });
    } catch (error) {
        console.error('❌ Kļūda izveidojot sesiju:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== VERIFY CODE ====================
app.post('/verify-code', async (req, res) => {
    const raw = req.body?.code;

    console.log('📥 Kods saņemts /verify-code:', raw);

    if (!raw) {
        return res.json({ valid: false, message: 'Nav koda' });
    }

    // Normalizar: eliminar guiones, espacios, mayúsculas
    const code = normalizeCode(raw);

    console.log(`🔍 Normalizēts kods: "${code}" (garums: ${code.length})`);

    if (code.length !== 12) {
        return res.json({
            valid: false,
            message: `Kodam jābūt 12 zīmēm. Saņemts: ${code.length}`
        });
    }

    try {
        const [rows] = await pool.query(
            'SELECT * FROM activations WHERE activation_code = ? AND is_used = FALSE',
            [code]  // buscamos el código normalizado (sin guiones)
        );

        console.log(`🔎 DB rezultāts: ${rows.length} rindas`);

        if (rows.length > 0) {
            await pool.query(
                'UPDATE activations SET is_used = TRUE WHERE activation_code = ?',
                [code]
            );

            console.log(`✅ Kods apstiprināts: ${code}`);
            return res.json({ valid: true });
        } else {
            // Debug: mostrar qué hay en la tabla
            const [all] = await pool.query('SELECT activation_code, is_used FROM activations LIMIT 10');
            console.log('📋 Kodi datubāzē:', all);

            return res.json({ valid: false, message: 'Nepareizs kods vai jau izmantots' });
        }
    } catch (err) {
        console.error('Kļūda verificējot kodu:', err);
        return res.status(500).json({ valid: false, message: 'Servera kļūda' });
    }
});

// ==================== WEBHOOK ====================
app.post('/webhook', async (req, res) => {
    console.log("🔥 WEBHOOK SAŅEMTS");
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        console.log(`✅ Notikums: ${event.type}`);
    } catch (err) {
        console.error("❌ Paraksta kļūda:", err.message);
        return res.status(400).send('Webhook Error');
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_details?.email;

        if (email) {
            // Generamos código normalizado (sin guiones) para guardar en DB
            const activationCode = generateActivationCode();
            const displayCode = formatCodeForDisplay(activationCode);

            console.log(`🎉 MAKSĀJUMS VEIKSMĪGS`);
            console.log(`   Email: ${email}`);
            console.log(`   Kods DB: ${activationCode}`);
            console.log(`   Kods lietotājam: ${displayCode}`);

            try {
                const [result] = await pool.query(
                    'INSERT INTO customers (email, stripe_session_id, status) VALUES (?, ?, "paid")',
                    [email, session.id]
                );

                await pool.query(
                    'INSERT INTO activations (activation_code, customer_id) VALUES (?, ?)',
                    [activationCode, result.insertId]  // guardamos SIN guiones
                );

                console.log('💾 Saglabāts datubāzē');

                // Enviar email con el código formateado (con guiones para el usuario)
                await sendActivationEmail(email, displayCode);

            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    console.warn('⚠️ Sesija jau apstrādāta:', session.id);
                } else {
                    console.error('Kļūda saglabājot:', err);
                }
            }
        }
    }

    res.status(200).send('OK');
});

// ==================== EMAIL (Gmail) ====================
// .env vajag: EMAIL_USER=tava@gmail.com  EMAIL_PASS=xxxxxxxxxxxxxxxx (16 zīmju App Password)
async function sendActivationEmail(email, displayCode) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('⚠️ EMAIL_USER vai EMAIL_PASS nav konfigurēts .env failā');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,  // Gmail App Password (ne parasta parole!)
        },
    });

    try {
        await transporter.sendMail({
            from: `"Čāpuki" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Čāpuku meža stāsti – aktivācijas kods',
            html: `
                <div style="font-family: sans-serif; max-width: 500px; margin: auto;">
                    <h2>🌲 Paldies par pirkumu!</h2>
                    <p>Tavs aktivācijas kods:</p>
                    <div style="
                        font-size: 28px;
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
                </div>
            `,
        });
        console.log(`📧 E-pasts nosūtīts uz: ${email}`);
    } catch (err) {
        console.error('❌ E-pasta kļūda:', err.message);
    }
}

// ==================== DEBUG: listar códigos (solo desarrollo) ====================
if (process.env.NODE_ENV !== 'production') {
    app.get('/debug/codes', async (req, res) => {
        const [rows] = await pool.query(
            'SELECT a.activation_code, a.is_used, c.email, a.created_at FROM activations a JOIN customers c ON a.customer_id = c.id ORDER BY a.created_at DESC LIMIT 20'
        );
        res.json(rows);
    });

    // Insertar código de prueba manualmente
    app.post('/debug/add-code', async (req, res) => {
        const { email, code } = req.body;
        const cleanCode = normalizeCode(code || generateActivationCode());
        try {
            const [r] = await pool.query(
                'INSERT INTO customers (email, status) VALUES (?, "paid")',
                [email || 'test@test.com']
            );
            await pool.query(
                'INSERT INTO activations (activation_code, customer_id) VALUES (?, ?)',
                [cleanCode, r.insertId]
            );
            res.json({ ok: true, code: cleanCode, display: formatCodeForDisplay(cleanCode) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}


const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🚀 Serveris darbojas uz porta: ${PORT}`);
    console.log(`❤️  Health: https://chapuki-backend.onrender.com/health`);
    console.log(`📊 Webhook: https://chapuki-backend.onrender.com/webhook`);
    console.log(`🔑 Verifikācija: https://chapuki-backend.onrender.com/verify-code`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
app.get('/test-db', async (req, res) => {
    try {
        const conn = await pool.getConnection();
        await conn.query('SELECT 1');
        conn.release();
        res.json({
            status: '✅ DB savienojums veiksmīgs',
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
        });
    } catch (err) {
        res.status(500).json({
            status: '❌ DB savienojums neizdevās',
            error: err.message,
            code: err.code,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
        });
    }
});
