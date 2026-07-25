import { PAYMENT_HEADER, X402_SCHEME, X402_VERSION, type PaymentRequirements } from './payment';
import { settlePaymentHeader, type SettleContext, type SettlementResult } from './settle';

export interface PaywalledResource {
  /** URL path, e.g. `/reports/INV-2026-0007`. */
  path: string;
  description: string;
  /** Produce the paid response body once payment has settled. */
  handler: (request: Request, settlement: SettlementResult) => Promise<unknown> | unknown;
}

export interface PaywallServerOptions {
  port: number;
  requirements: PaymentRequirements;
  settleContext: SettleContext;
  resources: PaywalledResource[];
  /** Called after each successful sale (for bookkeeping/dashboards). */
  onSale?: (resourcePath: string, settlement: SettlementResult) => void;
}

/** JSON body of the HTTP 402 response, per x402 V2. */
function paymentRequiredBody(requirements: PaymentRequirements, resourceUrl: string) {
  return {
    x402Version: X402_VERSION,
    error: 'Payment required',
    accepts: [
      {
        ...requirements,
        resource: { url: resourceUrl },
      },
    ],
  };
}

/**
 * Serve x402-paywalled resources: no payment header → HTTP 402 with
 * `PaymentRequirements`; with a payment header → settle on-chain (facilitator
 * or self-settle), then serve the resource plus the settlement receipt.
 */
export function servePaywalled(options: PaywallServerOptions) {
  const routes = new Map(options.resources.map((resource) => [resource.path, resource]));

  return Bun.serve({
    port: options.port,
    idleTimeout: 240,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return Response.json({ ok: true });
      }
      const resource = routes.get(url.pathname);
      if (!resource) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }

      const paymentHeader = request.headers.get(PAYMENT_HEADER);
      if (!paymentHeader) {
        return Response.json(paymentRequiredBody(options.requirements, request.url), {
          status: 402,
        });
      }

      const settlement = await settlePaymentHeader(
        options.settleContext,
        paymentHeader,
        options.requirements,
      );
      if (!settlement.success) {
        return Response.json(
          { error: 'Payment settlement failed', reason: settlement.errorReason },
          { status: 402 },
        );
      }

      options.onSale?.(resource.path, settlement);
      const body = await resource.handler(request, settlement);
      return Response.json(body, {
        headers: {
          'X-PAYMENT-RESPONSE': Buffer.from(
            JSON.stringify({
              success: true,
              transaction: settlement.transactionHash,
              network: options.requirements.network,
            }),
            'utf8',
          ).toString('base64'),
        },
      });
    },
  });
}

/** Buyer-side: fetch a paywalled resource, paying on 402. */
export async function fetchWithPayment(
  url: string,
  createHeader: (requirements: PaymentRequirements) => string,
): Promise<{ response: Response; paid: boolean; requirements?: PaymentRequirements }> {
  const first = await fetch(url);
  if (first.status !== 402) {
    return { response: first, paid: false };
  }
  const body = (await first.json()) as { accepts?: Array<Record<string, unknown>> };
  const accepted = body.accepts?.[0];
  if (!accepted) {
    throw new Error('402 response carried no payment requirements');
  }
  const { resource: _resource, ...requirements } = accepted;
  const paymentRequirements = requirements as unknown as PaymentRequirements;
  const header = createHeader(paymentRequirements);
  const paid = await fetch(url, { headers: { [PAYMENT_HEADER]: header } });
  return { response: paid, paid: true, requirements: paymentRequirements };
}
