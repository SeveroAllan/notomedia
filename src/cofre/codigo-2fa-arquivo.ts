import { createHash } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Fallback assistido do desafio de 2FA do Amplimed (homologação): enquanto o desafio está aberto,
 * aguarda UM código transitório de 6 dígitos entregue por um operador autorizado em arquivo descartável
 * (<diretorio>/<sha256("2fa-"+medicoId)[:16]>.txt). Vínculo à tentativa: só aceita arquivo criado
 * depois que a espera começou e apaga ao ler. Validade curta: desiste em `esperaMs`.
 * O código nunca é registrado nem persistido. Sem o diretório configurado, este caminho nem existe.
 */
export async function pedirCodigo2faPorArquivo(diretorio: string, medicoId: string, esperaMs = 240_000): Promise<string | null> {
    const caminho = join(diretorio, createHash('sha256').update('2fa-' + medicoId).digest('hex').slice(0, 16) + '.txt');
    const inicio = Date.now();
    while (Date.now() - inicio < esperaMs) {
        try {
            const st = await stat(caminho);
            if (st.mtimeMs >= inicio - 5_000) {
                const texto = (await readFile(caminho, 'utf8')).trim();
                await unlink(caminho).catch(() => {});
                if (/^\d{6}$/.test(texto)) return texto;
                return null; // conteúdo fora do formato: descarta e encerra esta tentativa
            }
        } catch { /* arquivo ainda não existe */ }
        await new Promise(r => setTimeout(r, 2_000));
    }
    return null;
}
