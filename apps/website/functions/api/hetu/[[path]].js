import { handle } from '../../../server/router.mjs';

export const onRequest = ({ request, env }) => handle(request, env);
