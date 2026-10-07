<!--
D-08b · Acuerdo de Encargo de Tratamiento de Datos Personales (DPA), versión en español. La versión en inglés es DPA_EN.md y
ambas tienen el mismo valor (Términos §24.4). Borrador del constructor sin abogado (decisión D-08b, opción 1).
Trazabilidad: `auth:` = authority/r2; `law:` = fila de CHECKLIST.md. Marcadores admitidos: [NIT], [domicilio],
[correo de notificaciones], [fecha de vigencia], [teléfono] (ver LAWYER_LATER F-05).
-->

# Acuerdo de Encargo de Tratamiento de Datos Personales (DPA)

**Versión:** 1.0 · **Vigente desde:** [fecha de vigencia]

Este Acuerdo forma parte de los Términos de Servicio de Kauro (los "Términos") y lo aceptan electrónicamente el Cliente y
**Kauro Data S.A.S.**, NIT [NIT], domicilio [domicilio], correo [correo de notificaciones] ("Kauro"). Los términos con mayúscula
no definidos aquí tienen el significado de los Términos.

Este Acuerdo es el **contrato de transmisión de datos personales** del artículo 2.2.2.25.5.2 del Decreto 1074 de 2015 (antes
artículo 25 del Decreto 1377 de 2013) y, para los Clientes sujetos a las leyes de privacidad de California, Virginia o Colorado, el
contrato
de "service provider" o "processor" que esas leyes exigen (sección 14).
<!-- law: C-20, C-21, C-60..C-66 -->

## 1. Roles y cadena de tratamiento

1.1. **Kauro es encargado.** Respecto de los datos personales contenidos en los Archivos que el Cliente carga y en todo lo que se
derive de ellos (perfiles, índices de duplicados, linaje, excepciones, contexto minimizado, Paquetes, informes y comprobantes de
importación) (los "Datos del Cliente"), Kauro actúa como encargado del tratamiento ("processor" / "service provider") y trata los
datos solo por cuenta del Cliente.
<!-- auth: 19 §Data processing agreement; 09 §Derived data and worker scratch (los derivados heredan la clase del origen) -->

1.2. **Cadena registrada.** Al crear cada cliente final y cada proyecto, el Cliente registra en la Plataforma la cadena de
roles aplicable:
- **Cadena agencia–cliente final:** el Cliente Final es el responsable (controller) de los datos de su CRM, el Cliente (agencia)
  actúa como su encargado y Kauro es subencargado del Cliente. El Cliente garantiza que su contrato con el Cliente Final le
  permite contratar a Kauro como subencargado en los términos de este Acuerdo, incluidos los subencargados del Anexo III y las
  transmisiones de la sección 10.
- **Cadena de dos partes:** cuando el Cliente es responsable de los datos (Cliente Interno que trata datos de su propia empresa,
  o agencia que trata sus propios datos de negocio), el Cliente es el responsable y Kauro su encargado.

Kauro no presume que el Cliente es dueño de todos los datos. Una casilla genérica de "soy el responsable" no basta: la Plataforma
registra la autoridad del Cliente sobre los datos de cada cliente final (referencia de autoridad de tratamiento).
<!-- auth: 19 §Data processing agreement (enmendado por A3 §4.7); A3 §3.7 ("EndClient.processingAuthorityRef"); registry/additional_scenarios.json R2-111 "Agency processor chain" -->

1.3. **Kauro es responsable de sus propios datos.** Los datos de las cuentas y usuarios del Cliente, facturación, pagos,
soporte, seguridad y comunicaciones con Kauro no son Datos del Cliente: Kauro los trata como responsable según su Política de
Tratamiento de Información Personal.
<!-- producto: brief D-08b (Kauro responsable de su cuenta y usuarios) -->

## 2. Descripción del tratamiento (Anexo I)

El objeto, la naturaleza, la finalidad, los tipos de datos, las categorías de titulares y la duración del tratamiento se
describen en el Anexo I, que forma parte de las instrucciones documentadas del Cliente.

## 3. Instrucciones del Cliente

3.1. Kauro trata los Datos del Cliente únicamente según las instrucciones documentadas del Cliente. Constituyen instrucciones:
(a) este Acuerdo y los Términos; (b) cada carga, selección de hojas, sellado, aprobación de Plan, decisión semántica, compra,
descarga, comprobante de importación, extensión, solicitud de eliminación y concesión de acceso de soporte que un Usuario
autorizado haga en la Plataforma; y (c) las instrucciones escritas adicionales que Kauro acepte.
<!-- auth: 19 §Data processing agreement ("Kauro processes only documented instructions"); 02 §4–§10; 08 §Support access and break-glass -->

3.2. Kauro avisará al Cliente si considera que una instrucción infringe la ley aplicable o excede el servicio calificado, y podrá
suspender su ejecución mientras se aclara. Kauro rechazará o someterá a revisión separada las instrucciones de conservar datos
indefinidamente, tratar datos sensibles no soportados o enviar registros crudos a un modelo no aprobado.
<!-- auth: 19 §Data processing agreement (tercer párrafo); 19 §Service terms (segundo párrafo) -->

3.3. **Usos prohibidos para Kauro.** Kauro no: (a) vende ni comparte ("sell" o "share") los Datos del Cliente; (b) los conserva,
usa o revela para un fin distinto de las finalidades del Anexo I; (c) los conserva, usa o revela fuera de la relación comercial
directa con el Cliente; (d) los combina con datos personales recibidos de otros clientes o de su propia interacción con los
titulares; (e) los usa para entrenar o mejorar modelos de lenguaje; (f) los usa para contactar, perfilar o vender a los
titulares ni al Cliente Final.
<!-- law: C-61, C-62 (Cal. Civ. Code §1798.140(ag)(1)(A)–(D); 11 CCR §7051(a)(1)–(4)) · auth: 06 §Scoped memory ("no vector database, cross-tenant RAG or silent online learning"); 16 §Offer and buyer fit (Kauro no contacta al cliente final); A3 §3.7 -->

3.4. **Derivados sintéticos no personales.** Kauro no crea a partir de los Datos del Cliente casos de evaluación, reglas globales
ni otros derivados, salvo que el Cliente lo autorice por escrito para un proyecto concreto. Aun con esa autorización, el derivado
debe haber sido despojado de todo dato personal y de todo dato confidencial del Cliente, se revisa antes de usarse y no permite
reidentificar a nadie. Sin autorización, Kauro solo conserva las reglas no personales que ya existían o que se construyen con
datos sintéticos.
<!-- auth: 06 §Scoped memory ("Rejected or corrected suggestions can inform a separately reviewed synthetic evaluation case after customer data is removed"); 09 §Retention schedule (fila "Minimized model context": "unless a non-personal synthetic derivative is separately approved") · resolución de silencio S-12 -->

## 4. Obligaciones del Cliente

El Cliente: (a) solo entrega a Kauro datos cuyo tratamiento esté autorizado conforme a la ley que le aplica a él y al Cliente
Final; (b) garantiza que los datos son veraces y actualizados en lo que de él dependa y comunica oportunamente a Kauro las
novedades, rectificaciones y supresiones que deban reflejarse; (c) no carga las categorías prohibidas de la sección 5.2 de los
Términos; (d) responde las consultas y reclamos de los titulares como responsable, o los traslada al Cliente Final; (e) informa a
los titulares lo que la ley le exija sobre el uso de encargados; y (f) exige a Kauro el respeto de las condiciones de seguridad y
privacidad.
<!-- law: C-12 (Ley 1581 art. 17 literales e, f, g, h, i); auth: 19 §Data categories and excluded use -->

## 5. Obligaciones de Kauro

Kauro, como encargado: (a) trata los Datos del Cliente a nombre del Cliente conforme a los principios de la Ley 1581 de 2012
(legalidad, finalidad, libertad, veracidad, transparencia, acceso y circulación restringida, seguridad y confidencialidad) y a la
política de tratamiento del responsable, en lo que sea aplicable al encargo; (b) salvaguarda la seguridad de las bases de datos
con las medidas del Anexo II; (c) guarda confidencialidad; (d) realiza oportunamente las actualizaciones, rectificaciones o
supresiones que el Cliente le instruya y actualiza la información que el Cliente reporte dentro de los cinco (5) días hábiles
siguientes a su recibo; (e) permite el acceso solo a las personas autorizadas; (f) adopta un manual interno de políticas y
procedimientos; (g) informa a la Superintendencia de Industria y Comercio las violaciones a los códigos de seguridad conforme a la
sección 11; (h) cumple los requerimientos de la autoridad; y (i) cumple las obligaciones aplicables de las leyes de Estados Unidos
de la sección 14 y otorga a los Datos del Cliente el mismo nivel de protección que esas leyes exigen; y (j) tramita los reclamos
de los titulares, registra las leyendas "reclamo en trámite" e "información en discusión judicial" y se abstiene de hacer circular
la información cuyo bloqueo ordene la Superintendencia de Industria y Comercio, conforme a la sección 12.
<!-- law: C-13, C-13b (Ley 1581 art. 18 lit. e, g, h, i), C-21 (Decreto 1074 art. 2.2.2.25.5.2 numerales 1–3), C-62 -->

## 6. Confidencialidad del personal

Kauro garantiza que toda persona autorizada a tratar Datos del Cliente (su personal y los colaboradores con acceso) está sujeta a
un deber de confidencialidad. Los vendedores, las vistas ordinarias del propietario, la analítica, las notificaciones, los
registros y las herramientas de desarrollo reciben solo los hechos mínimos necesarios; ningún registro de cliente entra en
asistentes de desarrollo, repositorios ni servicios de modelos no pagados. El acceso de soporte a registros sigue la sección 12.2
de los Términos.
<!-- auth: 01 CH-006; 08 §Model boundary (último párrafo); 08 §Support access and break-glass; 13 §Privacy in reports and downloads · law: C-64, C-65 -->

## 7. Medidas de seguridad

Kauro aplica las medidas técnicas y organizativas del Anexo II, adecuadas a la naturaleza de los Datos del Cliente y al riesgo.
Kauro puede cambiarlas siempre que el nivel de protección no disminuya.
<!-- law: C-13 (art. 18 lit. b), C-62 (11 CCR §7051(a)(5); Cal. Civ. Code §1798.81.5 citado allí), C-66 (C.R.S. 6-1-1305(4)) -->

## 8. Subencargados

8.1. **Autorización general.** El Cliente autoriza a Kauro a usar los subencargados del Anexo III para las funciones y datos allí
indicados. Kauro celebra con cada subencargado un contrato escrito que le impone obligaciones de protección de datos al menos
equivalentes a las de este Acuerdo, incluidas las exigidas por la sección 14, y responde ante el Cliente por su cumplimiento.
<!-- auth: 19 §Data processing agreement ("controls subprocessors"); 19 §Subprocessor register · law: C-63 (Cal. Civ. Code §1798.140(ag)(2); 11 CCR §7051(b)), C-65, C-66 -->

8.2. **Cambios.** Kauro avisará al Cliente, por la Plataforma y por correo a sus administradores, con al menos treinta (30) días
de anticipación, la incorporación o el reemplazo de un subencargado que trate Datos del Cliente, indicando entidad, función,
datos y ubicación. El Cliente puede objetar por escrito, con motivos razonables de protección de datos, dentro de ese plazo. Si
las partes no resuelven la objeción, el Cliente puede terminar los Pedidos afectados que no se hayan ejecutado y recibir el
reembolso de lo pagado por ellos.
<!-- auth: 19 §Subprocessor register ("Provider changes require data-flow and contract review, customer notice where applicable, technical qualification and an exit/deletion plan") · law: C-66 (C.R.S. 6-1-1305(3)(b), texto 2026: oportunidad de objetar; Virginia B.5 exige solo contrato escrito, la objeción va más allá) · resolución de silencio S-07 -->

8.3. **Lo que no son subencargados.** El proveedor de pagos (Wise) y el banco de Kauro actúan como responsables
independientes de los datos de pago que tratan para sus propios fines regulados y no reciben Datos del Cliente. Los
colaboradores comerciales de Kauro no reciben Datos del Cliente.
<!-- auth: 19 §Subprocessor register ("A provider can be an independent controller for certain payment or compliance functions"; "Listing every vendor as a subprocessor would be inaccurate"); 13 §Privacy in reports and downloads; A8 §1 -->

## 9. Ubicación de los datos

Los Datos del Cliente se almacenan y procesan en regiones de Amazon Web Services ubicadas en Estados Unidos. Las solicitudes al
modelo de lenguaje en Amazon Bedrock se procesan en Estados Unidos, en una región de EE. UU. o mediante un perfil de inferencia
geográfico limitado a EE. UU.; Kauro no usa perfiles de inferencia globales. Las copias de recuperación no crean una copia
permanente no informada de los Archivos. Kauro, sus herramientas y su personal pueden acceder a los datos desde Colombia en los
casos permitidos por la sección 12.2 de los Términos.
<!-- auth: amendments/A9_CLOUD_AWS.md §3 y §4 ("verify region, effective routing (in-region vs cross-region inference profile), data residency"); 14 §Network paths ("A US model endpoint and US storage location are distinct residency facts"); 14 §Storage configuration ("Cold recovery does not create an undisclosed permanent copy of raw CRM data") · resolución de silencio S-01 (la región exacta la fija B14) -->

## 10. Transmisiones y transferencias internacionales

10.1. El envío de Datos del Cliente desde el Cliente (o el Cliente Final) a Kauro, y de Kauro a sus subencargados en Estados
Unidos, es una **transmisión** de datos a un encargado para que trate por cuenta del responsable, y no una transferencia a un
nuevo responsable. Para el derecho colombiano, este Acuerdo y los contratos de Kauro con sus subencargados cumplen la función del
contrato de transmisión del artículo 2.2.2.25.5.2 del Decreto 1074 de 2015.
<!-- law: C-20, C-21 -->

10.2. Estados Unidos de América figura en la lista de países con nivel adecuado de protección de la Superintendencia de
Industria y Comercio (Circular Única, Título V, Capítulo 3, numeral 3.2). Esa calificación no exime a Kauro de demostrar las
medidas apropiadas y efectivas que aplica. Este Acuerdo y el Anexo II describen los compromisos y las medidas; su implementación y
su efectividad se demuestran con evidencia: la configuración vigente, las pruebas y los registros de operación que exigen las
comprobaciones de activación, que Kauro pone a disposición del Cliente según la sección 15.
<!-- law: C-22, C-23 -->

10.3. Kauro no transfiere Datos del Cliente a terceros responsables. Si en el futuro un subencargado debiera tratar datos fuera
de Estados Unidos, se aplicará la sección 8.2.

## 11. Incidentes de seguridad

11.1. **Aviso al Cliente.** Kauro avisará al Cliente de inmediato y sin demora injustificada desde que descubra un incidente de
seguridad que afecte Datos del Cliente (violación de los códigos de seguridad, o pérdida, robo, adquisición o acceso no
autorizado) o tenga motivos razonables para creer que ocurrió, sin esperar a confirmarlo, y en todo caso dentro de las **setenta
y dos (72) horas** siguientes a ese momento. Si una ley aplicable exige un aviso más temprano, ese plazo prevalece. El aviso
inicial incluye lo que se sepa: alcance afectado, hechos conocidos, acción inmediata recomendada al Cliente, contención en curso
y la fecha de la siguiente actualización; Kauro lo actualiza a medida que avanza la investigación. Kauro no espera a conocer la
causa raíz para dar el aviso inicial y no afirma que no hubo exposición antes de comprobarlo.
<!-- auth: 19 §Incident and breach obligations ("Do not wait for complete root cause if the applicable deadline requires action"); 18 §Incident communication; 14 §Incident containment · law: C-67 (Cal. Civ. Code §1798.82(b): "immediately following discovery"; Va. Code §18.2-186.6(D): "without unreasonable delay following discovery") · resolución de silencio S-02 (r2) -->

11.2. **Asistencia.** Kauro entrega al Cliente la información razonablemente disponible (cronología, datos y titulares afectados
en cuanto se conozcan, medidas adoptadas) para que el Cliente y el Cliente Final cumplan sus propias obligaciones de notificación
a titulares y autoridades. La decisión y el contenido de las notificaciones a titulares corresponden al responsable, salvo que la
ley obligue directamente a Kauro.
<!-- law: C-65 (Va. Code §59.1-579 A.2), C-66 (C.R.S. 6-1-1305(2)(b)) -->

11.3. **Reporte a la Superintendencia.** Como encargado sujeto a la ley colombiana, Kauro reportará el incidente a la
Superintendencia de Industria y Comercio dentro de los quince (15) días hábiles siguientes a su detección, por el aplicativo o
canal que esa entidad disponga, y coordinará el reporte con el Cliente.
<!-- law: C-14, C-15 (Ley 1581 art. 18 lit. k; Circular Única Título V numeral 2.1 lit. f(ii)) -->

11.4. **Registro.** Kauro registra cada incidente con detección, impacto, sujetos afectados, contención, preservación mínima de
evidencia, reparación, comunicación y recuperación. Una retención por incidente tiene motivo y fecha de revisión; no es una
excepción permanente a la conservación.
<!-- auth: 14 §Incident containment; 19 §Incident and breach obligations -->

## 12. Asistencia con los derechos de los titulares

12.1. La Plataforma permite al Cliente consultar, corregir mediante una nueva Revisión, excluir y eliminar Datos del Cliente
dentro de los plazos de conservación.

12.2. **Consultas y reclamos recibidos por Kauro.** Si un titular presenta a Kauro una consulta o un reclamo sobre Datos del
Cliente, Kauro: (a) autentica al solicitante y delimita la solicitud antes de revelar o eliminar algo; (b) identifica el proyecto
y el responsable según la cadena registrada (sección 1.2) y, en la cadena agencia–cliente final, hace llegar la solicitud al
Cliente Final por medio del Cliente; (c) recibido un reclamo completo, registra en los datos afectados la leyenda "reclamo en
trámite" y su motivo dentro de los dos (2) días hábiles siguientes y la mantiene hasta que se decida; (d) traslada al responsable,
dentro de los dos (2) días hábiles siguientes al recibo, lo que solo el responsable puede decidir, e informa del traslado al
titular; (e) cumple sus propios deberes de encargado sin esperar al responsable, y ejecuta lo que el responsable decida dentro de
los plazos legales (consultas: diez (10) días hábiles más cinco; reclamos: quince (15) días hábiles más ocho, avisando la prórroga
antes del vencimiento del término inicial); y (f) si ya no conserva los datos, lo informa. Kauro no responde en el fondo por el
responsable salvo instrucción del Cliente o deber legal propio.
<!-- auth: 19 §Rights requests and privacy complaints · law: C-10, C-13, C-17 (Ley 1581 arts. 14, 15 y 18 lit. e, g) · CHECKLIST A-02, A-17 -->

12.3. Kauro ayuda al Cliente, con medidas técnicas y organizativas apropiadas y en la medida de la información de que dispone, a
responder las solicitudes de los titulares, a cumplir sus deberes de seguridad y a realizar evaluaciones de impacto o de riesgo
que el Cliente deba documentar, entregándole la información necesaria sobre el tratamiento.
<!-- law: C-62 (11 CCR §7051(a)(5), (9)), C-65 (Va. Code §59.1-579 A.1–A.3), C-66 (C.R.S. 6-1-1305(2)(a)–(c)) -->

12.4. **Leyendas y bloqueo.** Cuando una autoridad competente notifique a Kauro, o el Cliente le informe que fue notificado, de un
proceso judicial sobre la calidad de un dato, Kauro inserta en los datos afectados la leyenda "información en discusión judicial".
Cuando la Superintendencia de Industria y Comercio ordene bloquear información controvertida por el titular, Kauro impide su
circulación mientras dure la orden: bloquea descargas, publicación de Paquetes, envíos al modelo y nuevo procesamiento del alcance
afectado, sin eliminar la información salvo que la orden lo disponga.
<!-- auth: 19 §Rights requests and privacy complaints ("The agency/controller chain is identified"); 09 §Early deletion (bloqueos por alcance); 14 §Incident containment (controles independientes por alcance) · law: C-13, C-13b (Ley 1581 arts. 15 y 18 lit. e, g, h, i), C-17, C-62 (11 CCR §7051(a)(9)) · CHECKLIST A-02, A-17 -->

## 13. Supresión y devolución al terminar

13.1. Al terminar la prestación del servicio, o antes cuando lo pida, el Cliente, por su cuenta o por instrucción documentada del
Cliente Final, elige si Kauro **devuelve** o **elimina** todos los Datos del Cliente que todavía conserve, incluidos los Archivos
de origen aceptados y los derivados que contengan datos personales, salvo que una ley exija conservarlos. La devolución se hace
por descarga segura en la Plataforma antes de la eliminación. Además, Kauro elimina los Datos del Cliente según el calendario de
conservación del Anexo IV al vencer cada plazo, o cuando el Cliente pide la eliminación anticipada, lo que ocurra primero; la
Plataforma avisa antes de cada eliminación para que el Cliente pueda descargar.

13.2. Kauro emite un comprobante de eliminación por el alcance que controla, con el alcance pedido, la versión de la política,
los plazos, la revocación de accesos, las generaciones de objetos enumeradas y los resultados de eliminación y de ausencia. El
comprobante no contiene valores de los registros eliminados y no cubre copias ya descargadas ni importaciones hechas por el
Cliente. Una copia eliminada puede persistir unos días tras el borrado en el almacenamiento del proveedor, hasta su expiración
automática; Kauro no la usa ni la restaura.

13.3. Cuando la ley obliga a conservar algún dato, Kauro lo conserva solo para ese fin, separado y sin contenido de CRM. Los
registros financieros y de seguridad de Kauro no contienen Datos del Cliente.
<!-- auth: 09 §Early deletion; 09 §Deletion receipts and restoration; 09 §Retention schedule; 09 §Notifications and customer action · law: C-65 (Va. Code §59.1-579 B.2), C-66 (C.R.S. 6-1-1305(5)(d)(I), texto 2026) · CHECKLIST A-15 -->

## 14. Términos para Clientes sujetos a leyes de privacidad de California, Virginia o Colorado

14.1. **Finalidades limitadas y especificadas.** El Cliente revela Datos del Cliente a Kauro solo para las finalidades
comerciales específicas del Anexo I, sección 3 ("business purposes"). Kauro actúa como "service provider" en el sentido del
Código Civil de California §1798.140(ag) y como "processor" en el sentido de la Virginia Consumer Data Protection Act (Va. Code
§59.1-579) y de la Colorado Privacy Act (C.R.S. 6-1-1305). Kauro solo ha verificado los términos de encargado de esas tres leyes.
Si al Cliente o al Cliente Final le aplica la ley de privacidad de otro estado, el Cliente lo informa antes de cargar los datos y
Kauro califica los términos obligatorios de esa ley antes de aceptar el proyecto; sin esa calificación, ese proyecto no se acepta.
<!-- law: C-60, C-61, C-64, C-65, C-66, C-68 · CHECKLIST A-19 · ver LAWYER_LATER L-08 -->

14.2. **Compromisos de Kauro.** Además de la sección 3.3, Kauro: (a) cumple las obligaciones que le resultan aplicables de la
California Consumer Privacy Act y su reglamento y otorga a los Datos del Cliente el mismo nivel de protección que esa ley exige a
los negocios; (b) notifica al Cliente si determina que ya no puede cumplir esas obligaciones; (c) permite al Cliente tomar
medidas razonables y apropiadas para asegurar que Kauro usa los datos de forma coherente con las obligaciones del Cliente, según
la sección 15; (d) permite al Cliente, previa notificación, tomar medidas razonables y apropiadas para detener y remediar un uso
no autorizado, incluida la entrega de documentación que acredite que Kauro ya no conserva ni usa los datos de un titular que
pidió la eliminación; y (e) habilita al Cliente para atender las solicitudes de los consumidores o cumple las solicitudes que el
Cliente le informe.
<!-- law: C-60 (Cal. Civ. Code §1798.100(d)(1)–(5)), C-62 (11 CCR §7051(a)(5)–(9)) -->

14.3. **Usos permitidos.** Kauro puede además conservar o usar Datos del Cliente, en la medida razonablemente necesaria y
proporcionada, para prevenir, detectar o investigar incidentes de seguridad o actividades maliciosas, fraudulentas o ilícitas
contra el servicio, y para cumplir la ley.
<!-- law: C-62b (11 CCR §7050(a)(4), (5)) · auth: 08 §Abuse controls -->

14.4. **Responsabilidad por rol.** Nada en este Acuerdo exime al Cliente ni a Kauro de la responsabilidad que la ley les impone
por su rol.
<!-- law: C-65 (Va. Code §59.1-579 C), C-66 (C.R.S. 6-1-1305(6)) -->

## 15. Información, auditoría y verificación

15.1. **Información.** A solicitud razonable del Cliente, Kauro pone a su disposición toda la información en su poder necesaria
para demostrar el cumplimiento de este Acuerdo y de las leyes de la sección 14: entre otras, la descripción vigente de medidas,
la lista de subencargados, los comprobantes de eliminación, el registro de accesos de soporte a los datos del Cliente y un
cuestionario de seguridad respondido. No hay un límite fijo de solicitudes.

15.2. **Auditorías e inspecciones.** Kauro permite y colabora con auditorías e inspecciones razonables del Cliente o del auditor
que el Cliente designe. Por regla general se programan con treinta (30) días de aviso y en horario hábil, pero ese aviso se acorta
a lo razonable cuando la auditoría responde a un requerimiento de una autoridad, a sospechas fundadas de incumplimiento, a un
cambio material del tratamiento o a un incidente. Para proteger a otros clientes y la información confidencial de Kauro, el
acceso se limita al alcance necesario y el auditor se obliga a confidencialidad; la información confidencial que se necesite como
evidencia se entrega bajo esa confidencialidad, no se niega. Cada parte asume sus propios costos.

15.3. **Auditoría independiente alternativa.** Con el consentimiento del Cliente, Kauro puede en su lugar contratar, al menos una
vez al año y a su propio costo, a un auditor calificado e independiente que audite sus políticas y medidas técnicas y
organizativas con un marco de control y un procedimiento de auditoría apropiados y aceptados, y entregará el informe al Cliente
cuando lo pida.
<!-- law: C-60 (§1798.100(d)(3)), C-61 (§1798.140(ag)(1)(D)), C-62 (11 CCR §§7050(h), 7051(a)(6)), C-65 (Va. Code §59.1-579 B.3–B.4), C-66 (C.R.S. 6-1-1305(5)(d)(II), texto 2026: auditoría alternativa anual a costo del encargado, con consentimiento) -->

## 16. Responsabilidad, vigencia y ley aplicable

16.1. La responsabilidad de las partes bajo este Acuerdo se rige por la sección 18 de los Términos, sin perjuicio de la sección
14.4 y de la responsabilidad que la ley imponga a cada parte frente a los titulares y las autoridades.

16.2. Este Acuerdo rige mientras Kauro trate Datos del Cliente y sus obligaciones de confidencialidad, seguridad y supresión
sobreviven hasta la eliminación completa.

16.3. Este Acuerdo se rige por la ley colombiana, sin perjuicio de las normas imperativas de protección de datos que apliquen al
Cliente o al Cliente Final por su domicilio o el de los titulares, que Kauro cumplirá en lo que le corresponda como encargado.
Las controversias se resuelven según la sección 22 de los Términos.

---

## Anexo I. Descripción del tratamiento

**1. Objeto.** Preparación de datos de CRM a partir de archivos: recepción, inspección, perfilamiento, propuesta semántica
acotada, transformación determinista, validación, entrega, soporte y eliminación.
<!-- auth: 19 §Data processing agreement (segundo párrafo) -->

**2. Naturaleza de las operaciones.**
1. Recepción de Archivos en una zona de cuarentena, inspección de formato, de archivos comprimidos y de software malicioso.
2. Sellado de la Revisión (huellas, hojas admitidas, configuración de lectura).
3. Perfilamiento completo de los datos admitidos (conteos, formatos, candidatos a duplicado, relaciones).
4. Envío de un **contexto minimizado** a un modelo de lenguaje en Amazon Bedrock para proponer decisiones acotadas. El contexto
   contiene solo estructura y hechos agregados (clase L0), vocabulario semántico aprobado (L1) y ejemplos autorizados enmascarados
   con sustituciones propias de la tarea (L2). Nunca contiene datos personales o confidenciales crudos (L3) ni credenciales (L4).
   El modelo propone; no ejecuta ni concede autoridad.
5. Revisión y aprobación del Plan por el Cliente.
6. Transformación determinista, validación, conciliación de linaje y publicación del Paquete.
7. Verificación de comprobantes de importación entregados por el Cliente (proyectos por etapas).
8. Soporte con acceso acotado, y eliminación.
<!-- auth: 02 §4–§10; 06 §Privacy classes and minimization; 08 §Quarantine and malware boundaries; 08 §Model boundary -->

**3. Finalidades comerciales específicas ("business purposes").** (a) Producir para el Cliente el Free data health check, el Plan,
el Paquete y la evidencia del proyecto que el Cliente solicita; (b) prestar el soporte y el remedio de defectos de ese proyecto;
(c) mantener la seguridad e integridad del servicio para ese proyecto; (d) eliminar los datos según el Anexo IV.

**4. Tipos de datos personales.** Los que el Cliente incluya en exportaciones de CRM y hojas de cálculo de negocio dentro de los
objetos soportados: datos de identificación y contacto profesional (nombres, cargos, correos, teléfonos, direcciones de empresa),
pertenencia a empresas y organizaciones, datos de negocios u oportunidades, identificadores de registros del CRM, fechas,
propietarios de registros, campos personalizados y campos de texto libre (notas). Excluidos: las categorías prohibidas de la
sección 5.2 de los Términos.
<!-- auth: 02 §Service modes (objetos: contactos, organizaciones/cuentas, negocios/oportunidades); 19 §Data categories and excluded use -->

**5. Categorías de titulares.** Contactos de negocio, clientes y prospectos del Cliente Final o del Cliente, y empleados o
usuarios del CRM que figuren como propietarios de registros. Pueden ser residentes de Estados Unidos, de Colombia o de otros
países, sujeto a la sección 5.5 de los Términos.

**6. Duración.** Durante cada proyecto y hasta los límites del Anexo IV.

**7. Frecuencia.** Por proyecto, a solicitud del Cliente.

## Anexo II. Medidas técnicas y organizativas

Medidas existentes en el diseño aprobado del servicio. Kauro no declara certificaciones que no tiene.

| Área | Medida |
|---|---|
| Aislamiento entre clientes | Base de datos PostgreSQL con seguridad a nivel de fila (RLS) para lectura y escritura; roles de ejecución sin privilegios de dueño ni de omisión de RLS; contexto de cliente por transacción que se limpia al devolver la conexión; claves foráneas que atan cliente y padre. <!-- auth: 08 §Database isolation --> |
| Acceso de usuarios | Correo verificado y MFA obligatorios para acceder a datos; reautenticación reciente para acciones de alto impacto; cookies de sesión Secure, HttpOnly y SameSite; protección CSRF; CORS limitado a los orígenes de la aplicación. <!-- auth: 08 §Authentication and assurance --> |
| Almacenamiento | Zonas separadas (cuarentena, aceptado, perfil, minimizado, provisional, entrega, comprobantes, legal/financiero, seguridad); nombres de objeto opacos; objetos nunca públicos ni cacheados en CDN; precondiciones que impiden sobrescribir; inventario periódico contra el registro de objetos. Cifrado en reposo de los objetos (cifrado del lado del servidor de Amazon S3) y cifrado en tránsito (TLS). <!-- auth: 09 §Storage zones and object registry; 14 §Network paths (HSTS/TLS); law/fuente: AWS S3 default encryption (CHECKLIST V-04) --> |
| Contención de procesos | Credenciales de almacenamiento de corta vida, limitadas al intento y a prefijos exactos, emitidas por un intermediario; el proceso de inteligencia no accede al almacenamiento crudo; sin acceso general a internet desde los procesos de migración; contenedores sin privilegios de root; límites de recursos al extraer y leer archivos. <!-- auth: 08 §Storage capabilities and worker containment; 08 §Secrets and supply chain; 14 §Network paths --> |
| Contenido hostil | Validación de formato, inspección de archivos comprimidos, cobertura de antimalware registrada; un escaneo fallido no es un archivo limpio; sin ejecución de macros ni fórmulas; informes con escape contextual y PDF sin recursos remotos. <!-- auth: 08 §Quarantine and malware boundaries; 02 §Intake and project boundaries --> |
| Modelo de lenguaje | Contexto minimizado (L0–L2) ligado a una decisión de salida que fija los bytes exactos, el destino y el vencimiento; sin datos crudos ni credenciales; pruebas de inyección de instrucciones; sin cambio silencioso de proveedor ni de endpoint. En Amazon Bedrock, Kauro configura la retención de datos de inferencia en cero y el registro de invocaciones desactivado, y no usa modelos que exijan retener entradas o salidas o revisión humana. <!-- auth: 06 §Privacy classes and minimization; 08 §Model boundary; A9 §4 ("retention (no storage of inputs/outputs; invocation logging off)"); 06 §Provider selection decision (Covered models) · fuente: CHECKLIST V-02, V-03 --> |
| Soporte | Vista de soporte con metadatos seguros; acceso a registros solo con concesión por caso (propósito, proyecto, operaciones, aprobador, vencimiento máximo de 30 minutos, lectura por defecto), auditada y revocable. <!-- auth: 08 §Support access and break-glass --> |
| Secretos y cadena de suministro | Secretos en el gestor de secretos; sin llaves estáticas de larga vida (identidad federada para despliegue); dependencias fijadas y analizadas; identidades de construcción, despliegue y ejecución separadas. <!-- auth: 08 §Secrets and supply chain; A9 §3 (IAM + GitHub OIDC, Secrets Manager) --> |
| Registros y auditoría | Eventos de seguridad sin contenido de cliente ni credenciales; registros de aplicación 30 días y evidencia de seguridad 180 días; el rastreo no captura cuerpos HTTP. <!-- auth: 08 §Audit events and retention; 09 §Retention schedule --> |
| Descargas | Autorización revisada en cada descarga; enlaces firmados de 15 minutos; correos sin enlaces firmados ni registros. <!-- auth: 09 §Early deletion; 13 §Privacy in reports and downloads; 09 §Notifications and customer action --> |
| Eliminación | Eliminación por generación con comprobación de ausencia y comprobante; copias de respaldo con metadatos, no contenido de archivos; lápidas aplicadas antes de restaurar. <!-- auth: 09 §Early deletion; 09 §Deletion receipts and restoration; 14 §Storage configuration --> |
| Resiliencia | Copias de respaldo diarias de metadatos con recuperación a un punto en el tiempo, verificadas mediante simulacros. <!-- auth: 14 §Database resilience --> |
| Incidentes | Contención por alcance (cargas, revisiones, compras, procesamiento, publicación, descargas) independiente de reembolsos y eliminación; registro del incidente. <!-- auth: 14 §Incident containment --> |
| Organización | Mínimo privilegio para personal y vendedores; deber de confidencialidad; ningún dato de cliente en herramientas de desarrollo o repositorios; reproducción de defectos con datos sintéticos. <!-- auth: 01 CH-006; 08 §Model boundary --> |

## Anexo III. Subencargados autorizados

| Subencargado | Función | Datos del Cliente que recibe | Ubicación |
|---|---|---|---|
| Amazon Web Services, Inc. | Infraestructura de nube: cómputo, base de datos, almacenamiento de objetos, colas, gestión de secretos, identidad, registros y modelos de lenguaje mediante Amazon Bedrock. | Todos los Datos del Cliente que la Plataforma almacena o procesa; en Bedrock, solo el contexto minimizado del Anexo I, punto 2.4. | Regiones de AWS en Estados Unidos. |
<!-- auth: amendments/A9_CLOUD_AWS.md §3 (servicios AWS) y §1 (Resend sin cambio); 19 §Subprocessor register; reference/MESSAGING_AND_SENDER_OPERATIONS.md (Resend: datos mínimos, retención de 30 días del plan observado) · fuentes: CHECKLIST V-01, V-05 -->

Proveedores de Kauro que **no** son subencargados de Datos del Cliente: Resend (correo transaccional; es encargado de Kauro para
los datos de los usuarios del Cliente —correo, nombre y contenido mínimo del aviso—, que según la sección 1.3 no son Datos del
Cliente; no recibe registros de CRM y conserva los datos de envío por un periodo propio, 30 días en el plan observado), Google LLC
(Google Workspace: correo corporativo de Kauro; el Cliente no debe enviar registros por correo), Cloudflare, Inc. (registro de dominio y DNS), Wise (responsable
independiente de datos de pago), Bancolombia (banco de Kauro) y el proveedor de facturación electrónica de Kauro (datos de
facturación del Cliente, no Datos del Cliente). Google Cloud no se usa en producción.
<!-- auth: A9 §1 (Google Workspace, Cloudflare, Resend sin cambio; GCP fuera del camino crítico); A4 §Owner acts (Cloudflare registrar y DNS); A8 §1; 15 §Accounting integration decision -->

## Anexo IV. Calendario de conservación de Datos del Cliente

El calendario de la sección 13.1 de los Términos forma parte de este Acuerdo. En resumen: carga incompleta, 24 horas; Free data
health check, 7 días desde el resultado y máximo 14 desde el sellado; proyecto pagado ordinario, 7 días desde el primer Paquete
y máximo 14 desde el pago; proyecto por etapas, máximo 21 días desde la primera etapa y 30 desde el pago; una extensión blanda de
hasta 72 horas que nunca supera los máximos; contexto minimizado, solo durante la revisión activa y su ventana breve de
evidencia, y se elimina con los datos del proyecto.
<!-- auth: 09 §Retention schedule; 09 §Quotes, reuploads and retention; registry/policy.json retention -->
