# Kauro: informe de auditoría del constructor y del programa

Fecha: 05-oct-2026, 03:00Z (04-oct 22:00 hora de Bogotá).
Base: 10 auditorías especializadas, cada una verificada después por separado (se eliminaron los hallazgos que resultaron falsos) y consolidadas por el arquitecto jefe.
Repositorios revisados: kauro-platform 4f99a67, kauro-migration-core 80a12af (PR #16 810889f), kauro-intelligence-core 2d01430 (PR #11 cf24e30, PR #12 3fc4cde) y la carpeta local C:\Projects\Kauro.
Informes detallados: `/home/user/kauro-audit/*.md`. Los archivos del sistema operativo del constructor ("builder OS", ya corregidos y probados) están en `/home/user/kauro-audit/builder-os/`.

---

## 1. Veredicto ejecutivo

1. **El producto está bien construido. Lo que pierde los días es el proceso.** La plataforma pasa su verificación completa en Linux (450/450 pruebas en 8,5 minutos) y aísla bien los datos de cada cliente: la base de datos fuerza esa separación en 137 de 139 tablas. Migration Core mata 128 de 128 mutaciones y produce un paquete byte a byte reproducible. Intelligence Core tiene un banco de calificación sellado y riguroso. El problema no es la calidad del código.

2. **Al ritmo actual no se llega al 19-oct.** Con el ritmo medido en git (8 días activos, 3 de 11 días parados por cuota, unas 4 rondas de Codex por unidad de revisión), la fecha probable de producción es el **30-oct**, y la pesimista el **3-nov**. Eso queda incluso después de la fecha límite de la propia autoridad (A4: objetivo 23-oct, límite 28-oct).

3. **Con los cambios de este informe, el 19-oct es alcanzable con un margen de unos 2 días** (fecha probable de producción: sábado 17-oct). Probabilidad estimada: **55–65 %**, siempre que se cumplan las 8 condiciones de la sección 6. El margen es real pero pequeño. No admite otra semana como la del 29-sep.

4. **Hoy hay cinco cosas rotas que bloquean el camino crítico.** Todas se arreglan en horas:
   - (a) `main` de la plataforma está en rojo desde el 04-oct a las 21:46Z. No es una "carrera intermitente": son 8 pruebas que mezclan el reloj de Node con el reloj de PostgreSQL. Detrás hay además un defecto real de producto en el orden justo de admisión.
   - (b) La publicación de Migration Core 3.0.0 lleva 6 días atascada. La causa es un defecto de la herramienta de publicación (reutiliza el estado del PR #15), no un problema del motor. Si se fusiona a mano, fallará en el paso siguiente (`consumer-check` tiene escrito a mano "2.0.3").
   - (c) En Intelligence Core, el PR #11 (B04) se puede fusionar **sin evidencia de mutaciones**, porque GitHub cuenta una comprobación omitida como aprobada.
   - (d) El único runner de sabotaje del PC muere cuando WSL se apaga, y además está ocupado con una ejecución que no puede pasar (run 37233396440).
   - (e) Quedan unos USD 7,50 de presupuesto de Actions. Un run de la plataforma cuesta unos 63 minutos facturables (unos USD 0,50; runs 37236104551 y 37234145817) y cada PR suele costar 3 runs (PR, update-branch, main). Unos 40 PRs de la plataforma ≈ USD 60, más MC ≈ USD 5 y IC: hacen falta unos USD 70–80.

5. **El mayor riesgo de calidad todavía no ha estallado.** Intelligence Core está construido sobre MC 2.0.1. MC 3.0.0 rechaza su configuración y cambió el comportamiento con los espacios en blanco. Si la calificación pagada de B04 se ejecuta antes de portar IC a 3.0.0, el resultado no vale para B05 y hay que pagarla y correrla de nuevo (2–4 días). Además, el PR #12 hace inalcanzables 8 verdades del corpus sellado sin que la validación lo detecte.

---

## 2. Dónde se están perdiendo los días (cuantificado)

| # | Fuga | Evidencia | Días perdidos hasta hoy | Días en riesgo hasta el 19-oct |
|---|---|---|---|---|
| 1 | **Rondas de Codex por arreglos incompletos.** De 27 rechazos en re-revisión, 25 fueron hallazgos anteriores arreglados a medias, no hallazgos nuevos. FH-R2 quedó "parcial" durante 6 rondas, B07-R1 durante 3. | `tools/review/out/*/review.json`; B07 7 rondas, B09 5, B10 unas 26 en total | ~3 | 2–4 |
| 2 | **Atasco por cuota de Claude.** 60 % de la semana gastado en 18 h el 29-sep, sobre todo releyendo contexto. Tres días después casi sin avance: 6, 12 y 4 commits. | `quota-ledger.md`; commits por día | ~3 | 2–3 si se repite |
| 3 | **Herramientas de publicación de MC.** Estado compartido entre PRs, `consumer-check` con "2.0.3" escrito a mano, ensayo del flujo roto y fuera de CI, sabotaje de 3 a 5,6 h repetido sobre código del motor que no cambió, tiempos límite más cortos que la duración real. | `chain-dossier-loop-3.out`; diff vacío 13ba810..810889f en src/test | ~4 | 1–2 |
| 4 | **Verificaciones repetidas.** 33 verificaciones completas para 22 commits distintos; 7 verificaciones de Windows para rondas que solo revisaban documentos; la herramienta de revisión vuelve a verificar en cada re-revisión. | `tools/review/out/*/verify.log`; `package-review.sh` paso 1 | ~1,5 | 1–1,5 |
| 5 | **Esperas sin trabajar en otro carril** y mensajes de estado sin contenido. | Fallo observado 5 | ~1–2 | 1,5 |
| 6 | **Minutos de Actions comprados sin evidencia nueva.** De 9.525 minutos facturables (29-sep a 05-oct), al menos 5.200 no aportaron nada: sabotaje duplicado en el mismo run, el mismo árbol verificado 2 o 3 veces, trabajos que llegaron a su tiempo límite, trabajos caros que siguieron corriendo después de fallar uno barato. | auditoría ci-github §2 | costo en dinero | 1–3 si el presupuesto se agota |
| 7 | **El runner del PC muere con WSL**, más presión de memoria (6 verificaciones o cadenas cortadas). | shard 10 del run 37233396440, 2 h 34 min fuera de línea; `incidents.md` 03-oct | ~1 | 1–1,5 |
| 8 | **Matriz de fallos de B10 sin criterio de cierre.** 161 celdas sin cubrir, unas 26 rondas de Codex. | `B10-failure-matrix.md:258` | — | 2–3 |
| 9 | **Todo lo que viene después de B11 sigue en serie.** 22 de 64 comandos sin construir, 0 adaptadores reales, 0 Terraform. | grep CMD; `find -name '*.tf'` vacío | — | **4–5** (el mayor de todos) |

**Total perdido hasta hoy: unos 13–15 días-constructor. En riesgo hasta el 19-oct: unos 16–24 días** si no se cambia nada. Las fugas se solapan, por eso el retraso calendario neto es de unos 10–11 días.

---

## 3. Los 15 cambios que más días ahorran, en orden

| # | Cambio | Días ahorrados | Defectos que evita | Ejecutor | Horas |
|---|---|---|---|---|---|
| 1 | **Construir por adelantado y en paralelo**, con un contrato que asigna a cada carril sus propios archivos. S-A hace Terraform, secretos e identidades de B14. S-B hace los 6 adaptadores reales de B15 (el host del worker de Batch lo hace el constructor). S-C hace el libro de los 441 casos y los comandos locales de B16. El constructor hace B10, B05, B11-B13 y B17-B18. Comandos y adaptadores, fusionados el 11 y el 13-oct. | 4–5 | Atajos de última hora (llaves JSON, un solo usuario de servicio para todo) | builder + 3 sesiones | ~120 |
| 2 | **Calificar el aislamiento de B16 y todo B17 en el entorno de B14 antes de B15.** Del final queda solo el simulacro de restauración. | ~3 | — | builder | 2 de plan |
| 3 | **Codex en una sola pasada.** Antes de Codex: un adversario interno (Opus) con la tabla de familias de defectos y una prueba de que cada test nuevo falla sin el arreglo (`red-proof`). En el prompt de Codex: que barra la familia completa y liste todas las rutas análogas. Desde la ronda 3, primero una corrección de causa raíz. | 2–4 | Defectos de concurrencia, tiempo y caída encontrados de a uno | builder | 6 |
| 4 | **Desbloquear B02 con UN commit** (consumer-check, ids del GitHub simulado, guarda de fusión, KAURO_PR obligatorio, tiempos límite, ensayo como paso de CI). Luego un universo, CI del PR y la cadena desde una carpeta de trabajo nueva. **No fusionar el PR #16 a mano.** | 1,5–2 | Publicar con herramientas defectuosas | builder | 3 + espera |
| 5 | **Una sola rama de integración en IC** (`ic/b04-integrate`): commits del PR #12, arreglo de identidad de cabeceras, anclas, puerto a MC 3.0.0, corpus resellado, validez ligada al motor, versión 0.6.0 final, endurecimiento de la campaña. Después, una sola revisión delta de Codex y un solo sabotaje. | 3–4 (riesgo) | Calificación pagada inválida; cabeceras BOM/ZWSP de Excel | builder | 14–20 |
| 6 | **Fondos y CI.** El dueño sube el tope de Actions (USD 100; puerta dura antes del push del PR #16). Las comprobaciones obligatorias fallan cuando falta la evidencia, en vez de saltarse. Cambios de CI en PRs propios. El sabotaje corre solo bajo petición y en el runner del PC. | 1–3 | Fusionar B04 sin evidencia de mutaciones | dueño + builder | 0,2 + 5 |
| 7 | **`main` en verde por la causa real.** Los instantes de las fixtures salen del reloj de la base de datos; el orden de admisión se sella con `clock_timestamp()` después del lock. Sin debilitar pruebas. | 1 | Orden injusto de agencias (R2-046) | builder | 6–7 |
| 8 | **B10 con fecha de cierre.** Suites parametrizadas por familia (el template ya lo permite), un oráculo de 15 invariantes de dinero y una resolución R-GAP del dueño para los niveles 2 y 3 que no tocan dinero. Cierre el 08-oct. | 2–3 | — | builder + dueño 15 min | 14 + carriles |
| 9 | **Instalar el builder OS** (corregido en esta auditoría): hooks de push, fusión y P0, recibos ligados a un árbol limpio, guardia contra la inactividad, control del ritmo de cuota, `run-heavy`, `doc-slice`. | ~3 (recurrencias) | Push antes de terminar pruebas; certificar un árbol sucio | builder | 3 |
| 10 | **Mantener vivo el PC**: keepalive de WSL, límites de memoria, pausa de Windows Update hasta el 20-oct, BIOS que enciende tras un corte de luz. | 1–1,5 | — | dueño 20 min + builder 2 h | 2,5 |
| 11 | **Una sola verificación de registro por sistema operativo y commit** (`--verify-receipt`, caché por sha), más un clúster PostgreSQL plantilla. | 1–1,5 | — | builder | 7 |
| 12 | **Enmienda A7 para el dueño:** mapa de casos de B00, definición de "tocado", cláusulas heredadas, alcance de la revisión B18, evidencia de 8 ítems = paquete de evidencia, tipos de revisión Codex. | 1,5–3 (en B18) | Disputas y megarrevisión en B18 | builder redacta, dueño firma | 3 + 0,5 |
| 13 | **Una sola hoja de decisiones del dueño antes del 07-oct:** subvención única para B04, presupuesto de nube, fecha de corte fiscal, delegación de publicar versiones, 19-oct registrado, revisión legal. | 2–3 de esperas | — | dueño | 2,5 |
| 14 | **ADR de tiempo:** las guardas de "todavía vigente" se juzgan en el momento del efecto (`effect_now()`), clasificadas sitio por sitio (11 sitios). | 1,5 (rondas futuras) | Que un permiso vencido autorice tras esperar un lock (producción) | builder | 6–8 |
| 15 | **Libro de los 441 casos y `package-brief` corregido** (puertas de calidad mal asignadas en 7 paquetes: el brief de B16 no trae G-TENANT ni 6 comandos). | 1–2 | Revisiones Codex con autoridad incompleta | S-C | 12 |

---

## 4. Conflictos entre auditores y cómo se resuelven

| Tema | Postura A | Postura B | Decisión |
|---|---|---|---|
| Fusionar el PR #16 de MC | "Fusionar a mano ya" (builder-tooling) | La verificación muestra que la cadena fallaría (PUT /merge rechazado) y además `consumer-check` falla | **No fusionar a mano.** Un commit con todos los arreglos, ensayo, universo, cadena con KAURO_PR=16 en una carpeta nueva. |
| `job-admission.test.ts:57` | Afirmar el orden desde los resultados de la ronda (platform-code-01) | Es un defecto de producto: `last_admitted_at = server_now()` | **No tocar la prueba. Arreglar el producto.** |
| `mustWait` del arnés | Tolerar un BEGIN ajeno | Debilitaría el arnés; 5c9ef38 ya cubre los dos modos de inestabilidad | **Semántica intacta.** Solo se agrega `stress-cells.mjs`. |
| Matriz B10 | Cambiarla por un modelo aleatorio con oráculo y diferir el nivel 1 a B16 | El nivel 1 encontró defectos reales de dinero; la regla de la matriz exige la facilidad del arnés | **Mantener el nivel 1** con suites parametrizadas (el template lo permite sin enmienda) más el oráculo. Los niveles 2 y 3 que no tocan dinero, con resolución R-GAP del dueño. |
| Windows en cada PR de la plataforma | Solo en main o con etiqueta (platform-code-10) | Decisión del dueño del 04-oct | **Decide el dueño (D-03).** Recomendación: Windows en CI solo en el candidato final (etiqueta `windows`) y en main, para ahorrar unos 25 minutos facturables por push. Mientras el dueño no cambie su decisión, sigue en cada PR. |
| Reservar rangos de migración | Rangos por carril (critical-path-10) | `runner.ts:66` exige versiones contiguas desde 0001 | **No relajar el runner.** Número provisional por carril y renumeración mecánica (`renumber-migration.mjs`) al rebasar antes de fusionar. |
| Clave del sabotaje reutilizable | Lista de archivos incluidos (migration-core-05) | Las pruebas leen `spec/**`, `docs/*.txt` y `tsconfig` | **Lista de exclusión**, o el árbol completo en la plataforma. Después de v3.0.0, con decisión registrada y Codex. |
| Alto en el piloto de B04 ante una violación dura | Que siga el otro candidato (IC-07) | El manual 06: un modelo no compensa un evaluador roto | **Mantener el alto.** Se baja la probabilidad de un alto falso con la verificación previa de validez y con el ensayo caótico. |
| Bloquear pushes mientras main está rojo | El builder-os original bloqueaba todos | A6.5 solo restringe fusiones | **Bloquear solo fusiones.** Ya corregido en los hooks. |
| Número de sesiones paralelas | Dos sesiones en la nube más el PC (critical-path) | Las sesiones comparten la cuota | **Hasta 3 sesiones activas en paralelo, con tope de cuota diario** (S-A, S-B y S-C 1 %/día cada una; el constructor unos 9 %). S-D (1 %) empieza solo cuando S-A o S-B terminan. Si el ritmo de cuota pasa a AMBER, se pausa primero S-C. |
| Runners adicionales del PC | 3 instancias en paralelo | 14,5 GB de RAM | **Una instancia.** La segunda solo después de medir el pico de memoria de un shard. |
| Revertir un commit si main sigue rojo tras 3 h | Revertir la fusión | Quitaría la protección de fondos de lane 5 | **Nunca revertir arreglos de seguridad de dinero.** Diagnóstico, tarjeta y carril prioritario. |

---

## 5. Tabla completa de hallazgos por área

La severidad que se muestra es la corregida por los verificadores. Las horas son de trabajo efectivo. Ejecutor: B = builder (la sesión Kauro del PC), S = sesión paralela, D = dueño.

### 5.1 Plataforma (código)
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| platform-code-01 | crítica | `main` rojo en Windows (run 37236104551): 8 fallos. Las fixtures usan `Date.now()` contra `server_now()` (commission-support.ts:569, harness.ts:361); el mismo árbol pasó en el PR (37234145817). | `serverNow(client)` en la ayuda de pruebas, con margen de 1 s; prueba de reproducción con el reloj desfasado 5 ms; no reescribir job-admission | B | 4–5 |
| V-plat-A (verificador) | alta | Orden de admisión sellado al inicio de la transacción (0021:322, store.ts:246): una agencia puede quedar mal ordenada (R2-046) | `clock_timestamp()` después del lock, o una secuencia | B | 2 |
| V-plat-B | media | Una línea HELD responde 422 RESPONSE_CONTRACT_VIOLATION (CORR_DUP, PAY_CRA) | Reproducir con providerCompletedAt = confirmedAt + 1 s; catalogar la respuesta o manejarla | B | 2–3 |
| platform-code-02 | media | El arnés con mustWait era inestable. 5c9ef38 ya lo corrigió | `tools/stress-cells.mjs` 20 veces para celdas nuevas o cambiadas. No relajar el arnés | B | 2 |
| platform-code-03 | alta | `server_now()` = inicio de la transacción. Quedan 11 guardas de "todavía vigente" sin `effect_now` | ADR; migración que cambie solo las guardas de vigencia; prueba generadora por guarda; lint | B | 6–8 |
| platform-code-04 | media | Un initdb más 43 migraciones por cada archivo de prueba (~2,5 s × 110) | Directorio de datos plantilla con clave hash de migraciones; concurrencia configurable | B | 4 |
| platform-code-05 | alta | Matriz B10: 472 celdas, 161 sin cubrir, unas 26 rondas | Suites parametrizadas, oráculo de invariantes, R-GAP para niveles 2 y 3 | B + D | 4 + carriles |
| platform-code-06 | media | La familia más grande de hallazgos es la evidencia de prueba débil | `revert-check`/`red-proof` y una pasada Sonnet con la tabla de familias | B | 5–6 |
| platform-code-07 | baja | Re-revisiones de paquetes aceptados (ya resuelto por A6). El README no tiene B10 ni B11 | `acceptance-touch.mjs`; filas del README | S-C | 2 |
| platform-code-08 | media | Instantes del proveedor comparados con desfase cero (PayPal) | Tolerancia con nombre (p. ej. 120 s) y pruebas en N-1 y N+1 | B | 3 |
| platform-code-09 | media | La prueba de navegador está fuera de la verificación; las pantallas de B11 etapa 2 no existen | `verify:browser` al cierre de cada paquete | B | 3 |
| platform-code-10 | media | Windows en cada push de PR (unos 40 minutos facturables) | Decisión del dueño D-03 | D | 0,5 |
| platform-code-11 | media | Choques de números de migración entre carriles | Renumeración mecánica (no se pueden reservar rangos, runner.ts:66) | B | 1 |
| platform-code-12 | baja | `.catch(() => undefined)` en cmd048 y execution-world | Afirmar el SQLSTATE; lint | B | 1 |
| platform-code-13 | baja | Faltan los paquetes @kauro/reports, ops y workers | Crear @kauro/reports puro; PDF en el worker | B | 2 |

### 5.2 Migration Core (B02)
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| migration-core-01 | crítica | IC compilado contra MC 2.0.1 con config 2.0.0; MC 3.0.0 lo rechaza (load-config.ts:142) | Puerto en `ic/b04-integrate`. Espacios en blanco decididos por primitiva, nunca un `trim:true` general. Vendorizar solo el activo publicado | B | 8 |
| migration-core-02 | crítica | La cadena reutilizó el mergedSha del PR #15, por eso el PR #16 nunca se fusionó | Carpeta de trabajo nueva, KAURO_PR=16; arreglo de código de merge.check y del estado por PR | B | 1 |
| migration-core-03 | crítica | `consumer-check.mjs:124` tiene "2.0.3" escrito: falla con 3.0.0 (reproducido) | Leer la versión de package.json; paso en evidence-rules | B | 0,5 |
| migration-core-04 | alta | El ensayo (rehearsal) no es una puerta y su GitHub simulado está desactualizado (ids 1000 vs 2000) | Arreglar los ids; los 6 escenarios en CI; regla: ninguna cadena real sin los 6 ensayos en verde | B | 1,5 |
| migration-core-05 | alta | Universo y sabotaje ligados a todo el manifiesto: cualquier cambio de herramientas vuelve a correr de 3 a 5,6 h | Después de 3.0.0: hash con lista de exclusión, `--reuse-sabotage`, DECISIONS y Codex | S-D | 7 |
| migration-core-06 | alta | Sabotaje en serie (128 mutaciones × suite completa) | `--workers`, pruebas apuntadas primero (después de 3.0.0) | S-D | 6 |
| migration-core-07 | alta | El sabotaje no depende de los trabajos baratos | `needs: [core-gate, evidence-rules, drift, candidate-preflight]`, etiqueta en PR; mantener Windows node 22 | S-D | 1,5 |
| migration-core-08 | media | Tiempos límite de la cadena menores que la duración real (120/100 min frente a 200–330) | 300/480 en el commit de la versión | B | 0,5 |
| migration-core-09 | media | 15.000 líneas de herramientas de publicación generan los defectos | Congelar después de 3.0.0 | B | 0 |
| migration-core-10 | media | El detalle de error de la cadena llega ilegible ("] \| }") | Extraer la primera línea con FAIL/Error y la ruta del log | B | 0,3 |
| migration-core-11 | media | Faltan unos 490 minutos facturables para publicar | El dueño sube el tope | D | 0,1 |
| migration-core-12 | baja | El tarball lleva dist/test; los documentos de la plataforma citan 2.0.3 | Envoltorio @kauro/migration-core en B05 | B | 1 |
| V-mc-A | media | `pack.mjs` sin compilar empaqueta sin dist sin avisar (sha 5587927d) | Que se niegue; vendorizar el tgz del dossier verificado por sha | S-D | 0,5 |
| V-mc-B | media | La fusión con rebase reescribe los SHAs: main repite 3,7 h de sabotaje | Reutilización por hash (S-D); por ahora, aceptarlo | S-D | — |

### 5.3 Intelligence Core (B03/B04)
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| intelligence-core-01 | crítica | Fusionar el PR #12 deja 8 verdades inalcanzables (k03 BOM/ZWSP) y `--check` sigue diciendo "válido" | Primero arreglar el motor (columnHeader = headerRaw), luego plantilla y resellado; validez 660/660 | B | 4–6 |
| intelligence-core-02 | crítica | IC fija MC 2.0.1: una calificación previa no sirve para B05 | Puerto a 3.0.0 desde el activo publicado; enmendar D4-REL-1 | B | 14–20 |
| intelligence-core-03 | alta | El PR #12 tiene 4 anclas de sabotaje obsoletas; su CI quemó unos 580 minutos | No volver a hacer push; arreglar inventarios; plegar en la rama de integración | B | 1,5 |
| intelligence-core-04 | alta | El registro de validez no se liga al motor, a MC ni a los prompts | Preflight que vuelve a correr la validez sobre el tarball empaquetado; registro v4 | B | 3 |
| intelligence-core-05 | media | Lo calificado (0.6.0-rc.1) no sería lo publicado | Proponer en la revisión delta empaquetar 0.6.0 y guardar la calificación fuera de los bytes | B | 2–3 |
| intelligence-core-06 | alta | Corridas frágiles: reintentos de 50/200 ms, sin reanudación, lock que solo el dueño puede quitar | Espera de 2 s y 8 s para 429/503/529; capa de caos; recuperación del lock con pid, host y boot id; correr en Windows nativo o en una VM | B | 5 |
| intelligence-core-07 | media | Un alto duro en el piloto detiene a ambos candidatos | Mantener el alto; reducir los altos falsos (04 y 06) | B | 1–2 |
| intelligence-core-08 | media | Sabotaje de unos 960 minutos de runner por candidato; selección por mutación lo baja a 10–20 min | Fase A con pruebas propias y fase B completa solo si sobrevive (después de B04) | S-D | 5 |
| intelligence-core-09 | media | Subvenciones sin margen para una corrida de repuesto | Una subvención combinada: A = USD 40, B = 4 corridas (Sonnet USD 120), alerta de facturación | D | 0,5 |
| intelligence-core-10 | media | La forma de lectura del logging no está verificada; los tokens tampoco | Sondas gratis el día 1 (fetchPublisherModelConfig v1/v1beta1, count-tokens) | B | 2 |
| intelligence-core-11 | media | Fixtures en secuencia: 4–7 h por corrida | `--concurrency ≤ 3` solo si el p50 pasa de 15 s | B | 3 |
| intelligence-core-12 | media | Run huérfano 37233396440 ocupa el runner | Cancelar; borrar la rama ic/ci-request-test | B | 0,2 |
| intelligence-core-13 | media | Secuencia: integrar todo antes de un único sabotaje y un único Codex | `ic/b04-integrate`; congelar el árbol al empezar el smoke | B | 1 |
| intelligence-core-14 | baja | La plomería de CI se llevó 7 rondas de Codex | Congelar ci.yml después del PR de CI | B | 0 |
| V-ic-A | alta | Los 429 sin usage retienen el cargo máximo y pueden disparar la regla 3 (STOP) | Tratar el 429 como no aceptación documentada (liberar o acotar la retención) | B | 2 |
| V-ic-B | media | `ubuntu-latest` cambiaría de imagen el 19-oct (**dato sin verificar**) | Fijar ubuntu-24.04 solo en trabajos sin matriz; en los de matriz, fijar renombra contextos obligatorios y requiere D-10 en la misma hora de la fusión | B | 0,5 |

### 5.4 CI y GitHub
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| ci-github-01 | crítica | El PR #11 queda `clean` con sabotaje y arquitectura **omitidos** (c714f37 nunca revisado; revirtió ICB-R2) | El agregador falla con "NOT REQUESTED"; merge-pr-when-green exige `success` de los contextos obligatorios | B | 2 |
| ci-github-02 | crítica | Run 37233396440 bloquea el único runner | Cancelar | B | 0,1 |
| ci-github-03 | alta | Un solo runner, sin keepalive | Tarea de keepalive, `memory=7–8GB`, una sola instancia, sondeo previo y alerta de cola de más de 15 min | B + D | 2 |
| ci-github-04 | alta | Presupuesto de Actions casi agotado | El dueño sube el tope a USD 60–100; diario de minutos | D | 0,1 |
| ci-github-05 | media | El mismo árbol se verifica 2 o 3 veces | Reutilizar por árbol completo (nunca un subconjunto), primero en la plataforma | B | 3 |
| ci-github-06 | alta | 3 rojos en árboles que ya habían pasado | Anotaciones por prueba; barreras en pg_locks; estrés local 30 veces; nunca poner en cuarentena | B | 5 |
| ci-github-07 | alta | El ci.yml de main en IC corre el sabotaje dos veces; el PR #12 lo usa | PR "CI: candidate evidence" primero | B | 1,5 |
| ci-github-08 | media | Sin política de tiempos límite | Shards: 45 min autoalojados y 120 en hosted; plataforma 20/45; tabla de duraciones | B | 0,5 |
| ci-github-09 | media | Sabotaje de MC sin `needs` | Después de la etiqueta 3.0.0 | S-D | 2 |
| ci-github-10 | media | ubuntu-latest cambiaría de imagen el 19-oct (sin verificar) | Fijar imágenes en trabajos sin matriz; matriz solo con D-10 | B | 0,5 |
| ci-github-11 | media | El runner autoalojado acepta código de PRs del mismo repo | Solo push:main y dispatch; guarda de workflows | B | 1 |
| ci-github-12 | media | Comprobaciones obligatorias de la plataforma y MC sin `integration_id` | Fijar 15368 en los rulesets | D | 0,2 |
| ci-github-13 | media | El nivel "barato" de IC tarda unos 20 min | Puerta rápida; autoprueba de arquitectura solo si cambia | B | 1 |
| ci-github-14 | media | CI mezclado con los PRs de paquetes | Regla "CI:"; guarda | B | 0,3 |
| ci-github-15 | media | Fallos opacos ("exit code 1") | JUnit y anotaciones `::error` | B | 1 |
| ci-github-16 | media | No hay CD | deploy.yml con WIF, Artifact Registry, Terraform y migración como Job | S-A | 8 |
| ci-github-17 | baja | El zip de PG17 en Windows se descarga sin checksum | Fijar SHA-256 y caché | S-A | 0,3 |
| ci-github-18 | baja | La concurrencia en main puede cancelar un run pendiente | Grupo por SHA en main | B | 0,2 |
| ci-github-19 | baja | Auto-merge apagado | Solo después de ci-github-01; mejor un merge-train propio | B | — |
| ci-github-20 | media | Windows en hosted y además local | Runner Windows autoalojado (después del 19-oct, por RAM) | D | — |
| ci-github-21 | baja | Shards desbalanceados | Solo si vuelve el sharding en hosted | B | 1 |
| V-ci-A | media | `cancel-in-progress: true` en el main de la plataforma | Quitarlo en main | B | 0,5 |

### 5.5 Herramientas del constructor
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| builder-tooling-01 | crítica | `state.json` compartido entre PRs (= migration-core-02) | No fusionar a mano; workName por PR; merge.check contra /pulls | B | 1,5 |
| builder-tooling-02 | crítica | Presupuesto: Windows al doble de costo más el sabotaje hosted de MC (unos 220 min por push) | Sabotaje de MC al runner del PC (después de la etiqueta); el dueño sube el tope | B + D | 3 |
| builder-tooling-03 | alta | Sin keepalive ni watchdog del runner | Tarea, timer de systemd, registro de memoria | B | 2 |
| builder-tooling-04 | alta | 12 shards en serie, tiempo límite de 600 min | Tiempo límite de 60 min autoalojado; guarda que cancela ante mutaciones reales; segundo runner solo con medición | B | 1,5 |
| builder-tooling-05 | alta | 25 de 27 re-revisiones fueron arreglos parciales | `counterexamples[]` e `invariant` en el esquema; `--rootcause` desde la ronda 3; pre-revisión | B | 3 |
| builder-tooling-06 | alta | 33 verificaciones para 22 shas; capacidad de Codex sin reintento | `verify-run.sh` con caché; reintento de Codex sin volver a verificar | B | 2 |
| builder-tooling-07 | alta | Sin semáforo de trabajos pesados entre sistemas operativos | Un lock de verificación compartido; semáforo aparte para sabotaje; espera acotada | B | 2 |
| builder-tooling-08 | alta | Sin vigilancia de main rojo | main-watch (en el builder-os) y anotaciones | B | 2,5 |
| builder-tooling-09 | media | Encuestadores de fusión frágiles | `merge-train.mjs` supervisado | B | 3 |
| builder-tooling-10 | alta | Sin supervisor de trabajos; Windows no verificado sobre el commit exacto | kjob/systemd-run; `win-verify.ps1` con un clon limpio por sha | B | 4 |
| builder-tooling-11 | media | Sin puerta de push | Hooks del builder-os | B | 1,5 |
| builder-tooling-12 | media | ci-local sin pipefail, ignora `if:` y `runs-on` | `-eo pipefail`; filtrar por OS; fallar si el fetch falla | B | 3 |
| builder-tooling-13 | media | La verificación corre los chequeos baratos al final | `verify:fast` primero | B | 1 |
| builder-tooling-14 | media | El harness de revisión ignora fallos de preparación y usa briefs sin fijar | `review next <lane>`; brief fijado a un sha; comprobar códigos de salida | B | 3 |
| builder-tooling-15 | media | Sin prueba de fallo sin el arreglo | `tools/red-proof.mjs` | B | 3 |
| builder-tooling-16 | media | Cuota pasiva | `quota-pace.mjs` (en el builder-os) | B | 0,5 |
| builder-tooling-17 | media | Sin métricas diarias | `metrics/daily.mjs` y STATUS.md | S-C | 2 |
| builder-tooling-18 | baja | Diagnóstico de la cadena pobre | Logs por nodo | B | 1 |
| V-tool-A | crítica | IC PR #12 rojo y bloqueado desde el 03-oct; el ACCEPT de Codex es sobre 7188a0c, no sobre la cabeza | Plegar en la rama de integración; la fusión exige ACCEPT = cabeza | B | 1–2 |

### 5.6 Autoridad y proceso
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| authority-process-01 | crítica | B00 sin mapa de casos: leído literalmente, nada pasa a ACCEPTED | `B00-case-map.md` con evidencia; R2-115 en N/A solo si el dueño firma A7 | B + D | 2,5 |
| authority-process-02 | alta | Puertas de calidad mal asignadas en 7 paquetes; `package-brief` filtra mal (B16 sin G-TENANT ni CMD003-007/038) | Unión de las puertas de sus casos; prueba sobre los 22 paquetes | S-C | 1,5 |
| authority-process-03 | alta | El libro de 441 casos no existe | Normalizar los mapas y crear `ledger.mjs` | S-C | 10–12 |
| authority-process-04 | alta | Hasta 4 verificaciones del mismo commit | `--verify-receipt`; el dueño decide si CI Windows sustituye a la verificación local | B + D | 3 |
| authority-process-05 | alta | "Tocado" no está definido; 655 archivos cambiados después de B06-B09 | A7 §3: se revisa dentro del paquete posterior; solo se reabre si cambian pruebas citadas o filas | D | 1 |
| authority-process-06 | alta | El 54 % de las celdas abiertas de B10 son mecanismos compartidos | 6 suites parametrizadas sin enmienda, con inyección por paso | B | 10–12 |
| authority-process-07 | alta | Codex encuentra una familia por ronda | Esquema con familia y rutas análogas; barrido en la re-revisión; A7 §5 | B + D | 1,5 |
| authority-process-08 | alta | Decisiones del dueño abiertas | Hoja de decisiones antes del 07-oct (sección 8) | D | 2,5 |
| authority-process-09 | alta | B16 sin empezar; unos 38–45 casos se pueden hacer localmente | Carril B16 local (S-C) | S | 20 |
| authority-process-10 | media | 8 ítems de evidencia sin asignar a artefactos | A7 §4b: paquete de evidence.mjs más el JSON de la revisión | B | 3 |
| authority-process-11 | media | Alcance de la revisión B18 sin definir | A7 §9 | B | 1 |
| authority-process-12 | media | Manuales 23 y 30 y CH-009 no marcados como reemplazados | A7 §10 | B | 1,5 |
| authority-process-13 | media | B17 puede reutilizar evidencia de importadores reales | EquivalenceReceipt cuando el diff de MC no toca la ruta | B | 4 |
| authority-process-14 | baja | A2 regla 3 contra regla 5 (cases.json) | A7 §11 | B | 0,5 |
| authority-process-15 | baja | B05 depende de B04 | Integrar B05 sobre el rc | B | 0 |
| V-auth-A | media | El mapa de casos de MC dice 2.0.3 REJECT | Volver a encabezarlo con 3.0.0 | B | 1 |
| V-auth-B | media | Mapas de casos en 3 formatos incompatibles | Esquema único (S-C, antes del libro) | S-C | 3 |
| V-auth-C | media | `package-review.sh` arma el brief de los cores desde un worktree viejo | Checkout fresco al sha; imprimir "registry @ sha" | B | 0,5 |

### 5.7 Camino crítico y calendario
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| critical-path-1 | alta | 22 comandos y 7 adaptadores (6 de S-B más el host del worker de B) sin construir en la cadena serial | Construir por adelantado con prioridades y contrato de carriles; ganancia de unos 4–5 días | B + S | 120 |
| critical-path-2 | crítica | Proyección actual: 30-oct | Plan diario vinculante (PLAN_MAESTRO) | B | 2 |
| critical-path-3 | crítica | Presupuesto para unas 9 fusiones | El dueño sube el tope; el PR de CI de IC a main; sabotaje bajo petición | D + B | 2 |
| critical-path-4 | alta | B10 sin criterio de cierre | Los 64 casos + nivel 1 + CONS_*/SWEEP_CRASH de fondos; el resto, con resolución | B | 30 |
| critical-path-5 | alta | Bloqueadores baratos de hoy | Ver la fase 0 del PROMPT_CONSTRUCTOR | B | 4 |
| critical-path-6 | alta | B04 necesita 2 subvenciones en serie | Una subvención combinada | D | 0,5 |
| critical-path-7 | alta | B14 sin empezar | S-A desde el 06-oct; aplicar cuando exista el proyecto | S-A | 30 |
| critical-path-8 | alta | Atascos de cuota; las sesiones comparten la cuota | 10–13 %/día con tope de 15 %; Sonnet construye, Opus diseña | B | 1 |
| critical-path-9 | alta | Unas 4 rondas por unidad | Autorrevisión de 7 familias; "quitar la guarda y que falle" | B | 3 |
| critical-path-10 | media | Choques de migraciones y archivos generados | Renumeración y regeneración en la fusión | B | 2 |
| critical-path-11 | media | B16 y B17 se pueden calificar antes de B15 | Planificado en PLAN_MAESTRO | B | 2 |
| critical-path-12 | media | ubuntu-latest cambiaría de imagen (sin verificar) | Fijar sin romper contextos (ver V-ic-B) | B | 0,5 |
| critical-path-13 | media | main rojo dos veces el 04-oct | Ver platform-code-01 y ci-github-06 | B | 4 |
| critical-path-14 | baja | El 19-oct no está registrado frente a A4 | El dueño lo registra (A7 §8) | D | 0,5 |
| V-cp-A | alta | La cuota de hoy ya está en el 85 % | 05-oct: solo P0 y pasos con script, hasta 6 % | B | — |
| V-cp-B | alta | A4 pone todos los actos del dueño el 08-oct | Rama del plan según cuándo existan GCP/Vertex | D | — |

### 5.8 Seguridad y privacidad
| id | sev | qué y evidencia | recomendación | ej | h |
|---|---|---|---|---|---|
| security-privacy-01 | alta | La calificación escribió en un HubSpot real (portal 51050101): quedan 6 propiedades, una de ellas única, y no hay prueba de que el token esté revocado | Recuperar el acceso o pedir al super admin que archive las propiedades y rote la app; evidencia REMOVE | D | 2,5 |
| security-privacy-02 | alta | No existen Secret Manager, WIF, cuentas de servicio por carga ni Terraform | S-A: carril base de B14 con inventario de secretos | S-A | 12–14 |
| security-privacy-03 | media | B16 sin cobertura previa | `B16-precoverage.md` (S-C) | S-C | 7 |
| security-privacy-04 | media | El CI de MC da tokens con escritura a los PRs | Tokens de solo lectura en un Environment `vendor-readonly` | D + B | 1,5 |
| security-privacy-05 | media | Sin `pnpm audit` en la plataforma ni escaneo de secretos | Trabajo de auditoría de dependencias; gitleaks antes del push | B | 1,5 |
| security-privacy-06 | media | Todos los agentes usan el token completo del dueño | Proteger main; PAT de grano fino | D | 1,5 |
| security-privacy-07 | media | El almacén DPAPI del PC lo puede leer cualquier agente | Política: en el PC solo credenciales de sandbox; las de producción directo a Secret Manager | D | 0,5 |
| security-privacy-08 | baja | Restos sensibles en kauro-local y en el backup D: | Retirar los zips y los mirrors; cifrar el archivo de D: | B + D | 1 |
| security-privacy-09 | baja | Canarios con formato realista | `gitleaks:allow` | B | 0,3 |
| V-sec-A | alta | READY_TO_CONNECT pide `gcloud auth login` con el usuario Owner | Suplantar a una cuenta deployer; revocar al usuario | D + B | 0,8 |

### 5.9 Builder OS (corregido en esta auditoría)
| id | sev | qué | estado | ej | h |
|---|---|---|---|---|---|
| builder-os-01 | crítica | main rojo sin vigilancia | Hooks main-watch y P0 listos; **primero el arreglo P0, después los hooks**; nunca revertir la protección de fondos | B | 4 |
| builder-os-02 | alta | No hay CLAUDE.md, hooks, agentes ni skills | Paquete corregido: un run cancelado no es rojo; P0 bloquea solo fusiones; la guarda Stop permite parar con el arreglo en curso; árbol limpio en los recibos; runner ocupado cuenta peso 1. **Probado en sandbox** | B | 3 |
| builder-os-03 | media | Contexto releído | `doc-slice` y paquetes de contexto de 3k | B | 0,5 |
| builder-os-04 | alta | Bucles con Codex | Adversario y `red-proof` obligatorios; las salvedades se listan con su prueba | B | 1 |
| builder-os-05 | alta | B10 puede comerse la semana | 3 carriles por archivo más un carril de kit | B | 2 |
| builder-os-06 | alta | B05 sin empezar; puertos de 2.0.3 | Skill b05-integrate (ya actualizado) | B | 12 |
| builder-os-07 | alta | El runner muere con WSL | Keepalive con disparador repetitivo | D | 0,5 |
| builder-os-08 | alta | Sin puerta de trabajos pesados | `run-heavy` con árbol limpio y runner contado | B | 0,5 |
| builder-os-09 | alta | Cada push cuesta dinero | PR de CI de IC; etiqueta de sabotaje en la cabeza final | B | 1 |
| builder-os-10 | alta | Ritmo de cuota manual | `quota-pace` | B | 0,5 |
| builder-os-11 | media | Scripts que reportan verde en falso (`tail` al final) | `exit $rc` | B | 1 |
| builder-os-12 | alta | El PC limita el paralelismo | Sesiones S-A, S-B, S-C (prompts listos) | S | 1 |
| builder-os-13 a 16 | media | Inactividad, publicación atada a un agente vivo, sin traspaso, carreras intermitentes | board.json, release-oneshot, HANDOFF, prueba de inestabilidad 20 veces | B | 4 |
| builder-os-17 | alta | `run-heavy` no se desacoplaba: la publicación podía morir con la sesión (fallo #6) | `--detached` obligatorio para mc-universe, mc-chain, b04-run y sabotage-full; mc-universe estimado en 340 min. **Probado en sandbox** | B | — (hecho) |
| builder-os-18 | alta | Un error de capacidad de Codex quemaba una ronda y bloqueaba el reintento | Solo cuenta una ronda con veredicto parseado de `review.json`; un fallo de infraestructura permite reintentar el mismo sha. **Probado** | B | — (hecho) |
| builder-os-19 | alta | La puerta de subvención de B04 siempre pasaba (solo miraba si existía `grants.md`) | Exige una fila aprobada del alcance (B04) con saldo ≥ `--est-usd`. **Probado** | B | — (hecho) |
| builder-os-20 | alta | `main-watch` leía el último run de cualquier workflow: P0 falso con `deploy.yml`, P0 tapado por un deploy verde, facturación como P0 | Filtro por workflow (verify.yml / ci.yml) y head sha; facturación agotada = BLOCKED_OWNER, no P0 | B | — (hecho) |
| builder-os-21 | media | stop-guard y el tablero sembrado empujaban carriles antes del plan (riesgo de repetir el 29-sep) | `notBefore` por carril; ruta del arnés del P0 corregida; sin `0044_*` fijo; GREEN = 4 subagentes + coordinador | B | — (hecho) |
| builder-os-22 | media | quota-pace podía fallar en Windows y dejar al constructor en AMBER; timeouts mayores que el del hook | fetch a 5 s, stop-guard a 10 s, respaldo manual `quota-manual.json`, smoke test en README-INSTALL | B | — (hecho) |
| builder-os-23 | media | El check-in cada 2 h era un turno Opus (12 al día) sin costear | `checkin.mjs`: script que despierta a Claude (Sonnet) solo si algo cambió | B | 2 |

### 5.10 Entorno local (PC)
| id | sev | qué | recomendación | ej | h |
|---|---|---|---|---|---|
| local-env-01 | alta | Sin keepalive de WSL desde el retiro | Tarea al inicio de sesión y cada 5 min; drop-in Restart=always; telemetría al inicio de cada job | B | 1,5 |
| local-env-02 | alta | La presión de memoria mata verificaciones | `memory=7GB`; límites del runner; nunca matar un shard en curso; lock solo entre verificaciones completas | B + D | 2 |
| local-env-03 | media | Windows Update y cortes de luz | Pausar actualizaciones hasta el 20-oct; BIOS que enciende con corriente; sin Autologon; reanudar a mano con STATE.md | D | 0,75 |
| local-env-04 | media | El ensayo del plan de B04 (428fa0b, 0db74ad) existe solo en kauro-local | Etiqueta `preserve/ic-b04-plan-rehearsal`; incorporarlo como herramienta SIMULATED | B | 1 |
| local-env-05 | media | 250 MB de autoridad vieja ("Kavo", 23/28-oct) en el árbol de trabajo | Fase 2 del retiro (después del keepalive); regla de búsqueda en CLAUDE.md | B | 1 |
| local-env-06 | media | La fase 2 quita el keepalive y recicla memorias | Orden: lecciones, keepalive, fase 2 con el runner libre | B | 0,5 |
| local-env-07 | media | Windows 30–45 % más lento; Defender | Exclusiones de Defender | D | 0,3 |
| local-env-08 | media | Un solo runner en serie | Volver a correr solo los shards fallidos; sabotaje solo del candidato | B | 1 |
| local-env-09 | media | IC vendoriza kavo-migration-core | Incluido en `ic/b04-integrate` | B | 3 |
| local-env-10 | media | El dossier de 3.0.0 existe solo en el PC | Copia en D:, verificada | B | 0,2 |
| local-env-11 | baja | Disco y VHDX sin vigilar | Sondeo de salud cada 15 min | B | 0,5 |
| local-env-12 | baja | kauro-local triplica ramas | README "no es fuente de verdad" | B | 0,3 |

---

## 6. Factibilidad honesta del 19-oct

| Escenario | Producción probable (P50) | Pesimista (P90) | Margen al 19-oct |
|---|---|---|---|
| Ritmo actual, sin cambios | 30-oct | 03-nov | −11 días |
| Solo se arreglan los rojos de hoy | ~25-oct | ~29-oct | −6 días |
| **Todo el plan, con los actos del dueño ya hechos** (GCP con facturación, Vertex/Model Garden, sandboxes de PayPal, Alegra y Resend) | **sáb 17-oct** | lun 19-oct | **+2 días** |
| Todo el plan, pero los actos del dueño recién el 08-oct (calendario A4) | lun 19-oct | ~21-oct | 0 días |

**Condiciones del 19-oct con margen (todas necesarias):**
1. `main` en verde el martes 06-oct a las 12:00 (Bogotá), y estable: cero rojos que no se diagnostiquen.
2. El tope de Actions subido hoy (USD 100), confirmado antes de cualquier push de PR. Las comprobaciones obligatorias fallan cuando falta la evidencia. El sabotaje corre solo bajo petición en el runner del PC, con keepalive.
3. v3.0.0 publicada el miércoles 07-oct.
4. IC portado a 3.0.0 y revisión delta de Codex aceptada el jueves 08-oct. Las 3 corridas de B04 terminadas el sábado 10-oct.
5. B10 enviado a cierre el jueves 08-oct y cerrado el viernes 09-oct.
6. Adaptadores, B12 y B13 fusionados el domingo 11-oct; comandos de B16, B17 y B18 el martes 13-oct.
7. Cuota planificada en 12 %/día para todas las sesiones juntas (constructor 9 %, cada sesión paralela 1 %), con tope duro de 13 % y un orden de recorte escrito (PLAN_MAESTRO §2), y como máximo 2 rondas de Codex por unidad.
8. El dueño firma la hoja de decisiones antes del 07-oct a las 18:00 y responde las tarjetas en menos de 4 h hábiles.

Si cualquiera de las condiciones 1 a 4 se atrasa un día, el margen se consume día por día. La fecha de respaldo es el 23-oct (objetivo A4); la fecha límite dura, el 28-oct.

---

## 7. Riesgos principales

| # | Riesgo | Probabilidad | Impacto | Señal temprana | Contingencia |
|---|---|---|---|---|---|
| R1 | B04 no alcanza un umbral (soportados ≥ 0,97 o abstención ≥ 0,99) | media | 2–3 días | resultados del piloto | B05 sigue sobre 0.6.0; diagnóstico; la nueva corrida va en paralelo, fuera del camino de construcción |
| R2 | Se agota la cuota de Claude a mitad de semana | media | 2–3 días | quota-pace en AMBER dos veces seguidas | Pausar S-C, después S-B; Opus solo para el adversario; nada de abanicos |
| R3 | Se agota el presupuesto de Actions | alta si no se actúa | 1–3 días | un PR pasa de 3 runs, o un run falla por facturación (main-watch lo marca BLOCKED_OWNER, no P0) | El dueño sube el tope; sabotaje en el PC; Windows solo en el candidato |
| R4 | Siguen los rojos intermitentes en main | media | medio día cada uno | anotaciones de CI | `stress-cells`, barreras en pg_locks, P0 inmediato |
| R5 | La publicación de MC vuelve a fallar | baja tras el arreglo | 1 día | un ensayo en rojo | Ningún lanzamiento real sin los 6 ensayos en verde |
| R6 | Los actos del dueño en GCP, PayPal o Alegra se atrasan | media | 2 días | tarjeta sin respuesta 4 h | Construir contra el simulador; aplicar B14 apenas exista el proyecto; mover B15 un día y usar el colchón |
| R7 | El PC se apaga (actualización, luz, OOM) | media | 0,5–1 noche | sondeo de salud | Keepalive, pausa de actualizaciones, BIOS, STATE.md |
| R8 | Choques entre sesiones paralelas | media | medio día | conflictos al rebasar | Contrato de archivos, renumeración, regeneración solo en la fusión |
| R9 | Codex rechaza A7 o las suites parametrizadas | baja | 1 día | revisión de diseño | Enviar el diseño de la suite antes del código |
| R10 | Propiedades en el HubSpot real (reputación) | ya ocurrió | legal/reputación | — | El dueño contacta al dueño del portal esta semana |

---

## 8. Lo que el dueño tiene que decidir o hacer (y nada más)

| id | Acto | Cuándo | Tiempo |
|---|---|---|---|
| D-01 | Subir el tope de Actions a **USD 100** para octubre (Settings → Billing → Spending limits). Cuentas: unos 40 PRs de la plataforma × 3 runs × USD 0,50 ≈ USD 60, más MC ≈ USD 5 (la publicación de 3.0.0 son unos 550 minutos facturables) e IC; quedan USD 7,50. **Puerta dura:** sin esta confirmación no sale el push del PR #16 el 06 | hoy | 5 min |
| D-02 | Instalar el keepalive en PowerShell elevado; pausar Windows Update hasta el 20-oct; BIOS "Restore on AC power loss = On" | hoy | 20 min |
| D-03 | Windows en CI: ¿en cada PR (actual) o solo en el candidato final y en main? Recomendado: candidato y main. Ojo: si Windows corre solo con etiqueta, el contexto obligatorio omitido contaría como aprobado; por eso merge-train exige un run de Windows con `success` sobre la cabeza final | 06-oct | 5 min |
| D-04 | Una subvención combinada para B04: A = USD 40, B = hasta USD 120 (Sonnet) para 4 corridas, recalculada a la baja con el piloto; Opus necesita una nueva aprobación. Alerta de facturación en GCP | 06-oct | 10 min |
| D-05 | Resolución R-GAP: los niveles 2 y 3 de la matriz B10 que no tocan dinero se difieren a B16 | 06-oct | 15 min |
| D-06 | Firmar A7 (redacta el constructor): B00, "tocado", cláusulas heredadas, verificación de registro (recomendado en §4a: el CI Windows en verde sobre el sha exacto reemplaza la verificación local de Windows al cerrar un paquete; ahorra unas 10 h de PC exclusivo), alcance de B18, tipos de revisión Codex, delegación de diseño, 19-oct como objetivo interno | 07-oct | 30 min |
| D-07 | Autorizar que Claude fusione, etiquete y publique versiones de los 3 repos cuando A4 (b)–(d) esté en verde (sin force, notificando) | 06-oct | 5 min |
| D-08 | Fecha de corte fiscal Alegra frente al puente DIAN: 12-oct. Ruta de revisión legal de los contratos | 07-oct | 15 min |
| D-09 | Proyecto GCP con facturación, Model Garden (Sonnet/Opus), permiso `serviceAccountTokenCreator` sobre la cuenta deployer (no `gcloud auth login` de Owner en el PC) | lo antes posible (A4: 08-oct) | 30 min |
| D-10 | Proteger main en los 3 repos; PAT de grano fino para el constructor; `integration_id` 15368 en los rulesets. **Además, cada vez que una imagen de matriz se fije, editar el contexto obligatorio en la misma hora de la fusión** (todos los rulesets usan `strict`). Contextos exactos hoy: plataforma, ruleset 24468235: `verify (ubuntu-24.04)`, `verify (windows-latest)` (pasaría a `verify (windows-2025)`). MC, ruleset 21822071: `gate (ubuntu-latest, node 22)`, `gate (ubuntu-latest, node 24)`, `gate (windows-latest, node 22)`, `gate (windows-latest, node 24)`, más `architecture closure (ARCHITECTURE-01)`, `sabotage`, `dependency audit`, `document drift (DRIFT-01)`, `evidence rules (EVIDENCE-RULES-01)`, `candidate preflight (RELEASE-CANDIDATE-01)`. IC, ruleset 22920889: `gate (ubuntu-latest, node 24)`, `gate (windows-latest, node 24)`, más `sabotage (INTELLIGENCE-SABOTAGE-01)`, `architecture closure (INTELLIGENCE-ARCHITECTURE-01)`, `dependency audit`. En MC no se toca nada antes de v3.0.0 | 07-oct (y con cada fijado) | 30 min |
| D-11 | HubSpot portal 51050101: recuperar el acceso o pedir al super admin que archive las 6 propiedades `kauro_qualification_*` y rote la app privada | esta semana | 1–2 h |
| D-12 | Tokens de solo lectura de HubSpot y Salesforce para CI | 08-oct | 30 min |

---

## 9. Fortalezas que hay que conservar

- **Base de datos:** RLS forzado en 137 de 139 tablas, 477 políticas, roles sin BYPASSRLS. Invariantes en la base (KC0xx) que convierten un bug en un commit rechazado en vez de dinero corrompido.
- **Arquitectura y contratos:** la puerta de arquitectura (capas, imports profundos, bundle del cliente), los chequeos de deriva de OpenAPI y del cliente web, y el catálogo de respuestas (N13/R23).
- **El arnés de fallos:** evidencia por operación, puntos de caída en el límite del commit, `assertInjected`. Lanes 4 y 5 encontraron 7 defectos reales de dinero.
- **Migration Core:** tarball determinista (sha 2686ee65…), 1.857 pruebas, sabotaje 128/128, recibos leídos de GitHub por id, cadena tipada con reutilización por huella.
- **Intelligence Core:** verdad plantada por el generador, registro de validez barato, sobre de costo exacto a partir de bytes reales, transporte Vertex mínimo sin SDK, sin claves JSON de cuenta de servicio.
- **CI:** acciones fijadas por SHA, `persist-credentials: false`, permisos de solo lectura, el árbol de trabajo debe quedar intacto, ci-local deriva sus pasos del propio ci.yml.
- **Proceso:** A6 (lo aceptado queda ligado a su commit); `incidents.md` con "chequeo barato agregado"; la plantilla de la matriz de fallos con 10 reglas de familias; Codex con usuario y sandbox propios; clases de evidencia honestas (SIMULATED nunca se presenta como ejecución real).

---

## 10. Entregables de esta auditoría

- `PLAN_MAESTRO.md`: plan día por día del 06 al 19-oct, grafo de dependencias, puntos de control, contingencias.
- `PROMPT_CONSTRUCTOR.md`: el prompt único para pegar en la sesión del constructor.
- `PROMPT_SESION_PARALELA.md`: los prompts de S-A (B14 infra), S-B (B15 adaptadores), S-C (libro de casos y B16 local) y S-D (eficiencia de CI de los cores, desde el 10-oct).
- `builder-os/`: versión final, corregida y probada en sandbox contra un clon de kauro-platform 4f99a67.
