/** Per-page ordering for device Cookie/CSRF session changes. No token persistence here. */
export interface CsrfRequestContext {
  generation: number;
  token: string | null;
  changesSession: boolean;
}

let generation = 0;

export function captureCsrfRequest(token: string | null, changesSession = false): CsrfRequestContext {
  if (changesSession) generation++;
  return { generation, token, changesSession };
}

export function isCurrentCsrfRequest(context: CsrfRequestContext): boolean {
  return context.generation === generation &&
    (context.changesSession || context.token === sessionStorage.getItem('csrfToken'));
}

export function updateCsrfToken(token: unknown, context: CsrfRequestContext): void {
  if (typeof token !== 'string' || !token || !isCurrentCsrfRequest(context)) return;
  sessionStorage.setItem('csrfToken', token);
  context.token = token;
}
