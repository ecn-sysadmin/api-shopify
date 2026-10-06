/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * RESTlet: recibe una orden de Shopify (JSON) y
 *   1. Busca al cliente por correo o nombre de empresa
 *   2. Si no existe, crea un cliente potencial (Lead) con su dirección
 *   3. Crea la orden de venta con dirección de facturación y envío
 *
 * Las direcciones se llenan con los campos del formulario de dirección de México
 * (custrecord_streetname, custrecord_streetnum, custrecord_colonia...),
 * así que NO hace falta modificar los formularios de dirección.
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], (record, search, log, runtime) => {

	// ─── AJUSTAR ──────────────────────────────────────────────────────────
	const CONFIG = {
		FORMULARIO_OC: 341,        // customForm que usaba la app
		UBICACION: 110,            // location
		CODIGO_IMPUESTO: 1,        // taxCode (IVA 16%)
		IMPUESTOS: {
			'0.16': 1,
			'0.08': 2,
			'0': 3
		},
		SUBSIDIARIA: 2,         // Si la cuenta es OneWorld: ID de la subsidiaria
		ESTADO_LEAD: null,         // Opcional: entitystatus para el cliente potencial
		ARTICULO_ENVIO: null,      // Opcional: ID del artículo para cobrar el envío
		ARTICULO_RESPALDO: null,   // Opcional: artículo genérico si no se encuentra el SKU

		CAMPO_FECHA_ENTREGA: 'enddate',  // Cambia por el ID que viste en el formulario
		DIAS_ENTREGA: 0,
	};
	// ──────────────────────────────────────────────────────────────────────

	function codigoImpuesto(l){
		const tasa = l.taxable === false ? 0 : Number(l.tax_rate || 0);
		const id = CONFIG.IMPUESTOS[String(tasa)];
		if (id) return id;
		log.audit('Tasa sin mapear', `SKU ${l.sku}: tasa ${tasa}, se usa el código por defecto`);
		return CONFIG.CODIGO_IMPUESTO;
	}

	const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

	/** "Bulevar Paseo Río Sonora 69" -> { calle: "Bulevar Paseo Río Sonora", numero: "69" } */
	function separarCalle(addr1) {
		const texto = (addr1 || '').trim();
		const m = texto.match(/^(.*?)[\s,]+(?:No\.?\s*|Núm\.?\s*|Num\.?\s*|#\s*)?(\d+[A-Za-z-]*)$/i);
		if (m && !vacio(m[1])) return { calle: m[1].trim() || 'S/N', numero: m[2] || 'S/N' };
		return { calle: texto || 'S/N', numero: 'S/N' };
	}

	/** Llena un subregistro de dirección con los campos del formulario de México */
	function llenarDireccion(dir, a) {
		if (!dir || !a) return;

		// El país va primero: define qué formulario de dirección se aplica
		dir.setValue({ fieldId: 'country', value: a.country_code || 'MX' });

		const nombre = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name;
		const { calle, numero } = separarCalle(a.address1);

		const valores = {
			addressee: a.company || nombre || 'Cliente Shopify',
			attention: a.company ? nombre : '',
			city: a.city,
			zip: a.zip,
			state: a.province_code, // Ej. "SON"
		};
		
		const pais = (a.country_code || 'MX').toUpperCase();

		valores.addr1 = a.address1 || 'S/N';
		valores.addr2 = a.address2;
		if (pais !== 'US'){
			valores.custrecord_streetname = calle;
			valores.custrecord_streetnum = numero;
			valores.custrecord_colonia = a.address2; // En Shopify MX, address2 suele ser la colonia
		}

		Object.keys(valores).forEach((campo) => {
			if (vacio(valores[campo])) return;
			try {
				dir.setValue({ fieldId: campo, value: valores[campo] });
			} catch (e) {
				log.error('Campo de dirección no asignado: ' + campo, e.message);
			}
		});
	}
	function getDireccion_text(a, o){
		if (!a) return 'Dirección: N/A';

		const nombre = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name;
		const email = o.email || 'N/A';
		const { road, num } = separarCalle(a.address1);
		const city = a.city || 'N/A';
		const zip = a.zip || 'N/A';
		const phone = a.phone || 'S/N';
		const state = a.province_code || 'N/A'; // Ej. "SON"
		const country = (a.country_code || 'MX').toUpperCase();
		const addr1 = a.address1 || 'S/N';
		const addr2 = a.address2 || 'N/A';

		const memo =	', Dirección: ' +
						`Name: ${nombre}, ` +
						`Email: ${email}, ` +
						`Phone: ${phone}, ` +
						`Country: ${country}, ` +
						`City: ${city}, ` +
						`State: ${state}, ` +
						`Zip: ${zip}, ` +
						`Road: ${road}, Num.${num}, ` +
						`addr1: ${addr1}, ` +
						`addr2: ${addr2}`;

		return memo;
	}

	function buscarUno(tipo, filtros) {
		let id = null;
		search.create({ type: tipo, filters: filtros, columns: ['internalid'] })
			.run().getRange({ start: 0, end: 1 })
			.forEach((r) => { id = r.id; });
		return id;
	}

	function buscarCliente(email, empresa) {
		// La búsqueda de clientes incluye clientes potenciales y prospectos
		if (!vacio(email)) {
			const id = buscarUno(search.Type.CUSTOMER, [['email', 'is', email], 'AND', ['isinactive', 'is', 'F']]);
			if (id) return id;
		}
		if (!vacio(empresa)) {
			const id = buscarUno(search.Type.CUSTOMER, [['companyname', 'is', empresa], 'AND', ['isinactive', 'is', 'F']]);
			if (id) return id;
		}
		return null;
	}

	function crearCliente(o) {
		const dirFact = o.billing_address || o.shipping_address || {};
		const empresa = dirFact.company;
		const nombre = dirFact.first_name || (o.customer && o.customer.first_name) || 'Cliente';
		const apellido = dirFact.last_name || (o.customer && o.customer.last_name) || 'Shopify';

		const rec = record.create({ type: record.Type.LEAD, isDynamic: true });

		if (CONFIG.SUBSIDIARIA) rec.setValue({ fieldId: 'subsidiary', value: CONFIG.SUBSIDIARIA });

		if (!vacio(empresa)) {
			rec.setValue({ fieldId: 'isperson', value: 'F' });
			rec.setValue({ fieldId: 'companyname', value: empresa });
		} else {
			rec.setValue({ fieldId: 'isperson', value: 'T' });
			rec.setValue({ fieldId: 'firstname', value: nombre });
			rec.setValue({ fieldId: 'lastname', value: apellido });
		}

		if (!vacio(o.email)) rec.setValue({ fieldId: 'email', value: o.email });
		// El teléfono va en el cliente, porque el formulario de dirección de México no lo muestra
		if (!vacio(o.phone)) rec.setValue({ fieldId: 'phone', value: o.phone });
		if (CONFIG.ESTADO_LEAD) rec.setValue({ fieldId: 'entitystatus', value: CONFIG.ESTADO_LEAD });

		if (o.customer && o.customer.id) {
			rec.setValue({ fieldId: 'externalid', value: 'shopify_cust_' + o.customer.id });
		}

		// Dirección predeterminada
		rec.selectNewLine({ sublistId: 'addressbook' });
		rec.setCurrentSublistValue({ sublistId: 'addressbook', fieldId: 'defaultbilling', value: true });
		rec.setCurrentSublistValue({ sublistId: 'addressbook', fieldId: 'defaultshipping', value: true });
		const dir = rec.getCurrentSublistSubrecord({ sublistId: 'addressbook', fieldId: 'addressbookaddress' });
		llenarDireccion(dir, dirFact);
		rec.commitLine({ sublistId: 'addressbook' });

		return rec.save();
	}

	const cacheArticulos = {};
	function buscarArticulo(sku) {
		if (vacio(sku)) return CONFIG.ARTICULO_RESPALDO;
		if (cacheArticulos[sku] === undefined) {
			cacheArticulos[sku] = buscarUno(search.Type.ITEM, [['itemid', 'is', sku], 'AND', ['isinactive', 'is', 'F']]);
		}
		return cacheArticulos[sku] || CONFIG.ARTICULO_RESPALDO;
	}

	function crearOrden(clienteId, o, externalId) {
		const so = record.create({
			type: record.Type.SALES_ORDER,
			isDynamic: true,
			defaultValues: { customform: CONFIG.FORMULARIO_OC, entity: clienteId },
		});

		so.setValue({ fieldId: 'externalid', value: externalId });
		so.setValue({ fieldId: 'otherrefnum', value: o.name });  // Ej. "#ECN Express1508"

		const entrega = new Date();
		entrega.setDate(entrega.getDate() + CONFIG.DIAS_ENTREGA);
		so.setValue({ fieldId: CONFIG.CAMPO_FECHA_ENTREGA, value: entrega });
		
		const dirFact = o.billing_address || o.shipping_address || {};
		var memo =	`Transacción realizada por: ${o.gateway}\n` +
					`${getDireccion_text(dirFact, o)}`;

		so.setValue({ fieldId: 'location', value: CONFIG.UBICACION });
		if (!vacio(o.gateway)) so.setValue({ fieldId: 'memo', value: memo });
		if (!vacio(o.email)) so.setValue({ fieldId: 'email', value: o.email });

		so.setValue({ fieldId: 'custbody17', value: true }); // ¿Es de Shopify?

		// Artículos
		(o.line_items || []).forEach((l) => {
			const itemId = buscarArticulo(l.sku);
			if (!itemId) throw new Error('No se encontró el artículo con SKU "' + l.sku + '" (' + l.title + ')');

			so.selectNewLine({ sublistId: 'item' });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: l.quantity });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: Number(l.price) });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: codigoImpuesto(l) });
			try {
				so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxrate1', value: 16 });
			} catch (e) {
				log.debug('taxrate1 no disponible', e.message);
			}
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: CONFIG.UBICACION });
			so.commitLine({ sublistId: 'item' });
		});

		// Envío (opcional)
		if (CONFIG.ARTICULO_ENVIO && Number(o.shipping_total) > 0) {
			so.selectNewLine({ sublistId: 'item' });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: CONFIG.ARTICULO_ENVIO });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: Number(o.shipping_total) });
			so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: CONFIG.CODIGO_IMPUESTO });
			so.commitLine({ sublistId: 'item' });
		}

		// Direcciones de la OC
		if (o.billing_address) {
			llenarDireccion(so.getSubrecord({ fieldId: 'billingaddress' }), o.billing_address);
		}
		if (o.shipping_address) {
			llenarDireccion(so.getSubrecord({ fieldId: 'shippingaddress' }), o.shipping_address);
		}

		return so.save();
	}

	const post = (o) => {
		try {
			// log.debug( 'Payload recibido: ', JSON.stringify(o).substring(0, 3900 ));

			const script = runtime.getCurrentScript();
			const syncOrdenes	= script.getParameter({ name: 'custscript_sync_ordenes' });
			const syncClientes	= script.getParameter({ name: 'custscript_sync_clientes' });

			if(!syncOrdenes){
				log.audit('Sincronización desactivada', 'Orden ignorada: ' + o.name);
				return { ok: true, omitida: true, mensaje: 'Sincronización de órdenes desactivada.' };
			}

			if (!o || !o.id) return { ok: false, error: 'PAYLOAD_INVALIDO', mensaje: 'Falta el id de la orden.' };

			const externalId = 'shopify_' + o.id;

			// Evita duplicados si Shopify reenvía el webhook
			const existente = buscarUno(search.Type.SALES_ORDER, [
				['externalidstring', 'is', externalId], 'AND', ['mainline', 'is', 'T'],
			]);
			if (existente) return { ok: true, existente: true, ordenId: existente };

			const empresa = (o.billing_address && o.billing_address.company) || '';
			let clienteId = 21912; // 21912 -> PUBLICO EN GENERAL;
			if(syncClientes) clienteId = buscarCliente(o.email, empresa);
			const clienteNuevo = !clienteId;
			if (clienteNuevo) {
				clienteId = crearCliente(o);
			}

			const ordenId = crearOrden(clienteId, o, externalId);

			log.audit('Orden creada', `Shopify ${o.name} -> OV ${ordenId}, cliente ${clienteId}${clienteNuevo ? ' (nuevo)' : ''}`);
			return { ok: true, clienteId, clienteNuevo, ordenId };
		} catch (e) {
			log.error('Error procesando orden ' + (o && o.name), e);
			return { ok: false, error: e.name || 'ERROR', mensaje: e.message };
		}
	};

	return { post };
});
