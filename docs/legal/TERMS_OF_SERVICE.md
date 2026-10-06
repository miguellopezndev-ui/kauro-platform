<!--
D-08b · Términos de Servicio (agencia/cliente ↔ Kauro). Borrador redactado por el constructor sin abogado (decisión del dueño
D-08b, opción 1, 2026-10-05). Fuentes legales: CHECKLIST.md. Incertidumbres: LAWYER_LATER.md.
Convención de trazabilidad: cada afirmación de hecho sobre Kauro lleva un comentario `auth:` con el archivo y el encabezado de
authority/r2 (o de la enmienda) del que sale. Los comentarios `law:` remiten a la fila del CHECKLIST.
Únicos marcadores admitidos: [NIT], [domicilio], [correo de notificaciones], [fecha de vigencia]; más [teléfono], añadido por
exigencia del Decreto 1377 de 2013 art. 13 (ver LAWYER_LATER F-05).
-->

# Términos de Servicio de Kauro

**Versión:** 1.0 · **Vigentes desde:** [fecha de vigencia]

Estos Términos de Servicio (los "Términos") regulan la relación entre **Kauro Data S.A.S.** ("Kauro") y la persona jurídica que
crea una cuenta de cliente en la plataforma de Kauro (el "Cliente"). Léalos completos antes de aceptarlos. Junto con los
documentos enumerados en la sección 1.3 forman el contrato entre las partes.

## 1. Partes, documentos del contrato y orden de prevalencia

1.1. **Kauro.** Kauro Data S.A.S., sociedad por acciones simplificada constituida en Colombia, NIT [NIT], con domicilio en
[domicilio], correo de notificaciones [correo de notificaciones], teléfono [teléfono], sitio web kaurodata.com.
<!-- auth: amendments/A8_PAYMENT_ROUTING.md §1 (Kauro Data S.A.S.); amendments/A4_OPERATING_MODEL.md §Owner acts (dominio kaurodata.com); 19 §BusinessProfile and legal facts (dirección postal real, sin oficina ficticia) -->

1.2. **Cliente.** El Cliente es (a) una agencia que presta servicios de CRM, RevOps o limpieza de datos a sus propios clientes
(cada uno, un "Cliente Final"), o (b) una empresa cuyo equipo interno de CRM o datos trabaja sobre los datos de su propia
empresa ("Cliente Interno"). Kauro contrata únicamente con el Cliente, no con su Cliente Final ni con las personas que aparecen en
los archivos.
<!-- auth: 01_CHARTER.md §Purpose and customer promise (texto enmendado por A3 §4.1); 02 §Buyer, user and job to be done; A3 §3.7 -->

1.3. **Documentos del contrato.** El contrato está formado por: (i) estos Términos; (ii) el Acuerdo de Encargo de Tratamiento de
Datos Personales ("DPA", archivo DPA.md, y su versión en inglés DPA_EN.md); (iii) la Política de Tratamiento de Información
Personal de Kauro; (iv) la lista de subencargados y transferencias publicada en el DPA; (v) el calendario de conservación de la
sección 13; (vi) la política de soporte y remedios de las secciones 11 y 12; y (vii) cada Cotización aceptada (el "Pedido").
<!-- auth: 19 §Customer instrument hierarchy -->

1.4. **Prevalencia.** En caso de contradicción prevalece, en este orden: el DPA en lo relativo a datos personales tratados por
cuenta del Cliente; el Pedido en cuanto a modo, unidades, precio, descuento, impuestos y alcance de entrega; y estos Términos en
todo lo demás. Ningún correo, mensaje de un vendedor, texto publicitario o pantalla amplía las obligaciones de Kauro más allá de
estos documentos. Una excepción negociada solo obliga si consta en una enmienda escrita al Pedido aceptada por ambas partes.
<!-- auth: 19 §Customer instrument hierarchy; 19 §Service terms: required operative content ("The order governs mode, counted units...") -->

## 2. Definiciones

- **Plataforma:** la aplicación web de Kauro, su API y los paquetes que produce.
- **Archivos:** las exportaciones de CRM y hojas de cálculo que el Cliente carga.
- **Revisión de origen:** el conjunto sellado de Archivos y hojas admitidas, con sus huellas (hash) y configuración de lectura.
  Cualquier cambio posterior crea una nueva Revisión.
- **Plan:** el plan de transformación acotado que el Cliente revisa y aprueba, ligado a una Revisión, a un Contrato de Destino y a
  unas decisiones concretas.
- **Contrato de Destino:** la descripción vigente y aprobada de la instancia de CRM de destino (cuando el modo la requiere).
- **Perfil soportado:** el perfil de importación aceptado para un destino (importador de HubSpot o Data Loader de Salesforce).
- **Paquete:** el entregable publicado (archivos, informe, manifiesto legible por máquina e instrucciones de importación).
- **Finalización del servicio:** el momento en que el primer Paquete del Pedido queda disponible para descarga, o, en una
  importación por etapas, el momento en que queda disponible la entrega final.
- **Usuarios autorizados:** las personas que el administrador del Cliente invita y a quienes asigna un rol.
- **Unidades facturables:** las ocurrencias de objetos admitidos bajo la proyección sellada, antes de la deduplicación aprobada,
  según la sección 7.
- **Free data health check:** la revisión gratuita, previa a la compra, del estado de los datos cargados (sección 3.3).
<!-- auth: 19 §Service terms: required operative content ("define files, source revision, plan, package, target contract, supported profile, service completion and authorized users"); 02 §4 Upload, inspect and seal; 02 §6 Resolve and approve the plan; 16 §Billable unit and fairness; A3 §3.2 -->

## 3. Objeto y alcance del servicio

3.1. **Qué hace Kauro.** Kauro recibe Archivos autorizados, los inspecciona, perfila los datos, propone un Plan acotado, obtiene
la aprobación del Cliente, cobra el precio acordado, ejecuta el Plan de forma determinista y entrega un Paquete con evidencia y,
cuando el modo lo incluye, un procedimiento de importación para el destino. El servicio es de **preparación de archivos**: Kauro
limpia archivos exportados, no el CRM en vivo.
<!-- auth: 01 §Purpose and customer promise (segundo párrafo); A3 §3.3 ("we clean exported files, not your live CRM") -->

3.2. **Modos.** Cada proyecto tiene un único modo comprado y una única instancia de destino para su revisión pagada:
- **CLEAN:** tablas limpias, disposición de cada unidad de origen, inventario de incidencias, explicación de las
  transformaciones aprobadas y verificación por máquina. No afirma que un archivo genérico cumpla el esquema de un CRM desconocido.
- **HUBSPOT:** archivos de los objetos soportados, asociaciones, configuración del importador, pasos ordenados y evidencia ligada
  al destino, con un Contrato de Destino vigente y un perfil de importación de HubSpot aceptado.
- **SALESFORCE:** archivos de los objetos soportados, mapeo y configuración de Data Loader, pasos de dependencia y evidencia
  ligada al destino, con metadatos vigentes de la organización y un perfil de Data Loader aceptado.

Solo pueden cotizarse los modos y capacidades que la Plataforma muestre como disponibles en el momento de la Cotización. Kauro
califica importaciones únicamente para HubSpot y Salesforce. Cambiar de CLEAN a HUBSPOT, o cambiar de organización de
Salesforce, exige una nueva Cotización y una nueva aprobación.
<!-- auth: 02 §Service modes; 02 §Capability publication contract; A3 §3.3 -->

3.3. **Free data health check.** Antes de comprar, el Cliente puede solicitar un Free data health check sobre los Archivos que
cargue dentro de los límites publicados. Es gratuito y no crea obligación de compra. Está acotado y protegido contra abuso: una
revisión activa por Cliente a la vez, un tope de gasto de procesamiento por revisión y una pausa de nuevas revisiones gratuitas
cuando se agota el presupuesto disponible. No siempre está disponible de inmediato y su duración depende de la capacidad
observada; Kauro no promete un plazo fijo. Si el presupuesto de procesamiento se agota, la Plataforma entrega el perfil
determinista y un estado pendiente específico, sin inventar una interpretación completa.
<!-- auth: A3 §3.2 (nombre público, tope USD 1.50 freeAuditCeilingCents 150, agencyAudits 1, pausa al 90%); A3 §3.5 ("the check is free and creates no obligation to buy"); A3 §3.6 (sin plazo fijo); 02 §5 Receive the audit -->

3.4. **Objetos cubiertos.** El alcance inicial de objetos es contactos, organizaciones/cuentas y negocios/oportunidades, con las
asociaciones soportadas por destino. No están incluidos, salvo que se publique una capacidad calificada: conversión de leads,
objetos personalizados arbitrarios, actividades, adjuntos, recreación de historial de interacciones, membresías de campañas,
aprovisionamiento de propietarios ni despliegue de automatizaciones. Cada forma no soportada recibe una explicación y una ruta de
acción.
<!-- auth: 02 §Service modes (último párrafo) -->

3.5. **Qué no hace Kauro.** Kauro no escribe en el CRM de producción del Cliente ni del Cliente Final, no despliega campos,
reglas de validación ni automatizaciones, no hace enriquecimiento pagado, no administra el CRM en vivo ni ofrece mantenimiento
continuo de bases de datos, no presta consultoría ilimitada y no ejecuta código arbitrario ni instrucciones en lenguaje natural
que eludan el compilador del Plan. Generar un archivo de importación no otorga a Kauro autoridad sobre un CRM.
<!-- auth: 01 §Purpose and customer promise; 02 §Service modes (columna "Excluded authority"); 02 §6; 16 §What the price includes; 16 §Offer and buyer fit ("not an unlimited consulting retainer") -->

3.6. **Uso de modelos de lenguaje.** Para proponer decisiones acotadas (por ejemplo, el significado de una columna o un posible
duplicado), la Plataforma puede enviar a un modelo de lenguaje alojado en Amazon Bedrock únicamente un contexto minimizado:
estructura, datos agregados, vocabulario semántico aprobado y ejemplos enmascarados autorizados. No se envían registros crudos,
credenciales ni secretos. Las propuestas del modelo nunca se ejecutan por sí solas: el Cliente decide, y solo el motor
determinista ejecuta operaciones soportadas y validadas.
<!-- auth: 06 §Privacy classes and minimization (L0–L4); 08 §Model boundary; 01 CH-002; amendments/A9_CLOUD_AWS.md §3 (Bedrock) y §4 -->

3.7. **Lo que decide el Cliente.** Las decisiones semánticas que no se pueden establecer a partir de los hechos de origen y de
destino (por ejemplo, si dos personas parecidas deben unificarse o si un valor debe borrarse) son del Cliente. Un candidato a
duplicado no es una unificación confirmada; Kauro unifica duplicados solo con la aprobación del Cliente y nada se elimina sin
dejar rastro.
<!-- auth: 02 §What remains human; 02 §5; A3 §3.3 -->

3.8. **Estado de disponibilidad.** Kauro opera inicialmente en disponibilidad limitada, dentro de un envoltorio técnico calificado
y de límites publicados (archivos, tamaño, filas, columnas, expansión de archivos comprimidos y concurrencia). Un límite que la
Plataforma no publica no está ofrecido.
<!-- auth: 02 §Capability publication contract (AVAILABLE_LIMITED); 02 §Intake and project boundaries; 09 §Initial intake envelope -->

## 4. Cuentas, usuarios y seguridad de acceso

4.1. El Cliente se registra mediante un proceso explícito de membresía. La similitud de nombre o de dominio de correo nunca
otorga membresía. El primer administrador del Cliente suministra la información de facturación y contractual, acepta las
versiones vigentes de los documentos del contrato y confirma su autoridad para tratar los datos de su Cliente Final o de su
propia empresa.
<!-- auth: 02 §2 Establish agency authority; 11 §Agency onboarding -->

4.2. Para acceder a datos, cada Usuario autorizado debe tener correo verificado y segundo factor de autenticación (MFA)
activado. Las acciones de alto impacto (transferencia de titularidad, cambio de destino de pagos, concesiones privilegiadas,
decisiones destructivas) exigen reautenticación reciente.
<!-- auth: 08 §Authentication and assurance -->

4.3. El Cliente es responsable de: las personas que invita y los roles que asigna; revocar el acceso de quien deje de trabajar
con él; mantener la confidencialidad de sus credenciales y factores; y avisar a Kauro sin demora si sospecha un acceso no
autorizado. Kauro nunca pide contraseñas, códigos de recuperación ni semillas de MFA por correo o chat.
<!-- auth: 08 §Authentication and assurance (último párrafo); 11 §Billing, team, settings and help -->

4.4. Un usuario que pertenece a varios Clientes elige activamente el Cliente con el que trabaja; los datos siguen el contexto
seleccionado.
<!-- auth: 02 §2; 11 §Agency onboarding -->

## 5. Autoridad sobre los datos, uso aceptable y datos prohibidos

5.1. **Declaración de autoridad.** El Cliente declara y garantiza que (a) tiene la autoridad necesaria para cargar y hacer
tratar los Archivos y para tomar las decisiones semánticas que el servicio requiere; (b) cuando actúa por cuenta de un Cliente
Final, cuenta con las instrucciones y autorizaciones de ese Cliente Final; y (c) la recolección de los datos y su entrega a Kauro
cumplen la ley aplicable al Cliente y al Cliente Final, incluidas las autorizaciones de los titulares cuando la ley las exige.
Esta declaración no exime a Kauro de sus propias obligaciones.
<!-- auth: 19 §Service terms: required operative content (segundo párrafo); 17 Ley 1581 deberes del responsable (law: C-12) -->

5.2. **Datos prohibidos.** El Cliente no cargará: credenciales o secretos de autenticación; datos completos de tarjetas de pago;
datos de salud regulados; datos sensibles en el sentido del artículo 5 de la Ley 1581 de 2012 o "sensitive personal information"
de las leyes estatales de EE. UU.; datos de niños, niñas y adolescentes; ni otras categorías cuyas obligaciones o requisitos de
seguridad excedan el servicio calificado. Un campo de "notas" puede contener información sensible: el Cliente debe revisarlo o
excluirlo antes de cargar.
<!-- auth: 19 §Data categories and excluded use; 02 §1 (no se aceptan adjuntos de CRM en el formulario) -->

5.3. **Hallazgo de datos prohibidos.** Si se detecta material prohibido, Kauro puede poner en cuarentena o pausar el alcance
afectado, minimizar el acceso, avisar al contacto autorizado del Cliente y aplicar el procedimiento de eliminación o de
incidente. Kauro no copiará ese material en un ticket de soporte ni en una consulta a un modelo.
<!-- auth: 19 §Data categories and excluded use (último párrafo) -->

5.4. **Instrucciones fuera de alcance.** Kauro puede pedir evidencia, o suspender el tratamiento afectado, si una instrucción
parece ilícita o fuera del alcance contratado (por ejemplo, conservar datos indefinidamente o enviar registros crudos a un
modelo no aprobado).
<!-- auth: 19 §Service terms: required operative content; 19 §Data processing agreement (tercer párrafo) -->

5.5. **Datos sujetos a leyes de otras jurisdicciones.** El servicio inicial se ofrece para clientes y datos cuyo tratamiento se
rige por la ley colombiana y por leyes de Estados Unidos; de las leyes estatales de privacidad, Kauro solo ha verificado las de
California, Virginia y Colorado, y un proyecto sujeto a otra se acepta solo según la sección 14.1 del DPA. Kauro no ofrece en esta versión los instrumentos de transferencia del
Reglamento General de Protección de Datos de la Unión Europea ni del Reino Unido. Si los Archivos contienen datos cuyo
tratamiento esté sujeto a esas normas, el Cliente debe informarlo antes de cargarlos para que Kauro evalúe si puede admitir el
proyecto; sin esa evaluación, no deben cargarse.
<!-- auth: 02 §Buyer, user and job to be done ("Expansion to other markets is a capability change with legal and support consequences"); 19 §Data processing agreement (último párrafo, GDPR depende de roles y geografía) · resolución de silencio: ver CHECKLIST §Silencios S-06 -->

5.6. **Uso aceptable.** El Cliente no intentará acceder a datos de otros clientes, eludir límites de carga, de revisión gratuita
o de seguridad, cargar contenido activo o malicioso, ni usar la Plataforma para actividades ilícitas. Kauro aplica límites de
tasa y de recursos y puede suspender el abuso conforme a la sección 19.
<!-- auth: 08 §Abuse controls; 08 §Quarantine and malware boundaries -->

## 6. Cotización, Pedido y aceptación electrónica

6.1. **Cotización.** El servidor calcula la Cotización con las Unidades facturables admitidas, el modo, el nivel de recurrencia y
el descuento válido. La Cotización registra versión de precios, evidencia de cantidad, descuento aplicado, tratamiento
tributario, emisor, huellas de origen, plan y destino, vencimiento del precio y la fecha hasta la cual los datos estarán
disponibles. Una Cotización emitida no cambia; una corrección material crea una Cotización sustituta con comparación visible.
<!-- auth: 16 §Quote calculation; 02 §7 Quote and purchase -->

6.2. **Vigencia.** El precio de una Cotización vence a los catorce (14) días. La disponibilidad de los datos se muestra por
separado y puede terminar antes. No se puede pagar ni ejecutar una Cotización sobre datos ya eliminados; en ese caso el Cliente
vuelve a cargar los Archivos y obtiene una Revisión validada compatible o una nueva Cotización.
<!-- auth: 09 §Quotes, reuploads and retention; 02 §7 -->

6.3. **Formación del contrato.** La Cotización publicada en la Plataforma es una oferta mercantil de Kauro. El Pedido se forma
cuando el Cliente acepta la Cotización en la Plataforma (aprobación del Plan vigente y confirmación de compra) dentro de su
vigencia. La aceptación se hace por medios electrónicos y tiene plena validez; Kauro conserva un registro durable de la versión
de cada documento aceptado, de la identidad del Usuario autorizado, de la fecha y de la Cotización. Ningún cambio posterior del
sitio web modifica un Pedido existente.
<!-- auth: 19 §Customer instrument hierarchy ("durable record"; "A later website edit does not silently amend an existing order") · law: C-30..C-34 (Ley 527 arts. 5, 14, 15; C. Co. arts. 824, 845, 864; Decreto 2364 de 2012) -->

6.4. **Requisitos de compra.** Para comprar se requieren una aprobación vigente del Plan, datos disponibles, capacidad de
procesamiento financiada, identidad de facturación, la declaración del tipo de comprador de la sección 25.1 y un medio de pago
utilizable.
<!-- auth: 02 §7 · law: C-37 · CHECKLIST A-05 -->

6.5. **Cambios de alcance.** Un nuevo alcance requiere un nuevo Pedido o una enmienda aceptada. Por defecto se permite un único
reemplazo de origen antes de la ejecución, previa revalidación, si no ha empezado ninguna ejecución pagada y el nuevo alcance
queda en la misma banda. Corregir un defecto de Kauro nunca se convierte en una compra nueva no informada.
<!-- auth: 16 §Scope changes and credits; 19 §Service terms: required operative content -->

## 7. Precios, descuentos e impuestos

7.1. **Unidad de precio.** El precio depende del modo y de la banda de Unidades facturables. Se cuentan las ocurrencias de
objetos admitidos bajo la proyección sellada antes de la deduplicación aprobada; no se cuentan filas físicas de salida ni la
multiplicación de relaciones. Kauro no puede cambiar la interpretación después del pago para alcanzar una banda superior. Cero
unidades elegibles no generan una venta de precio mínimo.
<!-- auth: 16 §Billable unit and fairness; 16 §Price schedule -->

7.2. **Tarifa.** Para Clientes que no son consumidores, los precios de referencia vigentes figuran en el Anexo A y en la página de
precios; toda cifra mostrada antes de la Cotización es una banda indicativa y el precio que obliga es el de la Cotización emitida
sobre el alcance sellado. Para un Cliente que sea consumidor rige la sección 7.7, que prevalece sobre este párrafo.
<!-- auth: A3 §3.4; 16 §Price schedule -->

7.3. **Descuentos.** (a) Descuento por recurrencia, calculado al emitir la Cotización sobre los proyectos calificados del Cliente
en los 365 días anteriores: 5 % con 1 a 9 proyectos previos, 10 % con 10 a 24 y 15 % con 25 o más. (b) Descuento fundador del
25 % en el primer proyecto elegible de cada uno de los tres primeros clientes fundadores aceptados (agencias o Clientes Internos),
solo mientras pueda reservarse un cupo; el cupo se reserva al emitir la Cotización con descuento fundador y vence con ella. (c)
Los descuentos no se acumulan: se aplica el mayor elegible. Un reembolso posterior de un proyecto previo afecta Cotizaciones
futuras, no un Pedido ya aceptado.
<!-- auth: 16 §Recurrence decision; 16 §Founding incentive (enmendado por A3 §4.5); A3 §3.4, §3.5 punto 3, §3.7 (cupos fundadores abiertos a Clientes Internos) -->

7.4. **Moneda.** Los precios para clientes fuera de Colombia se expresan y cobran en dólares de los Estados Unidos (USD). A los
clientes extranjeros no se les muestran pesos colombianos. Los clientes colombianos pagan en pesos colombianos por la ruta que
Kauro indique en su Cotización, separada del cobro internacional en USD. A un consumidor siempre se le informa y se le cobra el
precio en pesos colombianos (sección 7.7).
<!-- auth: amendments/A8_PAYMENT_ROUTING.md §2 regla 6; 16 §Price schedule (USD) -->

7.5. **Impuestos.** Los precios de la tarifa del Anexo A, para Clientes que no son consumidores, no incluyen impuestos. La
Cotización muestra, antes del pago, los impuestos que
correspondan según el tratamiento tributario validado para esa operación, y el total. Kauro emite la factura electrónica de venta
conforme a la regulación de la DIAN. Si una retención en la fuente es legalmente exigible al Cliente, este la practica y entrega
el certificado correspondiente.
<!-- auth: 15 §Money vocabulary; 15 §FiscalProfile; 16 §Quote calculation; 01 CH-007 · law: C-40, C-41 -->

7.6. **Lo que incluye el precio.** Las transformaciones deterministas aprobadas, el informe de excepciones dentro del envoltorio
admitido, la verificación del Paquete, el informe con la marca del Cliente según las opciones soportadas, la guía de destino, la
continuación por etapas necesaria para la estrategia de relaciones comprada y la corrección de defectos verificados de Kauro.
Una importación por etapas, con su acción adicional y su ventana de conservación, se informa antes de la compra y no genera un
segundo cobro por el solo hecho de que los identificadores de destino aparezcan después de una etapa anterior.
<!-- auth: 16 §What the price includes -->

7.7. **Precios para consumidores.** A un Cliente que sea consumidor (sección 25.1), todo precio que Kauro le informe o anuncie
—en la página de precios, en ejemplos, en la Plataforma y en la Cotización— se le muestra visualmente, junto a la descripción del
servicio, como **precio total en pesos colombianos que incluye el IVA cuando aplique y todos los demás impuestos y costos
adicionales** que deba pagar, con el impuesto que calcule el proveedor de facturación electrónica de Kauro para esa operación.
La página de precios muestra esos totales, o una pestaña para consumidores claramente identificada que los muestra para cada
banda. Ninguna cifra indicativa sin impuestos o en dólares es el único precio que ve un consumidor, y la Cotización muestra el
mismo total. El precio informado coincide con el cobrado; si aparecen dos precios, el consumidor paga el menor.
<!-- law: C-37b (Ley 1480 de 2011 art. 26; SIC Circular Única, Título II, numerales 2.3 y 2.3.1) · CHECKLIST A-18 · ver LAWYER_LATER L-07 (tarifa y exenciones de IVA) -->

## 8. Pagos

8.1. **Medios de pago.** Kauro trabaja por proyecto: no hay suscripciones ni cargos recurrentes automáticos. Para clientes de
Estados Unidos, la Plataforma ofrece, cuando están habilitados:
- **Transferencia bancaria en EE. UU. / ACH**, recibida en la cuenta empresarial de Kauro en Wise, con una referencia única por
  Pedido. Esta opción solo se muestra mientras está habilitada; Kauro puede no ofrecerla.
- **PayPal / tarjeta**, mediante PayPal Business.

Un Cliente que paga mediante una plataforma de cuentas por pagar paga a los datos bancarios que Kauro haya indicado para ese
Pedido. Kauro no está integrado con esas plataformas.
<!-- auth: amendments/A8_PAYMENT_ROUTING.md §1 y §2 (reglas 2, 3, 4, 5); 15 §Initial payment decision -->

8.2. **Cuándo un Pedido está pagado.** Una página de retorno del proveedor no prueba el pago. Un Pedido está pagado solo cuando
Kauro confirma la captura con el proveedor (PayPal) o concilia un crédito entrante por el **monto exacto y en la moneda** del
Pedido (ACH). Los cargos que cobre el banco o la plataforma del Cliente por enviar el pago corren por cuenta del Cliente; las
comisiones de recepción y de procesamiento del lado de Kauro corren por cuenta de Kauro y no se suman al total.
<!-- auth: 02 §7 ("Payment return pages do not assert payment success"); A8 §3 ("the order paid only on a reconciled credit of the exact amount and currency"); 15 §Money vocabulary ("only explicitly disclosed permitted charges"); 15 §Fee reference and example · resolución de silencio S-09 -->

8.3. **Sin doble cobro.** Una falla en la comunicación con el proveedor no produce un segundo cobro; los pagos inciertos se
concilian antes de cualquier reintento.
<!-- auth: 01 CH-007; 15 §Webhooks and reconciliation -->

8.4. **Datos bancarios de Kauro.** Kauro solo comunica sus datos bancarios dentro de la Plataforma o desde su dominio
verificado. Si el Cliente recibe un cambio de datos bancarios por otro medio, debe confirmarlo en la Plataforma antes de pagar.
<!-- auth: 15 §Settlement and withdrawal (cambio de destino de pago con verificación); 08 §Authentication and assurance -->

8.5. **Disputas y contracargos.** Si el Cliente abre una disputa o contracargo, Kauro responde con evidencia veraz y limitada al
servicio disputado (términos aceptados, Cotización, aprobación, pago, disponibilidad y descarga del Paquete, historial de
soporte), sin aportar registros del CRM. Una reversión puede revocar la autoridad de nuevas ejecuciones del Pedido afectado.
<!-- auth: 15 §Disputes and chargebacks -->

## 9. Ejecución, entrega e importación

9.1. El trabajo autorizado usa entradas inmutables. La salida provisional permanece privada hasta que el verificador final, la
conciliación de linaje, la nueva verificación de autorización y la publicación tienen éxito. Un intento cancelado o reemplazado no
publica.
<!-- auth: 02 §8 Execute and deliver -->

9.2. El Cliente recibe un Paquete con informe para humanos, manifiesto legible por máquina e instrucciones específicas del
destino. La Plataforma distingue paquete preparado, descargable, descargado e importación reportada por el Cliente. Kauro nunca
marca un proyecto como importado solo porque se descargó un archivo.
<!-- auth: 02 §8 -->

9.3. **La importación es del Cliente.** El Cliente ejecuta la importación documentada en su propio entorno de destino autorizado
y es responsable de ella. En importaciones por etapas, el Cliente entrega en la Plataforma los comprobantes de resultado
definidos y recibe la siguiente etapa verificada. Un archivo arbitrario de "éxito" no es prueba.
<!-- auth: 02 §9 Verify target import and handle issues; 19 §Service terms ("agency's responsibility for final CRM import") -->

9.4. **Cambios del destino.** Un cambio del destino después del pago pausa la ejecución que depende de él; el Cliente recibe el
impacto y sus opciones. Un cobro adicional solo procede con un nuevo alcance aceptado.
<!-- auth: 15 §Price and source expiry races -->

9.5. **Marca del Cliente.** El Cliente puede poner su marca en el informe y omitir la publicidad de Kauro, pero no puede editarlo
para afirmar una certificación, garantía o importación que no ocurrió.
<!-- auth: 13 §Branding and white label -->

## 10. Cancelación y reembolsos

10.1. **Antes del inicio del procesamiento pagado.** El Cliente puede cancelar un Pedido pagado antes de que empiece su
procesamiento y recibe el reembolso del valor pagado. Las comisiones del proveedor de pagos que no se recuperen son costo de Kauro.
<!-- auth: 15 §Refund policy and calculation (segundo párrafo) -->

10.2. **Después del inicio del procesamiento.** La cancelación detiene el trabajo futuro y bloquea nuevas publicaciones, pero no
puede deshacer trabajo ya transmitido ni una importación que el Cliente ya haya hecho. Kauro evalúa de buena fe la solicitud según
la fase registrada y, cuando proceda, abona el valor a una nueva Revisión o lo reembolsa, y explica por escrito su decisión. Kauro
no impone penalidades que no estén en estos Términos. Si el Cliente es consumidor, sus derechos legales de la sección 25
(retracto, entrega y reversión del pago) prevalecen sobre esta evaluación y sobre cualquier abono.
<!-- auth: 19 §Service terms (párrafo de cancelación); 01 CH-005; 15 §Refund policy and calculation ("does not invent a penalty"); 16 §Scope changes and credits ("Prior payment is credited or refunded through the ledger where appropriate") · resolución de silencio S-08 -->

10.3. **Defecto de Kauro.** El remedio por defecto de Kauro se rige por la sección 11.

10.4. **Forma del reembolso.** Los reembolsos se pagan por el mismo medio de pago cuando sea posible (los de ACH, como
transferencia saliente aprobada por Kauro). El total reembolsado nunca excede lo efectivamente capturado menos reembolsos y
reversiones anteriores. Un reembolso parcial identifica el componente del servicio afectado y ajusta el impuesto de forma
coherente, con la nota crédito correspondiente.
<!-- auth: 15 §Refund policy and calculation; A8 §3 ("refunds as outbound transfers under owner approval"); 15 §TaxDocument state machine -->

10.5. **Vencimiento de precio y datos.** Si un pago se confirma después del vencimiento de la Cotización o de la eliminación de
los datos, Kauro respeta el precio solo si el origen, el destino, el tratamiento legal y el alcance siguen siendo válidos; en
caso contrario reembolsa o emite una nueva Cotización a elección del Cliente.
<!-- auth: 15 §Price and source expiry races -->

## 11. Defectos y remedios

11.1. **Qué es un defecto de Kauro.** Un incumplimiento material del Paquete frente al Plan aprobado, al Contrato de Destino o al
perfil soportado, imputable a Kauro. No son defectos de Kauro, por sí mismos: errores del origen, ediciones del Cliente, cambios
del destino o configuraciones de herramientas de terceros; Kauro los distingue con evidencia y sin culpar automáticamente al
Cliente.
<!-- auth: 19 §Service terms (párrafo del remedio); 02 §9 (clasificación de fallas) -->

11.2. **Plazo para reclamar.** El Cliente puede reportar un defecto dentro de los **treinta (30) días** siguientes a la
Finalización del servicio. Como los datos se conservan por menos tiempo (sección 13), un reclamo posterior a la eliminación puede
exigir volver a cargar exactamente el mismo origen y la evidencia; la Plataforma lo explica. Los proyectos por etapas usan los
hitos informados antes de la compra.
<!-- auth: 18 §Support coverage and service targets; registry/policy.json support.defectReportDays = 30; 11 §Billing, team, settings and help -->

11.3. **Remedio.** Para un defecto material verificado de Kauro, el remedio principal es investigar y reparar o regenerar el
Paquete, con un objetivo inicial de **cinco (5) días hábiles**. Si la reparación no es razonable o no es posible, Kauro reembolsa
el valor del proyecto afectado en lo que corresponda. Esto no limita los derechos que la ley no permite excluir; para un Cliente
que sea consumidor, el remedio lo elige él según la sección 25.9.
<!-- auth: 18 §Support coverage and service targets; registry/policy.json support.defectRepairTargetBusinessDays = 5; 15 §Refund policy and calculation (tercer párrafo); 19 §Service terms ("preserves rights that cannot legally be excluded") -->

## 12. Soporte

12.1. El soporte humano es por escrito, de lunes a viernes de 09:00 a 17:00 hora de Bogotá (America/Bogota), excluidos los
festivos aplicables. El acuse de recibo es automático y el objetivo de respuesta humana es el siguiente día hábil. Kauro no ofrece
soporte atendido 24/7.
<!-- auth: 18 §Support coverage and service targets; registry/policy.json support -->

12.2. El Cliente nunca debe enviar su exportación de CRM por correo. Las solicitudes de soporte se refieren a identificadores
de proyecto y de artefacto. Si Kauro necesita ver registros, lo hace dentro de la Plataforma mediante un acceso de soporte
específico para el caso: con propósito, proyecto y operaciones definidos, aprobación, duración máxima de treinta (30) minutos,
lectura por defecto, registro de auditoría y, cuando corresponda, consentimiento del Cliente.
<!-- auth: 02 §9; 08 §Support access and break-glass; registry/policy.json retention.breakglassSeconds = 1800 -->

12.3. El Cliente puede tener una llamada opcional con un vendedor de habla inglesa, pero no está obligado a ella para comprar.
<!-- auth: 02 §1 Discover and qualify fit; 11 §Billing, team, settings and help -->

## 13. Conservación, devolución y eliminación de datos

13.1. **Calendario.** Kauro conserva los datos del Cliente durante los periodos siguientes ("día" significa periodo de 24 horas):

| Clase | Disponibilidad ordinaria | Límite máximo |
|---|---|---|
| Carga incompleta y cuarentena | Hasta que termina la inspección o vence la reserva | 24 horas desde el inicio de la carga |
| Origen y derivados del Free data health check (sin pago) | 7 días después de que el resultado esté listo o de la falla terminal | 14 días desde el sellado |
| Origen y entrega de un proyecto pagado ordinario | 7 días después de que el primer Paquete esté disponible | 14 días desde la confirmación del pago |
| Origen y artefactos de una importación por etapas | Hasta el fin de la ventana por etapas y luego hasta 7 días para la entrega final | 21 días desde la primera etapa y nunca más de 30 días desde la confirmación del pago |
| Comprobantes de importación | 7 días desde que su verificación termina | Dentro del límite del proyecto por etapas cuando se necesitan para continuar |
| Esquema de destino y configuración reutilizable | Hasta 180 días desde la última confirmación o uso | Vigencia ejecutable máxima de 30 días; se invalida ante un cambio material del destino |
| Contexto minimizado enviado al modelo | Durante la revisión activa y su breve ventana de evidencia | Se elimina con los datos del proyecto |
| Registros de aplicación | 30 días | Sin contenido de CRM ni secretos |
| Evidencia mínima de seguridad | 180 días | Sin contenido de CRM |
| Registros financieros y legales | El plazo legal aplicable | Separados, sin contenido de CRM |
<!-- auth: 09 §Retention schedule; registry/policy.json retention -->

13.2. **Extensión.** Se permite una sola extensión de un plazo blando por proyecto, de hasta setenta y dos (72) horas, solicitada
por un usuario autorizado antes de que venza, con propósito indicado; nunca supera los límites máximos. Abrir un informe,
contactar soporte o recibir recordatorios no extiende la conservación.
<!-- auth: 09 §Quotes, reuploads and retention; registry/policy.json retention.softExtensionsPerProject = 1, softExtensionMaximumSeconds = 259200, extendHardCap = false -->

13.3. **Devolución o eliminación a elección del responsable.** Al terminar la prestación del servicio, o antes cuando lo pida,
el Cliente (por su propia cuenta o por instrucción de su Cliente Final) elige si Kauro le **devuelve** o **elimina** todos los
datos personales de los Datos del Cliente que Kauro todavía conserve: los Archivos de origen aceptados, los Paquetes y los demás
derivados que contengan datos personales (perfiles, excepciones, linaje, comprobantes de importación). La devolución se hace por
descarga segura dentro de la Plataforma antes de la eliminación; después, Kauro elimina y entrega el comprobante de la sección
13.4. Si el Cliente no elige, se aplica el calendario de la sección 13.1, que elimina los datos en plazos cortos; la Plataforma
avisa la fecha de eliminación para que el Cliente pueda descargar antes. Lo que la ley obligue a conservar se conserva solo para
ese fin. Cada enlace de descarga firmado vence a los quince (15) minutos.
<!-- auth: 09 §Notifications and customer action; 09 §Early deletion; 09 §Deletion receipts and restoration; 19 §Data processing agreement ("return/deletion"); registry/policy.json retention.signedDownloadSeconds = 900 · law: C-65 (Va. Code §59.1-579 B.2), C-66 (C.R.S. 6-1-1305(5)(d)(I), texto 2026) · resolución S-11 (r2) · CHECKLIST A-15 -->

13.4. **Eliminación anticipada.** El Cliente puede pedir la eliminación anticipada de un proyecto o de un alcance. Kauro bloquea
primero nuevas cargas, envíos al modelo, procesamientos, publicaciones y descargas, cancela los intentos activos y elimina todas
las generaciones registradas (cuarentena, aceptados, derivados, provisionales, entregas, comprobantes y copias de soporte),
comparándolas con el inventario del proveedor. Kauro entrega un comprobante de eliminación para el alcance que controla; no puede
eliminar copias ya descargadas por el Cliente ni importaciones hechas en su CRM. Si una operación del proveedor falla, la
eliminación queda parcial y visible, y se reintenta.
<!-- auth: 09 §Early deletion; 09 §Deletion receipts and restoration -->

13.5. **Copias de respaldo.** Las copias de respaldo de la base de datos contienen metadatos y referencias, no el contenido de
los Archivos. La recuperación de una copia no reactiva descargas ni datos eliminados.
<!-- auth: 14 §Storage configuration ("Domain backups contain metadata and safe references, not source file payload"); 09 §Deletion receipts and restoration -->

## 14. Protección de datos personales

14.1. Respecto de los datos personales contenidos en los Archivos y en sus derivados, el Cliente (o su Cliente Final, según la
cadena registrada) es el responsable del tratamiento y Kauro actúa como **encargado** por cuenta del Cliente, conforme al DPA.
Respecto de los datos de las cuentas, usuarios, facturación y comunicaciones del Cliente con Kauro, Kauro es **responsable** y
los trata según su Política de Tratamiento de Información Personal.
<!-- auth: 19 §Data processing agreement (texto enmendado por A3 §4.7); producto: brief D-08b · law: C-01..C-29 -->

14.2. Kauro no vende ni comparte los datos personales de los Archivos, no los usa para fines propios, no los combina con datos
de otros clientes y no los usa para entrenar modelos. No existe base vectorial, búsqueda entre clientes ni aprendizaje en línea.
<!-- auth: 06 §Scoped memory; 01 CH-006; 09 §Derived data and worker scratch · law: C-60..C-66 -->

## 15. Propiedad intelectual

15.1. **Software de Kauro.** Kauro (o quien le haya licenciado) es titular de la Plataforma, su código, sus modelos de
configuración, sus plantillas genéricas y su documentación. El Cliente recibe un derecho no exclusivo, intransferible y limitado
a la vigencia del contrato para usar la Plataforma en su propia operación.

15.2. **Datos del Cliente.** Kauro no adquiere la propiedad de los Archivos ni de los registros de clientes. El Cliente concede a
Kauro solo la licencia necesaria para prestar el servicio, conforme a las instrucciones del DPA.

15.3. **Entregables.** El Cliente puede usar, modificar y entregar a su Cliente Final los Paquetes e informes generados para él.
La marca, logotipo y colores que el Cliente carga siguen siendo suyos; los usa Kauro solo para generar sus informes. La evidencia
técnica de Kauro dentro del manifiesto conserva su procedencia.

15.4. **Comentarios.** Kauro puede usar las sugerencias generales del Cliente sobre el producto sin obligación de pago, sin
incluir datos del Cliente. Kauro solo usa el nombre, la identidad o testimonios del Cliente con su aprobación escrita del texto
exacto.
<!-- auth: 19 §Service terms (IP distingue software, datos, marca y entregables; "Kauro does not claim ownership of customer records"); 13 §Branding and white label; 18 §Feedback and product improvement -->

## 16. Confidencialidad

16.1. Cada parte protegerá la información no pública de la otra que reciba con ocasión del contrato con, al menos, el cuidado que
aplica a la suya y nunca con un cuidado inferior al razonable; la usará solo para cumplir o ejercer el contrato; y la revelará
solo a su personal, colaboradores y proveedores que la necesiten y estén obligados a reserva equivalente.

16.2. No es información confidencial la que (a) ya era pública sin culpa de quien la recibe; (b) ya la tenía legítimamente quien
la recibe; (c) recibe legítimamente de un tercero sin obligación de reserva; o (d) desarrolla de forma independiente. Una parte
puede revelar información cuando una autoridad competente se lo ordene, avisando antes a la otra si la ley lo permite y limitando
la revelación a lo ordenado.

16.3. Los datos personales de los Archivos se rigen además por el DPA. Esta obligación sobrevive a la terminación mientras la
información conserve su carácter confidencial.
<!-- auth: 19 §Service terms ("Confidentiality covers both parties' nonpublic information with defined permitted uses and exceptions") -->

## 17. Declaraciones del Cliente; alcance de las garantías

17.1. El Cliente declara que la información de facturación y de identidad que suministra es veraz, y que sus Usuarios autorizados
actúan con su autorización.

17.2. Kauro presta el servicio con la diligencia de un profesional del ramo y conforme al Plan aprobado. Kauro no garantiza que
el CRM de destino aceptará siempre la importación cuando el destino cambie o cuando el Cliente modifique archivos o
configuraciones; tampoco garantiza un resultado comercial, un ahorro determinado ni que una revisión gratuita encuentre
problemas. Ninguna disposición de estos Términos excluye derechos irrenunciables del Cliente.
<!-- auth: A3 §3.5 (no se promete ahorro); 01 CH-012; 19 §Service terms (remedio y derechos irrenunciables) · law: C-36, C-37 -->

## 18. Limitación de responsabilidad

18.1. La responsabilidad total de cada parte frente a la otra por todos los reclamos derivados de un Pedido o relacionados con él
se limita al valor efectivamente pagado por el Cliente a Kauro por los Pedidos de los doce (12) meses anteriores al hecho que
origina el reclamo.

18.2. Ninguna parte responde frente a la otra por lucro cesante ni por perjuicios que no se previeron ni pudieron preverse al
celebrar el contrato.

18.3. Los límites anteriores **no aplican** a: (a) dolo o culpa grave; (b) la obligación del Cliente de pagar el precio; (c) los
derechos que la ley no permite limitar; ni (d) la responsabilidad que la ley imponga a cada parte frente a los titulares de los
datos o frente a la autoridad de protección de datos por su propio rol.
<!-- auth: 19 §Service terms ("does not insert a sweeping 'no liability under any circumstances' clause"); 15 §Refund policy · law: C-35 (C.C. arts. 63, 1522, 1616) · ver LAWYER_LATER L-04 · resolución de silencio S-03 -->

## 19. Suspensión y terminación

19.1. **Suspensión.** Kauro puede suspender, con aviso al Cliente y por el alcance mínimo necesario: (a) el tratamiento de una
instrucción aparentemente ilícita o fuera de alcance; (b) el alcance afectado por datos prohibidos; (c) el acceso de un usuario o
cuenta usado para abuso o con riesgo de seguridad; (d) nuevas ejecuciones de un Pedido con pago revertido; o (e) servicios
afectados por un incidente, como medida de contención. La suspensión conserva los caminos legítimos de recuperación, reembolso y
eliminación.
<!-- auth: 19 §Service terms; 19 §Data categories and excluded use; 08 §Abuse controls; 14 §Incident containment; 15 §Disputes and chargebacks -->

19.2. **Terminación por el Cliente.** El Cliente puede cerrar su cuenta en cualquier momento. El cierre detiene nuevos Pedidos y
sigue las obligaciones pendientes de entrega, reembolso, legales y de eliminación. El Cliente puede obtener los registros
permitidos durante el proceso de cierre.

19.3. **Terminación por Kauro.** Kauro puede terminar el contrato con un aviso de treinta (30) días, o de inmediato ante un
incumplimiento grave del Cliente no subsanado dentro de los diez (10) días hábiles siguientes a un aviso escrito. Los Pedidos
pagados y en curso al momento del aviso sin causa se terminan de prestar o se reembolsan.

19.4. **Efectos.** Al terminar, los datos del Cliente se eliminan según la sección 13 y el DPA, y se conservan solo los
registros financieros, legales y de seguridad mínimos, separados y sin contenido de CRM. "Cuenta eliminada" no significa que
desaparezcan las facturas que la ley obliga a conservar. Las secciones 13, 15, 16, 18, 22, 23 y 25 sobreviven.
<!-- auth: 16 §Agency lifecycle ("Closing an agency stops new orders..."); 19 §Rights requests and privacy complaints (último párrafo); 09 §Retention schedule · resolución de silencio S-10 (plazos de aviso de terminación) -->

## 20. Vendedores y comunicaciones

20.1. Kauro puede vender por medio de colaboradores comerciales independientes. Un vendedor no puede prometer funciones, fechas,
precios, soporte ilimitado, conservación permanente ni escrituras en un CRM en vivo, ni obligar a Kauro fuera de la Cotización
emitida por la Plataforma. Los vendedores no reciben los informes con registros de CRM.
<!-- auth: 19 §Customer instrument hierarchy (último párrafo); 02 §1 ("A seller cannot promise a feature or delivery date..."); 13 §Privacy in reports and downloads -->

20.2. Kauro envía al Cliente avisos transaccionales del servicio (cuenta, invitaciones, estado del pago, entrega, avisos de
eliminación, soporte) a los usuarios registrados. Esos avisos no incluyen registros de CRM ni enlaces de descarga firmados; enlazan
a la Plataforma. Las comunicaciones comerciales a los Usuarios autorizados se envían solo a quienes las autorizaron por separado
y por los canales que autorizaron, con las reglas de la sección 17 de la Política de Tratamiento (identificación como
publicidad, consulta del Registro de Números Excluidos para destinatarios en Colombia, horario legal y baja inmediata). Aceptar
estos Términos no implica aceptar publicidad.
<!-- auth: 09 §Notifications and customer action; reference/MESSAGING_AND_SENDER_OPERATIONS.md (Resend, solo transaccional; suppression); 18 §Communication compliance · law: C-50, C-51, C-52 · CHECKLIST A-14 -->

## 21. Cambios a estos Términos

21.1. Cada versión de los documentos del contrato tiene número y fecha de vigencia. Kauro avisará por la Plataforma y por correo
a los administradores del Cliente, con al menos treinta (30) días de anticipación, cualquier cambio material. El cambio rige para
Pedidos posteriores a su aceptación; nunca modifica un Pedido ya aceptado. Si el Cliente no acepta la nueva versión, puede cerrar
su cuenta sin costo antes de que rija.
<!-- auth: 19 §Customer instrument hierarchy ("version and effective date"; "Material changes require notice and acceptance where applicable") -->

## 22. Ley aplicable y solución de controversias

22.1. Estos Términos y cada Pedido se rigen por las leyes de la República de Colombia.

22.2. Las partes intentarán resolver cualquier controversia mediante negociación directa durante treinta (30) días calendario
desde el aviso escrito de una de ellas. Esa etapa no impide pedir medidas urgentes ni presentar una acción antes de que caduque o
prescriba. Si no la resuelven, la controversia se someterá a los jueces competentes conforme a las reglas legales de jurisdicción
y competencia aplicables.

22.3. Nada de lo anterior impide a un titular de datos o a una autoridad ejercer los derechos o competencias que la ley les
otorga, ni al Cliente acudir a la Superintendencia de Industria y Comercio cuando la ley lo permita.
<!-- auth: 19 §Service terms ("Liability limits, exclusions, governing law, forum, dispute procedure and any indemnity require application to the actual operator..."; "no ... invented foreign jurisdiction") · law: C-42 (Código General del Proceso art. 28 num. 3: la estipulación de domicilio contractual para efectos judiciales se tiene por no escrita) · ver LAWYER_LATER L-05 (arbitraje o reconocimiento en EE. UU.) -->

## 23. Notificaciones

23.1. Kauro notifica al Cliente por la Plataforma y al correo del administrador registrado. El Cliente notifica a Kauro en
[correo de notificaciones] o por los canales de la Plataforma. Una notificación por correo se entiende recibida cuando el sistema
de información del destinatario la recibe, salvo prueba en contrario.
<!-- law: C-32 (Ley 527 de 1999, art. 24, tiempo de recepción en el sistema de información designado) -->

23.2. Las notificaciones judiciales a Kauro se dirigen a [domicilio] y a [correo de notificaciones].

## 24. Disposiciones varias

24.1. **Fuerza mayor.** Ninguna parte responde por el incumplimiento causado por fuerza mayor o caso fortuito, siempre que avise
a la otra y mitigue sus efectos; esto no suspende las obligaciones de seguridad ni de eliminación de datos que sigan siendo
posibles.

24.2. **Cesión.** El Cliente no puede ceder el contrato sin consentimiento escrito de Kauro. Kauro puede cederlo a una sociedad
sucesora de su negocio, avisando al Cliente, siempre que el cesionario asuma las obligaciones del DPA.

24.3. **Independencia.** Las partes son contratistas independientes. Nada crea sociedad, agencia comercial ni relación laboral.

24.4. **Idioma.** Estos Términos se redactan en español. Kauro puede ofrecer traducciones; en caso de diferencia prevalece la
versión en español, salvo para el DPA, cuya versión en inglés tiene el mismo valor que la española.

24.5. **Integridad y divisibilidad.** Los documentos de la sección 1.3 son el acuerdo completo entre las partes sobre su objeto.
Si una disposición resulta inválida, las demás conservan su efecto y la inválida se reemplaza por la válida más cercana a su
propósito.

## 25. Clientes que son consumidores

25.1. **Declaración del tipo de comprador.** Antes de pagar, el Cliente declara en la Plataforma si adquiere el servicio para una
necesidad intrínsecamente ligada a su actividad económica (por ejemplo, una agencia que prepara datos para los proyectos de sus
clientes) o como destinatario final para una necesidad que no lo está. Kauro no presume que un Cliente no es consumidor. Si el
Cliente es consumidor según el artículo 5, numeral 3, de la Ley 1480 de 2011, se aplica esta sección cualquiera que haya sido su
declaración, y ninguna otra disposición de estos Términos limita los derechos que esa ley le da.

25.2. **Información antes de comprar.** La Plataforma informa, antes de la compra y en el mismo medio: la identidad de Kauro
(sección 1.1); la descripción del servicio (secciones 3 y 7.6, el Plan y la Cotización); el precio total en pesos colombianos
con todos los impuestos y costos (sección 7.7); los medios de pago; el plazo de prestación del servicio que indica la Cotización; la vigencia de la oferta; y el
derecho de retracto con el procedimiento para ejercerlo. Estos Términos y los demás documentos del contrato pueden consultarse,
imprimirse y descargarse en todo momento, antes y después de la compra.

25.3. **Resumen y aceptación.** Antes de terminar la compra, la Plataforma muestra un resumen del Pedido (servicio, modo, unidades,
precio, impuestos y total) que el Cliente puede corregir o cancelar y descargar. La aceptación es expresa y queda registrada.

25.4. **Acuse de recibo.** A más tardar el día calendario siguiente al Pedido, Kauro envía un acuse de recibo con el plazo de
prestación, el precio exacto con impuestos y la forma de pago.

25.5. **Retracto.** El consumidor puede retractarse dentro de los cinco (5) días hábiles siguientes a la celebración del contrato,
desde la Plataforma o escribiendo a [correo de notificaciones] con la referencia del Pedido. El contrato se resuelve y Kauro
devuelve todo lo pagado, sin descuentos, por el mismo medio de pago o por el que acuerden, dentro de los quince (15) días
calendario siguientes al ejercicio del derecho, una vez el consumidor entregue los datos correctos que se le pidan para hacerlo.
El retracto no procede si la prestación del servicio ya comenzó con el acuerdo del consumidor: por eso, dentro de esos cinco días
Kauro solo empieza el procesamiento pagado si el consumidor lo pide de forma expresa en la Plataforma después de ser informado de
que con ello pierde el retracto; si no lo pide, Kauro espera a que venza el plazo.

25.6. **Plazo de prestación y falta de disponibilidad.** Kauro presta el servicio dentro del plazo aceptado en la Cotización o, si
no se indicó, dentro de los treinta (30) días calendario siguientes al día en que el consumidor hizo el Pedido. Si en cualquier
momento antes de ese plazo Kauro sabe que no podrá prestar el servicio (por ejemplo, por falta de capacidad o porque el alcance
no se puede atender), se lo informa **de inmediato**; el consumidor puede entonces terminar el contrato y recibir la devolución de
todo lo pagado, sin retenciones ni descuentos, dentro de los quince (15) días calendario siguientes, o pedir una segunda fecha. Si
Kauro supera el plazo, el consumidor tiene el mismo derecho de terminar y recibir la devolución en quince (15) días calendario.

25.7. **Reversión del pago.** Se aplica cuando el consumidor pagó por comercio electrónico con tarjeta de crédito, débito u otro
instrumento de pago electrónico y tanto Kauro como el emisor del instrumento están domiciliados en Colombia. Causales: fraude,
operación no solicitada, servicio no recibido, o servicio que no corresponde a lo pedido o es defectuoso. El consumidor presenta
queja a Kauro por la Plataforma, por correo a [correo de notificaciones] o verbalmente, **dentro de los cinco (5) días hábiles
siguientes** a: la fecha en que tuvo noticia de la operación fraudulenta o no solicitada; la fecha en que debió recibir el
servicio (el Paquete, según el plazo de la sección 25.6), si no lo recibió; o la fecha en que lo recibió, si no corresponde a lo
pedido o es defectuoso. La queja indica las razones, la causal, el valor por el que se pide la reversión y el instrumento al que se
cargó la operación. Por cualquier medio que se presente, Kauro entrega de inmediato una constancia descargable con la fecha y la
causal.

Dentro del mismo plazo de cinco (5) días hábiles se notifica al emisor del instrumento de pago, por los canales que el emisor
disponga. Si el consumidor no es el titular del instrumento (por ejemplo, pagó con la tarjeta de otra persona), **esa
notificación la debe presentar el titular del producto financiero**; el consumidor sigue presentando su queja a Kauro. La
notificación al emisor contiene como mínimo: (1) las razones de la solicitud; (2) la causal; (3) el valor; (4) la identificación
de la transacción con su número, fecha y hora, si es el caso; (5) la cuenta, tarjeta o instrumento al que se cargó; y (6) la
constancia de la queja presentada a Kauro. Los participantes del proceso de pago deben tener un formulario de solicitud de
reversión, pero el consumidor puede usar cualquier otro documento que cumpla estos requisitos.

Presentada la solicitud al emisor, los participantes del proceso de pago tienen **quince (15) días hábiles** para hacer efectiva
la reversión. Si la cuenta de Kauro no tiene fondos suficientes y la reversión es parcial, **Kauro reembolsa directamente al
consumidor** el valor o el monto faltante. Si Kauro ya había devuelto el precio directamente y la reversión también procede, el
consumidor devuelve esos recursos a Kauro. Kauro **no vuelve a cobrar ni pide volver a cargar** la transacción mientras la
reversión no esté resuelta: solo si una autoridad jurisdiccional o administrativa determina, mediante decisión **en firme**, que
la reversión no era procedente, y una vez notificada esa decisión, el emisor puede cargar definitivamente la transacción al
consumidor.

25.8. **Peticiones, quejas y reclamos.** La Plataforma ofrece un canal de atención que entrega un número de radicado con la fecha y
la hora de cada petición, queja o reclamo y permite hacerle seguimiento. Si el consumidor reclama de forma verbal o telefónica,
Kauro le entrega constancia escrita con la fecha y el objeto del reclamo. Kauro responde cada reclamación directa **dentro de los
quince (15) días hábiles** siguientes a su recepción, con las pruebas en que se basa. El sitio y la Plataforma muestran un enlace
visible a la Superintendencia de Industria y Comercio (www.sic.gov.co).

25.9. **Garantía y remedios.** Si Kauro incumple la prestación del servicio, el consumidor **elige** entre que se le preste el
servicio en las condiciones contratadas o que se le devuelva el precio pagado; la sección 11 (remedio a elección de Kauro) no se le
aplica en lo que reduzca esa elección. Ninguna disposición de las secciones 10 y 11 limita los derechos de esta sección ni los
demás derechos irrenunciables del consumidor.
<!-- law: C-36, C-37 (Ley 1480 de 2011 arts. 5 num. 3, 7, 11 num. 3, 46, 47 —modificado por la Ley 2439 de 2024—, 50 —literales b, g y h modificados por la Ley 2439 de 2024—, 51 y 58 num. 5 lit. b y c; Decreto 1074 de 2015 arts. 2.2.2.51.1, 2.2.2.51.2, 2.2.2.51.4 a 2.2.2.51.10 y 2.2.2.51.12) · auth: A3 §3.7 (Clientes Internos admitidos); 02 §7 Quote and purchase · CHECKLIST A-05 · resolución S-23 -->

## Anexo A. Tarifa de referencia para Clientes que no son consumidores (USD, antes de impuestos)

Esta tabla **no es un precio para consumidores**: a un consumidor se le informa el total en pesos colombianos con impuestos
incluidos (sección 7.7). Aplica solo a los modos que la Plataforma muestre como disponibles al emitir la Cotización. Las bandas superiores a 500.000
unidades no están disponibles hasta que se acepte el envoltorio mayor.

| Unidades facturables | CLEAN | HUBSPOT | SALESFORCE |
|---|---:|---:|---:|
| 1–50.000 | 695 | 1.295 | 1.495 |
| 50.001–150.000 | 1.095 | 1.995 | 2.295 |
| 150.001–500.000 | 1.795 | 2.995 | 3.495 |
| 500.001–1.000.000 | No disponible | No disponible | No disponible |

Ejemplo de cálculo: HUBSPOT con 50.000 unidades cuesta USD 1.295; con 50.001 unidades, USD 1.995. Con descuento de recurrencia
del 5 %, la primera banda queda en USD 1.230,25 antes de impuestos.
<!-- auth: 16 §Price schedule; 16 §Quote calculation; A3 §3.4 -->
