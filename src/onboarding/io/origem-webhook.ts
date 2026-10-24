/** Origem configurada do próprio app, nunca inferida de Host ou proxy. */
export function origemWebhookConfigurada(valor?: string): string | null {
  if (!valor?.trim()) return null;
  try {
    const url = new URL(valor.trim());
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
