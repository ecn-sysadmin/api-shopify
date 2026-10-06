# API Power Automate → Node.js → NetSuite (prueba de conexión)

## 1. Preparar NetSuite (una sola vez)
1. **Setup > Company > Enable Features > SuiteCloud**: activa *REST Web Services*, *Token-Based Authentication* y *SuiteScript* (server).
2. **Setup > Integration > Manage Integrations > New**: marca *Token-Based Authentication*, desmarca *Authorization Code Grant*. Guarda y copia **Consumer Key / Secret** (solo se muestran una vez).
3. Crea o usa un **rol** con permisos: *Log in using Access Tokens*, *REST Web Services* y los de registros que usarás (Invoices, Customers, Currency para la prueba).
4. **Setup > Users/Roles > Access Tokens > New**: elige la integración, el usuario y ese rol. Copia **Token ID / Secret**.
5. El **Account ID** está en *Setup > Company > Company Information* (ej. `1234567` o `1234567_SB1` en sandbox).

## 2. Subir a GoDaddy (cPanel con "Setup Node.js App")
1. Sube la carpeta (por el Administrador de archivos o Git) fuera de `public_html`, ej. `~/api-netsuite`.
2. En cPanel → **Setup Node.js App → Create Application**:
   - Node.js version: **18 o superior** (se usa `fetch` nativo)
   - Application root: `api-netsuite`
   - Application URL: tu dominio o subdominio (idealmente un subdominio como `api.tudominio.com`)
   - Startup file: `app.js`
3. Agrega las variables de entorno de `.env.example` en la sección *Environment variables* (más seguro que subir el `.env`).
4. Clic en **Run NPM Install** y luego **Restart**.
5. Si pusiste la app en una subruta (`tudominio.com/api-ns`), define `BASE_PATH=/api-ns`.

> Si tu plan de GoDaddy no tiene "Setup Node.js App" (algunos planes compartidos no lo incluyen), necesitas un VPS; ahí se corre con `npm install` y `pm2 start app.js`.

## 3. Probar por capas
| Paso | Qué prueba | Llamada |
|---|---|---|
| 1 | La app vive en GoDaddy | `GET https://api.tudominio.com/api/health` (en el navegador) |
| 2 | Power Automate llega a la API | `POST /api/ping` con header `x-api-key` |
| 3 | La API llega a NetSuite | `GET /api/test-netsuite` con header `x-api-key` |

Desde tu PC:
```bash
curl https://api.tudominio.com/api/test-netsuite -H "x-api-key: TU_API_KEY"
```

## 4. Desde Power Automate
Acción **HTTP** (conector premium):
- Método: `GET`
- URI: `https://api.tudominio.com/api/test-netsuite`
- Encabezados: `x-api-key` = tu clave

Respuesta esperada: `{"ok": true, "mensaje": "Conexión con NetSuite OK", ...}`

## Cómo leer los errores
- **401 de la API**: Power Automate no mandó bien el `x-api-key`.
- **statusNetSuite 401**: firma/credenciales. Revisa Account ID (formato `_SB1` vs `-sb1` lo maneja el código), que el token sea del mismo ambiente (producción vs sandbox) y la hora del servidor.
- **statusNetSuite 400/403**: ¡la conexión ya funciona! Solo falta permiso en el rol o cambiar `NS_TEST_QUERY`.
- **404 de la API**: la ruta no coincide; revisa `BASE_PATH`.
