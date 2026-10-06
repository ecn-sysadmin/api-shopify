// Cliente para llamar un RESTlet de NetSuite con autenticación por token (TBA, OAuth 1.0 HMAC-SHA256).
// Requiere Node 18+ (usa fetch nativo).
const crypto = require('crypto');

const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function required(name) {
	const v = process.env[name];
	if (!v) throw new Error(`Falta la variable de entorno ${name}`);
	return v.trim();
}

function getConfig() {
	const accountId = required('NS_ACCOUNT_ID'); // ej. 1234567 o 1234567_SB1
	return {
		realm: accountId.toUpperCase().replace(/-/g, '_'),
		host: `https://${accountId.toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`,
		restletUrl: required('NS_RESTLET'),
		consumerKey: required('NS_CONSUMER_KEY'),
		consumerSecret: required('NS_CONSUMER_SECRET'),
		tokenId: required('NS_TOKEN_ID'),
		tokenSecret: required('NS_TOKEN_SECRET'),
	};
}

function encabezadoOAuth(method, url) {
	const cfg = getConfig();
 
	const u = new URL(url);
	const oauth = {
		oauth_consumer_key: cfg.consumerKey,
		oauth_token: cfg.tokenId,
		oauth_nonce: crypto.randomBytes(16).toString('hex'),
		oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
		oauth_signature_method: 'HMAC-SHA256',
		oauth_version: '1.0',
	};
 
	// Parámetros de la firma: OAuth + query string (script, deploy)
	const params = [...Object.entries(oauth), ...u.searchParams.entries()]
		.map(([k, v]) => [enc(k), enc(v)])
		.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
 
	const urlBase = `${u.protocol}//${u.host}${u.pathname}`;
	const textoBase = [method.toUpperCase(), enc(urlBase), enc(params)].join('&');
	const llave = `${enc(cfg.consumerSecret)}&${enc(cfg.tokenSecret)}`;
	const firma = crypto.createHmac('sha256', llave).update(textoBase).digest('base64');
 
	const partes = Object.entries({ ...oauth, oauth_signature: firma })
		.map(([k, v]) => `${k}="${enc(v)}"`)
		.join(', ');
 
	return `OAuth realm="${cfg.realm}", ${partes}`;
}

async function llamarRestlet(payload) {
	const cfg = getConfig();
	
	const url = cfg.restletUrl;
	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: encabezadoOAuth('POST', url),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});
 
	const texto = await resp.text();
	let datos;
	try { datos = JSON.parse(texto); }
	catch { datos = { ok: false, mensaje: texto }; }
 
	if (!resp.ok) {
		throw new Error(`NetSuite respondió ${resp.status}: ${datos.mensaje || texto}`);
	}
	return datos;

}

// Consulta SuiteQL sencilla, útil para probar la conexión
function suiteql(q, limit = 5) {
  return nsRequest('POST', '/services/rest/query/v1/suiteql', {
	query: { limit },
	body: { q },
	headers: { Prefer: 'transient' },
  });
}

module.exports = { llamarRestlet, suiteql };