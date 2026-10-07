# Plan de la prueba real de ACH (entregable 9b, Pagos V1) — borrador 2026-10-07

Objetivo: confirmar la capacidad del rail V1 de punta a punta (Pagos V1 §2 a-f): un cobro ACH real de un pagador en EE. UU.
a los datos USD de Wise Business de KAURO DATA S.A.S., su conciliación en Kauro, y una devolución controlada con evidencia.

## Precondiciones (todas reales, ninguna supuesta)
1. KAURO DATA S.A.S. registrada (NIT/RUT) — D-14.
2. Wise Business aprobado a nombre de la sociedad; datos USD visibles en la cuenta; la cuenta indica recepción ACH.
3. Kauro en un entorno con la ruta ACH configurada en estado VERIFIED-pending (no ENABLED para clientes).
4. Respuestas del contador sobre cómo registrar el cobro y la devolución (cambiario y DIAN) — o al menos sobre la prueba.

## Pagador
- Necesitamos **una persona o empresa en EE. UU. con cuenta bancaria de EE. UU.** que haga un ACH (no tarjeta, no Zelle a
  persona, no PayPal) a los datos USD de Wise. Debe aceptar recibir la devolución.
- **Bloqueo si no existe:** es un dato del dueño (tarjeta D-25). Alternativas reales: (a) un conocido/cliente piloto en
  EE. UU.; (b) un primer cliente real de bajo monto con su consentimiento explícito de prueba; (c) una cuenta bancaria propia
  en EE. UU. (si el dueño tuviera una) — no se crea ninguna cuenta nueva solo para esto sin decisión del dueño.

## Monto
- Recomendado: **USD 25** (cubre que la devolución se vea como transacción normal; costo de la prueba bajo). Una factura de
  Kauro por USD 25 con referencia única.

## Pasos
1. Kauro emite la factura de prueba (USD 25) con los datos USD y una referencia única; se registra la orden en Kauro.
2. El pagador envía ACH con la referencia. Se registra fecha/hora de envío.
3. Llegada a Wise (esperado: horas, hasta 4 días hábiles según la ayuda oficial). Se descarga el comprobante/extracto.
4. Conciliación en Kauro (entrada manual del rol owner con el comprobante): la orden pasa a pagada **solo** con monto y moneda
   exactos; evidencia guardada; revenue/cash y comisión del vendedor (si aplica) se registran.
5. Devolución controlada: autorización del owner en Kauro; se registra el reembolso (idempotente) **antes** de ejecutar; el
   owner envía desde Wise el reembolso al pagador (USD 25, o el monto que el contador indique si hay costos); se guarda el
   comprobante de salida; Kauro marca "refunded" **solo** con ese comprobante; se ajustan revenue/cash, comisión y evidencia
   fiscal (nota crédito si el contador lo indica).
6. Pruebas negativas en la misma ventana (sin dinero extra): repetir el registro del reembolso con la misma clave no crea un
   segundo reembolso; un reembolso en estado incierto no ofrece "reenviar".
7. Evidencia final: paquete con factura, comprobantes de Wise de entrada y salida, registros de Kauro (orden, conciliación,
   reembolso, asientos), y el resultado de la conciliación sin diferencias.

## Criterio de éxito
Los seis puntos de Pagos V1 §2 se cumplen; cero diferencias en la conciliación; un solo cobro y una sola devolución
registrados; evidencia archivada. Solo entonces la ruta ACH puede pasar a ENABLED y Kauro puede decir públicamente que acepta
ACH.

## Costo esperado
ACH entrante: sin comisión de Wise (ayuda oficial). Salida de la devolución: la que muestre la cuenta Wise al ejecutarla (se
registra). Ningún gasto sin línea en `.kauro/grants.md` si supera lo que el dueño autorice.

## Ajuste del dueño (2026-10-07) — vigente
- Un solo pago de prueba sirve para el cobro y la devolución.
- El cobro se HABILITA cuando: (a) el ACH de ese pago está recibido y conciliado en Kauro, y (b) la devolución de ese mismo
  pago está ENVIADA desde Wise y registrada en Kauro con el comprobante de envío de Wise. No se espera a que llegue a la cuenta
  del pagador; un rebote posterior sigue el flujo normal de rebote (nunca un reenvío mientras esté incierto).
- Pagador: el dueño lo confirma cuando la SAS esté registrada (D-25). Sin pago desde cuenta propia del dueño (R2 15).
- D-26: sin cobro habilitado no hay producción; si Wise no está vivo el 12-oct 20:00, se mueve la fecha.
- Paso 5 y el criterio de éxito de arriba se leen con este ajuste (la devolución cuenta con el comprobante de envío).
