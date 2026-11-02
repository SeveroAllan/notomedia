import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

export interface BoasVindasPareamentoDeps {
  pool: Pick<pg.Pool, 'query'>;
  ativo: boolean;
  nomeInstancia: string;
  allowlist: readonly string[];
  enviar: (telefone: string, texto: string) => Promise<boolean>;
}

function telefoneAutorizado(telefone: string, allowlist: readonly string[]): string | null {
  if (allowlist.length !== 1) return null;
  const autorizado = gerarVariantesTelefoneBrasileiro(allowlist[0]!);
  const variantes = gerarVariantesTelefoneBrasileiro(telefone);
  if (!variantes.some(v => autorizado.includes(v))) return null;
  return variantes.find(v => /^55\d{10,11}$/.test(v)) ?? null;
}

function primeiroNomeConfiavel(nome: string | null): string | null {
  const valor = nome?.trim() ?? '';
  // Login OTP gera placeholders "Médico 1234"; nunca tratar como nome verificado.
  if (!valor || /^m[eé]dic[oa](?:\s|$)/i.test(valor) || /^dr\.?\s*\(?a\)?\.?$/i.test(valor)) return null;
  const primeiro = valor.split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'-]{1,39}$/u.test(primeiro) ? primeiro : null;
}

/** Texto exclusivo do primeiro pareamento. Não infere últimas notas, agenda nem autorização fiscal. */
export function mensagemBoasVindasPareamento(nome: string | null): string {
  const primeiro = primeiroNomeConfiavel(nome);
  return [
    primeiro ? `Olá, ${primeiro}! Sou o Noto.` : 'Olá! Sou o Noto.',
    'Posso ajudar a organizar suas notas fiscais.',
    'Confirmei a conexão do seu WhatsApp.',
    'A emissão ainda depende das informações e autorizações necessárias.',
    'Desde quando você não emite notas?',
    'Qual agenda você usa: TribeMD, Amplimed ou outra?'
  ].join('\n');
}

/**
 * Só é chamada depois de conexão OPEN confirmada pela Evolution.
 * A reserva no Postgres garante NO MÁXIMO uma tentativa por conta, em qualquer
 * réplica. Falhas/timeouts de transporte ficam "incerta" sem reenvio automático;
 * sem idempotency key no provedor não há como prometer entrega exatamente uma vez.
 */
export async function enviarBoasVindasAposPareamento(deps: BoasVindasPareamentoDeps): Promise<boolean> {
  if (!deps.ativo || deps.allowlist.length !== 1 || !deps.nomeInstancia) return false;
  try {
    const identificacao = await deps.pool.query(
      `select w.conta_id, u.nome, u.telefone
         from whatsapp_instancias w
         join medicos m on m.id = w.medico_id and m.conta_id = w.conta_id
         join usuarios u on u.id = m.usuario_id and u.conta_id = w.conta_id
        where w.nome_instancia = $1 and w.status = 'conectado'
          and w.conectado_em is not null and w.oficial = false
          and u.ativo = true and u.auth_user_id is not null
        limit 2`,
      [deps.nomeInstancia]
    );
    // Nunca escolher identidade arbitrária se a relação ficar ambígua.
    if (identificacao.rows.length !== 1) return false;
    const registro = identificacao.rows[0] as {
      conta_id?: string; nome?: string | null; telefone?: string | null;
    };
    if (!registro.conta_id || !registro.telefone) return false;
    const destino = telefoneAutorizado(registro.telefone, deps.allowlist);
    if (!destino) return false;

    // Um INSERT é o limite de concorrência: conflito não gera segunda mensagem.
    const reservado = await deps.pool.query(
      `insert into noto_boas_vindas_pareamento (conta_id, nome_instancia, estado)
       select w.conta_id, w.nome_instancia, 'reservada'
         from whatsapp_instancias w
        where w.nome_instancia = $1 and w.conta_id = $2
          and w.status = 'conectado' and w.conectado_em is not null
       on conflict (conta_id) do nothing returning conta_id`,
      [deps.nomeInstancia, registro.conta_id]
    );
    if (reservado.rows.length !== 1) return false;

    // Após reservar, nunca repetir envio automaticamente, mesmo se der timeout.
    let enviado = false;
    try {
      enviado = await deps.enviar(destino, mensagemBoasVindasPareamento(registro.nome ?? null));
    } catch {
      enviado = false;
    }
    await deps.pool.query(
      `update noto_boas_vindas_pareamento
          set estado = $2, enviado_em = case when $2 = 'enviada' then now() else null end
        where conta_id = $1 and estado = 'reservada'`,
      [registro.conta_id, enviado ? 'enviada' : 'incerta']
    );
    return enviado;
  } catch {
    // Sem telefone, texto, nome, SQL, credenciais ou error.message nos logs.
    console.warn('[boas-vindas] indisponivel_ou_indeterminado');
    return false;
  }
}
