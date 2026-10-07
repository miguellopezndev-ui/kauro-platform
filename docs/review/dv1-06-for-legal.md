# DV1-06 for legal: text ToS 8.2 must mirror

Source: [ACH-ROUTE r8](../design/ACH-ROUTE.md) §0 DV1-06 (on-time credit confirmed late) and DV1-05 (admission); R2 15 §Price
and source expiry races; owner decision Payments V1 and its Addendum (2026-10-07). For lane LEGAL-V1 (`pw-legal`,
`docs/legal/TERMS_OF_SERVICE.md` §8.2). The legal text must say no more and no less than the safeguards below. Wording may be
adapted to the ToS style; each numbered safeguard must stay recognisable, and none may be added as a promise (no guaranteed
bank timing, no fee promise, no grace period beyond the published tolerance). The tolerance value is route data shown in the
payment instructions; the ToS refers to it, it does not fix a number.

## Texto (español, para TERMS_OF_SERVICE.md §8.2)

**8.2 Cuándo se considera pagado un pedido por transferencia bancaria**

1. Un pedido se considera pagado solo cuando Kauro concilia un abono **recibido** en la cuenta de Kauro por el **monto exacto en
   USD** del pedido, con la referencia del pedido, y verificado con evidencia bancaria. Iniciar o programar una transferencia no es
   confirmación de pago.
2. Las instrucciones de pago muestran una **fecha límite** y una fecha recomendada de envío ("enviar antes de"). Kauro no garantiza
   cuánto tarda el banco del cliente ni el sistema bancario en acreditar la transferencia.
3. Para decidir si el pago llegó a tiempo cuenta la **fecha y hora en que el banco registra el abono**, según el comprobante bancario,
   con el margen técnico indicado en las instrucciones de pago. No cuenta la fecha en que el cliente inició la transferencia, ni la
   fecha en que Kauro termina de conciliarla.
4. Si el abono quedó registrado a tiempo, Kauro respeta el precio aceptado aunque confirme el pago después de la fecha límite,
   **siempre que** al momento de confirmarlo sigan siendo válidos los archivos o la fuente, el destino, el tratamiento legal y fiscal
   y el alcance de entrega del pedido, y el proyecto no tenga otra compra abierta o pagada. Esto no depende de si Kauro ya había
   marcado el pedido como vencido.
5. Si el abono quedó registrado después de ese momento, o alguna de esas condiciones ya no se cumple, Kauro **no inicia el trabajo**:
   registra el dinero recibido y lo **devuelve** conforme a la sección de reembolsos; el cliente puede pedir una nueva cotización.
6. Un pago parcial, un pago mayor, un pago con otra referencia o enviado por un pagador distinto al titular de facturación aceptado
   queda **en revisión**: no habilita el trabajo y se devuelve conforme a la sección de reembolsos. Kauro no pide completar la
   diferencia con un segundo pago.
7. Kauro no pide un segundo pago mientras un pago enviado no esté conciliado. El cliente no debe pagar de nuevo mientras su pago esté
   en camino o en revisión.

## Reference text (English, for review and any English edition)

1. An order is paid only when Kauro reconciles a credit **received** in Kauro's account for the order's **exact USD amount**, with the
   order reference, verified with bank evidence. Initiating or scheduling a transfer is not confirmation of payment.
2. Payment instructions show a **deadline** and a recommended "send by" date. Kauro does not guarantee how long the customer's bank
   or the banking system takes to credit the transfer.
3. Timeliness is decided by **the date and time the bank books the credit**, per the bank evidence, within the technical tolerance
   stated in the payment instructions — not by when the customer initiated the transfer, nor by when Kauro finishes reconciling it.
4. If the credit was booked on time, Kauro honours the accepted price even when it confirms the payment after the deadline,
   **provided that**, when it confirms, the files or source, the target, the legal and fiscal treatment and the delivery scope are
   still valid and the project has no other open or paid purchase. This does not depend on whether Kauro had already marked the
   order as expired.
5. If the credit was booked later, or any of those conditions no longer holds, Kauro **does not start the work**: it records the money
   received and **returns** it under the refund section; the customer may request a new quote.
6. A partial payment, an overpayment, a payment with another reference or sent by a payer other than the accepted billing holder is
   **under review**: it does not enable the work and is returned under the refund section. Kauro does not ask for a top-up payment.
7. Kauro does not request a second payment while a sent payment is unreconciled. The customer should not pay again while a payment is
   in transit or under review.

## Traceability (for the reviewer)
| Safeguard | Design predicate |
|---|---|
| 1 | DV1-05 admission; D-ACH-06 / KP004 exact single capture |
| 2 | DV1-07 `sendBy`; PV1 §5 timing as data, no guarantee |
| 3 | DV1-06 DEADLINE (`bookedAt ≤ transferExpiresAt + providerTimeTolerance`, `bookedAt` from classified evidence) and PROVIDER-TIME |
| 4 | DV1-06 SUBJECT predicate; "one effect for every sweep order" (ACH-R7-05) |
| 5 | DV1-06 failure branch: capture recorded, EXPIRED, return, no authority; R2 15 "otherwise refund and issue a new quote" |
| 6 | D-ACH-06, D-ACH-08 rule 3 with FC-V (payer authorizations LATER) |
| 7 | R2 15 (discourage paying again); PAYMENTS-V1-REPLAN §8 ToS 8.3 |
