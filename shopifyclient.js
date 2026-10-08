// Cliente para la Admin API (GraphQL) de Shopify
// Obtiene los metacampos de un cliente a partir de su ID

// Variables de entorno:
// 	SHOPIFY_SHOP			ej. ecn-express.myshopify.com
// 	SHOPIFY_API_VERSION		ej. 2026-07 (opcional)

// App del Dev Dashboard (apps nuevas)
// 	SHOPIFY_CLIENT_ID
// 	SHOPIFY_CLIENT_SECRET

let tokenCache = { valor: null, expira: 0 };

function shop() {
	const s = ( required('SHOPIFY_SHOP') || '' ).trim();
	if (!s) throw new Error( 'Falta la variable de entorno SHOPIFY_SHOP' );
	return s;
}

function required(name) {
	const v = process.env[name];
	if (!v) throw new Error(`Falta la variable de entorno ${name}`);
	return v.trim();
}

async function obtenerToken() {
	
	// client credentials (el token dura -24h; se reutiliza mientras sea válido)
	if ( tokenCache.valor && Date.now() < tokenCache.expira ) return tokenCache.valor;

	const resp = await fetch( `https://${shop()}/admin/oauth/access_token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: required('SHOPIFY_CLIENT_ID') || '',
			client_secret: required('SHOPIFY_CLIENT_SECRET') || '',
		}),
	});
	// const datos = await resp.json().catch(() => ({}));
	// if ( !resp.ok || !datos.access_token ) {
	// 	throw new Error( `No se pudo obtener el token de Shopify (${resp.status}): ${JSON.stringify(datos)}` );
	// }

	const texto = await resp.text();
	let datos = {};
	try { datos = JSON.parse(texto); }
	catch { throw new Error( `No se pudo obtener el token de Shopify (${resp.status}): ${JSON.stringify(datos)}` ); }

	// Se renueva 60s antes de que expire
	tokenCache = {
		valor: datos.access_token,
		expira: Date.now() + ((datos.expires_in || 86399) - 60) * 1000,
	};

	return tokenCache.valor;
}

async function graphql(query, variables) {
	const version = required('SHOPIFY_API_VERSION') || '2026-10';
	const resp = await fetch(`https://${shop()}/admin/api/${version}/graphql.json`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Shopify-Access-Token': await obtenerToken(),
		},
		body: JSON.stringify({ query, variables }),
	});

	const datos = await resp.json().catch(() => ({}));
	if (!resp.ok || datos.errors) {
		throw new Error(`Shopify GraphQL (${resp.status}): ${JSON.stringify(datos.errors || datos)}`);
	}
	
	return datos.data;
}

/**
 * Devuelve los metacampos del cliente como objeto { "namespace.key": valor }.
 * Ej. { "custom.rfc": "XAXX010101000", "custom.regimen_fiscal": "601" }
 */
async function metacamposCliente(customerId) {
	if (!customerId) return {};

	const data = await graphql(
		`query ($id: ID!) {
			customer(id: $id) {
				metafields(first: 50) {
					nodes { namespace key type value }
				}
			}
		}`,
		{ id: `gid://shopify/Customer/${customerId}` }
	);

	const resultado = {};
	for (const m of data?.customer?.metafields?.nodes || []) {
		resultado[`${m.namespace}.${m.key}`] = m.value;
	}

	return resultado;
}

module.exports = { metacamposCliente };