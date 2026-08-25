# Servicio cloud opcional

El frontend sigue siendo estático y funciona sin este servicio. La API usa Express 5 sobre Node.js y es una frontera independiente: es el único componente que usa credenciales de Postgres y se despliega detrás del mismo origen lógico que la aplicación (por ejemplo, un proxy que sirva `/api/*` desde este proceso).

## Estructura del código

El servidor se organiza por responsabilidad:

```text
src/
├── server.js                    # arranque, dependencias y cierre ordenado
├── api/create-api.js            # composición de la aplicación Express
├── modules/                     # capacidades con estructura uniforme
│   ├── auth/
│   │   ├── auth-routes.js       # URLs y verbos HTTP
│   │   ├── auth-controller.js   # adaptación entre HTTP y el servicio
│   │   ├── auth-service.js      # registro, login, sesiones y autorización
│   │   └── auth-middleware.js
│   ├── trips/                   # routes → controller → service
│   │   ├── trip-access.js       # membresía: la única autorización de un viaje
│   │   ├── trip-member-service.js   # invitaciones, roles y salida
│   │   └── trip-stream-controller.js # eventos SSE de colaboración
│   ├── accounts/                # routes → controller → service
│   └── system/                  # salud y métricas
├── config/runtime-config.js     # lectura y validación del entorno
├── domain/plan-document.js      # validación y resumen de planes
├── http/                        # errores, respuestas y middleware HTTP
├── infrastructure/
│   └── postgres/                # pool, transacciones y migraciones
├── observability/request-metrics.js
├── realtime/trip-events.js      # bus de eventos por viaje (en proceso)
└── security/session-security.js
```

Un viaje se autoriza siempre por su fila en `trip_members`, nunca por
`trips.owner_id`: `trip-access.js` resuelve el rol (`owner`, `editor` o
`viewer`) y responde 404 —no 403— cuando quien pregunta no colabora en él, para
no confirmar que ese identificador existe. `realtime/trip-events.js` conserva
un bus en memoria para unidades, pero producción usa un listener dedicado de
PostgreSQL `LISTEN/NOTIFY`. Cada réplica recibe el aviso y lo reparte solo a sus
streams locales; el documento nunca viaja por `NOTIFY` ni por SSE.

`create-api.js` sólo construye dependencias y compone los módulos. Cada archivo `*-routes.js` declara endpoints, cada `*-controller.js` traduce peticiones y respuestas, y cada `*-service.js` contiene los casos de uso. Postgres, correo y configuración permanecen fuera de la capa HTTP.

## Desarrollo local

Requiere Node.js 20.6 o posterior y Postgres 15 o posterior:

Para levantar PostgreSQL, iniciar la API y servir el frontend bajo un único origen desde la raíz del repositorio:

```bash
cp .env.example .env
docker compose up --build
```

La aplicación queda disponible en `http://localhost:8000`. Nginx sirve los archivos estáticos y reenvía `/api/*` al contenedor `api`; este no publica su puerto directamente en el host. Al arrancar, la API crea las tablas en una base nueva y aplica cualquier migración pendiente antes de aceptar peticiones. Para otro dominio o puerto, define `APP_ORIGIN` con el origen público exacto y ajusta `FRONTEND_PORT`; define también credenciales `POSTGRES_*` no predeterminadas fuera del desarrollo local. En un despliegue HTTPS usa además `NODE_ENV=production` para emitir cookies de sesión seguras.

Para ejecutar la API directamente en la máquina y usar solo Postgres en Docker:

```bash
cp .env.example .env
docker compose up -d db
cd server
npm install
npm start
```

El servicio `db` usa PostgreSQL 16 en `127.0.0.1:5432`, con las credenciales de desarrollo incluidas en `.env.example`. Los datos se conservan en el volumen `trip_planner_postgres_data`. Para detener la base usa `docker compose stop db`; `docker compose down` elimina los contenedores y la red, pero conserva el volumen mientras no se añada `--volumes`.

`npm start` carga el `.env` de la raíz mediante el soporte nativo de Node.js y aplica automáticamente las migraciones cuando cloud está habilitada. `npm run migrate` continúa disponible para ejecutarlas manualmente. Docker Compose y la API directa comparten así una única fuente de configuración. Las variables ya inyectadas en el proceso tienen prioridad sobre el archivo, por lo que CI y producción pueden proporcionar su propia configuración sin quedar sobrescritas. Con `CLOUD_ENABLED=false`, `/api/health` responde, pero cuentas, viajes y sincronización permanecen deshabilitados.

El cliente muestra siempre la interfaz cloud y comprueba `/api/session` al arrancar. Si la API no está disponible, informa del fallo y mantiene operativo el modo local.

## Variables

- `FRONTEND_PORT`: puerto publicado por el frontend en Docker Compose.
- `POSTGRES_BIND_ADDRESS`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: publicación y credenciales del servicio Postgres en Docker Compose.
- `CLOUD_ENABLED`: feature flag del servidor; su valor seguro por defecto es `false`.
- `GRANULAR_SYNC_ENABLED`: anuncia el protocolo colaborativo v1; permanece en
  `false` hasta que API, migraciones y cliente compatibles estén desplegados.
- `PORT`: puerto HTTP, por defecto `8787`.
- `HOST`: interfaz de escucha; el valor seguro por defecto es `127.0.0.1`. Un despliegue en contenedor puede establecer explícitamente `0.0.0.0` detrás de su proxy.
- `APP_ORIGIN`: origen exacto permitido para registro y mutaciones.
- `DATABASE_URL`: conexión Postgres; obligatoria si cloud está habilitada.
- `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_MS`, `DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`: límites del pool y consultas.
- `BODY_LIMIT_BYTES`: límite del cuerpo y del documento portable antes de persistir.
- `OPERATION_BODY_LIMIT_BYTES`, `OPERATION_CATCHUP_LIMIT`: tamaño máximo de un
  comando granular y máximo de operaciones por lote de recuperación.
- `OPERATION_RATE_LIMIT`, `OPERATION_RATE_WINDOW_MS`: límite reintentable de
  operaciones por usuario y viaje.
- `PRESENCE_TTL_MS`, `PRESENCE_RATE_LIMIT`, `PRESENCE_RATE_WINDOW_MS`,
  `PRESENCE_CLEANUP_LIMIT`: caducidad, límites y limpieza acotada de presencia.
- `SESSION_DAYS`: caducidad fija de la sesión revocable (máximo 90).
- `TRUST_PROXY`: solo debe activarse detrás de un proxy controlado que reescriba `X-Forwarded-For`.

## Migraciones y pruebas

Al arrancar con cloud habilitada, la API aplica en orden los SQL pendientes de `server/migrations/` y registra cada nombre en `schema_migrations`; `npm run migrate` permite hacer lo mismo manualmente. En una base nueva esto crea todas las tablas, mientras que en una existente no repite las migraciones ya registradas. Las migraciones del lanzamiento son aditivas. Para integración se debe proporcionar una base vacía y exclusiva:

```bash
TEST_DATABASE_URL=postgres://.../trip_planner_test npm test
```

Nunca apuntes las pruebas a producción. La comprobación de salud ejecuta `SELECT 1` y solo devuelve disponibilidad y latencia; no expone la URL ni credenciales.

## Privacidad, retención y recuperación

Los documentos se validan por versión, tamaño y profundidad. Las consultas siempre filtran por el propietario derivado de la cookie; el servidor no acepta un `ownerId` del navegador. Cookies, tokens, enlaces completos, correos completos y documentos no forman parte del logging ni de las métricas. El historial conserva como mínimo las 100 revisiones más recientes y nunca poda la actual.

Las contraseñas se derivan con `scrypt` y una sal aleatoria; nunca se guardan ni se registran en claro. El login usa el mismo mensaje para correo desconocido y contraseña errónea. Cerrar sesión revoca el dispositivo actual. Si existen mutaciones pendientes, el cliente exige crear antes copias locales. Eliminar una cuenta exige volver a introducir la contraseña, revoca todas sus sesiones y elimina sus datos remotos mediante cascadas auditables en la base.

Ante un fallo de IndexedDB, la aplicación conserva el guardado `localStorage` legado y ofrece exportar el documento. Importación/exportación JSON y GitHub no contienen identidad, sesiones, revisiones ni outbox.

## Rollback

El despliegue compatible se hace en este orden:

1. Ejecuta las migraciones aditivas y despliega la API con
   `GRANULAR_SYNC_ENABLED=false`. Comprueba salud, esquema y endpoints legacy.
2. Despliega el cliente compatible. Con el flag apagado no activa viajes y sigue
   usando snapshots; las tablas y rutas v1 permanecen inertes.
3. Activa el flag en una réplica y en viajes de prueba. Después valida dos
   réplicas y dos cuentas, observando `operationLatencyAverageMs`,
   `operationConflicts`, `automaticRebases`, `snapshotFallbacks`, profundidad de
   cola y sesiones de presencia, además de carga y bloqueos de PostgreSQL.
4. Amplía por etapas. No retires el endpoint snapshot ni las columnas legacy en
   este lanzamiento.

El proxy mantiene `proxy_buffering off` y `proxy_read_timeout 300s`, por encima
del heartbeat de 25 segundos. Los logs y métricas contienen solo ids y estados
técnicos, nunca documentos, borradores, correos ni tokens.

Para volver atrás sin migración de datos:

1. Apaga `GRANULAR_SYNC_ENABLED`. No se activan más viajes y las operaciones de
   clientes ya cargados reciben un error reintentable; la cola granular se
   conserva en IndexedDB y no se convierte ni se descarta.
2. Espera a que los clientes actuales drenen antes de desplegar el cliente
   anterior cuando sea posible. Si no lo es, conserva IndexedDB: el cliente
   anterior ignora la cola y la versión nueva podrá retomarla al reactivarse.
3. Si se vuelve al bus en memoria, reduce la API a una sola réplica antes del
   cambio para no perder fan-out entre procesos.
4. No reviertas ni elimines `trip_revisions`, `trip_mutations`,
   `trip_presence`, sus columnas ni los endpoints v1. Todas las revisiones ya
   confirmadas siguen siendo documentos portables válidos en Postgres.
5. `STORAGE_VERSION` sigue en 31, `PLAN_VERSION` en 28 y el JSON portable no
   contiene cola, presencia ni conflictos; una exportación sigue siendo la vía
   de recuperación independiente del protocolo.
