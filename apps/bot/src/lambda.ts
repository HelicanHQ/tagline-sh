import { createProbot } from 'probot';
import app from '~/app/index';

/**
 * AWS Lambda entry point (behind a Lambda Function URL). The long-running
 * server entry (`probot run ./dist/index.js`) is unaffected — Docker and local
 * dev keep using that.
 *
 * Probot reads APP_ID / PRIVATE_KEY / WEBHOOK_SECRET from the environment.
 * The app is loaded once per container, outside the handler, so warm
 * invocations don't register duplicate event handlers.
 */

/** The subset of the Function URL (API Gateway v2) event we use. Headers arrive lowercased. */
interface FunctionUrlEvent {
    rawPath: string;
    headers: Record<string, string | undefined>;
    body?: string;
    isBase64Encoded: boolean;
    requestContext: { http: { method: string } };
}

interface FunctionUrlResult {
    statusCode: number;
    body: string;
}

const probot = createProbot();
const loaded = probot.load(app);

const json = (statusCode: number, body: unknown): FunctionUrlResult => ({
    statusCode,
    body: JSON.stringify(body),
});

/** @octokit/webhooks errors carry `status` (400 bad signature, 500 handler error), usually wrapped in an AggregateError-shaped `{ errors: [...] }`. */
const statusOf = (error: unknown): number | undefined =>
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
        ? error.status
        : undefined;

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const { method } = event.requestContext.http;
    if (method === 'GET' && event.rawPath === '/ping') return json(200, { ok: true });
    if (method !== 'POST' || event.rawPath !== '/api/github/webhooks') {
        return json(404, { error: 'not found' });
    }

    await loaded;
    const { headers } = event;
    const id = headers['x-github-delivery'];
    const name = headers['x-github-event'];
    const signature = headers['x-hub-signature-256'];
    if (!id || !name || !signature || !event.body) {
        return json(400, { error: 'missing webhook headers or body' });
    }
    const payload = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;

    try {
        // Cast is safe: verifyAndReceive validates the signature before dispatch,
        // and Probot narrows the payload per event name inside each handler.
        await probot.webhooks.verifyAndReceive({
            id,
            name: name as Parameters<typeof probot.webhooks.verifyAndReceive>[0]['name'],
            signature,
            payload,
        });
        return json(200, { ok: true });
    } catch (error: unknown) {
        const inner =
            typeof error === 'object' &&
            error !== null &&
            'errors' in error &&
            Array.isArray(error.errors)
                ? (error.errors[0] as unknown)
                : undefined;
        const status = statusOf(error) ?? statusOf(inner) ?? 500;
        probot.log.error({ err: error, id, name }, 'webhook handling failed');
        return json(status, { error: status === 400 ? 'invalid signature' : 'handler error' });
    }
};
