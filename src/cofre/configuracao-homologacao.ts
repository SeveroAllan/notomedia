import { isAbsolute, resolve, sep } from 'node:path';

/** Na homologação, nunca recorrer a perfis, chaves ou aliases do piloto.
 * A ausência de configuração desabilita somente o Cofre, não o WhatsApp. */
export function validarCofreHomologacao(env: NodeJS.ProcessEnv): boolean {
  const diretorio = env['COFRE_DIRETORIO']?.trim();
  const chave = env['COFRE_CHAVE']?.trim();
  const origem = env['COFRE_ORIGEM']?.trim();
  if (!diretorio || !isAbsolute(diretorio) || !chave || !origem) return false;
  const raiz = resolve(diretorio), legado = resolve('/dados/tribemd');
  if (raiz === '/' || raiz === legado || raiz.startsWith(legado + sep)) return false;
  if (env['TRIBEMD_TESTE_DIRETORIO'] && raiz === resolve(env['TRIBEMD_TESTE_DIRETORIO'])) return false;
  if (env['TRIBEMD_TESTE_CHAVE'] && chave === env['TRIBEMD_TESTE_CHAVE']) return false;
  const bytes = Buffer.from(chave, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== chave) return false;
  try {
    const u = new URL(origem);
    return u.protocol === 'https:' && u.username === '' && u.password === '' &&
      u.pathname === '/' && u.search === '' && u.hash === '' &&
      u.origin === env['APP_PUBLIC_ORIGIN']?.trim();
  } catch { return false; }
}
