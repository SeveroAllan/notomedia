/**
 * Consulta interna isolada por conta (`medicos.conta_id`) para reaproveitar
 * CPF criptografado, telefone e último valor cobrado de pacientes já atendidos
 * antes no consultório. Separado do orquestrador para manter as regras de
 * decisão independentes de SQL.
 */

import type pg from 'pg';
import { validarCpf } from '../paciente/validar-cpf.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { normalizarNomeParaBusca } from './cruzar-comprovante-agenda.js';

export interface DadosPacienteConhecido {
  nome: string | null;
  cpf: string | null;
  telefone: string | null;
  ultimoValorCentavos: number | null;
}

export async function buscarDadosConhecidosPacienteConta(
  pool: Pick<pg.Pool, 'query'>,
  chaveCriptografia: string,
  entrada: {
    contaId: string;
    pacienteNome?: string | null;
    pacienteTelefone?: string | null;
  }
): Promise<DadosPacienteConhecido | null> {
  const nomeNorm = entrada.pacienteNome ? normalizarNomeParaBusca(entrada.pacienteNome) : '';
  const variantesTel = entrada.pacienteTelefone
    ? gerarVariantesTelefoneBrasileiro(entrada.pacienteTelefone)
    : [];
  if (!nomeNorm && !variantesTel.length) return null;

  const { rows } = await pool.query(
    `select p.id, p.nome, p.telefone,
            case when p.cpf_cnpj_encriptado is not null
              then pgp_sym_decrypt(p.cpf_cnpj_encriptado, $2)
              else null end as cpf_limpo,
            (select sn.valor_servico_centavos
               from public.solicitacoes_nota sn
              where sn.paciente_id = p.id and sn.valor_servico_centavos > 0
              order by sn.criado_em desc
              limit 1) as ultimo_valor_nota
       from public.pacientes p
       join public.medicos m on m.id = p.medico_id
      where m.conta_id = $1
      order by p.atualizado_em desc
      limit 150`,
    [entrada.contaId, chaveCriptografia]
  ).catch(() => ({ rows: [] as any[] }));

  const candidatos = rows as Array<{
    nome: string | null;
    telefone: string | null;
    cpf_limpo: string | null;
    ultimo_valor_nota: number | null;
  }>;

  const matchPorTelefone = variantesTel.length
    ? candidatos.find(c => {
        const tel = String(c.telefone ?? '').replace(/\D/g, '');
        return Boolean(tel) && variantesTel.includes(tel);
      })
    : undefined;

  const matchPorNome = !matchPorTelefone && nomeNorm
    ? candidatos.find(c => {
        const n = normalizarNomeParaBusca(String(c.nome ?? ''));
        return Boolean(n) && n === nomeNorm;
      })
    : undefined;

  const encontrado = matchPorTelefone ?? matchPorNome;
  const cpfValido = encontrado?.cpf_limpo && validarCpf(encontrado.cpf_limpo)
    ? encontrado.cpf_limpo.replace(/\D/g, '')
    : null;

  let ultimoValorCentavos = encontrado?.ultimo_valor_nota ? Number(encontrado.ultimo_valor_nota) : null;
  if (!ultimoValorCentavos && nomeNorm) {
    const casosRes = await pool.query(
      `select paciente_nome, valor_centavos
         from public.noto_casos_emissao
        where conta_id = $1 and valor_centavos is not null and valor_centavos > 0
          and estado in ('emitida', 'enfileirada', 'aguardando_aprovacao_medico')
        order by atualizado_em desc
        limit 50`,
      [entrada.contaId]
    ).catch(() => ({ rows: [] as any[] }));
    const casoAnterior = casosRes.rows.find(
      r => normalizarNomeParaBusca(String(r.paciente_nome ?? '')) === nomeNorm
    );
    if (casoAnterior?.valor_centavos) ultimoValorCentavos = Number(casoAnterior.valor_centavos);
  }

  if (!encontrado && !ultimoValorCentavos) return null;
  return {
    nome: encontrado?.nome ? String(encontrado.nome) : null,
    cpf: cpfValido,
    telefone: encontrado?.telefone ? String(encontrado.telefone) : null,
    ultimoValorCentavos
  };
}
