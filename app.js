// API intermedia: Power Automate -> esta API -> NetSuite
try { require('dotenv').config(); } catch { /* En GoDaddy usamos las variables del panel */ }

const crypto = require('crypto');
const express = require('express');
const { llamarRestlet, suiteql } = require('./netsuite');
const { metacamposCliente } = require('./shopifyclient');

const app = express();

// Se guarda el cuerpo sin procesar para validar la firma de los webhooks de Shopify
app.use(express.json({
	limit: '10mb',
	verify: (req, res, buf) => { req.rawBody = buf; },
}));

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const router = express.Router();

// -----------------------------------------------------
// Seguridad API
// -----------------------------------------------------
function requireApiKey(req, res, next) {
	const expected = process.env.API_KEY || '';
	const received = req.get('x-api-key') || '';

	const ok =
	expected.length > 0 &&
	received.length === expected.length &&
	crypto.timingSafeEqual(
		Buffer.from(received),
		Buffer.from(expected)
	);

	if (!ok) {
	return res.status(401).json({
		ok: false,
		error: 'API key inválida o ausente'
	});
	}

	next();
}

// -----------------------------------------------------
// Raíz
// -----------------------------------------------------
router.get('/', (req, res) => {
	res.json({
		ok: true,
		servicio: 'api-netsuite'
	});
});

// -----------------------------------------------------
// Health check
// -----------------------------------------------------
router.get(['/api/health', '/health', '/healthz'], (req, res) => {
	res.json({
		ok: true,
		servicio: 'api-netsuite',
		node: process.version,
		hora: new Date().toISOString()
	});
});

// -----------------------------------------------------
// Prueba API -> NetSuite
// -----------------------------------------------------
router.get('/api/test-netsuite', requireApiKey, async (req, res) => {

	console.log('======================================');
	console.log('INICIO PRUEBA NETSUITE');
	console.log('Hora:', new Date().toISOString());

	// Solo mostramos si las variables existen.
	// NO mostramos sus valores.
	console.log('Variables de entorno:', {
		NS_ACCOUNT_ID: !!process.env.NS_ACCOUNT_ID,
		NS_CONSUMER_KEY: !!process.env.NS_CONSUMER_KEY,
		NS_CONSUMER_SECRET: !!process.env.NS_CONSUMER_SECRET,
		NS_TOKEN_ID: !!process.env.NS_TOKEN_ID,
		NS_TOKEN_SECRET: !!process.env.NS_TOKEN_SECRET,
		NS_RESTLET: !!process.env.NS_RESTLET,
		NS_WEBHOOKS_SECRET: !!process.env.NS_WEBHOOKS_SECRET,
	});

	const q =
		process.env.NS_TEST_QUERY ||
		'SELECT id, name FROM currency';

	console.log('Consulta SuiteQL:', q);

	const inicio = Date.now();

	try {

		console.log('Enviando solicitud a NetSuite...');

		const r = await suiteql(q, 5);

		const ms = Date.now() - inicio;

		console.log('NetSuite respondió.');
		console.log('Resultado:', {
			ok: r.ok,
			status: r.status,
			ms: ms
		});

		if (r.ok) {

			console.log('CONEXIÓN NETSUITE EXITOSA');
			console.log('======================================');

			return res.json({
				ok: true,
				mensaje: 'Conexión con NetSuite OK',
				ms,
				muestra: r.data?.items ?? r.data
			});
		}

		console.error('NETSUITE RECHAZÓ LA SOLICITUD');

		// El detalle puede contener información útil del error,
		// pero no contiene nuestros secretos OAuth.
		console.error('Status NetSuite:', r.status);
		console.error('Detalle NetSuite:', r.data);

		const pista =
			r.status === 401
			? 'Autenticación rechazada por NetSuite. Revisar Account ID, Token-Based Authentication y permisos del rol.'
			: r.status === 403
			? 'NetSuite recibió la autenticación pero el rol no tiene permisos suficientes para esta operación.'
			: r.status === 400
			? 'NetSuite recibió la solicitud pero rechazó la consulta SuiteQL.'
			: 'NetSuite devolvió un error inesperado.';

		console.log('======================================');

		return res.status(502).json({
			ok: false,
			statusNetSuite: r.status,
			pista,
			ms,
			detalle: r.data
		});

	} catch (err) {

		const ms = Date.now() - inicio;

		console.error('ERROR AL CONECTAR CON NETSUITE');
		console.error('Tipo:', err?.name);
		console.error('Mensaje:', err?.message);
		console.error('Código:', err?.code);
		console.error('Tiempo:', ms, 'ms');

		if (err?.cause) {
			console.error('Causa:', err.cause);
		}

		console.log('======================================');

		return res.status(500).json({
			ok: false,
			error: 'Error al conectar con NetSuite',
			tipo: err?.name || null,
			mensaje: err?.message || null,
			codigo: err?.code || null,
			ms
		});
	}
});
// -----------------------------------------------------
// TEMPORAL: prueba API -> RESTlet sin pasar por Shopify
// -----------------------------------------------------
router.post('/api/test-orden', requireApiKey, async (req, res) => {
	try {
		const r = await llamarRestlet(req.body);
		console.log('[Prueba RESTlet]', r);
		return res.json({ ok: true, restlet: r });
	} catch (e) {
		console.error('[Prueba RESTlet] Error:', e.message);
		return res.status(502).json({ ok: false, error: e.message });
	}
});
// -----------------------------------------------------
// OV Shopify: Shopify -> NetSuite -> API -> RESTlet Netsuite
// -----------------------------------------------------
function firmaValida(req) {
	const secreto = process.env.NS_WEBHOOKS_SECRET;
	if (!secreto || !req.rawBody) return false;
	const recibida = req.get('X-Shopify-Hmac-Sha256') || '';
	const calculada = crypto
		.createHmac('sha256', secreto)
		.update(req.rawBody)
		.digest('base64');
	const a = Buffer.from(recibida);
	const b = Buffer.from(calculada);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Solo se envían a NetSuite los datos necesarios
function resumirOrden(o) {
	const cliente = o.customer || {};
	return {
		id: o.id,
		name: o.name,
		email: o.email || o.contact_email || cliente.email,
		phone: (o.billing_address && o.billing_address.phone) || o.phone || cliente.phone,
		gateway: (o.payment_gateway_names || []).join(', '),
		taxes_included: o.taxes_included,
		shipping_total: (o.total_shipping_price_set && o.total_shipping_price_set.shop_money.amount) || 0,
		customer: { id: cliente.id, first_name: cliente.first_name, last_name: cliente.last_name },
		billing_address: o.billing_address,
		shipping_address: o.shipping_address,
		line_items: (o.line_items || []).map((l) => ({
			sku: l.sku,
			title: l.title,
			quantity: l.quantity,
			price: l.price,
			taxable: l.taxable,
			tax_rate: (l.tax_lines && l.tax_lines.length) ? Number(l.tax_lines[0].rates) : 0,
		})),
	};
}
router.post('/webhooks/shopify/orders-create', async (req, res) => {
	console.log('[Shopify] Webhook recibido', {
		topic: req.get('X-Shopify-Topic'),
		tienda: req.get('X-Shopify-Shop-Domain'),
		tieneFirma: !!req.get('X-Shopify-Hmac-Sha256'),
		tieneSecreto: !!process.env.NS_WEBHOOKS_SECRET,
		bytes: req.rawBody ? req.rawBody.length : 0,
	});

	if (!firmaValida(req)) return res.status(401).send('Firma inválida');

	// Shopify espera respuesta en menos de 5 s; se responde primero y luego se procesa
	res.status(200).send('OK');

	const orden = req.body || {};

	try {
		const payload = resumirOrden(orden);

		// Metacampos del cliente; si fallan, la orden se registra de todos modos
		try {
			payload.customer.metafields = await metacamposCliente(orden.customer && orden.customer.id);
			// console.log('[Shopify] Metacampos del cliente:', payload.customer.metafields);
		} catch (e) {
			console.error('[Shopify] No se pudieron leer los metacampos:', e.message);
			payload.customer.metafields = {};
		}

		const r = await llamarRestlet(payload);

		if (r.ok) {
			console.log(`[Shopify] ${orden.name} -> OV ${r.ordenId}${r.existente ? ' (ya existía)' : ''}`);
		} else {
			console.error(`[Shopify] ${orden.name} falló en NetSuite: ${r.error} - ${r.mensaje}`);
		}
	} catch (e) {
		console.error(`[Shopify] ${orden.name} error al llamar NetSuite:`, e.message);
	}
});

// -----------------------------------------------------
// Montar rutas
// -----------------------------------------------------
app.use(BASE_PATH || '/', router);

// -----------------------------------------------------
// 404
// -----------------------------------------------------
app.use((req, res) => {
	res.status(404).json({
		ok: false,
		error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`
	});
});

// -----------------------------------------------------
// Iniciar servidor
// -----------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
	console.log(
		`API escuchando en ${HOST}:${PORT} (base: ${BASE_PATH || '/'})`
	);
});