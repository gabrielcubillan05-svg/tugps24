# Auditoría de seguridad, datos y operación — TuGPS24

**Fecha:** 3 de octubre de 2026 · **Alcance:** todo el repositorio (70 endpoints, 32 páginas del panel, librerías, crons, JS del navegador, dependencias, historial de git) · **Método:** cinco revisiones independientes en paralelo (autenticación y permisos; exposición de datos; entradas externas e inyección; operación y resiliencia; lógica de negocio), cada hallazgo verificado leyendo el código real y, donde aplicaba, reproducido con scripts. No se modificó código durante la auditoría.

## 0. Estado de ejecución (3 de octubre de 2026, madrugada)

Se aplicaron en `main`, en siete commits, 61 de los 69 hallazgos. El séptimo commit (3 de octubre, mañana) cerró tres de los que estaban para "siguiente iteración":

- **Webhook de WhatsApp en dos fases:** antes de responder a Meta solo se verifica la firma y se marca cada mensaje como visto; transcripción, Anthropic y envío corren después de responder (`waitUntil` de Vercel). Meta recibe el 200 en menos de un segundo y ya no reenvía paquetes ni da el webhook por caído.
- **Candado por número de cliente:** dos mensajes seguidos del mismo cliente se procesan uno después del otro (el segundo ve al primero en el historial), con lo que ya no se pisan el historial ni la respuesta del agente. Los acuses de Meta se omiten si el número está ocupado.
- **Fusión del lead al guardar:** el agente relee el lead después de pensar y aplica solo los campos que cambió este mensaje (las notas nuevas se agregan encima); si una secretaria tomó el lead mientras tanto, se respeta. Aplica a WhatsApp y al chat web.
- **Contadores de no leídos del chat atómicos (`HINCRBY`):** en un hash por usuario, en vez de reescribir la conversación entera en cada mensaje; los valores viejos se siguen mostrando hasta que la persona abre esa conversación.

Lo que queda pendiente y por qué:

| Pendiente | Motivo | Quién |
|---|---|---|
| Confirmar respaldos diarios en la consola de Upstash | No es visible desde el código; el cron propio de respaldo a Blob ya corre a las 2:30 am | Gabriel |
| Aceptar los acuerdos de tratamiento de datos (DPA) de Anthropic y OpenAI y pedir retención cero | Trámite en las consolas de cada proveedor | Gabriel |
| Revisar el texto nuevo de la política de privacidad con quien lleve lo legal | Es un borrador técnico, no asesoría jurídica | Gabriel |
| Conectar `/api/health` a un monitor externo gratuito (UptimeRobot, Better Stack) | Servicio externo | Gabriel |
| Reescribir el historial de git para sacar el teléfono real del script borrado | Requiere `git filter-repo` y push forzado que afecta el clon de la PC | Decisión de Gabriel |
| Campo `rev` por registro en TODAS las colecciones | Se cubrió el caso real (el agente IA pisando ediciones del CRM) con fusión de cambios al guardar; el `rev` genérico para el resto de módulos queda para cuando se mida un choque concreto | Siguiente iteración |
| Historial de WhatsApp como lista en Redis | Se resolvió la pérdida de mensajes con un candado por número de cliente, sin migrar la estructura; la migración a lista queda como mejora opcional | Siguiente iteración |
| Índices secundarios (tareas por asignado, leads por seguimiento, novedades por día, conversaciones por usuario) | Rendimiento, no seguridad; se hará con medición | Siguiente iteración |
| Dos vulnerabilidades altas en herramientas del adaptador de Vercel (`path-to-regexp`, `http-cache-semantics`) | Solo con `npm audit fix --force`, que cambia versiones mayores; afectan al build, no al runtime | Revisar con la próxima versión del adaptador |
| Operadores ven casos importantes de todas las sucursales | La central de monitoreo es nacional por diseño; se deja documentado | Sin cambio |

## 1. Resumen ejecutivo

| Gravedad | Cantidad | Qué significa |
|---|---|---|
| Crítico | 4 | Explotable hoy o pérdida total de datos sin recuperación |
| Alto | 19 | Fuga de datos, suplantación o pérdida parcial con un escenario realista |
| Medio | 24 | Riesgo real pero acotado, o incumplimiento legal sin daño inmediato |
| Bajo | 22 | Higiene, defensa en profundidad, trazabilidad |

**Lo que hay que hacer esta semana, en orden:**

1. **Actualizar Astro y dependencias** (`npm audit fix`): la versión instalada 7.1.6 tiene una ejecución remota de código conocida vía imágenes AVIF, y hay 12 vulnerabilidades altas más. Media hora de trabajo, una línea de comando y un despliegue.
2. **Cerrar el salto de ruta (`..`) en los dos servidores de archivos** (`/api/blob-file` y `/api/whatsapp-media-file`): hoy permiten leer cualquier foto, firma o soporte privado, el segundo incluso sin iniciar sesión. Diez líneas de código.
3. **Impedir que el chat web público se enganche al historial de un cliente existente** por teléfono: hoy un desconocido con el número de un cliente obtiene sus datos a través de Andrés y puede alterar su lead. Un cambio pequeño en `web-chat.ts`.
4. **Confirmar que Upstash tiene respaldos diarios activados y agregar una exportación propia a Blob**: no existe ninguna copia de la única base de datos. Si alguien borra una llave o la cuenta se suspende, se pierde todo.
5. **Papelera en "Borrar todo" de Cobranza** y candado de ejecución en la limpieza diaria y en el envío masivo de plantillas.
6. **Bloquear que Josué y Wilmar puedan crear cuentas admin** y limitar su capacidad de resetear claves de gerentes.
7. **Arreglar la alarma de apagados en el cambio de día** y el cálculo de "vencido" de los reportes programados, que hoy se dispara a las 7 pm por usar la hora del servidor.

Lo demás se puede planear en las dos semanas siguientes (sección 3) y en un mes (cumplimiento de la Ley 1581, retención por módulo, índices de rendimiento).

## 2. Hallazgos críticos y altos (detalle)

Cada punto: qué pasa, cómo se explota o falla, y la solución concreta.

### 2.1 Seguridad: acceso y archivos

**[CRÍTICO] Dependencias con vulnerabilidades conocidas, una de ejecución remota de código** — `package.json`. Astro 7.1.6 (< 7.2.8) tiene RCE por optimización de imágenes AVIF (GHSA-26w7-cxv4-gfx2); en modo servidor la ruta `/_image` existe aunque el sitio no la use. Además: sharp, undici, devalue, path-to-regexp y otras (12 altas). La librería `xlsx` 0.18.5 usada para leer los Excel de cobranza y garantías tiene contaminación de prototipos y ReDoS sin arreglo en npm.
→ **Solución:** `npm audit fix` y volver a desplegar; para `xlsx` migrar a la versión oficial de SheetJS (≥ 0.20.2 desde cdn.sheetjs.com) o a `exceljs`. Opcional: deshabilitar el endpoint de imágenes de Astro si no se usa.

**[ALTO] Salto de ruta en el servidor público de material de WhatsApp** — `src/pages/api/whatsapp-media-file.ts:12-22`. Solo valida que la ruta empiece por `whatsapp-agent-media/`; la librería de Blob construye una URL y el navegador/servidor normaliza `..`, así que `?path=whatsapp-agent-media/../planillas/<ruta>` sirve cualquier archivo privado **sin sesión** y con caché pública. Reproducido: `new URL('.../whatsapp-agent-media/../tasks/abc').pathname === '/tasks/abc'`.
→ **Solución:** rechazar rutas con segmentos `..`, `.` o vacíos, y servir solo los `pathname` registrados en `internal:whatsapp-agent-media`. Renombrar los archivos con sufijo aleatorio al subirlos.

**[ALTO] El mismo salto de ruta en `/api/blob-file` evade la autorización por prefijo** — `src/pages/api/blob-file.ts:22-101`. Un técnico con una tarea propia pide `tasks/<id-de-su-tarea>-x/../../reports/<ruta>` y obtiene fotos de novedades, suspensiones, casos o archivos de otros módulos.
→ **Solución:** misma normalización; para `tasks/` y `planillas/` exigir que la ruta coincida exactamente con la guardada en el registro (`task.proof.pathname`, firma de la planilla). Además falta la rama `garantias/`, por lo que hoy las fotos de garantías devuelven 403 (bug funcional).

**[ALTO] El chat web público permite tomar el lead de cualquier teléfono** — `src/pages/api/web-chat.ts:98-134`. Sin sesión, si el teléfono coincide con un lead existente (incluso de WhatsApp Ads) la sesión anónima se convierte en ese lead: recibe el historial completo en el contexto de Andrés, puede preguntarle nombre, ciudad, vehículo y fecha agendada del cliente real, marcarlo "sin interés" y escribir en su historial (inyección de instrucciones que luego ve el agente de WhatsApp). Los celulares colombianos son enumerables; el límite actual es 150 mensajes por IP y día.
→ **Solución:** nunca reutilizar un lead por teléfono desde el chat web: crear siempre un lead `web-chat` ligado al `sessionId`, marcarlo "posible duplicado" para que la secretaria lo fusione, y responder de forma neutra. Limitar `name` (80), `phone` (20) y validar `sessionId` como UUID. Si se quiere unir historiales, pedir un código por WhatsApp antes.

**[ALTO] Josué y Wilmar pueden crear una cuenta con rol admin** — `src/pages/api/users.ts:111-133`. El `POST` acepta a quien tenga permiso de sucursales y solo valida que el rol exista; el `PATCH` sí les prohíbe tocar admins, pero el `POST` lo salta. Con esa cuenta nueva son admin plenos.
→ **Solución:** en `POST`, si no es `canManageUsers`, rechazar `role === 'admin'`.

**[MEDIO→ALTO combinado] Josué y Wilmar pueden resetear la clave y cambiar el rol de cualquier no admin** — `users.ts:216-287`. Permite suplantar a un gerente con un solo rastro de auditoría.
→ **Solución:** limitar ese bloque a `branches` e `inventoryBranches`; para clave y rol exigir `currentPassword` propio y notificar al afectado.

**[ALTO] Toda secretaria ve y exporta a CSV los 3.470 leads del país con teléfono y notas** — `src/pages/api/leads.ts:187-217`, `public/js/interno-crm.js:1100-1119`. Una cuenta comprometida o un empleado que se va exfiltra la base comercial completa; la exportación no deja huella en auditoría.
→ **Solución:** acotar el GET para `secretaria` a su sucursal o sus leads; "Exportar CSV" solo para supervisor en adelante y desde un endpoint servidor que registre `leads_export`.

### 2.2 Datos personales y cumplimiento (Ley 1581 de 2012)

**[ALTO] Recolección sin autorización previa y seguimiento comercial sin consentimiento** — `WebChatWidget.astro`, `web-chat.ts:101-119`, `whatsapp-cold-followup-cron.ts:46-66`. El chat web crea leads sin casilla de autorización ni enlace a la política; el seguimiento "frío" manda hasta 8 plantillas semanales a todos los leads sin filtrar por origen, incluidos los manuales y los de Meta que solo pidieron una cotización.
→ **Solución:** casilla obligatoria de autorización con `consentAt` guardado en el lead; limitar el seguimiento frío a `whatsapp-ads` y `web-chat`; frase "responde NO para no recibir más mensajes" y flag `optOut` que todos los crons respeten.

**[ALTO] No hay forma de borrar a un cliente a pedido** — `leads.ts:477-502`, `cobros.ts`, `garantias.ts`, `planillas-vehiculo.ts`, `suspensiones.ts`, `casos-importantes.ts`. Borrar un lead deja su conversación, su entrada en el índice de teléfonos, su copia en el archivo y su nombre en auditoría; cobros, garantías, planillas (cédula y firma), suspensiones y casos no tienen borrado individual. La ley exige responder una supresión en 15 días hábiles.
→ **Solución:** endpoint admin `DELETE /api/data-subject` que, dado teléfono o cédula, busque en todas las colecciones y borre registros y blobs, dejando en auditoría solo un hash; y que el DELETE de leads borre conversación e índice.

**[ALTO] Datos de clientes y empleados viajan a Anthropic y OpenAI sin figurar en la política ni formalizarse** — `sales-agent.ts`, `collections-agent.ts`, `messages.ts:355-431`, `gabot-report.ts`, `transcribe.ts` (audios a Whisper). La política de privacidad no menciona WhatsApp, IA ni transcripción.
→ **Solución:** aceptar los DPA de Anthropic y OpenAI (y retención cero si está disponible), actualizar `privacidad.astro` con encargados y transferencias internacionales, y minimizar: sin teléfono en `consultar_crm`, primer nombre y saldo redondeado para Valentina, nombre más placa en los pendientes de GPSITO.

### 2.3 Pérdida de datos y operación

**[CRÍTICO] No existe ningún respaldo de Redis ni de Blob** — `storage-maintenance.ts`, `scripts/`, `vercel.json`. Redis es la única base de datos; los archivos de leads y tareas viven en el mismo Redis; Blob no tiene versionado. Un borrado accidental, un bug que escriba un hash vacío o una suspensión de la cuenta pierden 3.470 leads, 78.000 novedades, usuarios y todas las conversaciones.
→ **Solución:** (1) confirmar en la consola de Upstash que los *Daily Backups* están activos; (2) cron diario `/api/backup-cron` que recorra las llaves `internal:*` por bloques y suba un JSON por llave a Blob en `backups/AAAA-MM-DD/`, con retención de 30 días; (3) nunca borrar un blob referenciado por un registro vivo.

**[CRÍTICO] "Borrar todo" en Cobranza es un `DEL` irreversible de tres llaves** — `cobros.ts:440-441`. La única protección es un `confirm()` del navegador.
→ **Solución:** `RENAME` a `internal:cobros-trash:<fecha>` con caducidad de 30 días en vez de borrar; exigir escribir "BORRAR" en el modal.

**[CRÍTICO] Un fallo de Redis al marcar un mensaje de WhatsApp lo pierde para siempre** — `whatsapp-webhook.ts:668-719`. El `SET NX` de idempotencia está fuera del `try` por mensaje; si Upstash falla ahí, la excepción cae al `catch` externo, que responde 200 y Meta no reintenta.
→ **Solución:** si Redis falla antes de marcar, responder 503 para que Meta reintente; mover el `SET NX` dentro del `try` por mensaje.

**[ALTO] Si Meta rechaza el envío, el sistema cree que respondió** — `whatsapp-webhook.ts:279, 439, 565`. No se lee `result.ok`; `lastOutboundAt` y el historial ya se escribieron, así que el filtro "Sin responder" y el reintento del día lo descartan.
→ **Solución:** comprobar `result.ok`; si falla, no actualizar `lastOutboundAt`, guardar `[Estado WhatsApp] failed` en el historial, auditar y avisar a Josué si hay más de N fallos en 10 minutos.

**[ALTO] Anthropic sin créditos o caído: respuesta genérica y recuperación manual** — `anthropic-client.ts`, `whatsapp-webhook.ts:330-333`. Cada cliente recibe "dame un momento" y nada más; nadie recibe aviso; al día siguiente hay que acordarse de pulsar "Reintentar".
→ **Solución:** cuando `reply === null`, auditar `anthropic_unavailable`, push a admin/Josué con límite de uno cada 15 minutos, marcar `needsRetry` en el lead y que el cron horario de seguimiento reintente solo dentro de la ventana de 24 horas.

**[ALTO] Ningún `fetch` externo tiene tiempo límite y el webhook procesa todo antes de responder** — `anthropic-client.ts:22`, `whatsapp.ts`, `transcribe.ts`. Una llamada colgada a Anthropic hace que Meta reintente mientras la primera sigue corriendo; un `fetch` colgado a Meta detiene el cron de cobranza.
→ **Solución:** `AbortSignal.timeout(20000)` en Anthropic y OpenAI, `8000` en Meta; en el webhook responder 200 de inmediato y procesar con `waitUntil` de `@vercel/functions` o una cola en Redis que un cron drene; fijar `maxDuration` por ruta.

**[ALTO] La limpieza diaria no tiene candado: dos corridas a la vez recortan el doble y pueden corromper novedades** — `storage-maintenance.ts:130-300`, `storage-report.ts:53`. Los `ltrim` por conteo y los `lset` por índice negativo asumen que nadie más tocó la lista.
→ **Solución:** `SET internal:cleanup-lock NX EX 900` al inicio; recortar comparando contenido (`lindex`) y verificar el `id` antes de cada `lset`.

**[ALTO] Envío masivo de plantillas sin candado: tanda doble al mismo cliente** — `cobros.ts:56-82` llamado por el cron horario y por el botón. Hasta 300 clientes pueden recibir la plantilla dos veces; Meta penaliza la calidad del número.
→ **Solución:** `SET internal:cobros-bulk-lock NX EX 600`; marcar `templateSentAt` antes de llamar a Meta y revertir si falla. Mismo candado en los dos crons de seguimiento.

**[ALTO] Condiciones de carrera: el último que escribe pisa al anterior** — webhook (`:287→:432`, con 6 segundos de Anthropic en medio) contra el PATCH del CRM (`leads.ts:334-469`) y `generate-quote.ts:484-490`; también cobros, suspensiones, garantías, tareas y conversaciones. Escenario: el cliente escribe, el webhook carga el lead, la secretaria agrega una nota 3 segundos después, el webhook escribe su copia y la nota desaparece.
→ **Solución:** campo `rev` por registro verificado al escribir (script Lua o `WATCH`), y en el webhook releer el lead después de Anthropic y aplicar solo los campos que cambió.

**[ALTO] `generate-quote.ts` escribe leads sin pasar por `writeLeads`** — `generate-quote.ts:484-490`. Única escritura fuera del helper: no sube la versión ni limpia la caché; otras instancias sirven el estado viejo hasta 15 segundos.
→ **Solución:** usar `writeLeads`.

**[ALTO] Nadie se entera cuando algo falla** — 166 `catch` vacíos, errores solo en `console.error` de Vercel; sin `/api/health`, sin alerta externa. Casos: Anthropic sin créditos, Meta rechazando, un cron respondiendo 401 por un secreto cambiado, Redis caído (la alarma de apagados calla en silencio).
→ **Solución:** helper `reportIncident(code, detail)` que audite, cuente con TTL y avise por push a admin/Josué con límite; cada cron termina con un `logAudit` de resumen y marca `cron_ok:<nombre>`; endpoint `/api/health` que verifique Redis y la antigüedad de esas marcas, vigilado por un monitor externo gratuito.

### 2.4 Lógica de negocio

**[ALTO] Apagados de los últimos 15 minutos del día: la alarma se apaga sola a medianoche y nunca escala** — `apagados-programados.ts:92-114`, `apagados-cron.ts:38-43`, `interno-alarmas.js`. La agenda se construye solo para "hoy" y el retraso se calcula en minutos del día; a las 00:00 la franja de las 23:50 desaparece y el push "en 1 minuto" de un apagado a las 00:00 nunca sale.
→ **Solución:** agenda con ayer y hoy, comparando el slot completo en milisegundos; en el cron ventana `[0, 3]` minutos para el push previo y escalación por diferencia real de tiempo.

**[ALTO] Con el reloj del PC adelantado, la alarma no suena** — `interno-alarmas.js:272-280`. `ignoreBefore` se calcula una vez con la hora local antes de conocer el desfase con el servidor.
→ **Solución:** calcularlo tras el primer sondeo exitoso con la hora del servidor, o que el servidor lo devuelva.

**[ALTO] La recarga automática por despliegue borra lo que alguien tenía a medio escribir en una pestaña de fondo** — `interno-notifications.js:72-75`. "Oculta" no significa "sin uso": una nota de CRM o una novedad con fotos a medio llenar se pierde al cambiar a WhatsApp Web si llega un despliegue.
→ **Solución:** antes de recargar comprobar que no haya `input`/`textarea` con contenido; si lo hay, mostrar el banner "Recargar" aunque esté oculta. Además, tras recargar en segundo plano la alarma queda muda hasta un clic (requisito del navegador): no recargar en segundo plano en pestañas con alarma.

**[ALTO] Reportes programados calculan "inicio del día" en UTC** — `scheduled-reports.ts:42-65`. Un reporte diario hecho a las 6 pm vuelve a aparecer vencido a las 7 pm; una fecha fijada a mano vence a las 7 pm del día anterior; la campanita usa otra fórmula y discrepa.
→ **Solución:** trabajar con fechas texto en Colombia (`dateInColombia`, `todayInColombia`) como ya hace `isOverdueInColombia`, y compartir la lógica con `notifications.ts`. Lo mismo para tareas recurrentes sin fecha (`tasks.ts:62-68`), la fecha impresa en la cotización (`generate-quote.ts:167`) y el vencimiento de contratos (`contracts.ts:44-51`).

## 3. Hallazgos medios (plan a dos semanas)

**Acceso y sesiones**
- Bloqueo de login solo por usuario: 5 intentos bloquean 15 minutos a cualquier cuenta conocida, sin límite por IP (`auth/login.ts:19-63`). → Contador por IP y por usuario+IP con retardo exponencial.
- Cambiar el rol no cierra las sesiones: un usuario degradado conserva privilegios hasta 24 horas (`auth.ts:312-424`, `users.ts:240-330`). → `destroyAllSessionsForUser` al cambiar rol, o releer rol y estado en `getSession`.
- Siembra de usuarios con clave `1234` conocida (`seed-users.ts:21-55`). → Clave aleatoria por usuario o cuentas inactivas hasta la entrega.
- `GET /api/users` devuelve usernames y `mustChangePassword` a todos los roles (`users.ts:52-99`). → Solo `{id, name, role}` para chat.
- Secretaria puede borrar cualquier lead; gerente edita tareas fuera de su sucursal (`leads.ts:477-502`, `tasks.ts:339-343`).
- Rate limit confía en el primer valor de `x-forwarded-for` (`rate-limit.ts:4-7`). → Preferir `x-real-ip`.

**Entradas e inyección**
- Inyección indirecta de instrucciones: nombre de perfil de WhatsApp y textos del cliente llegan al chat interno como mensajes de GPSITO y entran al contexto del asistente con herramientas (`whatsapp-webhook.ts:381-386`, `messages.ts:176-178`). → Marcar los avisos automáticos como datos (`[Aviso]`) y excluirlos del historial del modelo; recortar nombre (80) y ciudad (60); validar la sucursal en servidor.
- Sin límite de tamaño ni tasa en el chat interno y GPSITO, transcripción (16 MB) y cotizaciones (`messages.ts:116`, `gabot-transcribe.ts`, `generate-quote.ts`). → Tope de 4.000 caracteres y límites por usuario y hora.
- SVG y tipos declarados por el cliente aceptados como foto y servidos inline (8 endpoints de subida, `blob-file.ts:105`). → Lista blanca JPEG/PNG/WebP con verificación de bytes y `Content-Disposition`.
- SSRF ciego por el endpoint de Web Push elegido por el cliente (`push-subscribe.ts:28-35`). → Validar HTTPS y host en lista de servicios push.
- Inyección de atributo HTML en la galería de material del CRM (`interno-crm.js:1131-1135`). → `escapeHtml` y validación de URL en servidor.
- Webhook de WhatsApp no comprueba `phone_number_id` (`whatsapp-webhook.ts:628-635`).

**Datos personales**
- Valentina revela nombre y saldo a quien escriba desde un número tomado de un Excel sin verificar (`cobros.ts:56-82`, `collections-agent.ts`). → Primera plantilla sin monto y confirmación de identidad antes de dar la cifra.
- Cédula, teléfono y firma del cliente visibles a todos los técnicos y conservados sin límite (`planillas-vehiculo.ts`). → Enmascarar cédula en la lista; retención de 2 años.
- Diagnóstico médico e hijos menores en la ficha de empleados sin autorización ni retención tras el retiro (`incapacidades.ts`, `employees.ts`). → Eliminar o cifrar el diagnóstico; autorización registrada; purga tras `fechaRetiro`.
- Retención indefinida en cobros, garantías, suspensiones, casos, solicitudes, planillas, seguimiento y archivos de leads y tareas (`storage-maintenance.ts:14-30`). → Plazos por módulo en `RETENTION` con el mismo patrón de simulación.
- Teléfonos y notas de clientes en logs y auditoría (`whatsapp-webhook.ts:710`, `leads.ts:289,470`, `users.ts:379` que puede guardar `currentPassword`). → Registrar ids, no datos; lista blanca de campos en el meta.
- Datos personales en el repositorio: un teléfono real en `scripts/fix-leads-2026-09-26.mjs`, 58 empleados en `src/data/employee-seed.json`, usernames privilegiados como constantes. → Borrar y reescribir historial; mover la lista de usernames a Redis.
- Política de privacidad incompleta (sin WhatsApp, IA, transcripción, cookies, plazos) y sin aviso en los puntos de captura (`privacidad.astro`).
- Operadores ven casos importantes de todas las sucursales (`casos-importantes.ts:85-93`).

**Operación**
- `readCobros` sin caché en la ruta caliente del webhook y en el visor cada 60 segundos. → Mismo patrón de versión y caché que leads; marcar en el índice "no es cobro".
- Versión global del chat: el "visto" de cualquier usuario invalida el "sin cambios" de todas las pestañas. → Versión por usuario.
- Caché de GPSITO mal partida: los pendientes van en el bloque cacheado, así que casi nunca se lee y se paga el 125 % (`gabot-agent.ts:226-240`). → Mover pendientes y nombre al bloque volátil. El corte de 60 pendientes es por posición y puede dejar fuera tareas y CRM. → Tope por sección.
- Historial de WhatsApp y contadores de no leídos del chat se reescriben completos en concurrencia (`appendHistory`, `messages.ts:139-145`). → Listas con `RPUSH`/`LTRIM` y `HINCRBY`.
- Escrituras masivas de un solo comando (backfills, índice de teléfonos, garantías) que a 3× el volumen superan 10 MB. → Lotes de 500.
- Búsqueda de novedades dispara hasta 100 peticiones simultáneas. → Concurrencia 5-10 y techo de 30.000.
- "Silenciar 5 minutos" oculta también apagados nuevos que venzan en ese lapso (`interno-alarmas.js:133-205`). → Silenciar por franja, no global.
- Crons de recordatorios de GPSITO sin aislamiento por usuario: un fallo aborta el resto.
- Siete colecciones y cinco carpetas de Blob crecen sin regla de retención (garantías llegará a 10 MB en un año).
- `una_vez` con fecha pasada queda "activa"; doble entrada en el log si dos confirman a la vez; supervisores reciben dos pushes por escalamiento.
- Entrada `hisnaldis` del botón de encargados puede coincidir con "Hisnaldis Junior Cárdenas" si fueran cuentas distintas (`inventario-encargados.ts:44-49`). → Para entradas de una palabra comparar solo el username.

## 4. Hallazgos bajos (higiene, un mes)

Enumeración de usuarios por tiempo de respuesta en login; el cambio de clave propio no cierra otras sesiones; `mustChangePassword` solo se exige en páginas y no en la API; admin editándose sin `currentPassword`; comparaciones de username con mayúsculas inconsistentes; `session.name` inexistente en cinco registros (atribución perdida); comparaciones de secretos de crons con `!==`; token de Meta en la query string; fechas sin validar volcadas en atributos `value`; grupos de chat con `memberIds` sin validar; instrucciones del administrador sin tope; fotos y firmas cacheadas 24 horas en equipos compartidos (bajar a 5 minutos para `planillas/`, `casos/`, `suspensiones/`); nombres de clientes en el texto de los push; aviso de supervisión de chats internos; paginación por offset que puede saltarse un registro que cambió de posición; TTL de 15 segundos de la caché de leads anula casi todo el ahorro (subir a minutos); `ignoreBefore` y la agenda de apagados en el cambio de día; aviso de promoción compara fechas con zonas distintas (`whatsapp-promo-notice.ts:57,83`); llaves que crecen sin recorte (`internal:whatsapp-phone-index` huérfanos, `internal:agent-conversations:*`); `visits:total` incrementable sin límite.

## 5. Lo que está bien y no hay que tocar

- Sesiones con id aleatorio firmado por HMAC, comparación en tiempo constante, cookie `HttpOnly`, `Secure`, `SameSite=Lax`, caducidad de 24 horas más 4 de inactividad, revocación en Redis.
- Contraseñas con scrypt y sal por usuario; el hash nunca sale al navegador.
- Protección CSRF (`verifySameOrigin`) en el 100 % de los endpoints mutantes; cabeceras de seguridad completas (CSP sin scripts inline, HSTS, `nosniff`, `frame-ancestors 'none'`).
- Las 32 páginas del panel y los endpoints gatean con `getSession` más una función `canX`, nunca con el rol crudo.
- Blob 100 % privado; webhooks de Meta con firma HMAC verificada antes de parsear; los 9 crons fallan cerrado sin `CRON_SECRET`.
- Las herramientas de GPSITO se registran solo si el usuario tiene el permiso y los resolvers vuelven a validar en servidor; Andrés y Valentina solo pueden modificar el lead o cobro del número que escribe.
- Ningún secreto en el código ni en los 108 commits; sin mass assignment; enumeraciones validadas en servidor; tamaños de archivo acotados.
- El trabajo de hoy: idempotencia del webhook, caché de leads con versión, contadores de versión en los sondeos, recálculo global de avisos con candado, lectura paginada de notificaciones, limpieza con simulación y respaldo a Blob antes de recortar novedades, horario de silencio y tandas en los envíos.

## 6. Anexos

### 6.1 Endpoints con verificación insuficiente

| Ruta | Método | Qué falta |
|---|---|---|
| `/api/whatsapp-media-file` | GET | Normalización de ruta (`..`) |
| `/api/blob-file` | GET | Normalización de ruta; coincidencia exacta con el registro; rama `garantias/` |
| `/api/web-chat` | POST | No engancharse a leads existentes; límites de tamaño; `sessionId` como UUID |
| `/api/users` | POST | Prohibir `role: 'admin'` a quien no es admin |
| `/api/users` | PATCH | Invalidar sesiones al cambiar rol; limitar a sucursales para Josué/Wilmar; `currentPassword` en autoedición |
| `/api/users` | GET | Campos mínimos para roles sin gestión |
| `/api/auth/login` | POST | Límite por IP; tiempo constante |
| `/api/seed-users` | POST | Clave aleatoria |
| `/api/leads` | DELETE | Solo supervisor en adelante |
| `/api/tasks` | PATCH | Alcance por sucursal para gerente |
| `/api/messages`, `/api/gabot-transcribe`, `/api/generate-quote` | POST | Tope de tamaño y tasa |
| `/api/push-subscribe` | POST | Validar host del endpoint |
| Toda la API | * | Exigir `mustChangePassword === false` |

### 6.2 Inventario de datos personales (resumen)

| Dato | Dónde | Quién lo ve | Conservación | Borrable a pedido |
|---|---|---|---|---|
| Leads (nombre, teléfono, ciudad, notas) | `internal:leads`, archivo, índice | secretaria a admin, nacional | indefinido (archivo a 180 d solo Nuevo/Contactado/Perdido) | parcial |
| Conversaciones WhatsApp (Andrés y Valentina) | hashes de conversaciones | solo admin; Anthropic | 60 mensajes; indefinido | no |
| Audios de voz | no se guardan; OpenAI Whisper | OpenAI | transitorio | n/a |
| Cobranza (nombre, teléfono, deuda) | `internal:cobros` | gerente a admin, Wilmar | indefinido | solo "borrar todo" |
| Planillas (cédula, teléfono, firma) | Redis + Blob `planillas/` | técnicos y gerente de la sucursal | indefinido | no |
| Garantías, suspensiones, casos, solicitudes | Redis + Blob | por sucursal o nacional según módulo | indefinido | no |
| Novedades (placa, nota, fotos) | lista + Blob `reports/` | operadores a admin | fotos 90 d, texto 1 año, archivo indefinido | no |
| Ficha RRHH (cédula, hijos, EPS, cuenta) e incapacidades (diagnóstico) | `internal:employee-profiles`, `internal:incapacidades` | admin, Josué, Wilmar | indefinido, incluso tras retiro | no |
| Auditoría (con nombres y teléfonos en el texto) | `internal:audit` | gerente, admin, GPSITO | 90 d | no |

### 6.3 Llaves de Redis con riesgo de crecimiento

Sin regla de retención: `internal:garantias` (riesgo de superar 10 MB en un año), `internal:suspensiones`, `internal:casos-importantes`, `internal:solicitudes-administrativas`, `internal:pagos-internos`, `internal:planillas-vehiculo`, `internal:seguimiento-masivos`, `internal:cobros`, `internal:cobro-whatsapp-conversations`, `internal:leads-archive`, `internal:tasks-archive`, `internal:agent-conversations:*`, `internal:whatsapp-phone-index` (campos huérfanos). Blob sin borrado: `garantias/`, `suspensiones/`, `casos/`, `solicitudes-admin/`, `planillas/`, `whatsapp-agent-media/`.

Con límite o caducidad correctos: notificaciones (200), mensajes de chat (500), historial de WhatsApp (60 reales), auditoría (90 d), novedades (fotos 90 d, texto 365 d), sesiones, rate limits, marcas de idempotencia, cachés y contadores de versión, baldes diarios de uso de IA (400 d).

### 6.4 Rutas que aún leen colecciones completas por petición

`GET /api/my-pendientes` (9 colecciones por visita al inicio), `POST /api/messages` a GPSITO (las mismas 9 más usuarios), `GET /api/tasks`, `GET /api/conversations` (cuando cambia la versión global), `GET /api/whatsapp-conversations` (leads más cobros cada 60 s), `GET /api/cobros`, `GET /api/garantias` (usuarios, garantías, perfiles y horario). Índices propuestos: tareas por asignado, leads abiertos con seguimiento por fecha (sorted set), novedades por día, conversaciones por usuario, caché con versión para cobros y usuarios.
