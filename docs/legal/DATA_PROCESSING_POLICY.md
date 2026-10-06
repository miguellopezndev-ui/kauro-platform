<!--
D-08b · Política de Tratamiento de Información Personal de Kauro (Ley 1581 de 2012; Decreto 1377 de 2013 compilado en el
Decreto 1074 de 2015, art. 2.2.2.25.3.1). Borrador del constructor sin abogado (decisión D-08b, opción 1).
Trazabilidad: `auth:` = authority/r2; `law:` = fila de CHECKLIST.md. Marcadores admitidos: [NIT], [domicilio],
[correo de notificaciones], [fecha de vigencia], [teléfono] (ver LAWYER_LATER F-05).
-->

# Política de Tratamiento de Información Personal

**Versión:** 1.0 · **Vigente desde:** [fecha de vigencia]

## 1. Responsable del tratamiento

| Dato | Valor |
|---|---|
| Razón social | Kauro Data S.A.S. |
| NIT | [NIT] |
| Domicilio y dirección | [domicilio] |
| Correo electrónico | [correo de notificaciones] |
| Teléfono | [teléfono] |
| Sitio web | kaurodata.com |
<!-- law: C-03 (Decreto 1074 art. 2.2.2.25.3.1 num. 1: nombre, domicilio, dirección, correo y teléfono) · auth: A8 §1; A4 §Owner acts; 19 §BusinessProfile and legal facts -->

## 2. Marco normativo y alcance

Esta Política cumple la Ley Estatutaria 1581 de 2012, el Decreto 1377 de 2013 (compilado en el Capítulo 25 del Decreto 1074 de
2015) y las instrucciones de la Superintendencia de Industria y Comercio (SIC). Aplica a las bases de datos con datos personales
de las que **Kauro es responsable** y, en lo que corresponda, a los datos que Kauro trata como **encargado** por cuenta de sus
clientes (sección 12).
<!-- law: C-01, C-02 -->

## 3. Definiciones

Se usan las definiciones del artículo 3 de la Ley 1581 de 2012: autorización, base de datos, dato personal, encargado del
tratamiento, responsable del tratamiento, titular y tratamiento. Además: **transferencia** es el envío de datos a un receptor que
es a su vez responsable; **transmisión** es la comunicación de datos a un encargado para que los trate por cuenta del responsable.
<!-- law: C-01 (Ley 1581 art. 3); C-20 (Decreto 1074 art. 2.2.2.25.5.1) -->

## 4. Principios

Kauro aplica de manera armónica los principios de legalidad, finalidad, libertad, veracidad o calidad, transparencia, acceso y
circulación restringida, seguridad y confidencialidad del artículo 4 de la Ley 1581 de 2012, y el principio de responsabilidad
demostrada. En la práctica: recoge solo los datos necesarios para cada finalidad; no envía a vendedores, analítica, notificaciones,
registros ni herramientas de desarrollo más datos de los necesarios; y no usa datos de clientes en asistentes de desarrollo,
repositorios ni servicios de modelos no pagados.
<!-- law: C-01 (art. 4), C-24 (Decreto 1074 art. 2.2.2.25.6.1) · auth: 01 CH-006 -->

## 5. Roles de Kauro

- **Responsable:** de los datos de sus clientes como empresas y de sus usuarios, de los interesados y prospectos, de sus
  colaboradores comerciales y proveedores, de quienes ejercen derechos ante Kauro y de los registros de seguridad (sección 6).
- **Encargado:** de los datos personales contenidos en las exportaciones de CRM y hojas de cálculo que los clientes cargan para
  su preparación, y de sus derivados. En ese caso el responsable es el cliente o el cliente final del cliente, y el tratamiento se
  rige por el Acuerdo de Encargo (DPA) firmado con el cliente (sección 12).
<!-- auth: 19 §Data processing agreement; 01 §Purpose and customer promise (A3 §4.1); producto: brief D-08b -->

## 6. Bases de datos, datos tratados y finalidades (Kauro como responsable)

### 6.1. Clientes y usuarios de la plataforma

- **Titulares:** administradores y usuarios invitados de las agencias y empresas cliente.
- **Datos:** nombre, correo electrónico de trabajo, empresa, rol y permisos, idioma; información de verificación de correo y de
  segundo factor (Kauro no conserva contraseñas en texto claro ni muestra códigos de recuperación fuera del flujo seguro); registro
  de la aceptación de los documentos del contrato; actividad en la plataforma y eventos de seguridad (actor, alcance, acción,
  resultado y fecha); tipo de comprador declarado (agencia o equipo interno).
- **Finalidades:** (a) crear y administrar la cuenta, las membresías y los permisos; (b) prestar el servicio contratado y el
  soporte; (c) autenticar y proteger el acceso; (d) enviar avisos transaccionales del servicio (invitaciones, estado del
  procesamiento, pagos, entregas, avisos de eliminación, soporte); (e) aplicar descuentos de recurrencia y cupos fundadores; (f)
  medir de forma agregada el uso por segmento; (g) cumplir obligaciones legales y atender requerimientos de autoridad; (h) enviar
  comunicaciones comerciales sobre Kauro a usuarios que no se hayan dado de baja; y (i) prevenir el abuso y el fraude.
<!-- auth: 02 §2; 08 §Authentication and assurance; 08 §Audit events and retention; 11 §Agency onboarding; 16 §Recurrence decision; A3 §3.7 (tipo de comprador); reference/MESSAGING_AND_SENDER_OPERATIONS.md (avisos transaccionales vía Resend) -->

### 6.2. Facturación, pagos y contabilidad

- **Titulares:** representantes y contactos de facturación de los clientes; personas que figuran en pagos y transferencias.
- **Datos:** razón social, identificación tributaria, dirección de facturación, contacto de facturación, datos del pedido,
  referencias y estados del pago, nombre y referencia del ordenante en transferencias recibidas, reembolsos y disputas. Kauro no
  recibe ni guarda números completos de tarjetas: el pago con tarjeta se hace en PayPal.
- **Finalidades:** cobrar, conciliar pagos, emitir factura electrónica y notas, gestionar reembolsos y disputas, llevar la
  contabilidad y cumplir obligaciones tributarias y comerciales.
<!-- auth: 15 §Money vocabulary; 15 §FiscalProfile ("collects only billing facts necessary"); 15 §Disputes and chargebacks; A8 §1, §3 -->

### 6.3. Interesados y prospectos

- **Titulares:** personas que llenan el formulario de contacto del sitio, y contactos de negocio de **agencias** que Kauro
  identifica como posibles clientes.
- **Datos:** del formulario: nombre, correo y empresa, tipo de comprador, destino, banda aproximada de registros y fecha deseada
  (el formulario no acepta archivos de CRM). De prospectos: nombre de la agencia, dominio, país, persona de contacto y su cargo,
  canal de contacto, fuente pública y fecha de observación, notas comerciales acotadas y estado de baja.
- **Finalidades:** responder solicitudes; evaluar si el proyecto encaja con el servicio; enviar comunicaciones comerciales
  dirigidas a agencias con un mecanismo de baja que funciona; y registrar las bajas para respetarlas siempre.
- **Límites:** Kauro solo prospecta agencias. Nunca investiga, registra como prospecto ni contacta para venta a empresas que no
  son agencias ni a sus equipos internos, ni a los clientes finales de sus agencias clientes. No usa los datos de los archivos de
  CRM de sus clientes para fines comerciales.
<!-- auth: 02 §1 Discover and qualify fit; 12 §Prospect record; 18 §Prospect qualification; 18 §Communication compliance; 16 §Offer and buyer fit; A3 §3.7 -->

### 6.4. Colaboradores comerciales y proveedores

- **Titulares:** vendedores independientes, candidatos a serlo, proveedores personas naturales y contactos de proveedores.
- **Datos:** identificación, contacto, información contractual, documentos tributarios y de seguridad social exigidos,
  datos bancarios para pagos, liquidaciones de comisiones y su soporte.
- **Finalidades:** seleccionar y contratar, administrar la relación, calcular y pagar comisiones u honorarios, cumplir
  obligaciones tributarias y contables, y atender disputas. Los documentos de identidad, bancarios y tributarios se guardan con
  acceso restringido a finanzas y nunca se incluyen en exportaciones de prospectos ni en paquetes de revisión.
<!-- auth: 17 §Currency, fees and tax documentation; 17 §Legal engagement packet; 12 §Seller onboarding and access lifecycle -->

### 6.5. Solicitudes, consultas y reclamos

- **Datos:** identificación del solicitante, tipo de solicitud, fechas, verificación aplicada, alcance, respuesta y cierre.
- **Finalidad:** atender y documentar el ejercicio de derechos y las quejas, conservando la evidencia mínima sin conservar los
  datos que se suprimieron.
<!-- auth: 19 §Rights requests and privacy complaints -->

### 6.6. Seguridad y registros técnicos

- **Datos:** eventos de seguridad y registros de la aplicación con identificadores de actor, alcance, acción, resultado y fecha.
  No contienen contenido de CRM, contraseñas ni secretos.
- **Finalidad:** proteger el servicio, investigar incidentes y demostrar el cumplimiento.
<!-- auth: 08 §Audit events and retention; 09 §Retention schedule -->

## 7. Datos sensibles y de niños, niñas y adolescentes

Kauro no solicita datos sensibles en ninguna de las bases de la sección 6 y no trata datos de niños, niñas o adolescentes; el
servicio es solo para empresas. Si un titular decide entregar un dato sensible, responder es facultativo. Los clientes tienen
prohibido cargar datos sensibles y datos de menores en los archivos de CRM (Términos de Servicio, sección 5.2).
<!-- law: C-07 (Ley 1581 arts. 5, 6 y 7; Decreto 1074 art. 2.2.2.25.2.3) · auth: 19 §Data categories and excluded use -->

## 8. Autorización

8.1. Kauro solicita la autorización previa, expresa e informada del titular al momento de la recolección, por un medio que
permite consultarla después: casilla de aceptación en el registro de la cuenta y en el formulario de contacto, con enlace a esta
Política y al Aviso de Privacidad; o documento firmado en la contratación de colaboradores. Kauro conserva la prueba de la
autorización.

8.2. No se requiere autorización en los casos del artículo 10 de la Ley 1581 de 2012, entre ellos los datos de naturaleza pública
y la información requerida por una autoridad en ejercicio de sus funciones. El tratamiento de datos de contacto de negocio
obtenidos de fuentes públicas para prospección se limita a lo indicado en la sección 6.3 y su base legal se documenta por fuente.
<!-- law: C-04, C-05, C-06 (Ley 1581 arts. 9 y 10; Decreto 1074 arts. 2.2.2.25.2.2, 2.2.2.25.2.4 y 2.2.2.25.2.5) · ver LAWYER_LATER L-03 (prospección con datos de fuentes públicas) -->

## 9. Derechos de los titulares

El titular puede: (a) conocer, actualizar y rectificar sus datos frente a Kauro, incluso frente a datos parciales, inexactos,
incompletos, fraccionados o que induzcan a error, o cuyo tratamiento no haya sido autorizado; (b) solicitar prueba de la
autorización, salvo cuando no se requiera; (c) ser informado, previa solicitud, del uso que se ha dado a sus datos; (d) presentar
quejas ante la Superintendencia de Industria y Comercio, después de agotar el trámite de consulta o reclamo ante Kauro; (e)
revocar la autorización o solicitar la supresión de sus datos cuando no se respeten los principios, derechos y garantías
constitucionales y legales, salvo que exista un deber legal o contractual de conservarlos; y (f) acceder gratuitamente a sus datos
al menos una vez cada mes calendario y cada vez que haya cambios sustanciales de esta Política.
<!-- law: C-08 (Ley 1581 arts. 8 y 16), C-09 (Decreto 1074 art. 2.2.2.25.4.2) -->

## 10. Procedimiento para consultas y reclamos

10.1. **Canal.** Las solicitudes se envían a [correo de notificaciones], o por escrito a [domicilio], o desde la sección de
privacidad de la cuenta en la plataforma. Kauro verifica la identidad del titular o de su causahabiente o representante antes de
revelar, corregir o suprimir datos.
<!-- auth: 11 §Billing, team, settings and help ("privacy requests"); 19 §Rights requests and privacy complaints -->

10.2. **Consultas.** Se atienden en un máximo de diez (10) días hábiles desde su recibo. Si no es posible, Kauro informa antes del
vencimiento los motivos y la nueva fecha, que no superará cinco (5) días hábiles adicionales.

10.3. **Reclamos** (corrección, actualización, supresión o presunto incumplimiento). El reclamo debe incluir la identificación
del titular, la descripción de los hechos, la dirección y los documentos que se quieran hacer valer. Si está incompleto, Kauro
pide completarlo dentro de los cinco (5) días siguientes a su recibo; si pasan dos (2) meses sin respuesta, se entiende desistido.
Si Kauro no es competente para resolverlo, lo traslada a quien corresponda en un máximo de dos (2) días hábiles e informa al
interesado. Recibido el reclamo completo, Kauro incluye en la base la leyenda "reclamo en trámite" y su motivo en un máximo de dos
(2) días hábiles, y la mantiene hasta decidir. El término para atenderlo es de quince (15) días hábiles desde el día siguiente a
su recibo; si no es posible, Kauro informa los motivos y la nueva fecha, que no superará ocho (8) días hábiles adicionales.

10.4. **Supresión y revocatoria.** No proceden cuando el titular tiene un deber legal o contractual de permanecer en la base de
datos (por ejemplo, facturas y registros contables que la ley obliga a conservar). En ese caso Kauro explica qué registros
residuales conserva y por qué.
<!-- law: C-10 (Ley 1581 arts. 14 y 15), C-11 (Decreto 1074 art. 2.2.2.25.2.6, revocatoria y supresión) · auth: 19 §Rights requests and privacy complaints (último párrafo) -->

## 11. Área responsable de la protección de datos

La función de protección de datos personales la asume el representante legal de Kauro, quien recibe y tramita las solicitudes de
los titulares por los canales de la sección 10.1.
<!-- law: C-09b (Decreto 1074 art. 2.2.2.25.4.4: designar persona o área) · resolución de silencio S-14 -->

## 12. Datos que Kauro trata como encargado (archivos de CRM)

12.1. Cuando una agencia o empresa carga exportaciones de CRM, el responsable de esos datos es el cliente o su cliente final.
Kauro los trata solo para prepararlos según las instrucciones del cliente, no los usa para fines propios, no los vende ni los
comparte, no los usa para entrenar modelos y los elimina en plazos cortos (entre 24 horas y 30 días según la etapa; el calendario
completo está en los Términos de Servicio, sección 13).

12.2. Si usted es una persona cuyos datos aparecen en el CRM de un cliente de Kauro, dirija su solicitud a la empresa con la que
tiene relación. Si la envía a Kauro, Kauro la trasladará a ese cliente en un máximo de dos (2) días hábiles y se lo informará.
Kauro solo conserva los datos por el tiempo del proyecto, por lo que es posible que ya no los tenga.

12.3. Para preparar los datos, Kauro puede enviar a un modelo de lenguaje alojado en Amazon Bedrock (Amazon Web Services, en
Estados Unidos) solo un contexto minimizado: estructura, datos agregados, vocabulario aprobado y ejemplos enmascarados. Nunca
envía registros crudos, credenciales ni secretos, y el modelo no toma decisiones: las aprueba el cliente.
<!-- auth: 19 §Data processing agreement; 06 §Privacy classes and minimization; 09 §Retention schedule; 19 §Rights requests and privacy complaints; A9 §3 · law: C-17 -->

## 13. Transmisiones y transferencias internacionales

13.1. Kauro usa encargados (proveedores que tratan datos por su cuenta), algunos de ellos ubicados en Estados Unidos:

| Encargado | Función | Datos | Ubicación |
|---|---|---|---|
| Amazon Web Services, Inc. | Alojamiento, base de datos, almacenamiento, identidad, registros y modelos de lenguaje (Amazon Bedrock) | Todos los de la sección 6 que la plataforma guarda; archivos de CRM como subencargado | Estados Unidos |
| Resend | Correo transaccional del servicio | Correo y nombre del usuario y contenido mínimo del aviso | Estados Unidos |
| Google LLC (Google Workspace) | Correo corporativo de Kauro (soporte, ventas, administración) y registros internos de solicitudes, incidentes y formación | Datos de contacto, contenido de la correspondencia y datos de los registros internos (sin archivos de CRM) | Según la infraestructura de Google |
| Proveedor de facturación electrónica que Kauro use ante la DIAN | Emisión y validación de facturas y notas | Datos de facturación (sección 6.2) | Colombia |
<!-- registros internos de Google Workspace: INTERNAL_DATA_MANUAL §8 (resolución de silencio S-20) · auth: A9 §1 y §3; 19 §Subprocessor register; reference/MESSAGING_AND_SENDER_OPERATIONS.md; 15 §Accounting integration decision (Alegra candidato o ruta DIAN) · resolución de silencio S-05 (proveedor fiscal no elegido) -->

13.2. Kauro comunica datos de pago a **PayPal** y a **Wise**, y opera con su banco **Bancolombia**; estas entidades tratan esos
datos como responsables independientes según sus propias políticas, porque prestan servicios financieros regulados. Kauro también
entrega a la DIAN la información que la ley tributaria exige.
<!-- auth: A8 §1; 19 §Subprocessor register (proveedor como responsable independiente); 15 §TaxDocument state machine -->

13.3. Las comunicaciones de datos a encargados en el exterior son **transmisiones** y se rigen por contratos que obligan al
encargado a tratar los datos según los principios de la Ley 1581 y esta Política, a proteger la seguridad de las bases y a guardar
confidencialidad. Estados Unidos figura en la lista de países con nivel adecuado de protección de la SIC. Kauro no transfiere
datos personales a terceros responsables fuera de Colombia distintos de los indicados en la sección 13.2.
<!-- law: C-20, C-21, C-22, C-23 · ver LAWYER_LATER L-01 (suficiencia de los contratos estándar de AWS, Resend y Google como contrato de transmisión) -->

## 14. Seguridad

Kauro aplica medidas técnicas, humanas y administrativas para impedir la adulteración, pérdida, consulta, uso o acceso no
autorizado: segundo factor obligatorio, aislamiento por cliente en la base de datos, cifrado en tránsito y en reposo, credenciales
de corta vida, mínimo privilegio, registros de auditoría sin contenido sensible y eliminación verificada. La descripción completa
está en el Anexo II del Acuerdo de Encargo.
<!-- law: C-12 (art. 17 lit. d), C-13 (art. 18 lit. b) · auth: 08 (todas las secciones citadas en DPA Anexo II) -->

## 15. Conservación

| Base | Plazo |
|---|---|
| Clientes y usuarios | Mientras la cuenta esté activa y hasta seis (6) meses después de su cierre, salvo los datos que deban conservarse por otra base |
| Facturación, pagos y contabilidad | Al menos diez (10) años, por la obligación de conservar libros y papeles del comerciante (Código de Comercio, art. 60) |
| Prospectos | Hasta la baja del titular o veinticuatro (24) meses sin interacción, lo que ocurra primero; la baja se conserva para respetarla |
| Interesados del formulario | Doce (12) meses desde la última interacción si no se convierten en clientes |
| Colaboradores comerciales | Durante la relación y por los plazos legales tributarios y contables posteriores |
| Solicitudes y reclamos | Cinco (5) años desde su cierre, con la evidencia mínima |
| Registros de aplicación | Treinta (30) días |
| Evidencia de seguridad | Ciento ochenta (180) días, salvo retención por incidente con motivo y fecha de revisión |
| Archivos de CRM (como encargado) | Según el calendario de los Términos de Servicio, sección 13 |
<!-- auth: 09 §Retention schedule (registros 30 días, seguridad 180 días, financieros por plazo legal, CRM); law: C-25 (Decreto 1074 art. 2.2.2.25.2.8 limitación temporal), C-38 (C. Co. art. 60) · resolución de silencio S-13 (plazos de cuentas, prospectos, formulario y solicitudes no fijados por la autoridad) -->

## 16. Cookies y tecnologías similares

La plataforma usa una cookie de sesión estrictamente necesaria para mantener la sesión iniciada y proteger contra falsificación
de solicitudes. A la fecha de vigencia, Kauro no usa cookies de publicidad ni de seguimiento de terceros. Si eso cambia, Kauro
actualizará esta Política antes de usarlas.
<!-- auth: 08 §Authentication and assurance (cookies de sesión Secure, HttpOnly, SameSite); 13 §Privacy in reports and downloads (prohibida la vista previa en analítica de terceros); diseño B11 D-AUTH-1 y D-PRIV-1 (docs/design/B11-agency-app.md) · resolución de silencio S-15 -->

## 17. Comunicaciones comerciales

Kauro envía comunicaciones comerciales con identificación veraz del remitente y del asunto, dirección postal real y un mecanismo
de baja que no exige iniciar sesión. La baja se aplica de inmediato y sobrevive a reasignaciones, reimportaciones de listas y
cambios de proveedor. Los avisos transaccionales del servicio no incluyen publicidad encubierta. Para destinatarios en Colombia,
Kauro envía mensajes comerciales solo de lunes a viernes de 7:00 a. m. a 7:00 p. m. y sábados de 8:00 a. m. a 3:00 p. m., nunca
domingos ni festivos.
<!-- auth: 18 §Communication compliance; reference/MESSAGING_AND_SENDER_OPERATIONS.md (baja sin login, supresión inmediata) · law: C-50 (CAN-SPAM, FTC), C-51 (Ley 2300 de 2023 arts. 3 y 5) -->

## 18. Incidentes de seguridad

Kauro gestiona los incidentes con un registro de detección, impacto, contención, comunicación y recuperación; reporta a la SIC
las violaciones de los códigos de seguridad dentro de los quince (15) días hábiles siguientes a su detección y avisa a los
titulares y clientes afectados cuando corresponde.
<!-- law: C-14, C-15 · auth: 14 §Incident containment; 19 §Incident and breach obligations -->

## 19. Registro Nacional de Bases de Datos

Kauro no está obligada a inscribir sus bases de datos en el Registro Nacional de Bases de Datos mientras sus activos totales no
superen 100.000 UVT; si llega a superarlos, las inscribirá en el plazo que fije la SIC.
<!-- law: C-16 (Decreto 1074 art. 2.2.2.26.1.2, modificado por el Decreto 090 de 2018) -->

## 20. Vigencia y cambios

Esta Política rige desde [fecha de vigencia]. Las bases de datos tienen la vigencia de las finalidades de la sección 6 y los
plazos de la sección 15. Kauro informará los cambios sustanciales a los titulares por la plataforma, por correo o en el sitio
web antes de aplicarlos y, cuando afecten la finalidad, solicitará una nueva autorización.
<!-- law: C-03 (Decreto 1074 art. 2.2.2.25.3.1 num. 6 y parágrafo), C-26 (art. 2.2.2.25.2.2 sobre nueva autorización por cambio de finalidad) -->
